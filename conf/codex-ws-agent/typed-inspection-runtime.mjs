import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { canonicalSha256, buildContextEnvelope, buildThreadKey } from './chat-runtime.mjs'
import { buildTypedInspectionNativeInputs, finalizeTypedInspectionInputReceipt } from './typed-inspection-input-carriers.mjs'
import {
  TYPED_INSPECTION_INSTRUCTIONS, TYPED_INSPECTION_OUTPUT_SCHEMA, validateTypedInspectionOutcome,
  typedDeliberationAdapterReady
} from './juyiting-typed-outcome.mjs'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const HASH = /^[a-f0-9]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const AUTHORIZATION = /^inspection_[a-f0-9]{40}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const exactKeys = (value, keys) => object(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => own(value, key))
const nonblank = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const safeDecimalLength = value => DECIMAL.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
const directoryFsync = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
const assertPrivateDirectory = path => {
  const lexical = lstatSync(path, { bigint: true }); const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (lexical.isSymbolicLink() || !lexical.isDirectory() || (uid !== null && lexical.uid !== uid) || Number(lexical.mode & 0o777n) !== 0o700 || realpathSync(path) !== resolve(path)) fail('TYPED_INSPECTION_PRIVATE_DIRECTORY_UNSAFE')
  return path
}
const ensurePrivateRoot = path => {
  const absolute = resolve(path)
  if (!existsSync(absolute)) { mkdirSync(absolute, { recursive: true, mode: 0o700 }); chmodSync(absolute, 0o700); directoryFsync(dirname(absolute)); directoryFsync(absolute) }
  return assertPrivateDirectory(absolute)
}
const header = (headers, name) => {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  return key ? String(headers[key]) : null
}
const responseBytes = async response => {
  if (typeof response.arrayBuffer === 'function') return Buffer.from(await response.arrayBuffer())
  if (Buffer.isBuffer(response.body)) return response.body
  fail('TYPED_INSPECTION_CONTENT_BODY_INVALID')
}
const fixedOrigin = raw => {
  let parsed
  try { parsed = new URL(raw) } catch { fail('TYPED_INSPECTION_ORIGIN_INVALID') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') fail('TYPED_INSPECTION_ORIGIN_INVALID')
  return parsed.origin
}
const sourcePath = ({ requestId, turnId, sourceRefId }) => `/internal/agent/chat/requests/${encodeURIComponent(requestId)}/turns/${encodeURIComponent(turnId)}/inspection/inputs/${encodeURIComponent(sourceRefId)}/content`

const assertSelector = selector => {
  if (!exactKeys(selector, ['kind', 'fileId', 'version', 'purpose', 'assetId', 'assetRevision'])) fail('TYPED_INSPECTION_MANIFEST_INVALID')
  if (!nonblank(selector.kind) || !nonblank(selector.purpose)) fail('TYPED_INSPECTION_MANIFEST_INVALID')
  for (const key of ['fileId', 'version', 'assetId', 'assetRevision']) if (selector[key] !== null && !nonblank(selector[key])) fail('TYPED_INSPECTION_MANIFEST_INVALID')
}
const assertProfile = profile => {
  if (!exactKeys(profile, ['profileId', 'engineContractId', 'enginePolicyDigest', 'toolPolicyDigest', 'inputPolicyDigest']) ||
      !nonblank(profile.profileId) || !nonblank(profile.engineContractId) ||
      !DIGEST.test(profile.enginePolicyDigest) || !DIGEST.test(profile.toolPolicyDigest) || !DIGEST.test(profile.inputPolicyDigest)) fail('TYPED_INSPECTION_MANIFEST_INVALID')
}
const assertScope = scope => {
  const keys = ['tenantId', 'ownerJiacn', 'clientId', 'conversationId', 'conversationGeneration', 'taskId', 'assignmentRevision', 'requestId', 'requestRevision', 'targetAgentId']
  if (!exactKeys(scope, keys) || keys.some(key => !nonblank(scope[key]))) fail('TYPED_INSPECTION_MANIFEST_INVALID')
  for (const key of ['conversationGeneration', 'assignmentRevision', 'requestRevision']) if (!DECIMAL.test(scope[key])) fail('TYPED_INSPECTION_MANIFEST_INVALID')
}
const assertSource = source => {
  const keys = ['sourceRefId', 'selector', 'mediaKind', 'mimeType', 'byteLength', 'sha256', 'carrier', 'carrierContractDigest']
  if (!exactKeys(source, keys) || !nonblank(source.sourceRefId) || !nonblank(source.mediaKind) || !nonblank(source.mimeType) ||
      !safeDecimalLength(source.byteLength) || !HASH.test(source.sha256) || !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT'].includes(source.carrier) ||
      !DIGEST.test(source.carrierContractDigest)) fail('TYPED_INSPECTION_MANIFEST_INVALID')
  assertSelector(source.selector)
}

export const resolveTypedInspectionRequest = (profile, message) => {
  const facts = message?.contextSnapshot?.facts
  if (!facts || !own(facts, 'typedInspection')) return null
  if (own(facts, 'typedDeliberation')) fail('TYPED_INSPECTION_MARKER_CONFLICT')
  const typed = facts.typedInspection
  const keys = ['schemaVersion', 'contract', 'purpose', 'discussionFacts', 'manifest', 'manifestDigest', 'authorizationId']
  if (!exactKeys(typed, keys) || typed.schemaVersion !== 1 || typed.contract !== 'juyiting-typed-inspection-v1' || typed.purpose !== 'INSPECT' ||
      !object(typed.discussionFacts) || !object(typed.manifest) || !DIGEST.test(typed.manifestDigest) || !AUTHORIZATION.test(typed.authorizationId)) fail('TYPED_INSPECTION_MARKER_INVALID')
  const manifest = typed.manifest
  if (!exactKeys(manifest, ['schemaVersion', 'purpose', 'scope', 'profile', 'sources']) || manifest.schemaVersion !== 1 || manifest.purpose !== 'INSPECT' || !Array.isArray(manifest.sources) || manifest.sources.length === 0) fail('TYPED_INSPECTION_MANIFEST_INVALID')
  assertScope(manifest.scope); assertProfile(manifest.profile)
  let previous = null
  for (const source of manifest.sources) { assertSource(source); if (previous !== null && source.sourceRefId <= previous) fail('TYPED_INSPECTION_SOURCE_ORDER_INVALID'); previous = source.sourceRefId }
  if (canonicalSha256(manifest) !== typed.manifestDigest) fail('TYPED_INSPECTION_MANIFEST_DIGEST_MISMATCH')
  const route = message.route === undefined ? message.routing?.interactionMode : message.route
  const scope = manifest.scope
  const bindings = [
    ['tenantId', message.tenantId], ['ownerJiacn', message.ownerJiacn], ['clientId', message.clientId],
    ['conversationId', message.conversationId], ['conversationGeneration', String(message.conversationGeneration)],
    ['taskId', message.taskId], ['requestId', message.requestId], ['requestRevision', String(message.requestRevision)], ['targetAgentId', message.targetAgentId]
  ]
  if (message?.durable !== true || route !== 'INSPECT' || bindings.some(([key, value]) => value !== scope[key]) || profile?.agentId !== scope.targetAgentId ||
      facts?.conversation?.id !== scope.conversationId || facts?.conversation?.generation !== scope.conversationGeneration || facts?.task?.id !== scope.taskId || facts?.targetAgentId !== scope.targetAgentId) fail('TYPED_INSPECTION_BINDING_INVALID')
  return freeze({ ...typed, manifest: freeze(manifest) })
}

const assertMeasuredInspectionProfile = ({ profile, typed, adapter, isolationReadback }) => {
  if (profile?.typedInspectionEnabled !== true) fail('TYPED_INSPECTION_DISABLED')
  if (!typedDeliberationAdapterReady(profile, adapter)) fail('TYPED_INSPECTION_NATIVE_ADAPTER_UNAVAILABLE')
  const manifestProfile = typed.manifest.profile
  const keys = ['schemaVersion', 'measured', 'profileId', 'engineContractId', 'enginePolicyDigest', 'toolPolicyDigest', 'inputPolicyDigest', 'toolPolicy', 'recovery', 'supportedInputs']
  if (!exactKeys(isolationReadback, keys) || isolationReadback.schemaVersion !== 1 || isolationReadback.measured !== true ||
      !['STRICT_NO_TOOLS', 'MANIFEST_READ_ONLY'].includes(isolationReadback.toolPolicy) || isolationReadback.recovery !== 'durable-inbox-turn-readback-v1' ||
      !Array.isArray(isolationReadback.supportedInputs) || isolationReadback.supportedInputs.length === 0) fail('TYPED_INSPECTION_PROFILE_NOT_MEASURED')
  for (const key of ['profileId', 'engineContractId', 'enginePolicyDigest', 'toolPolicyDigest', 'inputPolicyDigest']) if (isolationReadback[key] !== manifestProfile[key]) fail('TYPED_INSPECTION_PROFILE_BINDING_MISMATCH')
  const support = new Map()
  for (const item of isolationReadback.supportedInputs) {
    if (!exactKeys(item, ['mediaKind', 'mimeType', 'carrier', 'carrierContractDigest']) || !nonblank(item.mediaKind) || !nonblank(item.mimeType) ||
        !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT'].includes(item.carrier) || !DIGEST.test(item.carrierContractDigest)) fail('TYPED_INSPECTION_PROFILE_NOT_MEASURED')
    const key = [item.mediaKind, item.mimeType, item.carrier, item.carrierContractDigest].join('\u001f')
    if (support.has(key)) fail('TYPED_INSPECTION_PROFILE_NOT_MEASURED')
    support.set(key, item)
  }
  for (const source of typed.manifest.sources) if (!support.has([source.mediaKind, source.mimeType, source.carrier, source.carrierContractDigest].join('\u001f'))) fail('TYPED_INSPECTION_INPUT_UNSUPPORTED')
  return isolationReadback
}

const overlap = (left, right) => left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
const paeth = (left, above, upperLeft) => {
  const estimate = left + above - upperLeft; const leftDistance = Math.abs(estimate - left); const aboveDistance = Math.abs(estimate - above); const upperLeftDistance = Math.abs(estimate - upperLeft)
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : (aboveDistance <= upperLeftDistance ? above : upperLeft)
}
export const decodePngInspectionInput = bytes => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
  let offset = 8; let width = 0; let height = 0; let channels = 0; let seenHeader = false; let seenEnd = false; const compressed = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.subarray(offset + 4, offset + 8).toString('ascii'); const dataStart = offset + 8; const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
    const data = bytes.subarray(dataStart, dataEnd)
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes.subarray(offset + 4, dataEnd))) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
    if (type === 'IHDR') {
      if (seenHeader || length !== 13) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); const bitDepth = data[8]; const colorType = data[9]
      if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
      channels = colorType === 2 ? 3 : 4; seenHeader = true
    } else if (type === 'IDAT') {
      if (!seenHeader || seenEnd) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED'); compressed.push(data)
    } else if (type === 'IEND') {
      if (length !== 0 || !seenHeader || seenEnd) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED'); seenEnd = true
    }
    offset = dataEnd + 4
    if (seenEnd) break
  }
  if (!seenEnd || offset !== bytes.length || compressed.length === 0) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
  let inflated
  try { inflated = inflateSync(Buffer.concat(compressed)) } catch { fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED') }
  const stride = width * channels
  if (!Number.isSafeInteger(stride) || inflated.length !== height * (stride + 1)) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
  const pixels = Buffer.allocUnsafe(height * stride); let sourceOffset = 0
  for (let row = 0; row < height; row++) {
    const filter = inflated[sourceOffset++]; if (filter > 4) fail('TYPED_INSPECTION_IMAGE_DECODER_REJECTED')
    for (let column = 0; column < stride; column++) {
      const raw = inflated[sourceOffset++]; const outputOffset = row * stride + column
      const left = column >= channels ? pixels[outputOffset - channels] : 0; const above = row ? pixels[outputOffset - stride] : 0; const upperLeft = row && column >= channels ? pixels[outputOffset - stride - channels] : 0
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft)
      pixels[outputOffset] = (raw + predictor) & 0xff
    }
  }
  return freeze({ decoder: 'png-rgba8-rgb8-noninterlaced-v1', width, height, channels, pixelDigest: `sha256:${sha256(pixels)}` })
}
export const decodeWavInspectionInput = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('TYPED_INSPECTION_AUDIO_DECODER_REJECTED')
  let offset = 12; let format = null; let samples = null
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString('ascii'); const length = bytes.readUInt32LE(offset + 4); const start = offset + 8; const end = start + length
    if (end > bytes.length) fail('TYPED_INSPECTION_AUDIO_DECODER_REJECTED')
    if (type === 'fmt ') {
      if (format || length < 16) fail('TYPED_INSPECTION_AUDIO_DECODER_REJECTED')
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), blockAlign: bytes.readUInt16LE(start + 12), bitsPerSample: bytes.readUInt16LE(start + 14) }
    } else if (type === 'data') {
      if (samples) fail('TYPED_INSPECTION_AUDIO_DECODER_REJECTED'); samples = bytes.subarray(start, end)
    }
    offset = end + (length % 2)
  }
  if (!format || !samples || ![1, 3].includes(format.encoding) || ![1, 2].includes(format.channels) || ![8, 16, 24, 32].includes(format.bitsPerSample) ||
      !format.sampleRate || format.blockAlign !== format.channels * format.bitsPerSample / 8 || format.byteRate !== format.sampleRate * format.blockAlign || samples.length % format.blockAlign !== 0) fail('TYPED_INSPECTION_AUDIO_DECODER_REJECTED')
  return freeze({ decoder: 'wav-pcm-ieee-float-v1', ...format, frameCount: samples.length / format.blockAlign, sampleDigest: `sha256:${sha256(samples)}` })
}
export const BUILTIN_TYPED_INSPECTION_DECODERS = freeze({
  'image/png': Object.freeze({ decoderId: 'png-rgba8-rgb8-noninterlaced-v1', validate: ({ bytes }) => decodePngInspectionInput(bytes) }),
  'audio/wav': Object.freeze({ decoderId: 'wav-pcm-ieee-float-v1', validate: ({ bytes }) => decodeWavInspectionInput(bytes) })
})


export class TypedInspectionMaterializer {
  constructor({ apiOrigin, rootDir, fetchFn = globalThis.fetch, getRuntimeAuth, agentId, runtimeInstanceId, parsers = {}, decoders = BUILTIN_TYPED_INSPECTION_DECODERS, forbidden = [] }) {
    this.origin = fixedOrigin(apiOrigin); this.root = ensurePrivateRoot(rootDir)
    for (const candidate of forbidden.filter(value => value && existsSync(resolve(value)))) if (overlap(this.root, realpathSync(resolve(candidate)))) fail('TYPED_INSPECTION_PRIVATE_DIRECTORY_OVERLAP')
    if (typeof fetchFn !== 'function' || typeof getRuntimeAuth !== 'function' || !nonblank(agentId) || !nonblank(runtimeInstanceId) || !object(parsers) || !object(decoders)) fail('TYPED_INSPECTION_MATERIALIZER_CONFIG_INVALID')
    this.fetchFn = fetchFn; this.getRuntimeAuth = getRuntimeAuth; this.agentId = agentId; this.runtimeInstanceId = runtimeInstanceId; this.parsers = parsers; this.decoders = decoders
  }
  async materialize({ message, typed }) {
    const auth = this.getRuntimeAuth()
    if (!/^AgentRuntime [0-9a-f]{32}$/.test(auth || '')) fail('TYPED_INSPECTION_RUNTIME_AUTH_REQUIRED')
    const directoryKey = sha256(Buffer.from([typed.authorizationId, typed.manifestDigest, message.requestId, message.turnId].join('\u001f')))
    const finalDirectory = resolve(this.root, directoryKey)
    if (existsSync(finalDirectory)) fail('TYPED_INSPECTION_REQUEST_DIRECTORY_EXISTS')
    const temporary = resolve(this.root, `.${directoryKey}.${process.pid}.${Date.now()}.tmp`)
    mkdirSync(temporary, { mode: 0o700 }); chmodSync(temporary, 0o700); directoryFsync(this.root)
    const materialized = []
    try {
      for (let index = 0; index < typed.manifest.sources.length; index++) {
        const source = typed.manifest.sources[index]
        const path = sourcePath({ requestId: message.requestId, turnId: message.turnId, sourceRefId: source.sourceRefId })
        const expectedUrl = `${this.origin}${path}`
        const response = await this.fetchFn(expectedUrl, {
          method: 'GET', redirect: 'manual', headers: {
            Authorization: auth, Accept: source.mimeType, 'X-Agent-Id': this.agentId,
            'X-Agent-Runtime-Id': this.runtimeInstanceId, 'X-Inspection-Manifest-Digest': typed.manifestDigest
          }
        })
        if (!response || response.status !== 200) fail(response?.status >= 300 && response?.status < 400 ? 'TYPED_INSPECTION_REDIRECT_FORBIDDEN' : 'TYPED_INSPECTION_CONTENT_FETCH_FAILED')
        if (response.redirected === true || response.url !== expectedUrl) fail('TYPED_INSPECTION_RESPONSE_URL_MISMATCH')
        if ((header(response.headers, 'content-type') || '').trim().toLowerCase() !== source.mimeType.toLowerCase()) fail('TYPED_INSPECTION_CONTENT_TYPE_MISMATCH')
        if ((header(response.headers, 'content-length') || '').trim() !== source.byteLength) fail('TYPED_INSPECTION_CONTENT_LENGTH_MISMATCH')
        const bytes = await responseBytes(response)
        if (String(bytes.length) !== source.byteLength) fail('TYPED_INSPECTION_CONTENT_LENGTH_MISMATCH')
        if (sha256(bytes) !== source.sha256) fail('TYPED_INSPECTION_CONTENT_DIGEST_MISMATCH')
        const fileName = `${String(index).padStart(4, '0')}-${sha256(Buffer.from(source.sourceRefId)).slice(0, 24)}.input`
        const output = resolve(temporary, fileName)
        const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
        try { writeFileSync(fd, bytes); fsyncSync(fd); const stat = fstatSync(fd, { bigint: true }); if (!stat.isFile() || stat.size !== BigInt(bytes.length)) fail('TYPED_INSPECTION_OUTPUT_FILE_INVALID') } finally { closeSync(fd) }
        chmodSync(output, 0o400)
        const lexical = lstatSync(output, { bigint: true }); const stat = statSync(output, { bigint: true })
        if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.dev !== stat.dev || lexical.ino !== stat.ino || realpathSync(output) !== output) fail('TYPED_INSPECTION_OUTPUT_FILE_INVALID')
        const item = { ...source, bytes, path: output }
        if (source.carrier === 'LOCAL_IMAGE' || source.carrier === 'LOCAL_AUDIO') {
          const decoder = this.decoders[source.mimeType]
          if (!object(decoder) || !nonblank(decoder.decoderId) || typeof decoder.validate !== 'function') fail(source.carrier === 'LOCAL_IMAGE' ? 'TYPED_INSPECTION_IMAGE_DECODER_UNAVAILABLE' : 'TYPED_INSPECTION_AUDIO_DECODER_UNAVAILABLE')
          const decoded = await decoder.validate({ path: output, bytes: Buffer.from(bytes), source: freeze({ ...source }) })
          if (!object(decoded)) fail(source.carrier === 'LOCAL_IMAGE' ? 'TYPED_INSPECTION_IMAGE_DECODER_REJECTED' : 'TYPED_INSPECTION_AUDIO_DECODER_REJECTED')
          item.decoder = { decoderId: decoder.decoderId, readback: decoded }
        }
        if (source.carrier === 'PARSED_TEXT') {
          const parser = this.parsers[source.mimeType]
          if (!object(parser) || !DIGEST.test(parser.parserConfigDigest) || typeof parser.parse !== 'function') fail('TYPED_INSPECTION_PARSER_UNAVAILABLE')
          const parsedText = await parser.parse({ path: output, bytes: Buffer.from(bytes), source: freeze({ ...source }) })
          if (typeof parsedText !== 'string') fail('TYPED_INSPECTION_PARSER_OUTPUT_INVALID')
          item.parsedText = parsedText
          item.parser = { parserConfigDigest: parser.parserConfigDigest, sourceByteDigest: `sha256:${sha256(bytes)}`, extractedTextDigest: `sha256:${sha256(Buffer.from(parsedText, 'utf8'))}` }
        }
        materialized.push(item)
      }
      directoryFsync(temporary); renameSync(temporary, finalDirectory); directoryFsync(this.root)
      for (const source of materialized) source.path = resolve(finalDirectory, source.path.split('/').at(-1))
      assertPrivateDirectory(finalDirectory)
      return freeze({ directory: finalDirectory, sources: materialized })
    } catch (error) {
      try { rmSync(temporary, { recursive: true, force: true }); directoryFsync(this.root) } catch {}
      throw error
    }
  }
}

const carrierSource = source => {
  const base = { sourceRefId: source.sourceRefId, sha256: source.sha256, byteLength: source.byteLength, mimeType: source.mimeType,
    carrier: source.carrier, carrierContractDigest: source.carrierContractDigest, bytes: Buffer.from(source.bytes) }
  if (source.carrier === 'LOCAL_IMAGE' || source.carrier === 'LOCAL_AUDIO') return { ...base, path: source.path }
  if (source.carrier === 'PARSED_TEXT') return { ...base, parser: source.parser, parsedText: source.parsedText }
  return base
}
const inspectionEnvelopeInput = message => ({ type: 'text', text: JSON.stringify(buildContextEnvelope(message)) })
const inspectionPolicyHashes = (typed, adapter) => ({
  enginePolicyHash: typed.manifest.profile.enginePolicyDigest,
  toolPolicyHash: typed.manifest.profile.toolPolicyDigest,
  instructionSourceHash: canonicalSha256({ source: 'runtime-static', instructions: TYPED_INSPECTION_INSTRUCTIONS, outputSchema: TYPED_INSPECTION_OUTPUT_SCHEMA }),
  modelConfigHash: canonicalSha256({ model: adapter?.readback?.models || {}, config: adapter?.readback?.config || {}, contract: typed.manifest.profile.engineContractId })
})
const preparedRecord = ({ typed, converted, directory, threadKey, engineThreadId = null }) => freeze({
  schemaVersion: 1, contract: typed.contract, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest,
  inputPolicyDigest: typed.manifest.profile.inputPolicyDigest, inputDigest: converted.inputDigest,
  inspectionInputReceiptDraft: converted.inspectionInputReceiptDraft, inputDirectory: directory, threadKey,
  ...(engineThreadId ? { engineThreadId } : {})
})
const validatePreparation = (preparation, typed) => {
  if (!object(preparation) || preparation.schemaVersion !== 1 || preparation.contract !== typed.contract || preparation.authorizationId !== typed.authorizationId ||
      preparation.manifestDigest !== typed.manifestDigest || preparation.inputPolicyDigest !== typed.manifest.profile.inputPolicyDigest || !DIGEST.test(preparation.inputDigest) ||
      !object(preparation.inspectionInputReceiptDraft) || preparation.inspectionInputReceiptDraft.inputDigest !== preparation.inputDigest || !nonblank(preparation.threadKey)) fail('TYPED_INSPECTION_PREPARATION_INVALID')
  return preparation
}
const finalAgentText = turn => {
  const items = Array.isArray(turn?.items) ? turn.items : []
  const messages = items.filter(item => ['agentMessage', 'agent_message'].includes(item?.type) && typeof item.text === 'string')
  if (messages.length !== 1) fail('TYPED_INSPECTION_RECOVERED_FINAL_INVALID')
  return messages[0].text
}
const publishInspectionFinal = ({ profile, message, typed, rawOutcome, receiptDraft, engineThreadId, engineTurnId, threadKey, sendFinal }) => {
  const outcome = validateTypedInspectionOutcome(rawOutcome, typed.discussionFacts)
  const receipt = finalizeTypedInspectionInputReceipt({ receiptDraft, engineThreadId, engineTurnId })
  sendFinal(profile, message, outcome.text, {
    status: 'completed', routeUsed: 'INSPECT_NATIVE', productPolicy: 'fixed-manifest-read-only', threadGeneration: threadKey,
    outcomeContractVersion: 2, interactionOutcome: outcome, inspectionInputReceipt: receipt
  })
  return { status: 'completed', threadId: engineThreadId, turnId: engineTurnId, threadKey, inputDigest: receipt.inputDigest }
}

export const runTypedInspection = async (profile, message, {
  adapter, bindingStore, controls = { markPrepared: () => {}, markRunning: () => {}, isCancelled: () => false },
  materializer, isolationReadback, nativeInputAdapters = {}, sendFinal
} = {}) => {
  const typed = resolveTypedInspectionRequest(profile, message)
  if (!typed) fail('TYPED_INSPECTION_MARKER_REQUIRED')
  assertMeasuredInspectionProfile({ profile, typed, adapter, isolationReadback })
  if (!materializer || typeof materializer.materialize !== 'function' || typeof sendFinal !== 'function') fail('TYPED_INSPECTION_RUNTIME_CONFIG_INVALID')
  const materialized = await materializer.materialize({ message, typed })
  const converted = buildTypedInspectionNativeInputs({ authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest, sources: materialized.sources.map(carrierSource), adapters: nativeInputAdapters })
  const hashes = inspectionPolicyHashes(typed, adapter)
  const key = buildThreadKey({
    tenantId: message.tenantId, clientId: message.clientId, ownerJiacn: message.ownerJiacn, profileId: profile.profileId,
    agentId: profile.agentId, conversationId: message.conversationId, mode: 'INSPECT', workspaceScopeHash: 'inspection-private-inputs-v1',
    cwd: materialized.directory, ...hashes, conversationGeneration: String(message.conversationGeneration), authorizationId: typed.authorizationId,
    manifestDigest: typed.manifestDigest, inputPolicyDigest: typed.manifest.profile.inputPolicyDigest
  })
  controls.markPrepared(preparedRecord({ typed, converted, directory: materialized.directory, threadKey: key }))
  const prior = bindingStore?.get(key)
  if (prior?.state === 'RECOVERY_REQUIRED') fail('TURN_ACCEPTANCE_UNKNOWN')
  const binding = await adapter.startOrResumeThread(prior, {
    cwd: materialized.directory, model: profile.chatModel || profile.codexModel, config: { network: false }, developerInstructions: TYPED_INSPECTION_INSTRUCTIONS
  })
  bindingStore?.put(key, binding)
  controls.markPrepared(preparedRecord({ typed, converted, directory: materialized.directory, threadKey: key, engineThreadId: binding.threadId }))
  let accepted = null
  try {
    const result = await adapter.runTurn({
      threadId: binding.threadId, clientUserMessageId: message.messageId,
      input: [inspectionEnvelopeInput(message), ...converted.nativeInputs],
      policy: { cwd: materialized.directory, model: profile.chatModel || profile.codexModel, effort: profile.chatReasoningEffort, outputSchema: TYPED_INSPECTION_OUTPUT_SCHEMA },
      onAccepted: value => { accepted = value; controls.markRunning(() => adapter.interrupt(value.threadId, value.turnId), value) }
    })
    if (controls.isCancelled()) return { status: 'cancelled', threadId: result.threadId, turnId: result.turnId, threadKey: key }
    if (result.threadId !== binding.threadId || !nonblank(result.turnId)) fail('TYPED_INSPECTION_ENGINE_BINDING_MISMATCH')
    const published = publishInspectionFinal({ profile, message, typed, rawOutcome: result.content, receiptDraft: converted.inspectionInputReceiptDraft,
      engineThreadId: result.threadId, engineTurnId: result.turnId, threadKey: key, sendFinal })
    bindingStore?.put(key, { ...binding, state: 'IDLE', lastAppliedContextHash: message.contextSnapshot.contextHash, updatedAt: Date.now() })
    return published
  } catch (error) {
    if (error?.code === 'TURN_ACCEPTANCE_UNKNOWN') bindingStore?.markRecovery(key, error.message)
    if (error?.code === 'TURN_ACCEPTANCE_UNKNOWN' && !error.turn) error.turn = accepted || { threadId: binding.threadId, clientUserMessageId: message.messageId }
    throw error
  }
}

export const recoverTypedInspection = async (profile, message, record, {
  adapter, isolationReadback, sendFinal
} = {}) => {
  const typed = resolveTypedInspectionRequest(profile, message)
  if (!typed) fail('TYPED_INSPECTION_MARKER_REQUIRED')
  assertMeasuredInspectionProfile({ profile, typed, adapter, isolationReadback })
  const preparation = validatePreparation(record?.preparation, typed)
  const engineThreadId = record?.engine?.threadId || preparation.engineThreadId
  const expectedTurnId = record?.engine?.turnId || null
  if (!nonblank(engineThreadId)) fail('TYPED_INSPECTION_RECOVERY_BINDING_MISSING')
  const reconciliation = await adapter.reconcileTurn({ threadId: engineThreadId, turnId: expectedTurnId, clientUserMessageId: message.messageId })
  if (!reconciliation || ['ABSENT', 'ACCEPTED', 'RECOVERY_REQUIRED'].includes(reconciliation.status)) return { status: 'recovery_required', reconciliationStatus: reconciliation?.status || 'RECOVERY_REQUIRED' }
  if (reconciliation.status !== 'TERMINAL' || reconciliation.terminalStatus !== 'completed') fail('TYPED_INSPECTION_RECOVERED_TURN_FAILED')
  const resultThreadId = reconciliation.result?.thread?.id || engineThreadId
  const engineTurnId = reconciliation.turnId || reconciliation.turn?.id
  if (resultThreadId !== engineThreadId || !nonblank(engineTurnId) || (expectedTurnId && engineTurnId !== expectedTurnId)) fail('TYPED_INSPECTION_ENGINE_BINDING_MISMATCH')
  return publishInspectionFinal({ profile, message, typed, rawOutcome: finalAgentText(reconciliation.turn),
    receiptDraft: preparation.inspectionInputReceiptDraft, engineThreadId, engineTurnId, threadKey: preparation.threadKey, sendFinal })
}
