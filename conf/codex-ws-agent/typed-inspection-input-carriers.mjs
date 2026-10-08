/**
 * Pure conversion of already-authorized inspection sources. No I/O, authorization,
 * profile selection, thread creation, or native turn execution occurs here.
 */
import { createHash } from 'node:crypto'

const HASH = /^[a-f0-9]{64}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key))

export class TypedInspectionInputCarrierError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = code => { throw new TypedInspectionInputCarrierError(code) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const digest = value => `sha256:${sha256(value)}`
const validString = value => typeof value === 'string' && value.length > 0
const validDigest = value => typeof value === 'string' && DIGEST.test(value)
const validHash = value => typeof value === 'string' && HASH.test(value)
const validLength = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
const validScalarString = value => {
  if (typeof value !== 'string') return false
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!object(value)) return value
  const result = {}
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key])
  return result
}
export const canonicalTypedInspectionInputJsonV1 = value => JSON.stringify(canonicalValue(value))
const canonicalDigest = value => digest(Buffer.from(canonicalTypedInspectionInputJsonV1(value), 'utf8'))
const untrustedText = (sourceRefId, text) => `UNTRUSTED INSPECTION MATERIAL (${sourceRefId}):\n${text}`

const assertSourceBytes = source => {
  if (!Buffer.isBuffer(source.bytes) || !validLength(source.byteLength) || !validHash(source.sha256)
      || BigInt(source.bytes.length) !== BigInt(source.byteLength) || sha256(source.bytes) !== source.sha256) fail('TYPED_INSPECTION_SOURCE_BYTES_INVALID')
  return source.bytes
}
const assertBaseSource = source => {
  if (!object(source) || !validString(source.sourceRefId) || !validHash(source.sha256) || !validLength(source.byteLength)
      || !validString(source.mimeType) || !validString(source.carrier) || !validDigest(source.carrierContractDigest)) fail('TYPED_INSPECTION_SOURCE_INVALID')
}
const contributionBase = source => ({ schemaVersion: 1, sourceRefId: source.sourceRefId, sha256: source.sha256,
  byteLength: source.byteLength, mimeType: source.mimeType, carrier: source.carrier, carrierContractDigest: source.carrierContractDigest })
const receiptSource = (source, contributionDigest) => freeze({ sourceRefId: source.sourceRefId, sha256: source.sha256,
  byteLength: source.byteLength, carrier: source.carrier, contributionDigest })
const strictUtf8 = bytes => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { fail('TYPED_INSPECTION_DIRECT_TEXT_INVALID_UTF8') }
}
const assertAdapter = (adapters, key, mimeType) => {
  const adapter = adapters?.[key]
  if (!object(adapter) || !Array.isArray(adapter.supportedMimeTypes) || !adapter.supportedMimeTypes.includes(mimeType)
      || adapter.supportedMimeTypes.some(value => !validString(value)) || typeof adapter.toNativeInput !== 'function') fail(`TYPED_INSPECTION_${key === 'localImage' ? 'LOCAL_IMAGE' : 'LOCAL_AUDIO'}_UNSUPPORTED`)
  return adapter
}
const parseDirectText = source => {
  if (!exactKeys(source, ['sourceRefId', 'sha256', 'byteLength', 'mimeType', 'carrier', 'carrierContractDigest', 'bytes'])) fail('TYPED_INSPECTION_SOURCE_INVALID')
  const bytes = assertSourceBytes(source); const text = untrustedText(source.sourceRefId, strictUtf8(bytes))
  const preimage = { ...contributionBase(source), sourceByteDigest: digest(bytes), textDigest: digest(Buffer.from(text, 'utf8')) }
  const contributionDigest = canonicalDigest(preimage)
  return { nativeInput: { type: 'text', text }, receiptSource: receiptSource(source, contributionDigest) }
}
const parseLocal = (source, adapters, key) => {
  if (!exactKeys(source, ['sourceRefId', 'sha256', 'byteLength', 'mimeType', 'carrier', 'carrierContractDigest', 'bytes', 'path']) || !validString(source.path)) fail('TYPED_INSPECTION_SOURCE_INVALID')
  assertSourceBytes(source)
  const adapter = assertAdapter(adapters, key, source.mimeType)
  let nativeInput
  try { nativeInput = adapter.toNativeInput(Object.freeze({ path: source.path, mimeType: source.mimeType, sourceRefId: source.sourceRefId })) } catch { fail(`TYPED_INSPECTION_${key === 'localImage' ? 'LOCAL_IMAGE' : 'LOCAL_AUDIO'}_UNSUPPORTED`) }
  if (!exactKeys(nativeInput, ['type', 'path']) || nativeInput.type !== key || nativeInput.path !== source.path) fail(`TYPED_INSPECTION_${key === 'localImage' ? 'LOCAL_IMAGE' : 'LOCAL_AUDIO'}_UNSUPPORTED`)
  const contributionDigest = canonicalDigest(contributionBase(source))
  return { nativeInput, receiptSource: receiptSource(source, contributionDigest) }
}
const parseParsedText = source => {
  if (!exactKeys(source, ['sourceRefId', 'sha256', 'byteLength', 'mimeType', 'carrier', 'carrierContractDigest', 'bytes', 'parser', 'parsedText'])) fail('TYPED_INSPECTION_SOURCE_INVALID')
  const bytes = assertSourceBytes(source)
  if (!object(source.parser) || !exactKeys(source.parser, ['parserConfigDigest', 'sourceByteDigest', 'extractedTextDigest'])
      || !validDigest(source.parser.parserConfigDigest) || source.parser.sourceByteDigest !== digest(bytes)
      || !validDigest(source.parser.extractedTextDigest) || !validScalarString(source.parsedText)
      || source.parser.extractedTextDigest !== digest(Buffer.from(source.parsedText, 'utf8'))) fail('TYPED_INSPECTION_PARSED_TEXT_PROVENANCE_INVALID')
  const text = untrustedText(source.sourceRefId, source.parsedText)
  const preimage = { ...contributionBase(source), sourceByteDigest: source.parser.sourceByteDigest,
    parserConfigDigest: source.parser.parserConfigDigest, extractedTextDigest: source.parser.extractedTextDigest,
    textDigest: digest(Buffer.from(text, 'utf8')) }
  const contributionDigest = canonicalDigest(preimage)
  return { nativeInput: { type: 'text', text }, receiptSource: receiptSource(source, contributionDigest) }
}

/** Builds pre-turn native inputs and a receipt draft. It intentionally has no engine IDs. */
export const buildTypedInspectionNativeInputs = ({ authorizationId, manifestDigest, sources, adapters = {} }) => {
  if (!validString(authorizationId) || !validDigest(manifestDigest) || !Array.isArray(sources) || sources.length === 0 || !object(adapters)) fail('TYPED_INSPECTION_REQUEST_INVALID')
  let previousSourceRefId = null; const nativeInputs = []; const receiptSources = []
  for (const source of sources) {
    assertBaseSource(source)
    if (previousSourceRefId !== null && source.sourceRefId <= previousSourceRefId) fail('TYPED_INSPECTION_SOURCE_ORDER_INVALID')
    previousSourceRefId = source.sourceRefId
    let converted
    if (source.carrier === 'DIRECT_TEXT') converted = parseDirectText(source)
    else if (source.carrier === 'LOCAL_IMAGE') converted = parseLocal(source, adapters, 'localImage')
    else if (source.carrier === 'LOCAL_AUDIO') converted = parseLocal(source, adapters, 'localAudio')
    else if (source.carrier === 'PARSED_TEXT') converted = parseParsedText(source)
    else fail('TYPED_INSPECTION_UNKNOWN_CARRIER')
    nativeInputs.push(freeze(converted.nativeInput)); receiptSources.push(converted.receiptSource)
  }
  const inputDigest = canonicalDigest({ schemaVersion: 1, authorizationId, manifestDigest, sources: receiptSources })
  return freeze({ nativeInputs, inputDigest, inspectionInputReceiptDraft: { schemaVersion: 1, authorizationId, manifestDigest, inputDigest, sources: receiptSources } })
}

/** Adds only IDs actually returned by the accepted native turn; it does not start or read a turn. */
export const finalizeTypedInspectionInputReceipt = ({ receiptDraft, engineThreadId, engineTurnId }) => {
  if (!object(receiptDraft) || !exactKeys(receiptDraft, ['schemaVersion', 'authorizationId', 'manifestDigest', 'inputDigest', 'sources'])
      || receiptDraft.schemaVersion !== 1 || !validString(receiptDraft.authorizationId) || !validDigest(receiptDraft.manifestDigest)
      || !validDigest(receiptDraft.inputDigest) || !Array.isArray(receiptDraft.sources) || receiptDraft.sources.length === 0
      || !validString(engineThreadId) || !validString(engineTurnId)) fail('TYPED_INSPECTION_RECEIPT_INVALID')
  let previousSourceRefId = null
  for (const source of receiptDraft.sources) {
    if (!exactKeys(source, ['sourceRefId', 'sha256', 'byteLength', 'carrier', 'contributionDigest'])
        || !validString(source.sourceRefId) || !validHash(source.sha256) || !validLength(source.byteLength)
        || !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT'].includes(source.carrier)
        || !validDigest(source.contributionDigest)
        || (previousSourceRefId !== null && source.sourceRefId <= previousSourceRefId)) fail('TYPED_INSPECTION_RECEIPT_INVALID')
    previousSourceRefId = source.sourceRefId
  }
  const expectedInputDigest = canonicalDigest({ schemaVersion: 1, authorizationId: receiptDraft.authorizationId,
    manifestDigest: receiptDraft.manifestDigest, sources: receiptDraft.sources })
  if (receiptDraft.inputDigest !== expectedInputDigest) fail('TYPED_INSPECTION_RECEIPT_INVALID')
  return freeze({ ...receiptDraft, engineThreadId, engineTurnId })
}
