import { createHash } from 'node:crypto'

import { readBearerTokenFile } from './work-item-lease.mjs'

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_TEXT_BYTES = 2048
const MAX_MEMBERS = 100
const MAX_WORK_ITEMS = 25
const MAX_ARTIFACTS = 50
const MAX_REQUESTS = 25
const MAX_EVENTS = 100
const MAX_DEPENDENCIES = 25
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const LONG_MAX = 9223372036854775807n
const INT_MIN = -2147483648
const INT_MAX = 2147483647
const JWT_COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const DIGEST = /^[0-9a-f]{64}$/
const REASON = /^[A-Z0-9_]{1,80}$/
const SENSITIVE = /authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:https?|mysql|postgres(?:ql)?):\/\/[^\s/:]+:[^\s/@]+@|\bsk-[A-Za-z0-9_-]{12,}/i
const REDACTED_TEXT = '[REDACTED_SENSITIVE_TEXT]'
const SECTION_STATUSES = new Set(['AVAILABLE', 'TRUNCATED', 'UNAVAILABLE'])
const VISIBILITIES = new Set(['task_members', 'reviewer', 'private'])
const TOP_LEVEL_FIELDS = [
  'schemaVersion', 'provenance', 'taskDescription', 'members', 'workItems',
  'authoritativeArtifacts', 'openRequests', 'recentEvents', 'conversation',
  'digestAlgorithm', 'digest'
]
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const TASK_CONTEXT_PACK_FAILURE = Object.freeze({
  AUTH_UNAVAILABLE: 'TASK_CONTEXT_PACK_AUTH_UNAVAILABLE',
  REQUEST_INVALID: 'TASK_CONTEXT_PACK_REQUEST_INVALID',
  SCOPE_MISMATCH: 'TASK_CONTEXT_PACK_SCOPE_MISMATCH',
  NOT_FOUND: 'TASK_CONTEXT_PACK_NOT_FOUND',
  STALE: 'TASK_CONTEXT_PACK_STALE',
  UNAVAILABLE: 'TASK_CONTEXT_PACK_UNAVAILABLE',
  RESPONSE_INVALID: 'TASK_CONTEXT_PACK_RESPONSE_INVALID',
  RESPONSE_TOO_LARGE: 'TASK_CONTEXT_PACK_RESPONSE_TOO_LARGE',
  ABORTED: 'TASK_CONTEXT_PACK_ABORTED',
  TIMEOUT: 'TASK_CONTEXT_PACK_TIMEOUT'
})

export class TaskContextPackError extends Error {
  constructor(code) {
    super(code)
    this.name = 'TaskContextPackError'
    this.code = code
  }
}

const failure = code => new TaskContextPackError(code)
const invalidResponse = () => { throw failure(TASK_CONTEXT_PACK_FAILURE.RESPONSE_INVALID) }

const hasUnpairedSurrogate = value => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}

const isExactText = (value, maxCodePoints = 100) => (
  typeof value === 'string'
  && value.length > 0
  && !hasUnpairedSurrogate(value)
  && [...value].length <= maxCodePoints
  && !/^\p{White_Space}|\p{White_Space}$/u.test(value)
  && !/\p{Cc}/u.test(value)
)

const requireExactText = (value, maxCodePoints = 100) => {
  if (!isExactText(value, maxCodePoints)) invalidResponse()
  return value
}

const isCanonicalDecimal = (value, positive = false) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 19) return false
  try {
    const parsed = BigInt(value)
    return parsed <= LONG_MAX && (!positive || parsed > 0n)
  } catch { return false }
}

const requireDecimal = (value, positive = false) => {
  if (!isCanonicalDecimal(value, positive)) invalidResponse()
  return value
}

const requireInt = (value, { nullable = false, min = INT_MIN, max = INT_MAX } = {}) => {
  if (nullable && value === null) return value
  if (!Number.isInteger(value) || value < min || value > max) invalidResponse()
  return value
}

const requireBoolean = value => {
  if (typeof value !== 'boolean') invalidResponse()
  return value
}

const requireKeys = (value, required, optional = []) => {
  if (!isObject(value)) invalidResponse()
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalidResponse()
  return value
}

const requireArray = (value, max) => {
  if (!Array.isArray(value) || value.length > max) invalidResponse()
  return value
}


const validateSafeText = value => {
  requireKeys(value, ['value', 'redacted', 'truncated'])
  requireBoolean(value.redacted)
  requireBoolean(value.truncated)
  if (value.value !== null && typeof value.value !== 'string') invalidResponse()
  if (typeof value.value === 'string') {
    if (hasUnpairedSurrogate(value.value) || /\p{Cc}/u.test(value.value)
        || Buffer.byteLength(value.value, 'utf8') > MAX_TEXT_BYTES) invalidResponse()
  }
  if (value.redacted) {
    if (value.value !== REDACTED_TEXT || value.truncated) invalidResponse()
  } else if (typeof value.value === 'string' && SENSITIVE.test(value.value)) invalidResponse()
  if (value.value === null && (value.redacted || value.truncated)) invalidResponse()
}

const validateSectionBase = (section, required, optional = []) => {
  requireKeys(section, [...required, 'status', 'truncated'], [...optional, 'reason'])
  if (!SECTION_STATUSES.has(section.status)) invalidResponse()
  requireBoolean(section.truncated)
  if (section.status === 'AVAILABLE' && section.truncated) invalidResponse()
  if (section.status === 'TRUNCATED' && !section.truncated) invalidResponse()
  if (section.status === 'UNAVAILABLE' && (!hasOwn(section, 'reason') || section.truncated)) invalidResponse()
  if (hasOwn(section, 'reason') && (typeof section.reason !== 'string' || !REASON.test(section.reason))) invalidResponse()
}

const validateTaskDescription = section => {
  validateSectionBase(section, [], ['title', 'description'])
  if (section.status === 'UNAVAILABLE') {
    if (hasOwn(section, 'title') || hasOwn(section, 'description')) invalidResponse()
    return
  }
  if (!hasOwn(section, 'title') || !hasOwn(section, 'description')) invalidResponse()
  validateSafeText(section.title)
  validateSafeText(section.description)
}

const validateMembers = section => {
  validateSectionBase(section, ['items'])
  const items = requireArray(section.items, MAX_MEMBERS)
  for (const item of items) {
    requireKeys(item, ['agentId', 'role', 'status', 'version'])
    requireExactText(item.agentId)
    requireExactText(item.role)
    requireExactText(item.status)
    requireDecimal(item.version)
  }
  if (section.reason === 'MEMBER_LIMIT_REACHED' && items.length !== MAX_MEMBERS) invalidResponse()
}

const validateWorkItems = section => {
  validateSectionBase(section, ['items'])
  const items = requireArray(section.items, MAX_WORK_ITEMS)
  for (const item of items) {
    requireKeys(item, [
      'workItemId', 'title', 'workType', 'status', 'priority', 'requiredItem',
      'dependencyIds', 'dependenciesTruncated', 'version'
    ], ['description', 'assigneeAgentId'])
    requireExactText(item.workItemId)
    validateSafeText(item.title)
    if (hasOwn(item, 'description')) validateSafeText(item.description)
    requireExactText(item.workType)
    if (hasOwn(item, 'assigneeAgentId')) requireExactText(item.assigneeAgentId)
    requireExactText(item.status)
    requireInt(item.priority, { nullable: true })
    if (item.requiredItem !== null) requireBoolean(item.requiredItem)
    const dependencies = requireArray(item.dependencyIds, MAX_DEPENDENCIES)
    const unique = new Set()
    for (const dependency of dependencies) {
      requireExactText(dependency)
      if (unique.has(dependency)) invalidResponse()
      unique.add(dependency)
    }
    requireBoolean(item.dependenciesTruncated)
    requireDecimal(item.version)
    if (item.dependenciesTruncated && !section.truncated) invalidResponse()
  }
  if (section.reason === 'WORK_ITEM_LIMIT_REACHED' && items.length !== MAX_WORK_ITEMS) invalidResponse()
  if (section.status === 'UNAVAILABLE' && items.length !== 0) invalidResponse()
}

const validateArtifacts = section => {
  validateSectionBase(section, ['items'])
  const items = requireArray(section.items, MAX_ARTIFACTS)
  for (const item of items) {
    requireKeys(item, [
      'artifactId', 'producerAgentId', 'artifactType', 'title', 'contentHash',
      'artifactVersion', 'visibility', 'createdAt', 'outcomeState', 'outcomeVersion',
      'decisionId', 'decidedByAgentId', 'decidedAt'
    ], ['workItemId'])
    requireExactText(item.artifactId)
    if (hasOwn(item, 'workItemId')) requireExactText(item.workItemId)
    requireExactText(item.producerAgentId)
    requireExactText(item.artifactType)
    validateSafeText(item.title)
    if (typeof item.contentHash !== 'string' || !DIGEST.test(item.contentHash)) invalidResponse()
    requireDecimal(item.artifactVersion, true)
    if (!VISIBILITIES.has(item.visibility)) invalidResponse()
    requireDecimal(item.createdAt)
    if (item.outcomeState !== 'accepted') invalidResponse()
    requireDecimal(item.outcomeVersion, true)
    requireExactText(item.decisionId)
    requireExactText(item.decidedByAgentId)
    requireDecimal(item.decidedAt)
  }
  if (section.reason === 'AUTHORITATIVE_ARTIFACT_LIMIT_REACHED' && items.length !== MAX_ARTIFACTS) invalidResponse()
}

const validateRequests = section => {
  validateSectionBase(section, ['items'])
  const items = requireArray(section.items, MAX_REQUESTS)
  for (const item of items) {
    requireKeys(item, [
      'requestId', 'requesterAgentId', 'targetType', 'targetId', 'requestType',
      'status', 'priority', 'title', 'description', 'version'
    ], ['workItemId', 'dueAt'])
    requireExactText(item.requestId)
    if (hasOwn(item, 'workItemId')) requireExactText(item.workItemId)
    requireExactText(item.requesterAgentId)
    requireExactText(item.targetType)
    requireExactText(item.targetId)
    requireExactText(item.requestType)
    requireExactText(item.status)
    requireInt(item.priority, { nullable: true })
    validateSafeText(item.title)
    validateSafeText(item.description)
    if (hasOwn(item, 'dueAt')) requireDecimal(item.dueAt)
    requireDecimal(item.version)
  }
  if (section.reason === 'REQUEST_LIMIT_REACHED' && items.length !== MAX_REQUESTS) invalidResponse()
}

const validateEvents = section => {
  validateSectionBase(section, ['items'])
  const items = requireArray(section.items, MAX_EVENTS)
  let previous = -1n
  for (const item of items) {
    requireKeys(item, ['version', 'redacted'], [
      'eventType', 'actorType', 'actorId', 'aggregateType', 'aggregateId', 'occurredAt'
    ])
    requireDecimal(item.version, true)
    requireBoolean(item.redacted)
    const current = BigInt(item.version)
    if (current <= previous) invalidResponse()
    previous = current
    if (item.redacted) {
      if (Object.keys(item).length !== 2) invalidResponse()
    } else {
      for (const field of ['eventType', 'actorType', 'aggregateType', 'aggregateId', 'occurredAt']) {
        if (!hasOwn(item, field)) invalidResponse()
      }
      requireExactText(item.eventType)
      requireExactText(item.actorType)
      if (hasOwn(item, 'actorId')) requireExactText(item.actorId)
      requireExactText(item.aggregateType)
      requireExactText(item.aggregateId)
      requireDecimal(item.occurredAt, true)
    }
  }
}

const validateConversation = section => {
  validateSectionBase(section, ['contentOmitted'], ['conversationId', 'recentMessageCount', 'latestMessageAt'])
  if (section.contentOmitted !== true) invalidResponse()
  if (section.status === 'UNAVAILABLE') {
    if (hasOwn(section, 'conversationId') || hasOwn(section, 'recentMessageCount') || hasOwn(section, 'latestMessageAt')) invalidResponse()
    return
  }
  if (!hasOwn(section, 'conversationId') || !hasOwn(section, 'recentMessageCount')) invalidResponse()
  requireExactText(section.conversationId)
  requireInt(section.recentMessageCount, { min: 0 })
  if (hasOwn(section, 'latestMessageAt')) requireDecimal(section.latestMessageAt)
}

export const computeTaskContextPackDigest = pack => {
  if (!isObject(pack) || !hasOwn(pack, 'digest')) throw failure(TASK_CONTEXT_PACK_FAILURE.RESPONSE_INVALID)
  const canonical = { ...pack, digest: null }
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

const validatePack = (pack, scope, taskId, expectedVersion) => {
  requireKeys(pack, TOP_LEVEL_FIELDS)
  if (pack.schemaVersion !== 'f01-context-pack-v1' || pack.digestAlgorithm !== 'SHA-256'
      || typeof pack.digest !== 'string' || !DIGEST.test(pack.digest)) invalidResponse()
  requireKeys(pack.provenance, [
    'tenantId', 'clientId', 'taskId', 'actorAgentId', 'taskVersion', 'currentEventVersion'
  ])
  if (pack.provenance.tenantId !== scope.tenantId
      || pack.provenance.clientId !== scope.clientId
      || pack.provenance.taskId !== taskId
      || pack.provenance.actorAgentId !== scope.actorAgentId) {
    throw failure(TASK_CONTEXT_PACK_FAILURE.SCOPE_MISMATCH)
  }
  requireDecimal(pack.provenance.taskVersion)
  requireDecimal(pack.provenance.currentEventVersion)
  if (expectedVersion !== null && pack.provenance.currentEventVersion !== expectedVersion) {
    throw failure(TASK_CONTEXT_PACK_FAILURE.STALE)
  }
  validateTaskDescription(pack.taskDescription)
  validateMembers(pack.members)
  validateWorkItems(pack.workItems)
  validateArtifacts(pack.authoritativeArtifacts)
  validateRequests(pack.openRequests)
  validateEvents(pack.recentEvents)
  validateConversation(pack.conversation)
  if (computeTaskContextPackDigest(pack) !== pack.digest) invalidResponse()
  return pack
}

const isLoopback = hostname => {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  return Boolean(match && match.slice(1).every(value => Number(value) <= 255) && Number(match[1]) === 127)
}

const canonicalApiOrigin = wsUrl => {
  let endpoint
  try { endpoint = new URL(wsUrl) } catch { throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID) }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
  }
  if (endpoint.protocol === 'ws:' && !isLoopback(endpoint.hostname)) {
    throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
  }
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.pathname = '/'
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint.origin
}

const encodePathSegment = value => encodeURIComponent(value).replace(/[!'()*]/g,
  character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

const requestBinding = binding => {
  requireKeys(binding, ['tenantId', 'clientId', 'taskId', 'actorAgentId'], ['expectedVersion'])
  for (const [field, limit] of [['tenantId', 50], ['clientId', 50], ['taskId', 100], ['actorAgentId', 100]]) {
    if (!isExactText(binding[field], limit)) throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
  }
  if (binding.taskId === '.' || binding.taskId === '..') throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
  const expectedVersion = hasOwn(binding, 'expectedVersion') && binding.expectedVersion !== null
    ? binding.expectedVersion : null
  if (expectedVersion !== null && !isCanonicalDecimal(expectedVersion)) {
    throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
  }
  return Object.freeze({
    tenantId: binding.tenantId,
    clientId: binding.clientId,
    taskId: binding.taskId,
    actorAgentId: binding.actorAgentId,
    expectedVersion
  })
}

const decodeJwtScope = token => {
  if (typeof token !== 'string' || token.length > 8192 || !JWT_COMPACT.test(token)) {
    throw failure(TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE)
  }
  const payloadSegment = token.split('.')[1]
  let payloadBytes
  try {
    payloadBytes = Buffer.from(payloadSegment, 'base64url')
    if (payloadBytes.toString('base64url') !== payloadSegment) throw new Error('noncanonical')
  } catch { throw failure(TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE) }
  let claims
  try {
    const payloadText = payloadBytes.toString('utf8')
    if (!Buffer.from(payloadText, 'utf8').equals(payloadBytes)) throw new Error('invalid utf8')
    claims = JSON.parse(payloadText)
  } catch {
    throw failure(TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE)
  }
  if (!isObject(claims)
      || !isExactText(claims.jiacn, 50)
      || !isExactText(claims.client_id, 50)
      || !isExactText(claims.sub, 100)) {
    throw failure(TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE)
  }
  return Object.freeze({ tenantId: claims.jiacn, clientId: claims.client_id, actorAgentId: claims.sub })
}

const headerValue = (response, name) => {
  try { return response?.headers?.get?.(name) ?? null } catch { return null }
}

const requireResponseEnvelope = (response, endpoint) => {
  if (!response || !Number.isInteger(response.status) || typeof response.url !== 'string'
      || response.redirected === true || response.url !== endpoint.href
      || (response.status >= 300 && response.status < 400)) invalidResponse()
  const cacheDirectives = String(headerValue(response, 'cache-control') || '')
    .split(',').map(value => value.trim().toLowerCase())
  if (!cacheDirectives.includes('no-store')) invalidResponse()
  const contentType = String(headerValue(response, 'content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) invalidResponse()
}

const cancelBody = response => {
  try {
    if (typeof response?.body?.cancel === 'function') void response.body.cancel()
    else if (typeof response?.body?.destroy === 'function') response.body.destroy()
  } catch {}
}

const mapHttpFailure = response => {
  cancelBody(response)
  if (response.status === 401 || response.status === 403) throw failure(TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE)
  if (response.status === 404) throw failure(TASK_CONTEXT_PACK_FAILURE.NOT_FOUND)
  if (response.status === 409) throw failure(TASK_CONTEXT_PACK_FAILURE.STALE)
  throw failure(TASK_CONTEXT_PACK_FAILURE.UNAVAILABLE)
}

const declaredLength = response => {
  const value = headerValue(response, 'content-length')
  if (value === null || value === '') return null
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalidResponse()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw failure(TASK_CONTEXT_PACK_FAILURE.RESPONSE_TOO_LARGE)
  if (parsed > MAX_RESPONSE_BYTES) throw failure(TASK_CONTEXT_PACK_FAILURE.RESPONSE_TOO_LARGE)
  return parsed
}

const readBoundedBody = async (response, signal) => {
  const declared = declaredLength(response)
  const chunks = []
  let total = 0
  const append = chunk => {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_RESPONSE_BYTES) throw failure(TASK_CONTEXT_PACK_FAILURE.RESPONSE_TOO_LARGE)
    chunks.push(bytes)
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const abort = () => { try { void reader.cancel() } catch {} }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        if (signal.aborted) throw failure(TASK_CONTEXT_PACK_FAILURE.ABORTED)
        const result = await reader.read()
        if (!result || typeof result.done !== 'boolean') invalidResponse()
        if (result.done) break
        if (!(result.value instanceof Uint8Array)) invalidResponse()
        append(result.value)
      }
    } catch (error) {
      try { await reader.cancel() } catch {}
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      try { reader.releaseLock() } catch {}
    }
  } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const abort = () => { try { response.body.destroy?.() } catch {} }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const chunk of response.body) {
        if (signal.aborted) throw failure(TASK_CONTEXT_PACK_FAILURE.ABORTED)
        if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) invalidResponse()
        append(chunk)
      }
    } finally { signal.removeEventListener('abort', abort) }
  } else if (declared !== null && typeof response.arrayBuffer === 'function') {
    append(new Uint8Array(await response.arrayBuffer()))
  } else invalidResponse()
  if (declared !== null && declared !== total) invalidResponse()
  if (total === 0) invalidResponse()
  return Buffer.concat(chunks, total)
}

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export class TaskContextPackHttpAdapter {
  constructor({
    wsUrl,
    bearerTokenFile = '',
    tokenProvider = null,
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  }) {
    this.origin = canonicalApiOrigin(wsUrl)
    if (tokenProvider !== null && bearerTokenFile) throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
    this.tokenProvider = tokenProvider || (bearerTokenFile ? () => readBearerTokenFile(bearerTokenFile) : null)
    this.fetchFn = fetchFn
    this.timeoutMs = timeoutMs
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    if (typeof this.tokenProvider !== 'function' || typeof this.fetchFn !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
        || typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
      throw failure(TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE)
    }
  }

  async readForDispatch(binding, { signal = null } = {}) {
    const request = requestBinding(binding)
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw failure(TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
    }
    if (signal?.aborted) throw failure(TASK_CONTEXT_PACK_FAILURE.ABORTED)

    let token
    try { token = await this.tokenProvider() } catch {
      throw failure(TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE)
    }
    if (signal?.aborted) throw failure(TASK_CONTEXT_PACK_FAILURE.ABORTED)
    const jwtScope = decodeJwtScope(token)
    if (signal?.aborted) throw failure(TASK_CONTEXT_PACK_FAILURE.ABORTED)
    if (jwtScope.tenantId !== request.tenantId || jwtScope.clientId !== request.clientId
        || jwtScope.actorAgentId !== request.actorAgentId) {
      throw failure(TASK_CONTEXT_PACK_FAILURE.SCOPE_MISMATCH)
    }

    const endpoint = new URL(`${this.origin}/agent/tasks/${encodePathSegment(request.taskId)}/context-pack`)
    if (request.expectedVersion !== null) endpoint.searchParams.set('expectedVersion', request.expectedVersion)
    const controller = new AbortController()
    let timedOut = false
    let callerAborted = false
    let rejectAbort
    const abortPromise = new Promise((resolve, reject) => { rejectAbort = reject })
    const onAbort = () => {
      callerAborted = true
      controller.abort()
      rejectAbort(failure(TASK_CONTEXT_PACK_FAILURE.ABORTED))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = this.setTimeoutFn(() => {
      timedOut = true
      controller.abort()
      rejectAbort(failure(TASK_CONTEXT_PACK_FAILURE.TIMEOUT))
    }, this.timeoutMs)

    const operation = (async () => {
      const response = await this.fetchFn(endpoint, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal
      })
      requireResponseEnvelope(response, endpoint)
      if (response.status !== 200) mapHttpFailure(response)
      const bytes = await readBoundedBody(response, controller.signal)
      let parsed
      try {
        const text = bytes.toString('utf8')
        if (!Buffer.from(text, 'utf8').equals(bytes)) invalidResponse()
        parsed = JSON.parse(text)
      } catch (error) {
        if (error instanceof TaskContextPackError) throw error
        invalidResponse()
      }
      return deepFreeze(validatePack(parsed, jwtScope, request.taskId, request.expectedVersion))
    })()
    operation.catch(() => {})
    try {
      return await Promise.race([operation, abortPromise])
    } catch (error) {
      if (timedOut) throw failure(TASK_CONTEXT_PACK_FAILURE.TIMEOUT)
      if (callerAborted) throw failure(TASK_CONTEXT_PACK_FAILURE.ABORTED)
      if (error instanceof TaskContextPackError) throw error
      throw failure(TASK_CONTEXT_PACK_FAILURE.UNAVAILABLE)
    } finally {
      this.clearTimeoutFn(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
