import { createHash } from 'node:crypto'

export const ARCHIVE_MAINTENANCE_PROTOCOL = 'ARCHIVE_MAINTENANCE_EXECUTE/v1'
export const ARCHIVE_MAINTENANCE_TYPE = 'ARCHIVE_MAINTENANCE_EXECUTE'
export const APPROVED_ARCHIVE_PACKAGE_SHA256 = '8894d96341067dd7f9e2f45696eef44057dc61346255a0323b2d713a3c7ea081'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const POSITIVE = /^[1-9][0-9]{0,18}$/u
const JSON_CONTENT = 'application/json'
const MAX_JSON_BYTES = 2 * 1024 * 1024
export const MAX_ARCHIVE_SOURCE_BYTES = 16 * 1024 * 1024
const PAYLOAD_FIELDS = ['appointmentId', 'appointmentRevision', 'bindingVersion', 'contextRef', 'dispatchKey', 'executionEpoch', 'executionRef', 'grantRef', 'jobId', 'managerAuthorizationRevision', 'runId', 'schemaVersion', 'skillInstallationId', 'skillPackageSha256']
const WIRE_FIELDS = ['attempt', 'causationId', 'clientId', 'commandId', 'commandType', 'correlationId', 'deliveryEpoch', 'executionEpoch', 'expiresAt', 'fencingToken', 'issuedAt', 'messageId', 'messageType', 'ownerJiacn', 'payload', 'schemaVersion', 'targetAgentId', 'taskId', 'tenantId', 'workItemId']
const RESULT_FIELDS = ['attempt', 'commandId', 'draftRevision', 'editionId', 'executionEpoch', 'failureCode', 'failurePhase', 'failureRetryable', 'jobId', 'jobRevision', 'jobState', 'publicationId', 'publicationState', 'runId', 'runRevision', 'runState', 'stage', 'validationDigest', 'validationId', 'validationOutcome', 'workId']
const CONTEXT_FIELDS = ['agentId', 'appointmentId', 'appointmentRevision', 'bindingVersion', 'collectionId', 'draftId', 'draftRevision', 'expectedActiveEditionId', 'expectedWorkRevision', 'jobId', 'operation', 'permissionProfile', 'publicationMode', 'requiredSkill', 'rightsBasis', 'runId', 'sourceId', 'sourceSha256', 'sourceSummary', 'state', 'waitReason', 'workId']
const SKILL_FIELDS = ['key', 'packageSha256', 'version']
const DRAFT_FIELDS = ['content', 'contentSha256', 'draftId', 'jobId', 'revision', 'state', 'validatedRevision', 'validationId']
const VALIDATION_FIELDS = ['draftId', 'draftRevision', 'findings', 'outcome', 'validationDigest', 'validationId']
const PUBLICATION_FIELDS = ['draftRevision', 'editionId', 'jobId', 'manifestSha256', 'publicationId', 'readbackState', 'sourceSha256', 'state', 'workId']

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, expected) => object(value) && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
const id = value => typeof value === 'string' && ID.test(value)
const positive = value => typeof value === 'string' && POSITIVE.test(value) && BigInt(value) <= 9223372036854775807n
const scopeText = value => typeof value === 'string' && value.length > 0 && value.length <= 50 && value === value.trim()
  && !/[\u0000-\u001f\u007f]/u.test(value) && !/[\ud800-\udfff]/u.test(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const requireValue = (condition, code = 'ARCHIVE_COMMAND_INVALID') => {
  if (!condition) throw new ArchiveMaintenanceNativeError(code)
}
const nullable = (value, predicate) => value === null || predicate(value)
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value)
const loopback = hostname => {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127)
}

export class ArchiveMaintenanceNativeError extends Error {
  constructor(code, message = code, { status = null, uncertain = true } = {}) {
    super(message)
    this.name = 'ArchiveMaintenanceNativeError'
    this.code = code
    this.status = status
    this.uncertain = uncertain
  }
}

const baseUrl = wsUrl => {
  let url
  try { url = new URL(wsUrl) } catch { throw new ArchiveMaintenanceNativeError('ARCHIVE_NATIVE_FORBIDDEN') }
  requireValue(['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'ARCHIVE_NATIVE_FORBIDDEN')
  requireValue(url.protocol === 'wss:' || loopback(url.hostname), 'ARCHIVE_NATIVE_FORBIDDEN')
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/'
  return url
}

export const archiveMaintenanceApiOrigin = wsUrl => baseUrl(wsUrl).origin

export const validateArchiveMaintenanceCommand = (message, runtimeScope, now = Date.now(), { allowExpired = false } = {}) => {
  const wire = message?.rawPayload || message
  const payload = wire?.payload
  requireValue(exactKeys(wire, WIRE_FIELDS) && exactKeys(payload, PAYLOAD_FIELDS))
  requireValue(wire.schemaVersion === 1 && wire.messageType === 'command.dispatch' && wire.commandType === ARCHIVE_MAINTENANCE_TYPE && payload.schemaVersion === 1)
  requireValue(runtimeScope?.scheme === 'native-runtime-v1' && runtimeScope.tenantId === '0'
    && scopeText(runtimeScope.clientId) && runtimeScope.clientId !== '0' && scopeText(runtimeScope.ownerJiacn) && runtimeScope.ownerJiacn !== '0'
    && id(runtimeScope.agentId) && id(runtimeScope.runtimeInstanceId))
  for (const field of ['tenantId', 'clientId', 'ownerJiacn']) requireValue(wire[field] === runtimeScope[field])
  requireValue(wire.targetAgentId === runtimeScope.agentId && id(wire.messageId))
  for (const field of ['jobId', 'runId', 'appointmentId', 'grantRef', 'executionRef', 'dispatchKey', 'skillInstallationId']) requireValue(id(payload[field]))
  for (const field of ['executionEpoch', 'appointmentRevision', 'managerAuthorizationRevision', 'bindingVersion']) requireValue(positive(payload[field]))
  requireValue(payload.skillPackageSha256 === APPROVED_ARCHIVE_PACKAGE_SHA256)
  requireValue(payload.contextRef === `/internal/archive/v1/jobs/${payload.jobId}/runs/${payload.runId}/context`)
  requireValue(wire.taskId === payload.jobId && wire.workItemId === null && wire.correlationId === payload.jobId && wire.causationId === payload.runId)
  requireValue(Number.isSafeInteger(wire.attempt) && wire.attempt > 0 && wire.fencingToken === '1' && wire.deliveryEpoch === '1'
    && wire.executionEpoch === payload.executionEpoch)
  requireValue(Number.isSafeInteger(wire.issuedAt) && wire.issuedAt > 0 && Number.isSafeInteger(wire.expiresAt)
    && wire.expiresAt > wire.issuedAt && wire.issuedAt <= now && (allowExpired || now < wire.expiresAt))
  const seed = [wire.tenantId, wire.clientId, wire.ownerJiacn, payload.runId, wire.targetAgentId, ARCHIVE_MAINTENANCE_TYPE].join('\0')
  requireValue(wire.commandId === `cmd_controlled_${sha256(Buffer.from(seed))}`)
  return Object.freeze({ ...payload, commandId: wire.commandId, messageId: wire.messageId, attempt: wire.attempt,
    issuedAt: wire.issuedAt, expiresAt: wire.expiresAt, tenantId: wire.tenantId, clientId: wire.clientId,
    ownerJiacn: wire.ownerJiacn, targetAgentId: wire.targetAgentId, runtimeInstanceId: runtimeScope.runtimeInstanceId })
}

const endpoint = (wsUrl, command, suffix) => {
  const url = baseUrl(wsUrl)
  url.pathname = `/internal/archive/v1/jobs/${command.jobId}/runs/${command.runId}/${suffix}`
  return url
}
const exactResponse = (response, url) => {
  if (!response || response.redirected !== false || typeof response.url !== 'string') return false
  try { return new URL(response.url).href === url.href } catch { return false }
}
const contentType = response => String(response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase()
const abortReason = (signal, code) => signal?.reason instanceof Error ? signal.reason : new ArchiveMaintenanceNativeError(code)
const readBounded = async (response, maxBytes, exactLength, signal) => {
  const reader = response.body?.getReader?.()
  requireValue(reader && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  const chunks = []; let length = 0
  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal, 'ARCHIVE_NATIVE_ABORTED')
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value); length += chunk.length
      requireValue(length <= maxBytes && (exactLength === null || length <= exactLength), 'ARCHIVE_NATIVE_RESPONSE_INVALID')
      chunks.push(chunk)
    }
    requireValue(exactLength === null || length === exactLength, 'ARCHIVE_NATIVE_RESPONSE_INVALID')
    return Buffer.concat(chunks, length)
  } finally {
    try { reader.releaseLock() } catch {}
  }
}
const parseJson = async (response, signal) => {
  requireValue(contentType(response) === JSON_CONTENT, 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  let value
  try { value = JSON.parse((await readBounded(response, MAX_JSON_BYTES, null, signal)).toString('utf8')) } catch (error) {
    if (error instanceof ArchiveMaintenanceNativeError) throw error
    throw new ArchiveMaintenanceNativeError('ARCHIVE_NATIVE_RESPONSE_INVALID')
  }
  requireValue(exactKeys(value, ['code', 'data', 'msg', 'status']) && value.code === 'E0' && value.msg === 'ok' && value.status === 200, 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  return value.data
}
const requireResult = (value, command) => {
  requireValue(exactKeys(value, RESULT_FIELDS) && value.jobId === command.jobId && value.runId === command.runId
    && value.commandId === command.commandId && value.attempt === String(command.attempt) && value.executionEpoch === command.executionEpoch
    && ['WAITING', 'AUTHORIZED', 'RUNNING', 'COMPLETED', 'FAILED', 'FENCED'].includes(value.runState)
    && decimal(value.runRevision) && decimal(value.jobRevision) && decimal(value.draftRevision), 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  if (value.runState === 'COMPLETED') requireValue(['COMPLETED', 'AWAITING_HUMAN_RELEASE'].includes(value.stage), 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  if (value.runState === 'FAILED') requireValue(value.stage === 'FAILED' && id(value.failurePhase) && id(value.failureCode) && typeof value.failureRetryable === 'boolean', 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  return Object.freeze({ ...value })
}
const requireContext = (value, command) => {
  requireValue(exactKeys(value, CONTEXT_FIELDS) && value.jobId === command.jobId && value.runId === command.runId
    && value.appointmentId === command.appointmentId && value.appointmentRevision === command.appointmentRevision
    && value.agentId === command.targetAgentId && value.bindingVersion === command.bindingVersion
    && exactKeys(value.requiredSkill, SKILL_FIELDS) && value.requiredSkill.key === 'archive-maintainer'
    && value.requiredSkill.version === '1.0.0' && value.requiredSkill.packageSha256 === command.skillPackageSha256
    && id(value.collectionId) && id(value.workId) && ['ADD_WORK', 'REVISE_WORK'].includes(value.operation)
    && decimal(value.expectedWorkRevision) && nullable(value.expectedActiveEditionId, id)
    && ['DRAFT_ONLY', 'PUBLISH_VALIDATED'].includes(value.permissionProfile) && ['MANUAL', 'AUTO'].includes(value.publicationMode)
    && id(value.sourceId) && SHA256.test(value.sourceSha256) && id(value.draftId) && decimal(value.draftRevision), 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  return Object.freeze({ ...value, requiredSkill: Object.freeze({ ...value.requiredSkill }) })
}
const requireDraft = (value, command) => {
  requireValue(exactKeys(value, DRAFT_FIELDS) && value.jobId === command.jobId && id(value.draftId) && decimal(value.revision)
    && object(value.content) && Array.isArray(value.content.blocks) && Array.isArray(value.content.excludedSourceRanges)
    && SHA256.test(value.contentSha256), 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  return Object.freeze(value)
}
const requireValidation = value => {
  requireValue(exactKeys(value, VALIDATION_FIELDS) && id(value.validationId) && id(value.draftId) && decimal(value.draftRevision)
    && ['PASSED', 'FAILED'].includes(value.outcome) && SHA256.test(value.validationDigest) && Array.isArray(value.findings)
    && value.findings.every(finding => typeof finding === 'string'), 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  return Object.freeze(value)
}
const requirePublication = (value, command) => {
  requireValue(exactKeys(value, PUBLICATION_FIELDS) && value.jobId === command.jobId && id(value.publicationId)
    && id(value.workId) && id(value.editionId) && decimal(value.draftRevision) && SHA256.test(value.manifestSha256)
    && value.sourceSha256 === command.sourceSha256 && typeof value.state === 'string' && typeof value.readbackState === 'string', 'ARCHIVE_NATIVE_RESPONSE_INVALID')
  return Object.freeze(value)
}

export class ArchiveMaintenanceNativeClient {
  constructor({ wsUrl, runtimeScope, authorizationProvider, fetchFn = globalThis.fetch, now = () => Date.now(), maxCallMs = 30000, sessionSignal = null }) {
    this.wsUrl = wsUrl; this.runtimeScope = Object.freeze({ ...runtimeScope }); this.authorizationProvider = authorizationProvider
    this.fetchFn = fetchFn; this.now = now; this.maxCallMs = maxCallMs; this.sessionSignal = sessionSignal
    this.origin = archiveMaintenanceApiOrigin(wsUrl)
  }

  _headers(command, extra = {}) {
    const authorization = this.authorizationProvider()
    requireValue(/^AgentRuntime [0-9a-f]{32}$/u.test(authorization || ''), 'ARCHIVE_NATIVE_UNAUTHENTICATED')
    requireValue(this.runtimeScope.agentId === command.targetAgentId && this.runtimeScope.runtimeInstanceId === command.runtimeInstanceId, 'ARCHIVE_NATIVE_UNAUTHENTICATED')
    return { Authorization: authorization, 'X-Agent-Id': this.runtimeScope.agentId, 'X-Agent-Runtime-Id': this.runtimeScope.runtimeInstanceId,
      'X-Archive-Grant-Ref': command.grantRef, 'X-Archive-Execution-Ref': command.executionRef,
      'X-Archive-Command-Id': command.commandId, 'X-Archive-Command-Attempt': String(command.attempt),
      'X-Archive-Execution-Epoch': command.executionEpoch, Accept: JSON_CONTENT, ...extra }
  }

  async _request(command, suffix, { method = 'GET', body, headers = {}, producer = false, source = false } = {}) {
    if (this.sessionSignal?.aborted) throw abortReason(this.sessionSignal, 'ARCHIVE_NATIVE_ABORTED')
    if (producer && this.now() >= command.expiresAt) throw new ArchiveMaintenanceNativeError('ARCHIVE_EXECUTION_EXPIRED')
    const url = endpoint(this.wsUrl, command, suffix)
    const remaining = producer ? command.expiresAt - this.now() : this.maxCallMs
    const timeoutMs = Math.max(1, Math.min(this.maxCallMs, remaining))
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new ArchiveMaintenanceNativeError('ARCHIVE_NATIVE_TIMEOUT')), timeoutMs)
    const onAbort = () => controller.abort(abortReason(this.sessionSignal, 'ARCHIVE_NATIVE_ABORTED'))
    this.sessionSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.fetchFn(url, { method, redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: this._headers(command, headers), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      requireValue(exactResponse(response, url), 'ARCHIVE_NATIVE_FORBIDDEN')
      if (response.status !== 200) throw new ArchiveMaintenanceNativeError('ARCHIVE_NATIVE_DENIED', 'ARCHIVE_NATIVE_DENIED', { status: response.status, uncertain: false })
      if (source) {
        requireValue(contentType(response) === 'text/plain', 'ARCHIVE_NATIVE_RESPONSE_INVALID')
        const length = response.headers?.get('content-length')
        requireValue(typeof length === 'string' && /^[1-9][0-9]*$/u.test(length) && Number(length) <= MAX_ARCHIVE_SOURCE_BYTES, 'ARCHIVE_NATIVE_RESPONSE_INVALID')
        requireValue(response.headers?.get('x-archive-source-sha256') === command.sourceSha256, 'ARCHIVE_NATIVE_RESPONSE_INVALID')
        return readBounded(response, MAX_ARCHIVE_SOURCE_BYTES, Number(length), controller.signal)
      }
      return { data: await parseJson(response, controller.signal), etag: response.headers?.get('etag') || '' }
    } catch (error) {
      if (error instanceof ArchiveMaintenanceNativeError) throw error
      if (controller.signal.aborted) throw abortReason(controller.signal, 'ARCHIVE_NATIVE_ABORTED')
      throw new ArchiveMaintenanceNativeError('ARCHIVE_NATIVE_TRANSPORT')
    } finally {
      clearTimeout(timeout); this.sessionSignal?.removeEventListener('abort', onAbort)
    }
  }

  async result(command) { return requireResult((await this._request(command, 'result')).data, command) }
  async start(command) { return requireResult((await this._request(command, 'start', { method: 'POST', producer: true,
    headers: { 'Content-Type': JSON_CONTENT }, body: { commandId: command.commandId, messageId: command.messageId, attempt: String(command.attempt), executionEpoch: command.executionEpoch } })).data, command) }
  async context(command) { return requireContext((await this._request(command, 'context', { producer: true })).data, command) }
  async source(command, context) { return this._request({ ...command, sourceSha256: context.sourceSha256 }, `sources/${context.sourceId}/content`, { producer: true, source: true, headers: { Accept: 'text/plain' } }) }
  async draft(command) {
    const response = await this._request(command, 'draft', { producer: true }); const draft = requireDraft(response.data, command)
    requireValue(response.etag === `"v${draft.revision}"`, 'ARCHIVE_NATIVE_RESPONSE_INVALID'); return draft
  }
  async putDraft(command, revision, operationKey, draft) {
    const response = await this._request(command, 'draft', { method: 'PUT', producer: true, headers: { 'Content-Type': JSON_CONTENT,
      'Idempotency-Key': operationKey, 'If-Match': `"v${revision}"` }, body: draft })
    const result = requireDraft(response.data, command); requireValue(response.etag === `"v${result.revision}"`, 'ARCHIVE_NATIVE_RESPONSE_INVALID'); return result
  }
  async validate(command, revision, operationKey) { return requireValidation((await this._request(command, 'validate', { method: 'POST', producer: true,
    headers: { 'Idempotency-Key': operationKey, 'If-Match': `"v${revision}"` } })).data) }
  async validation(command) { return requireValidation((await this._request(command, 'validation', { producer: true })).data) }
  async publish(command, revision, operationKey, body) {
    const value = requirePublication((await this._request(command, 'publish', { method: 'POST', producer: true,
      headers: { 'Content-Type': JSON_CONTENT, 'Idempotency-Key': operationKey, 'If-Match': `"v${revision}"` }, body })).data,
    { ...command, sourceSha256: command.sourceSha256 })
    return value
  }
  async failure(command, body) { return requireResult((await this._request(command, 'failure', { method: 'POST', producer: true,
    headers: { 'Content-Type': JSON_CONTENT }, body })).data, command) }
}
