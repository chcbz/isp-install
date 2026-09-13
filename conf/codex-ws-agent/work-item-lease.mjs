import { lstatSync, readFileSync } from 'node:fs'

const COMMAND_TYPE = 'WORK_ITEM_EXECUTE'
const REASSIGNMENT_REASON = 'lease_expired_reassignment'
const ACTION_TYPE = 'work_item_execute'
const REASSIGNMENT_BINDING_VERSION = 'e05-reassignment-v1'
const MAX_RESPONSE_BYTES = 32 * 1024
const MAX_LEASE_DURATION_MS = 900_000
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
// Prefixes do not establish canonical authority. The server validates the registry;
// locally bind the bounded wire ID byte-exactly to the authenticated profile/receipt.
const AGENT_ID_WIRE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const REASSIGNMENT_ID = /^rsn_[0-9a-f]{64}$/
const HALL_COMMAND_ID = /^cmd_hall_action_[0-9a-f]{64}$/
const POSITIVE_DECIMAL = /^(0|[1-9][0-9]*)$/
const JWT_COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const RESPONSE_FIELDS = new Set([
  'reassignmentId', 'commandId', 'taskId', 'workItemId', 'agentId', 'status',
  'leaseToken', 'leaseUntil', 'workItemVersion', 'attemptCount', 'maxAttempts', 'changedAt'
])
const REASSIGNMENT_PAYLOAD_FIELDS = new Set([
  'actionType', 'instruction', 'conversationType', 'reason', 'conversationId',
  'triggerEventId', 'autonomyLevel', 'requiresApproval', 'context'
])
const REASSIGNMENT_CONTEXT_FIELDS = new Set([
  'taskTitle', 'workItemTitle', 'requestSummary', 'reviewSummary', 'contextVersion',
  'referenceIds', 'tags', 'bindingVersion', 'reassignmentId'
])
const RESOLVED_BINDING_FIELDS = new Set([
  'bindingVersion', 'reassignmentId', 'sourceCommandId', 'expectedWorkItemVersion', 'targetAgentId'
])
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const WORK_ITEM_LEASE_FAILURE = Object.freeze({
  UNAVAILABLE: 'WORK_ITEM_LEASE_UNAVAILABLE',
  BINDING_UNAVAILABLE: 'WORK_ITEM_REASSIGNMENT_BINDING_UNAVAILABLE',
  AUTH_UNAVAILABLE: 'WORK_ITEM_LEASE_AUTH_UNAVAILABLE',
  COMMAND_INVALID: 'WORK_ITEM_LEASE_COMMAND_INVALID',
  TARGET_MISMATCH: 'WORK_ITEM_LEASE_TARGET_MISMATCH',
  SCOPE_MISMATCH: 'WORK_ITEM_LEASE_SCOPE_MISMATCH',
  SOURCE_COMMAND_INVALID: 'WORK_ITEM_SOURCE_COMMAND_INVALID',
  STALE: 'WORK_ITEM_LEASE_STALE',
  RESPONSE_INVALID: 'WORK_ITEM_LEASE_RESPONSE_INVALID'
})

export class WorkItemLeaseError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'WorkItemLeaseError'
    this.code = code
  }
}

const failure = (code, message, cause) => new WorkItemLeaseError(code, message, cause ? { cause } : {})

const exact = (value, pattern = SAFE_SCOPE) => typeof value === 'string' && value === value.trim() && pattern.test(value)
const exactKeys = (value, fields) => isObject(value)
  && Object.keys(value).length === fields.size
  && Object.keys(value).every(key => fields.has(key))
const validSurrogates = value => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}
const boundedContent = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && value === value.trim() && validSurrogates(value)
  && !/[\u0000-\u001f\u007f]/.test(value)
const nonSecretContent = (value, max) => {
  if (!boundedContent(value, max)) return false
  const lower = value.toLowerCase()
  return ![
    'authorization:', 'bearer ', 'x-api-key:', 'api-key:', 'apikey:', 'api_key=',
    'api-key=', 'apikey=', 'password=', 'password:', 'passwd=', 'token=', 'token:',
    'secret=', 'secret:', 'client_secret', 'access_token', 'refresh_token', 'private_key',
    'ssh-rsa ', '-----begin private key', '-----begin rsa private key'
  ].some(marker => lower.includes(marker))
}

const canonicalApiOrigin = wsUrl => {
  let endpoint
  try { endpoint = new URL(wsUrl) } catch {
    throw failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'configured WS_URL cannot establish the lease API origin')
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'configured WS_URL cannot establish the lease API origin')
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname)
  if (endpoint.protocol === 'ws:' && !loopback) {
    throw failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'command-bound lease API requires TLS except on explicit loopback')
  }
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.pathname = '/'
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint.origin
}

export const isReassignmentWorkItemCommand = message => (
  message?.commandType === COMMAND_TYPE
  && (message?.payload?.reason === REASSIGNMENT_REASON
    || message?.payload?.context?.tags?.includes?.('lease-expired')
    || message?.payload?.context?.tags?.includes?.('reassignment'))
)

const requireReassignmentMarkers = message => {
  const tags = message?.payload?.context?.tags
  if (message?.payload?.actionType !== ACTION_TYPE
      || message?.payload?.reason !== REASSIGNMENT_REASON
      || !Array.isArray(tags) || tags.length !== 2
      || !tags.includes('lease-expired') || !tags.includes('reassignment')) {
    throw failure(WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID,
      'reassignment command markers do not match the frozen command contract')
  }
}

const sourceCommandId = message => {
  const values = message?.payload?.context?.referenceIds
  if (!Array.isArray(values) || values.length !== 1 || !exact(values[0], HALL_COMMAND_ID)
      || values[0] === message.commandId) {
    throw failure(WORK_ITEM_LEASE_FAILURE.SOURCE_COMMAND_INVALID,
      'reassignment command must carry exactly one distinct source command reference')
  }
  return values[0]
}

const expectedVersion = message => {
  const value = message?.payload?.context?.contextVersion
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID,
      'reassignment command contextVersion must be a canonical non-negative work-item version')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed === Number.MAX_SAFE_INTEGER) {
    throw failure(WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID, 'reassignment work-item version is outside the safe range')
  }
  return parsed
}

export const resolveReassignmentCommandBinding = message => {
  const payload = message?.payload
  const context = payload?.context
  if (!exactKeys(payload, REASSIGNMENT_PAYLOAD_FIELDS)
      || !exactKeys(context, REASSIGNMENT_CONTEXT_FIELDS)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID,
      'reassignment command payload/context contains unknown or missing fields')
  }
  if (context.bindingVersion !== REASSIGNMENT_BINDING_VERSION
      || !exact(context.reassignmentId, REASSIGNMENT_ID)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.BINDING_UNAVAILABLE,
      'reassignment command lacks the exact supported command binding')
  }
  if (context.taskTitle !== null || !nonSecretContent(context.workItemTitle, 500)
      || context.requestSummary !== null || context.reviewSummary !== null
      || payload.conversationId !== null || !exact(payload.triggerEventId)
      || payload.autonomyLevel !== 'autonomous' || payload.requiresApproval !== false
      || payload.conversationType !== 'juyiting'
      || context.tags[0] !== 'lease-expired' || context.tags[1] !== 'reassignment'
      || !nonSecretContent(payload.instruction, 8_000)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID,
      'reassignment command context is outside the E05 non-secret allowlist')
  }
  const source = sourceCommandId(message)
  const version = expectedVersion(message)
  return Object.freeze({
    bindingVersion: context.bindingVersion,
    reassignmentId: context.reassignmentId,
    sourceCommandId: source,
    expectedWorkItemVersion: version,
    targetAgentId: message.targetAgentId
  })
}

export const readBearerTokenFile = path => {
  if (typeof path !== 'string' || !path || path !== path.trim()) {
    throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'configured lease bearer-token file is unavailable')
  }
  let status
  try { status = lstatSync(path) } catch (error) {
    throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'configured lease bearer-token file is unavailable', error)
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0
      || (currentUid !== null && status.uid !== currentUid)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE,
      'lease bearer-token file must be a current-user-owned regular file with no group/other permissions')
  }
  let token
  try { token = readFileSync(path, 'utf8').trim() } catch (error) {
    throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'configured lease bearer-token file cannot be read', error)
  }
  if (token.length > 8192 || !JWT_COMPACT.test(token)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE,
      'lease bearer-token file does not contain one compact JWT')
  }
  return token
}

const awaitWithSignal = async (operation, signal) => {
  if (!signal) return operation
  if (signal.aborted) {
    Promise.resolve(operation).catch(() => {})
    throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'runtime authentication was invalidated')
  }
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'runtime authentication was invalidated'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation, aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

const cancelResponse = response => {
  try { void response?.body?.cancel?.().catch(() => {}) } catch {}
}

const responseBytes = async (response, signal) => {
  const declared = response?.headers?.get?.('content-length')
  if (declared && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    cancelResponse(response)
    throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API response exceeds the bounded response size')
  }
  let bytes
  if (response?.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    const abort = () => { try { void reader.cancel().catch(() => {}) } catch {} }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        const { value, done } = await awaitWithSignal(reader.read(), signal)
        if (done) break
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > MAX_RESPONSE_BYTES) {
          throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API response exceeds the bounded response size')
        }
        chunks.push(Buffer.from(value))
      }
      bytes = Buffer.concat(chunks, size)
    } catch (error) { abort(); throw error }
    finally { signal?.removeEventListener('abort', abort); reader.releaseLock() }
  } else if (declared && typeof response?.arrayBuffer === 'function') {
    // Compatibility with existing bounded offline transports, not an unbounded chunked fallback.
    bytes = Buffer.from(await awaitWithSignal(response.arrayBuffer(), signal))
  } else throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API response body is unavailable')
  if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES || (declared && Number(declared) !== bytes.length)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API response is empty or oversized')
  }
  return bytes
}

const validateLeaseResponse = (body, binding, previous = null) => {
  if (!isObject(body) || Object.keys(body).some(key => !RESPONSE_FIELDS.has(key))) {
    throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API returned an unexpected response shape')
  }
  for (const [field, expected] of [
    ['reassignmentId', binding.reassignmentId], ['commandId', binding.commandId],
    ['taskId', binding.taskId], ['workItemId', binding.workItemId], ['agentId', binding.targetAgentId]
  ]) {
    if (body[field] !== expected) throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, `lease API ${field} binding changed`)
  }
  if (!['claimed', 'running'].includes(body.status) || !exact(body.leaseToken)
      || !Number.isSafeInteger(body.leaseUntil) || body.leaseUntil <= 0
      || !Number.isSafeInteger(body.workItemVersion) || body.workItemVersion < 0
      || !Number.isSafeInteger(body.attemptCount) || body.attemptCount < 0
      || !Number.isSafeInteger(body.maxAttempts) || body.maxAttempts <= body.attemptCount
      || !Number.isSafeInteger(body.changedAt) || body.changedAt <= 0) {
    throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API returned invalid lease state')
  }
  if (previous && (body.leaseToken !== previous.leaseToken
      || body.workItemVersion < previous.workItemVersion
      || body.workItemVersion > previous.workItemVersion + 1)) {
    throw failure(WORK_ITEM_LEASE_FAILURE.STALE, 'lease fence or work-item version changed unexpectedly')
  }
  return Object.freeze({ ...body })
}

export class CommandBoundLeaseApi {
  constructor({ wsUrl, tokenProvider, runtimeCredentialProvider = null, fetchFn = globalThis.fetch }) {
    this.origin = canonicalApiOrigin(wsUrl)
    this.tokenProvider = tokenProvider
    this.runtimeCredentialProvider = runtimeCredentialProvider
    this.fetchFn = fetchFn
  }

  async read(binding) { return this.#request(binding, 'read') }
  async start(binding) { return this.#request(binding, 'start') }
  async heartbeat(binding, leaseDurationMillis) { return this.#request(binding, 'heartbeat', leaseDurationMillis) }

  async #request(binding, operation, leaseDurationMillis = null) {
    if (typeof this.fetchFn !== 'function' || (!this.runtimeCredentialProvider && typeof this.tokenProvider !== 'function')) {
      throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'authenticated lease transport is unavailable')
    }
    let token
    let runtime
    try {
      runtime = this.runtimeCredentialProvider?.()
      token = this.runtimeCredentialProvider ? runtime?.token : await this.tokenProvider()
    } catch (error) {
      if (error instanceof WorkItemLeaseError) throw error
      throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'authenticated lease credential is unavailable', error)
    }
    if (this.runtimeCredentialProvider && (!runtime || runtime.signal?.aborted
        || runtime.scheme !== 'native-runtime-v1' || !/^[0-9a-f]{32}$/.test(token)
        || runtime.agentId !== binding.targetAgentId || runtime.runtimeInstanceId !== binding.runtimeInstanceId
        || runtime.tenantId !== binding.tenantId || runtime.clientId !== binding.clientId)) {
      throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'runtime authentication is unavailable')
    }
    if (!runtime && (typeof token !== 'string' || !JWT_COMPACT.test(token) || token.length > 8192)) {
      throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'authenticated lease credential is unavailable')
    }
    const suffix = operation === 'read' ? 'lease' : `lease/${operation}`
    const encoded = [binding.taskId, binding.workItemId, binding.reassignmentId].map(encodeURIComponent)
    const endpoint = new URL(`/agent/tasks/${encoded[0]}/work-items/${encoded[1]}/reassignments/${encoded[2]}/${suffix}`, this.origin)
    endpoint.searchParams.set('actorAgentId', binding.targetAgentId)
    const body = {
      commandId: binding.commandId,
      expectedWorkItemVersion: binding.expectedWorkItemVersion,
      ...(operation === 'heartbeat' ? { leaseDurationMillis } : {})
    }
    let response
    try {
      response = await awaitWithSignal(this.fetchFn(endpoint, {
        method: 'POST', redirect: 'error',
        headers: {
          ...(runtime ? { Authorization: `AgentRuntime ${token}`, 'X-Agent-Id': runtime.agentId,
            'X-Agent-Runtime-Id': runtime.runtimeInstanceId } : { Authorization: `Bearer ${token}` }),
          Accept: 'application/json', 'Content-Type': 'application/json'
        },
        ...(runtime ? { signal: runtime.signal, cache: 'no-store', credentials: 'omit' } : {}),
        body: JSON.stringify(body)
      }), runtime?.signal)
    } catch (error) {
      throw failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'command-bound lease API transport failed without retry', error)
    }
    if ([401, 403].includes(response.status)) {
      cancelResponse(response)
      runtime?.invalidate()
      throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'command-bound lease authentication was rejected')
    }
    if (response.redirected === true || (response.url && response.url !== endpoint.toString())
        || (response.status >= 300 && response.status < 400)) {
      cancelResponse(response)
      throw failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'command-bound lease API redirect or origin change was rejected')
    }
    if (response.status !== 200) {
      cancelResponse(response)
      if (response.status === 404 || response.status === 409) {
        throw failure(WORK_ITEM_LEASE_FAILURE.STALE, 'command-bound lease was rejected as stale or unavailable')
      }
      throw failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'command-bound lease API is unavailable without retry')
    }
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase()
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
      cancelResponse(response)
      throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API response content type is not JSON')
    }
    const bytes = await responseBytes(response, runtime?.signal)
    if (runtime && (runtime.signal.aborted || this.runtimeCredentialProvider() !== runtime)) {
      throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'runtime authentication is unavailable')
    }
    let parsed
    try { parsed = JSON.parse(bytes.toString('utf8')) } catch {
      throw failure(WORK_ITEM_LEASE_FAILURE.RESPONSE_INVALID, 'lease API response is not valid JSON')
    }
    return validateLeaseResponse(parsed, binding)
  }
}

export class ReassignmentWorkItemLease {
  constructor({
    profile, runtimeInstanceId, tenantId = '', clientId = '', subjectAgentId = '',
    bearerTokenFile = '', leaseDurationMillis = 0, wsUrl,
    fetchFn = globalThis.fetch, tokenProvider = null, runtimeCredentialProvider = null,
    bindingResolver = resolveReassignmentCommandBinding,
    schedule = (callback, delay) => setTimeout(callback, delay), cancel = handle => clearTimeout(handle),
    now = () => Date.now()
  }) {
    this.profile = profile
    this.runtimeInstanceId = runtimeInstanceId
    this.runtimeCredentialProvider = runtimeCredentialProvider
    this.tenantId = tenantId
    this.clientId = clientId
    this.subjectAgentId = subjectAgentId
    this.leaseDurationMillis = Number(leaseDurationMillis)
    this.bindingResolver = bindingResolver
    this.schedule = schedule
    this.cancel = cancel
    this.now = now
    const provider = tokenProvider || (bearerTokenFile ? () => readBearerTokenFile(bearerTokenFile) : null)
    if (runtimeCredentialProvider && provider) throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE, 'ambiguous authentication configuration')
    this.api = new CommandBoundLeaseApi({ wsUrl, tokenProvider: provider, runtimeCredentialProvider, fetchFn })
    this.configured = Boolean(provider && exact(tenantId) && exact(clientId)
      && exact(subjectAgentId, AGENT_ID_WIRE) && subjectAgentId === profile?.agentId
      && exact(runtimeInstanceId) && Number.isSafeInteger(this.leaseDurationMillis)
      && this.leaseDurationMillis > 0 && this.leaseDurationMillis <= MAX_LEASE_DURATION_MS)
  }

  preflight(message) {
    if (!isReassignmentWorkItemCommand(message)) return null
    requireReassignmentMarkers(message)
    const runtime = this.runtimeCredentialProvider?.()
    const runtimeConfigured = runtime && runtime.scheme === 'native-runtime-v1'
      && !runtime.signal?.aborted && runtime.runtimeInstanceId === this.runtimeInstanceId
      && runtime.agentId === this.profile.agentId && exact(runtime.agentId, AGENT_ID_WIRE)
      && exact(runtime.tenantId) && exact(runtime.clientId)
      && this.leaseDurationMillis > 0 && this.leaseDurationMillis <= MAX_LEASE_DURATION_MS
    if (this.runtimeCredentialProvider ? !runtimeConfigured : !this.configured) {
      throw failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE,
        'reassignment execution is unavailable: no authenticated target runtime or private JWT configuration')
    }
    if (!exact(message.commandId) || !exact(message.taskId) || !exact(message.workItemId)
        || !exact(message.targetAgentId, AGENT_ID_WIRE)) {
      throw failure(WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID, 'reassignment command identity is invalid')
    }
    if (message.targetAgentId !== this.profile.agentId || message.targetAgentId !== (runtime?.agentId || this.subjectAgentId)) {
      runtime?.invalidate()
      throw failure(WORK_ITEM_LEASE_FAILURE.TARGET_MISMATCH, 'reassignment command target is not this authenticated Agent')
    }
    if (message.tenantId !== (runtime?.tenantId || this.tenantId) || message.clientId !== (runtime?.clientId || this.clientId)) {
      runtime?.invalidate()
      throw failure(WORK_ITEM_LEASE_FAILURE.SCOPE_MISMATCH, 'reassignment command tenant/client differs from authenticated configuration')
    }
    const source = sourceCommandId(message)
    const version = expectedVersion(message)
    const resolved = this.bindingResolver(message)
    if (!exactKeys(resolved, RESOLVED_BINDING_FIELDS)
        || resolved.bindingVersion !== REASSIGNMENT_BINDING_VERSION
        || !exact(resolved.reassignmentId, REASSIGNMENT_ID)) {
      throw failure(WORK_ITEM_LEASE_FAILURE.BINDING_UNAVAILABLE,
        'reassignmentId is not present in the verified E05 command context')
    }
    if (resolved.sourceCommandId !== source) {
      throw failure(WORK_ITEM_LEASE_FAILURE.SOURCE_COMMAND_INVALID, 'trusted reassignment binding changed source command identity')
    }
    if (resolved.expectedWorkItemVersion !== version) {
      throw failure(WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID, 'trusted reassignment binding changed work-item version')
    }
    if (resolved.targetAgentId !== message.targetAgentId) {
      throw failure(WORK_ITEM_LEASE_FAILURE.TARGET_MISMATCH, 'trusted reassignment binding changed target Agent identity')
    }
    return Object.freeze({
      reassignmentId: resolved.reassignmentId,
      sourceCommandId: source,
      commandId: message.commandId,
      taskId: message.taskId,
      workItemId: message.workItemId,
      targetAgentId: message.targetAgentId,
      expectedWorkItemVersion: version,
      runtimeInstanceId: this.runtimeInstanceId,
      ...(runtime ? { tenantId: runtime.tenantId, clientId: runtime.clientId } : {})
    })
  }

  async execute(message, run) {
    const binding = this.preflight(message)
    if (!binding) return run({ signal: undefined })
    const abort = new AbortController()
    const runtime = this.runtimeCredentialProvider?.()
    let heartbeatTimer = null
    let expiryTimer = null
    let heartbeatPromise = null
    let heartbeatFailure = null
    let current = null
    let stopped = false
    const stopTimers = () => {
      if (heartbeatTimer !== null) this.cancel(heartbeatTimer)
      if (expiryTimer !== null) this.cancel(expiryTimer)
      heartbeatTimer = null
      expiryTimer = null
    }
    const failLease = error => {
      if (heartbeatFailure) return
      heartbeatFailure = error instanceof WorkItemLeaseError
        ? error : failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'command-bound heartbeat failed without retry', error)
      stopTimers()
      abort.abort(heartbeatFailure)
    }
    const scheduleHeartbeat = () => {
      if (stopped || heartbeatFailure) return
      heartbeatTimer = this.schedule(() => heartbeat(), Math.max(1, Math.floor(this.leaseDurationMillis / 3)))
    }
    const armLeaseExpiry = () => {
      if (stopped || heartbeatFailure) return
      if (expiryTimer !== null) this.cancel(expiryTimer)
      expiryTimer = null
      const remaining = current?.leaseUntil - Number(this.now())
      if (!Number.isFinite(remaining) || remaining <= 0) {
        failLease(failure(WORK_ITEM_LEASE_FAILURE.STALE,
          'command-bound running lease expired before execution could remain fenced'))
        return
      }
      expiryTimer = this.schedule(() => failLease(failure(WORK_ITEM_LEASE_FAILURE.STALE,
        'command-bound running lease expired while execution outcome remained unconfirmed')), Math.max(1, Math.floor(remaining)))
    }
    const heartbeat = () => {
      heartbeatTimer = null
      if (stopped || heartbeatFailure) return Promise.resolve()
      heartbeatPromise = (async () => {
        try {
          const nextBinding = { ...binding, expectedWorkItemVersion: current.workItemVersion }
          const next = await this.api.heartbeat(nextBinding, this.leaseDurationMillis)
          const previous = current
          current = validateLeaseResponse(next, binding, previous)
          const unchanged = current.workItemVersion === previous.workItemVersion
            && current.leaseUntil === previous.leaseUntil
          const extended = current.workItemVersion === previous.workItemVersion + 1
            && current.leaseUntil > previous.leaseUntil
          if (current.status !== 'running' || (!unchanged && !extended)) {
            throw failure(WORK_ITEM_LEASE_FAILURE.STALE,
              'heartbeat changed the running lease outside the frozen version/expiry transition')
          }
          scheduleHeartbeat()
          armLeaseExpiry()
        } catch (error) { failLease(error) }
      })()
      return heartbeatPromise.finally(() => { heartbeatPromise = null })
    }
    const onRuntimeAbort = () => failLease(failure(WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE,
      'runtime authentication was invalidated'))
    if (runtime?.signal.aborted) onRuntimeAbort()
    else runtime?.signal.addEventListener('abort', onRuntimeAbort, { once: true })
    try {
      if (heartbeatFailure) throw heartbeatFailure
      const read = validateLeaseResponse(await this.api.read(binding), binding)
      if (read.status !== 'claimed' || read.workItemVersion !== binding.expectedWorkItemVersion) {
        throw failure(WORK_ITEM_LEASE_FAILURE.STALE, 'command-bound lease is not the expected fresh claimed version')
      }
      if (heartbeatFailure) throw heartbeatFailure
      const startBinding = { ...binding, expectedWorkItemVersion: read.workItemVersion }
      const started = validateLeaseResponse(await this.api.start(startBinding), binding, read)
      if (started.status !== 'running' || started.workItemVersion !== read.workItemVersion + 1) {
        throw failure(WORK_ITEM_LEASE_FAILURE.STALE, 'lease start did not produce the exact next running version')
      }
      if (heartbeatFailure) throw heartbeatFailure
      current = started
      await heartbeat()
      if (heartbeatFailure) throw heartbeatFailure
      const outcome = await run({ signal: abort.signal })
      stopped = true
      stopTimers()
      if (heartbeatFailure) {
        return { status: 'recovery_required', errorMessage: `${heartbeatFailure.code}: ${heartbeatFailure.message}` }
      }
      return outcome
    } catch (error) {
      const known = error instanceof WorkItemLeaseError
        ? error : failure(WORK_ITEM_LEASE_FAILURE.UNAVAILABLE, 'command-bound lease execution is unavailable without retry', error)
      return { status: 'recovery_required', errorMessage: `${known.code}: ${known.message}` }
    } finally {
      runtime?.signal.removeEventListener('abort', onRuntimeAbort)
      stopped = true
      stopTimers()
    }
  }
}
