/** Execution-scoped, fsynced checkpoints. No auth proof/token/URL enters this store.
 * This is not a work queue: even local START requires server-authorized resume. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseSkillJson, validateSkillData } from './skill-manifest.mjs'
import { skillCanonicalJson, skillDigest, skillHash, skillId, skillSha } from './skill-executor.mjs'
import { validateNativeConversationOutput } from './conversation-native.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const privateDirectory = path => {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== process.geteuid() || (stat.mode & 0o077)) fail('SKILL_STORE_UNSAFE')
}
const syncDirectory = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
const readPrivate = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid()) || (before.mode & 0o077n)) fail('SKILL_STORE_UNSAFE')
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true })
    if (before.size !== BigInt(bytes.length) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('SKILL_STORE_CHANGED')
    return bytes
  } finally { closeSync(fd) }
}
const writePrivate = (path, bytes) => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}

export const SKILL_INPUT_CARRIERS = Object.freeze(['native-text', 'native-image', 'native-audio', 'parsed-text', 'provider-image', 'local-file'])
export function validateSkillInputReceipts(receipts, inputRefs, frozenInputs = null, runner = null) {
  if (!Array.isArray(receipts) || receipts.length !== inputRefs.length) fail('SKILL_RESULT_INPUT_RECEIPT_INVALID')
  const seen = new Set()
  for (const receipt of receipts) {
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'carrier,delivery,inputRef,sha256' || !inputRefs.includes(receipt.inputRef)
        || seen.has(receipt.inputRef) || !skillSha(receipt.sha256) || !SKILL_INPUT_CARRIERS.includes(receipt.carrier) || receipt.delivery !== 'DELIVERED'
        || (receipt.carrier === 'local-file' && runner !== 'local-script')
        || (frozenInputs && frozenInputs.find(input => input.inputRef === receipt.inputRef)?.sha256 !== receipt.sha256)) fail('SKILL_RESULT_INPUT_RECEIPT_INVALID')
    seen.add(receipt.inputRef)
  }
}

export class SkillExecutionStore {
  constructor({ rootDirectory, scope, command }) {
    if (!isAbsolute(rootDirectory || '') || !scope || !skillId(command?.executionId)) fail('SKILL_STORE_CONFIG_INVALID')
    this.scopeDigest = skillDigest(scope); this.commandDigest = skillDigest(command)
    this.command = command; this.directory = resolve(rootDirectory, this.scopeDigest, command.executionId)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    for (const path of [resolve(rootDirectory), resolve(rootDirectory, this.scopeDigest), this.directory]) privateDirectory(path)
    for (const name of ['inputs', 'outputs', 'scratch']) {
      mkdirSync(resolve(this.directory, name), { recursive: true, mode: 0o700 }); privateDirectory(resolve(this.directory, name))
    }
    const previous = this.read('identity')
    const identity = { schemaVersion: 1, scopeDigest: this.scopeDigest, commandDigest: this.commandDigest,
      executionId: command.executionId, snapshotDigest: command.snapshotDigest }
    if (previous && skillDigest(previous) !== skillDigest(identity)) fail('SKILL_STORE_IDENTITY_CONFLICT')
    if (!previous) this.write('identity', identity)
    if (!this.read('command')) this.write('command', command)
  }
  path(name) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) fail('SKILL_STORE_KEY_INVALID'); return resolve(this.directory, `${name}.json`) }
  read(name) { privateDirectory(this.directory); const path = this.path(name); return existsSync(path) ? parseSkillJson(readPrivate(path)) : null }
  write(name, value) {
    privateDirectory(this.directory)
    const path = this.path(name), temp = resolve(this.directory, `tmp-${randomUUID()}`)
    const bytes = Buffer.from(skillCanonicalJson(value), 'utf8'); parseSkillJson(bytes)
    writePrivate(temp, bytes)
    try { renameSync(temp, path); syncDirectory(this.directory) } catch (error) { try { unlinkSync(temp) } catch {}; throw error }
  }
  readBlob(name, expected) {
    if (!skillId(name)) fail('SKILL_STORE_KEY_INVALID')
    privateDirectory(resolve(this.directory, 'outputs'))
    const bytes = readPrivate(resolve(this.directory, 'outputs', name))
    if (expected && (skillHash(bytes) !== expected.sha256 || String(bytes.length) !== String(expected.byteLength))) fail('SKILL_RESULT_BYTES_CHANGED')
    return bytes
  }
  writeBlob(name, bytes) {
    if (!skillId(name) || !Buffer.isBuffer(bytes)) fail('SKILL_STORE_KEY_INVALID')
    privateDirectory(resolve(this.directory, 'outputs'))
    const path = resolve(this.directory, 'outputs', name)
    if (existsSync(path)) { if (!readPrivate(path).equals(bytes)) fail('SKILL_RESULT_BYTES_CHANGED'); return }
    writePrivate(path, bytes); syncDirectory(resolve(this.directory, 'outputs'))
  }
  loadResult() {
    const result = this.read('result')
    if (!result) return null
    if (result.schemaVersion !== 1 || result.executionId !== this.command.executionId || result.snapshotDigest !== this.command.snapshotDigest
        || !result.result || !Array.isArray(result.result.artifacts) || !Array.isArray(result.result.inputReceipts)) fail('SKILL_RESULT_BINDING_INVALID')
    for (const artifact of result.result.artifacts) this.readBlob(artifact.outputId, artifact)
    return result
  }
  persistResult(descriptor, result) {
    if (!result || !Array.isArray(result.artifacts) || !Array.isArray(result.inputReceipts)) fail('SKILL_RESULT_INVALID')
    const outputs = descriptor.manifest.outputs
    if ((outputs.artifactsRequired && result.artifacts.length === 0) || (!outputs.multiple && result.artifacts.length > 1)) fail('SKILL_RESULT_ARTIFACTS_INVALID')
    const data = result.data ?? null
    if (!outputs.dataSchema && data !== null) fail('SKILL_RESULT_DATA_INVALID')
    if (outputs.dataSchema) validateSkillData(outputs.dataSchema, data)
    const ids = new Set()
    const artifacts = result.artifacts.map(artifact => {
      if (!skillId(artifact?.outputId) || ids.has(artifact.outputId) || !outputs.mimeTypes.includes(artifact.contentMimeType)
          || !validateNativeConversationOutput(artifact.contentMimeType, artifact.bytes)) fail('SKILL_RESULT_ARTIFACTS_INVALID')
      ids.add(artifact.outputId)
      this.writeBlob(artifact.outputId, artifact.bytes)
      return { outputId: artifact.outputId, contentMimeType: artifact.contentMimeType, sha256: skillHash(artifact.bytes), byteLength: String(artifact.bytes.length) }
    })
    validateSkillInputReceipts(result.inputReceipts, this.command.inputRefs, this.read('inputs-snapshot')?.inputs || null, descriptor.manifest.runner)
    const manifest = { schemaVersion: 1, executionId: this.command.executionId, snapshotDigest: this.command.snapshotDigest,
      result: { data, artifacts, inputReceipts: result.inputReceipts } }
    const previous = this.loadResult()
    if (previous && skillDigest(previous) !== skillDigest(manifest)) fail('SKILL_RESULT_CONFLICT')
    if (!previous) this.write('result', manifest)
    return manifest
  }
}

export class SkillEffects {
  constructor({ store, start, report, checkLease, bindingRevision = null, mayStart = () => true }) {
    this.store = store; this.start = start; this.report = report; this.checkLease = checkLease; this.bindingRevision = bindingRevision; this.mayStart = mayStart
  }
  async invoke(effectId, request, invoke) {
    if (!skillId(effectId) || typeof invoke !== 'function') fail('SKILL_EFFECT_INVALID')
    const effectDigest = skillDigest({ request, bindingRevision: this.bindingRevision })
    const name = `effect-${effectId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${skillHash(effectId).slice(0, 12)}`
    let local = this.store.read(name)
    if (local && (local.effectDigest !== effectDigest || local.bindingRevision !== this.bindingRevision)) fail('SKILL_EFFECT_CONFLICT')
    if (local?.status === 'SUCCEEDED') {
      // Reconfirm persistent server status; never trust a local record as admission.
      this.checkLease()
      const confirmation = await this.report(effectId, { effectDigest, providerBindingRevision: this.bindingRevision, status: 'SUCCEEDED', providerRequestId: local.providerRequestId, resultDigest: local.resultDigest })
      this.confirm(confirmation, local)
      return this.restore(local)
    }
    this.checkLease()
    if (!this.mayStart()) fail('SKILL_RESULT_UNKNOWN')
    const receipt = await this.start(effectId, { effectDigest, providerBindingRevision: this.bindingRevision })
    if (receipt?.schemaVersion !== 1 || receipt.disposition !== 'NEW' || receipt.status !== 'START_RECORDED' || receipt.providerRequestId !== null || receipt.resultDigest !== null || local) fail('SKILL_RESULT_UNKNOWN')
    local = { schemaVersion: 1, effectDigest, bindingRevision: this.bindingRevision, status: 'START_RECORDED', providerRequestId: null, resultDigest: null }
    // This durable write must finish BEFORE any external effect. A crash leaves unknown.
    this.store.write(name, local)
    this.checkLease()
    let value
    try { value = await invoke() } catch (cause) {
      this.store.write(name, { ...local, status: 'UNKNOWN' })
      try { await this.report(effectId, { effectDigest, providerBindingRevision: this.bindingRevision, status: 'UNKNOWN', providerRequestId: null, resultDigest: null }) } catch {}
      throw Object.assign(new Error('SKILL_RESULT_UNKNOWN'), { code: 'SKILL_RESULT_UNKNOWN', cause })
    }
    // Store actual returned bytes before reporting result or staging any output.
    const encoded = { ...value }
    if (Buffer.isBuffer(value?.bytes)) {
      const blobName = `effect-${skillHash(effectId)}`
      this.store.writeBlob(blobName, value.bytes)
      encoded.bytes = { blobName, sha256: skillHash(value.bytes), byteLength: String(value.bytes.length) }
    }
    const resultDigest = skillDigest(encoded)
    local = { ...local, status: 'SUCCEEDED', providerRequestId: value?.providerRequestId ?? null, resultDigest, value: encoded }
    this.store.write(name, local)
    this.checkLease()
    const confirmation = await this.report(effectId, { effectDigest, providerBindingRevision: this.bindingRevision, status: 'SUCCEEDED', providerRequestId: local.providerRequestId, resultDigest })
    this.confirm(confirmation, local)
    return this.restore(local)
  }
  confirm(receipt, local) {
    if (receipt?.schemaVersion !== 1 || !['KNOWN', 'RECORDED'].includes(receipt.disposition) || receipt.status !== 'SUCCEEDED'
        || receipt.providerRequestId !== local.providerRequestId || receipt.resultDigest !== local.resultDigest) fail('SKILL_EFFECT_REPORT_UNCONFIRMED')
  }
  restore(local) {
    if (!local.value || skillDigest(local.value) !== local.resultDigest) fail('SKILL_EFFECT_RESULT_CHANGED')
    const value = { ...local.value }
    if (value.bytes?.blobName) value.bytes = this.store.readBlob(value.bytes.blobName, value.bytes)
    return value
  }
}
