/** Protocol4 shares the existing conversation inbox/session/lease/output transport.
 * This lane never consumes v1/v2/v3 commands or grants authority from model prose. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { executeSkill, parseSkillCommand, skillDigest, skillHash, skillId, skillSha } from './skill-executor.mjs'
import { SkillExecutionStore, SkillEffects, validateSkillInputReceipts } from './skill-execution-store.mjs'
import { nativeSessionHeaders } from './conversation-native.mjs'
import { parseSkillJson, validateSkillData } from './skill-manifest.mjs'
const BASE = '/internal/agent/tasks'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, cause = null) => { throw Object.assign(new Error(code), { code, ...(cause ? { cause } : {}) }) }
const fenceValid = value => object(value) && Number.isSafeInteger(value.version) && value.version > 0 && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.token || '')
const leaseValid = (lease, command) => fenceValid(lease) && lease.executionId === command.executionId && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt > Date.now()
const originOf = value => {
  let url; try { url = new URL(value) } catch { fail('SKILL_API_ORIGIN_INVALID') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('SKILL_API_ORIGIN_INVALID')
  return url.origin
}
const sourceKinds = new Set(['TASK_LINKED_WORKSPACE_VERSION', 'CURRENT_CONVERSATION_ASSET', 'EXECUTION_RESULT'])
const byteLength = value => {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) fail('SKILL_INPUT_SNAPSHOT_INVALID'); return String(value) }
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) fail('SKILL_INPUT_SNAPSHOT_INVALID')
  return value
}
export function parseSkillInputSnapshot(snapshot, command, fence) {
  if (!object(snapshot) || snapshot.schemaVersion !== 4 || snapshot.executionId !== command.executionId || snapshot.leaseVersion !== fence.version
      || snapshot.snapshotDigest !== command.snapshotDigest || !Array.isArray(snapshot.inputs) || snapshot.inputs.length !== command.inputRefs.length
      || snapshot.noReferencedMaterials !== (snapshot.inputs.length === 0)) fail('SKILL_INPUT_SNAPSHOT_INVALID')
  const seen = new Set()
  return snapshot.inputs.map(input => {
    if (!object(input) || !command.inputRefs.includes(input.inputRef) || seen.has(input.inputRef) || !skillSha(input.sha256)
        || typeof input.contentMimeType !== 'string' || !sourceKinds.has(input.sourceKind) || !object(input.sourceIdentity)) fail('SKILL_INPUT_SNAPSHOT_INVALID')
    seen.add(input.inputRef)
    return { inputRef: input.inputRef, sourceKind: input.sourceKind, sourceIdentity: structuredClone(input.sourceIdentity),
      contentMimeType: input.contentMimeType, byteLength: byteLength(input.byteLength), sha256: input.sha256 }
  })
}
// Result digest is the server's canonical preimage, not the local checkpoint envelope.
export function skillResultPayload(manifest) {
  return { schemaVersion: 1, data: manifest.result.data, artifacts: manifest.result.artifacts.map(item => ({
    outputId: item.outputId, sha256: item.sha256, byteLength: Number(item.byteLength) })), inputReceipts: manifest.result.inputReceipts }
}
export function validateCommittedSkillResult(manifest, command, descriptor, phase, local = null) {
  const fields = ['schemaVersion', 'data', 'artifacts', 'inputReceipts', 'resultDigest', 'manifestId']
  if (!object(manifest) || Object.keys(manifest).length !== fields.length || !fields.every(key => Object.hasOwn(manifest, key))
      || manifest.schemaVersion !== 1 || !skillId(manifest.manifestId) || !skillSha(manifest.resultDigest)
      || !Array.isArray(manifest.artifacts) || !['ARCHIVING', 'COMPLETE'].includes(phase)) fail('SKILL_COMMIT_UNCONFIRMED')
  const ids = new Set()
  for (const artifact of manifest.artifacts) {
    if (!object(artifact) || Object.keys(artifact).length !== 3 || !skillId(artifact.outputId) || ids.has(artifact.outputId)
        || !skillSha(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1) fail('SKILL_COMMIT_UNCONFIRMED')
    ids.add(artifact.outputId)
  }
  const outputs = descriptor.manifest.outputs
  if ((outputs.artifactsRequired && !manifest.artifacts.length) || (!outputs.multiple && manifest.artifacts.length > 1)
      || (!outputs.dataSchema && manifest.data !== null)) fail('SKILL_COMMIT_UNCONFIRMED')
  if (outputs.dataSchema) validateSkillData(outputs.dataSchema, manifest.data)
  validateSkillInputReceipts(manifest.inputReceipts, command.inputRefs)
  const preimage = { schemaVersion: 1, data: manifest.data, artifacts: manifest.artifacts, inputReceipts: manifest.inputReceipts }
  if (skillDigest(preimage) !== manifest.resultDigest || (local && skillDigest(skillResultPayload(local)) !== manifest.resultDigest)) fail('SKILL_COMMIT_UNCONFIRMED')
  return { manifestId: manifest.manifestId, state: 'RESULT_COMMITTED', phase, resultDigest: manifest.resultDigest }
}

export class SkillConversationLane {
  constructor({ apiOrigin, rootDir, agentId, runtimeInstanceId, scope, getRuntimeHeaders, fetchFn = globalThis.fetch, registry, runners, onCommitted = async () => {} }) {
    this.origin = originOf(apiOrigin)
    if (!isAbsolute(rootDir || '') || !skillId(agentId) || !skillId(runtimeInstanceId) || typeof getRuntimeHeaders !== 'function'
        || typeof fetchFn !== 'function' || !scope || scope.agentId !== agentId || !registry || !(runners instanceof Map)) fail('SKILL_LANE_CONFIG_INVALID')
    this.root = resolve(rootDir, 'skill-runs'); this.agentId = agentId; this.instanceId = runtimeInstanceId
    this.scope = scope; this.auth = getRuntimeHeaders; this.fetch = fetchFn; this.registry = registry; this.runners = runners; this.active = false; this.onCommitted = onCommitted
  }
  headers() { return nativeSessionHeaders(this.auth(), this.agentId, this.instanceId) }
  async request(path, method, body, statuses = [200]) {
    const endpoint = new URL(path, `${this.origin}/`)
    if (endpoint.origin !== this.origin || endpoint.pathname !== path || endpoint.search || endpoint.hash) fail('SKILL_API_PATH_INVALID')
    const proof = this.headers(), headers = { ...proof, Accept: 'application/json' }
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
    let response
    try { response = await this.fetch(endpoint, { method, redirect: 'error', headers,
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) }) }
    catch (cause) { fail('SKILL_TRANSPORT_UNKNOWN', cause) }
    if (JSON.stringify(proof) !== JSON.stringify(this.headers())) fail('SKILL_SESSION_CHANGED')
    if (!response || !statuses.includes(response.status) || response.redirected === true || response.url !== endpoint.href) {
      throw Object.assign(new Error('SKILL_API_RESPONSE_UNCONFIRMED'), { code: 'SKILL_API_RESPONSE_UNCONFIRMED', status: response?.status })
    }
    if (response.headers?.get?.('content-type') && !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type'))) fail('SKILL_API_RESPONSE_UNCONFIRMED')
    try { return parseSkillJson(await response.text()) } catch (cause) { fail('SKILL_API_RESPONSE_UNCONFIRMED', cause) }
  }
  async readInput(path, command, fence, input, checkLease) {
    checkLease()
    const endpoint = new URL(`${path}/inputs/${input.inputRef}/content`, `${this.origin}/`)
    let reply
    try { reply = await this.fetch(endpoint, { method: 'POST', redirect: 'error', headers: { ...this.headers(), Accept: 'application/octet-stream', 'Content-Type': 'application/json' }, body: JSON.stringify(fence) }) }
    catch (cause) { fail('SKILL_INPUT_READ_UNCERTAIN', cause) }
    if (reply?.status !== 200 || reply.redirected || reply.url !== endpoint.href || reply.headers?.get?.('content-length') !== input.byteLength
        || reply.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') fail('SKILL_INPUT_READ_UNCERTAIN')
    const chunks = []; let length = 0
    try {
      const reader = reply.body.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break
          length += value.length; if (BigInt(length) > BigInt(input.byteLength)) fail('SKILL_INPUT_BYTES_INVALID')
          chunks.push(Buffer.from(value))
        }
      } finally { reader.releaseLock() }
    } catch (cause) { fail('SKILL_INPUT_READ_UNCERTAIN', cause) }
    const bytes = Buffer.concat(chunks, length)
    checkLease()
    if (String(bytes.length) !== input.byteLength || skillHash(bytes) !== input.sha256) fail('SKILL_INPUT_BYTES_INVALID')
    return bytes
  }
  pendingCommands() {
    const subject = resolve(this.root, skillDigest({ ...this.scope, apiOrigin: this.origin }))
    if (!existsSync(subject)) return []
    if (realpathSync(subject) !== subject || !lstatSync(subject).isDirectory()) fail('SKILL_STORE_UNSAFE')
    const pending = []
    for (const id of readdirSync(subject)) {
      if (!skillId(id)) fail('SKILL_STORE_UNSAFE')
      const directory = resolve(subject, id)
      if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) fail('SKILL_STORE_UNSAFE')
      const fd = openSync(resolve(directory, 'command.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      let command
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid() || (stat.mode & 0o077)) fail('SKILL_STORE_UNSAFE')
        command = parseSkillCommand(readFileSync(fd))
      } finally { closeSync(fd) }
      if (command.executionId !== id) fail('SKILL_STORE_IDENTITY_CONFLICT')
      const store = new SkillExecutionStore({ rootDirectory: this.root, scope: { ...this.scope, apiOrigin: this.origin }, command })
      if (store.read('attempt') && !store.read('receipt')) pending.push(command)
    }
    return pending
  }
  async poll() {
    if (this.active) return { processed: 0, busy: true }
    this.active = true
    try {
      const page = await this.request(`${BASE}/conversation-executions/commands`, 'GET')
      if (!object(page) || !Array.isArray(page.items) || page.items.length > 16) fail('SKILL_INBOX_INVALID')
      const commands = new Map(this.pendingCommands().map(command => [command.executionId, command]))
      for (const raw of page.items) {
        const command = parseSkillCommand(raw), previous = commands.get(command.executionId)
        if (previous && skillDigest(previous) !== skillDigest(command)) fail('SKILL_STORE_IDENTITY_CONFLICT')
        commands.set(command.executionId, command)
      }
      let processed = 0, firstError = null
      const executionErrors = [], proof = JSON.stringify(this.headers())
      for (const command of commands.values()) {
        // A command-local UNKNOWN must not starve unrelated work. A changed
        // subject/session or unsafe shared checkpoint tree ends the whole poll.
        if (proof !== JSON.stringify(this.headers())) fail('SKILL_SESSION_CHANGED')
        try { await this.process(command); processed++ } catch (error) {
          const code = error?.code
          if (typeof code !== 'string' || !/^(?:SKILL|MATERIALS)_[A-Z_]{1,80}$/.test(code)
              || /^(?:SKILL_SESSION_|SKILL_STORE_|SKILL_SCOPE_|SKILL_LANE_CONFIG_|SKILL_API_ORIGIN_)/.test(code)) throw error
          firstError ||= error
          executionErrors.push({ executionId: command.executionId, code })
        }
      }
      // Preserve the actual first error and cause, not a fake success/failure.
      if (firstError) { Object.assign(firstError, { processed, executionErrors }); throw firstError }
      return { processed }
    } finally { this.active = false }
  }
  async process(command) {
    const path = `${BASE}/${command.taskId}/runs/${command.runId}/conversation`
    const store = new SkillExecutionStore({ rootDirectory: this.root, scope: { ...this.scope, apiOrigin: this.origin }, command })
    let fence = null, expiry = 0, timer, renewalPromise, renewalError, running = true, proof
    const checkLease = () => {
      if (renewalError || !fence || Date.now() >= expiry) fail('SKILL_LEASE_UNCERTAIN', renewalError)
      if (JSON.stringify(proof) !== JSON.stringify(this.headers())) fail('SKILL_SESSION_CHANGED')
    }
    const renew = async () => {
      try {
        const next = await this.request(`${path}/lease/renew`, 'POST', fence)
        if (!leaseValid(next, command) || next.version !== fence.version || next.token !== fence.token) fail('SKILL_LEASE_UNCERTAIN')
        expiry = next.expiresAt
        if (running) timer = setTimeout(() => { renewalPromise = renew() }, Math.max(1, Math.floor((expiry - Date.now()) / 2)))
      } catch (error) { renewalError = error }
    }
    const common = () => ({ executionId: command.executionId, snapshotDigest: command.snapshotDigest, fence })
    let resume = null
    const ctx = {
      registry: this.registry, runners: this.runners, outputDirectory: resolve(store.directory, 'outputs'),
      claimOrResume: async () => {
        const attempted = store.read('attempt')
        // Write before claim; lost lease reply must use resume, not a new claim.
        if (!attempted) store.write('attempt', { schemaVersion: 1, executionId: command.executionId })
        proof = this.headers()
        if (attempted) {
          resume = await this.request(`${path}/resume`, 'POST', { executionId: command.executionId, snapshotDigest: command.snapshotDigest })
          if (!object(resume) || !Array.isArray(resume.allowedWork)) fail('SKILL_RESUME_INVALID')
        }
        const lease = resume?.lease || await this.request(`${path}/lease`, 'POST', { commandId: command.commandId, messageId: command.messageId })
        if (!leaseValid(lease, command)) fail('SKILL_LEASE_UNCERTAIN')
        fence = { version: lease.version, token: lease.token }; expiry = lease.expiresAt
        timer = setTimeout(() => { renewalPromise = renew() }, Math.max(1, Math.floor((expiry - Date.now()) / 2)))
        return { resultManifest: resume?.resultManifest || null }
      },
      loadResult: async () => store.loadResult(),
      materializeAuthorizedInputs: async (_command, descriptor) => {
        checkLease()
        if (resume && !resume.allowedWork.includes('EXECUTE') && !resume.allowedWork.includes('RECOVER_LOCAL_RESULT')) fail('SKILL_RESULT_UNKNOWN')
        const snapshot = await this.request(`${path}/inputs`, 'POST', fence)
        const inputs = parseSkillInputSnapshot(snapshot, command, fence)
        const savedInputs = store.read('inputs-snapshot')
        if (savedInputs && skillDigest(savedInputs.inputs) !== skillDigest(inputs)) fail('SKILL_INPUT_SNAPSHOT_INVALID')
        if (!savedInputs) store.write('inputs-snapshot', { schemaVersion: 1, inputs })
        if (inputs.some(input => !descriptor.manifest.inputs.acceptedMimeTypes.includes(input.contentMimeType))) fail('SKILL_INPUT_CONTRACT_INVALID')
        const materialized = []
        for (const input of inputs) {
          const bytes = await this.readInput(path, command, fence, input, checkLease)
          const target = resolve(store.directory, 'inputs', input.inputRef)
          let fd
          try {
            if (existsSync(target)) {
              if (realpathSync(target) !== target) fail('SKILL_INPUT_BYTES_INVALID')
              fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
              const before = fstatSync(fd, { bigint: true }), cached = readFileSync(fd), after = fstatSync(fd, { bigint: true })
              if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid()) || (before.mode & 0o077n)
                  || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !cached.equals(bytes)) fail('SKILL_INPUT_BYTES_INVALID')
            } else {
              fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
              writeFileSync(fd, bytes); fsyncSync(fd)
            }
          } finally { if (fd !== undefined) closeSync(fd) }
          const inputDir = openSync(resolve(store.directory, 'inputs'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { fsyncSync(inputDir) } finally { closeSync(inputDir) }
          materialized.push({ ...input, path: target, bytes })
        }
        return materialized
      },
      validateAndPersistResult: async (_command, descriptor, result) => store.persistResult(descriptor, result),
      stageOutputs: async (_command, artifacts) => {
        for (const artifact of artifacts) {
          checkLease()
          const bytes = store.readBlob(artifact.outputId, artifact), form = new FormData()
          form.set('file', new Blob([bytes], { type: artifact.contentMimeType }), artifact.outputId)
          for (const [key, value] of Object.entries({ version: String(fence.version), token: fence.token, sha256: artifact.sha256, length: artifact.byteLength })) form.set(key, value)
          const staged = await this.request(`${path}/outputs/${artifact.outputId}/content`, 'POST', form, [200, 201])
          if (staged.outputId !== artifact.outputId || staged.sha256 !== artifact.sha256 || String(staged.byteLength) !== artifact.byteLength
              || !['STAGED', 'COMMITTED'].includes(staged.state)) fail('SKILL_STAGE_UNCONFIRMED')
        }
      },
      recoverCommittedResult: async (_command, descriptor, manifest) => {
        checkLease()
        const local = store.read('result') // committed bytes need not remain on this host
        return validateCommittedSkillResult(manifest, command, descriptor, resume?.phase, local)
      },
      commitResult: async (_command, manifest) => {
        checkLease()
        const preimage = skillResultPayload(manifest), digest = skillDigest(preimage)
        const manifestId = `manifest_${digest}`
        const payload = { fence, snapshotDigest: command.snapshotDigest, data: preimage.data, artifacts: preimage.artifacts, inputReceipts: preimage.inputReceipts }
        let receipt
        try { receipt = await this.request(`${path}/result-commits/${manifestId}`, 'POST', payload) } catch (original) {
          // Read back persistent server truth. Never restage or regenerate a committed result.
          let recovered
          try { recovered = await this.request(`${path}/resume`, 'POST', { executionId: command.executionId, snapshotDigest: command.snapshotDigest }) } catch { throw original }
          if (!recovered.resultManifest) throw original
          const descriptor = (await this.registry.requireExact({ skillKey: command.skill.key, skillVersion: command.skill.version,
            packageSha256: command.skill.packageSha256, manifestSha256: command.skill.manifestSha256 }, { allowUnavailable: true })).descriptor
          receipt = validateCommittedSkillResult(recovered.resultManifest, command, descriptor, recovered.phase, manifest)
        }
        if (receipt?.manifestId !== manifestId || receipt.state !== 'RESULT_COMMITTED' || receipt.resultDigest !== digest
            || !['ARCHIVING', 'COMPLETE'].includes(receipt.phase)) fail('SKILL_COMMIT_UNCONFIRMED')
        return receipt
      },
      persistReceipt: async (_command, manifest, receipt) => {
        store.write('receipt', { schemaVersion: 1, executionId: command.executionId, snapshotDigest: command.snapshotDigest,
          localResultDigest: skillDigest(manifest), manifestId: receipt.manifestId, resultDigest: receipt.resultDigest,
          state: receipt.state, phase: receipt.phase })
        try { await this.onCommitted(command, receipt) } catch { store.write('cleanup-pending', { schemaVersion: 1, code: 'SKILL_CLEANUP_PENDING' }) }
        // Leave checkpoint retention explicit. A receipt never clears another execution's tree.
      }
    }
    ctx.effects = new SkillEffects({ store, bindingRevision: null, checkLease, mayStart: () => !resume || resume.allowedWork.includes('EXECUTE'),
      start: (id, body) => this.request(`${path}/effects/${id}/start`, 'POST', { ...common(), ...body }),
      report: (id, body) => this.request(`${path}/effects/${id}/result`, 'POST', { ...common(), ...body }) })
    // Current immutable binding revision is refreshed by the registry before run.
    const originalRequire = ctx.registry.requireExact.bind(ctx.registry)
    ctx.registry = { requireExact: async (skill, options) => { const entry = await originalRequire(skill, options); ctx.effects.bindingRevision = entry.binding?.revision ?? null; return entry } }
    try { return await executeSkill(command, ctx) }
    finally { running = false; clearTimeout(timer); await renewalPromise }
  }
}
