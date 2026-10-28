import { readNativeJson } from './native-json.mjs'
/** Protocol5 shares the existing conversation inbox/session/lease/output transport.
 * This lane never consumes or resumes v1/v2/v3/v4 commands or grants authority from model prose. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, openAsBlob, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { executeSkill, parseSkillCommand, skillDigest, skillId, skillSha } from './skill-executor.mjs'
import { SkillExecutionStore, validateSkillInputReceipts } from './skill-execution-store.mjs'
import { nativeSessionHeaders, nativePositiveLong } from './conversation-native.mjs'
import { parseSkillJson, validateSkillData } from './skill-manifest.mjs'
const BASE = '/internal/agent/tasks'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, cause = null) => { throw Object.assign(new Error(code), { code, ...(cause ? { cause } : {}) }) }
const fenceValid = value => object(value) && nativePositiveLong(value.version) && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.token || '')
const leaseValid = (lease, command) => fenceValid(lease) && Object.keys(lease).length === 4 && ['executionId', 'version', 'token', 'expiresAt'].every(key => Object.hasOwn(lease, key)) && lease.executionId === command.executionId && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt > Date.now()
const originOf = value => {
  let url; try { url = new URL(value) } catch { fail('SKILL_API_ORIGIN_INVALID') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('SKILL_API_ORIGIN_INVALID')
  return url.origin
}
// Public field names are projected once. Saved commands/effects/manifests retain their original hash preimages.
export function skillCommandFromWire(value) {
  if (!object(value) || !Object.hasOwn(value, 'snapshotSha256') || Object.hasOwn(value, 'snapshotDigest')) fail('SKILL_COMMAND_INVALID')
  const { snapshotSha256, ...command } = value
  return parseSkillCommand({ ...command, snapshotDigest: snapshotSha256 })
}
const effectRequest = body => ({ effectSha256: body.effectDigest, providerBindingRevision: body.providerBindingRevision,
  ...(Object.hasOwn(body, 'status') ? { status: body.status, providerRequestId: body.providerRequestId, resultSha256: body.resultDigest } : {}) })
const effectReceipt = value => {
  const keys = ['schemaVersion', 'disposition', 'status', 'providerRequestId', 'resultSha256']
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      value.resultSha256 !== null && !skillSha(value.resultSha256)) fail('SKILL_EFFECT_REPORT_UNCONFIRMED')
  const { resultSha256, ...receipt } = value
  return { ...receipt, resultDigest: resultSha256 }
}
const resultReceipt = value => {
  const keys = ['manifestId', 'state', 'phase', 'resultSha256']
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      !skillSha(value.resultSha256)) fail('SKILL_COMMIT_UNCONFIRMED')
  const { resultSha256, ...receipt } = value
  return { ...receipt, resultDigest: resultSha256 }
}
const engineTerminalCodes = new Set(['NATIVE_EXECUTION_TURN_FAILED', 'NATIVE_EXECUTION_TURN_INTERRUPTED'])
const sourceKinds = new Set(['TASK_LINKED_WORKSPACE_VERSION', 'CURRENT_CONVERSATION_ASSET', 'EXECUTION_RESULT', 'FORMAL_ARTIFACT'])
const byteLength = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) fail('SKILL_INPUT_SNAPSHOT_INVALID')
  return value
}
export function parseSkillInputSnapshot(snapshot, command, fence) {
  if (!object(snapshot) || snapshot.schemaVersion !== 5 || !nativePositiveLong(snapshot.leaseVersion) || snapshot.executionId !== command.executionId || snapshot.leaseVersion !== fence.version
      || snapshot.snapshotSha256 !== command.snapshotDigest || !Array.isArray(snapshot.inputs) || snapshot.inputs.length !== command.inputRefs.length
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
  return { schemaVersion: 2, data: manifest.result.data, effectDependencies: manifest.result.effectDependencies, artifacts: manifest.result.artifacts.map(item => ({
    outputId: item.outputId, sha256: item.sha256, byteLength: Number(item.byteLength) })), inputReceipts: manifest.result.inputReceipts }
}
export function validateCommittedSkillResult(manifest, command, descriptor, phase, local = null) {
  const fields = ['schemaVersion', 'data', 'artifacts', 'inputReceipts', 'effectDependencies', 'resultDigest', 'manifestId']
  if (!object(manifest) || Object.keys(manifest).length !== fields.length || !fields.every(key => Object.hasOwn(manifest, key))
      || manifest.schemaVersion !== 2 || !skillId(manifest.manifestId) || !skillSha(manifest.resultDigest)
      || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.effectDependencies) || manifest.effectDependencies.length !== 0 || !['ARCHIVING', 'COMPLETE'].includes(phase)) fail('SKILL_COMMIT_UNCONFIRMED')
  const ids = new Set()
  for (const artifact of manifest.artifacts) {
    if (!object(artifact) || Object.keys(artifact).length !== 3 || !skillId(artifact.outputId) || ids.has(artifact.outputId)
        || !skillSha(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) fail('SKILL_COMMIT_UNCONFIRMED')
    ids.add(artifact.outputId)
  }
  const outputs = command.outputs
  if ((outputs.artifactsRequired && !manifest.artifacts.length) || (!outputs.multiple && manifest.artifacts.length > 1)
      || (!outputs.dataSchema && manifest.data !== null)) fail('SKILL_COMMIT_UNCONFIRMED')
  if (outputs.dataSchema) validateSkillData(outputs.dataSchema, manifest.data)
  validateSkillInputReceipts(manifest.inputReceipts, command.inputRefs, null, 'native-execution')
  const preimage = { schemaVersion: 2, data: manifest.data, artifacts: manifest.artifacts, inputReceipts: manifest.inputReceipts, effectDependencies: manifest.effectDependencies }
  if (skillDigest(preimage) !== manifest.resultDigest || (local && skillDigest(skillResultPayload(local)) !== manifest.resultDigest)) fail('SKILL_COMMIT_UNCONFIRMED')
  return { manifestId: manifest.manifestId, state: 'RESULT_COMMITTED', phase, resultDigest: manifest.resultDigest }
}

export class SkillConversationLane {
  constructor({ apiOrigin, rootDir, agentId, runtimeInstanceId, scope, getRuntimeHeaders, fetchFn = globalThis.fetch, registry, runners, runNative = null, onCommitted = async () => {}, onFailed = async () => {}, now = Date.now, random = Math.random }) {
    this.origin = originOf(apiOrigin)
    if (!isAbsolute(rootDir || '') || !skillId(agentId) || !skillId(runtimeInstanceId) || typeof getRuntimeHeaders !== 'function'
        || typeof fetchFn !== 'function' || !scope || scope.agentId !== agentId || !registry) fail('SKILL_LANE_CONFIG_INVALID')
    this.root = resolve(rootDir, 'skill-runs'); this.agentId = agentId; this.instanceId = runtimeInstanceId
    this.scope = scope; this.auth = getRuntimeHeaders; this.fetch = fetchFn; this.registry = registry; this.runners = runners; this.active = false; this.onCommitted = onCommitted; this.onFailed = onFailed
    this.runNative = runNative; this.now = now; this.random = random; this.unknownRetries = new Map()
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
    try { return await readNativeJson(response) } catch (cause) { fail('SKILL_API_RESPONSE_UNCONFIRMED', cause) }
  }
  async readInput(path, command, fence, input, checkLease, signal) {
    checkLease()
    const endpoint = new URL(`${path}/inputs/${input.inputRef}/content`, `${this.origin}/`)
    let reply
    try { reply = await this.fetch(endpoint, { method: 'POST', redirect: 'error', signal, headers: { ...this.headers(), Accept: 'application/octet-stream', 'Content-Type': 'application/json' }, body: JSON.stringify(fence) }) }
    catch (cause) { fail('SKILL_INPUT_READ_UNCERTAIN', cause) }
    if (reply?.status !== 200 || reply.redirected || reply.url !== endpoint.href || reply.headers?.get?.('content-length') !== input.byteLength
        || reply.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') fail('SKILL_INPUT_READ_UNCERTAIN')
    checkLease()
    return reply.body
  }

  pendingCommands() {
    this.pendingCommandErrors = []
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
        try { command = parseSkillCommand(readFileSync(fd)) } catch (error) {
          // Historical commands without a current authority binding are not executable.
          // Preserve them and report their failure, but do not starve unrelated current work.
          if (error?.code !== 'SKILL_COMMAND_INVALID') throw error
          this.pendingCommandErrors.push({ executionId: id, error })
          continue
        }
      } finally { closeSync(fd) }
      if (command.executionId !== id) fail('SKILL_STORE_IDENTITY_CONFLICT')
      const store = new SkillExecutionStore({ rootDirectory: this.root, scope: { ...this.scope, apiOrigin: this.origin }, command })
      if (store.read('attempt') && !store.read('receipt') && !store.read('failure-receipt')) pending.push(command)
    }
    return pending
  }
  async poll() {
    if (this.active) return { status: 'BUSY', processed: 0, deferred: 0, executionErrors: [] }
    this.active = true
    try {
      const page = await this.request(`${BASE}/conversation-executions/commands`, 'GET')
      if (!object(page) || !Array.isArray(page.items) || page.items.length > 16) fail('SKILL_INBOX_INVALID')
      const commands = new Map(this.pendingCommands().map(command => [command.executionId, command]))
      const inboxErrors = []
      for (const raw of page.items) {
        let command
        try { command = skillCommandFromWire(raw) } catch (error) {
          // A queued pre-cutover command must neither execute nor starve v5
          // work. Only attribute errors with an unambiguous execution identity.
          if (error?.code !== 'SKILL_COMMAND_INVALID' || !skillId(raw?.executionId)) throw error
          if (commands.has(raw.executionId)) fail('SKILL_STORE_IDENTITY_CONFLICT')
          inboxErrors.push({ executionId: raw.executionId, code: error.code })
          continue
        }
        const previous = commands.get(command.executionId)
        if (previous && skillDigest(previous) !== skillDigest(command)) fail('SKILL_STORE_IDENTITY_CONFLICT')
        commands.set(command.executionId, command)
      }
      // Scheduling only: never an execution admission or a terminal failure.
      for (const id of this.unknownRetries.keys()) if (!commands.has(id)) this.unknownRetries.delete(id)
      let deferred = 0
      let processed = 0
      const executionErrors = [...(this.pendingCommandErrors || []).map(({ executionId, error }) => ({ executionId, code: error.code })), ...inboxErrors], proof = JSON.stringify(this.headers())
      for (const command of commands.values()) {
        // A command-local UNKNOWN must not starve unrelated work. A changed
        // subject/session or unsafe shared checkpoint tree ends the whole poll.
        if (proof !== JSON.stringify(this.headers())) fail('SKILL_SESSION_CHANGED')
        const retry = this.unknownRetries.get(command.executionId)
        if (retry && this.now() < retry.nextAt) { deferred++; continue }
        try {
          await this.process(command); processed++
          this.unknownRetries.delete(command.executionId)
        } catch (error) {
          const code = error?.code
          if (typeof code !== 'string' || !/^(?:SKILL|MATERIALS|NATIVE|TYPED_INSPECTION)_[A-Z_]{1,80}$/.test(code)
              || /^(?:SKILL_SESSION_|SKILL_STORE_|SKILL_SCOPE_|SKILL_LANE_CONFIG_|SKILL_API_ORIGIN_)/.test(code)) throw error
          if (code === 'SKILL_RESULT_UNKNOWN') {
            const attempt = Math.min((retry?.attempt || 0) + 1, 6)
            // 15s -> 30s -> ... -> 5min, with downward jitter; no deadline.
            const delay = Math.floor(Math.min(300000, 15000 * 2 ** (attempt - 1)) * (0.8 + 0.2 * this.random()))
            this.unknownRetries.set(command.executionId, { attempt, nextAt: this.now() + delay })
          } else this.unknownRetries.delete(command.executionId)
          executionErrors.push({ executionId: command.executionId, code })
        }
      }
      // Command-local failures remain explicit without misreporting the entire lane as unavailable.
      // Shared/session/store and unknown exceptions still escape above with their original cause.
      const status = executionErrors.length ? 'PARTIAL' : processed ? 'PROGRESSED' : deferred ? 'DEFERRED' : 'IDLE'
      return { status, processed, deferred, executionErrors }
    } finally { this.active = false }
  }
  async process(command) {
    const path = `${BASE}/${command.taskId}/runs/${command.runId}/conversation`
    const store = new SkillExecutionStore({ rootDirectory: this.root, scope: { ...this.scope, apiOrigin: this.origin }, command })
    const executionAbort = new AbortController()
    let fence = null, expiry = 0, timer, expiryTimer, renewalPromise, renewalError, running = true, proof
    const checkLease = () => {
      if (renewalError || !fence || Date.now() >= expiry) fail('SKILL_LEASE_UNCERTAIN', renewalError)
      if (JSON.stringify(proof) !== JSON.stringify(this.headers())) fail('SKILL_SESSION_CHANGED')
    }
    const armLeaseExpiry = () => {
      clearTimeout(expiryTimer)
      expiryTimer = setTimeout(() => {
        renewalError = Object.assign(new Error('SKILL_LEASE_UNCERTAIN'), { code: 'SKILL_LEASE_UNCERTAIN' })
        executionAbort.abort(renewalError)
      }, Math.max(1, expiry - Date.now()))
    }
    const renew = async () => {
      try {
        const next = await this.request(`${path}/lease/renew`, 'POST', fence)
        if (!leaseValid(next, command) || next.version !== fence.version || next.token !== fence.token) fail('SKILL_LEASE_UNCERTAIN')
        expiry = next.expiresAt; armLeaseExpiry()
        if (running) timer = setTimeout(() => { renewalPromise = renew() }, Math.max(1, Math.floor((expiry - Date.now()) / 2)))
      } catch (error) { renewalError = error; executionAbort.abort(error) }
    }
    const common = () => ({ executionId: command.executionId, snapshotSha256: command.snapshotDigest, fence })
    let resume = null
    const ctx = {
      registry: this.registry,
      runNative: request => { if (typeof this.runNative !== 'function') fail('SKILL_NATIVE_ADAPTER_MISSING'); return this.runNative({ ...request, store, checkActive: checkLease, signal: executionAbort.signal }) },
      claimOrResume: async () => {
        const attempted = store.read('attempt')
        // Write before claim; lost lease reply must use resume, not a new claim.
        if (!attempted) store.write('attempt', { schemaVersion: 1, executionId: command.executionId })
        proof = this.headers()
        if (attempted) {
          resume = await this.request(`${path}/resume`, 'POST', { executionId: command.executionId, snapshotSha256: command.snapshotDigest })
          if (!object(resume) || !Array.isArray(resume.allowedWork)) fail('SKILL_RESUME_INVALID')
        }
        if (resume?.turnFailureCode != null && !engineTerminalCodes.has(resume.turnFailureCode)) fail('SKILL_RESUME_INVALID')
        const knownTerminal = store.read('engine-failure')
        if (knownTerminal && resume?.turnFailureCode && knownTerminal.code !== resume.turnFailureCode) fail('SKILL_ENGINE_TERMINAL_INVALID')
        if (resume?.phase === 'FAILED') {
          if (resume.lease != null || resume.resultManifest != null || resume.allowedWork.length) fail('SKILL_RESUME_INVALID')
          return { failureReceipt: await persistFailure(resume.turnFailureCode ?? null) }
        }
        const lease = resume ? resume.lease : await this.request(`${path}/lease`, 'POST', { commandId: command.commandId, messageId: command.messageId })
        if (!leaseValid(lease, command)) fail('SKILL_LEASE_UNCERTAIN')
        fence = { version: lease.version, token: lease.token }; expiry = lease.expiresAt; armLeaseExpiry()
        timer = setTimeout(() => { renewalPromise = renew() }, Math.max(1, Math.floor((expiry - Date.now()) / 2)))
        if (resume?.turnFailureCode) {
          if (resume.phase !== 'RESULT_UNKNOWN' || resume.resultManifest != null || resume.allowedWork.some(work => work !== 'QUERY_EFFECT')) fail('SKILL_RESUME_INVALID')
          store.write('engine-failure', { code: resume.turnFailureCode, fence: { ...fence } })
          return { failureReceipt: await reportEngineTerminal(store.read('engine-failure')) }
        }
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
        const materialized = []
        for (const input of inputs) {
          try {
            materialized.push(await store.materializeInput(input,
              () => this.readInput(path, command, fence, input, checkLease, executionAbort.signal), checkLease))
          } catch (cause) {
            checkLease()
            if (typeof cause?.code === 'string' && /^SKILL_/.test(cause.code)) throw cause
            fail('SKILL_INPUT_READ_UNCERTAIN', cause)
          }
        }
        return materialized
      },
      stageOutputs: async (_command, artifacts) => {
        for (const artifact of artifacts) {
          checkLease()
          const blob = store.verifyBlob(artifact.outputId, artifact), form = new FormData()
          form.set('file', await openAsBlob(blob.path, { type: artifact.contentMimeType }), artifact.outputId)
          for (const [key, value] of Object.entries({ version: String(fence.version), token: fence.token, sha256: artifact.sha256, byteLength: artifact.byteLength })) form.set(key, value)
          const staged = await this.request(`${path}/outputs/${artifact.outputId}/content`, 'POST', form, [200, 201])
          if (staged.outputId !== artifact.outputId || staged.sha256 !== artifact.sha256 || staged.byteLength !== artifact.byteLength
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
        const payload = { fence, snapshotSha256: command.snapshotDigest, data: preimage.data, artifacts: preimage.artifacts.map(item => ({ ...item, byteLength: String(item.byteLength) })), inputReceipts: preimage.inputReceipts, effectDependencies: preimage.effectDependencies }
        let receipt
        try { receipt = resultReceipt(await this.request(`${path}/result-commits/${manifestId}`, 'POST', payload)) } catch (original) {
          // Read back persistent server truth. Never restage or regenerate a committed result.
          let recovered
          try { recovered = await this.request(`${path}/resume`, 'POST', { executionId: command.executionId, snapshotSha256: command.snapshotDigest }) } catch { throw original }
          if (!recovered.resultManifest) throw original
          receipt = validateCommittedSkillResult(recovered.resultManifest, command, null, recovered.phase, manifest)
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
    const persistFailure = async (engineCode, failureCode = null) => {
      const saved = { executionId: command.executionId, state: 'FAILED', failureCode, engineCode }
      store.write('failure-receipt', saved)
      try { await this.onFailed(command, saved) } catch { store.write('cleanup-pending', { schemaVersion: 1, code: 'SKILL_CLEANUP_PENDING' }) }
      return saved
    }
    const reportEngineTerminal = async terminal => {
      if (!engineTerminalCodes.has(terminal.code) || !fenceValid(terminal.fence)) fail('SKILL_ENGINE_TERMINAL_INVALID')
      // The fact is stable; a resumed execution must report under the newly
      // authorized lease, never reuse a previous runtime instance's fence.
      checkLease()
      const receipt = await this.request(`${path}/failure`, 'POST', { fence: terminal.fence, code: terminal.code })
      if (!object(receipt) || receipt.executionId !== command.executionId || receipt.taskId !== command.taskId
          || receipt.runId !== command.runId || receipt.targetAgentId !== this.agentId
          || !['FAILED', 'QUEUED'].includes(receipt.state)) fail('SKILL_FAILURE_UNCONFIRMED')
      if (receipt.state === 'QUEUED') fail('SKILL_RESULT_UNKNOWN') // unresolved registered effects remain unknown
      if (receipt.failureCode !== 'AGENT_DELIVERY_FAILED') fail('SKILL_FAILURE_UNCONFIRMED')
      return persistFailure(terminal.code, receipt.failureCode)
    }
    try {
      const failureReceipt = store.read('failure-receipt')
      if (failureReceipt) return failureReceipt
      const terminal = store.read('engine-failure')
      if (terminal) {
        if (!engineTerminalCodes.has(terminal.code) || !fenceValid(terminal.fence)) fail('SKILL_ENGINE_TERMINAL_INVALID')
        const claim = await ctx.claimOrResume()
        if (claim.failureReceipt) return claim.failureReceipt
        if (claim.resultManifest) fail('SKILL_ENGINE_TERMINAL_INVALID')
        const rebound = { code: terminal.code, fence: { ...fence } }
        store.write('engine-failure', rebound)
        return await reportEngineTerminal(rebound)
      }
      try { return await executeSkill(command, ctx) } catch (error) {
        if (!engineTerminalCodes.has(error?.code) || !fence) throw error
        const terminal = { code: error.code, fence: { ...fence } }
        store.write('engine-failure', terminal)
        checkLease()
        return await reportEngineTerminal(terminal)
      }
    } finally { running = false; clearTimeout(timer); clearTimeout(expiryTimer); executionAbort.abort(); await renewalPromise }
  }
}
