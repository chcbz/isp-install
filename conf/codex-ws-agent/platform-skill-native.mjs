import { createHash } from 'node:crypto'

const TYPE = 'PLATFORM_SKILL_INSTALL'
const ORIGIN = 'PLATFORM_PROVISIONED'
const PAYLOAD_FIELDS = ['bindingVersion', 'challengeId', 'installationId', 'packageRef', 'packageSha256', 'schemaVersion', 'skillKey', 'skillVersion']
const WIRE_FIELDS = ['attempt', 'causationId', 'clientId', 'commandId', 'commandType', 'correlationId', 'deliveryEpoch', 'executionEpoch', 'expiresAt', 'fencingToken', 'issuedAt', 'messageId', 'messageType', 'ownerJiacn', 'payload', 'schemaVersion', 'targetAgentId', 'taskId', 'tenantId', 'workItemId']
const RECEIPT_FIELDS = ['agentId', 'bindingVersion', 'errorCode', 'installationId', 'origin', 'packageSha256', 'revision', 'skillKey', 'skillVersion', 'state']
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const id = value => typeof value === 'string' && ID.test(value)
const SHA = /^[0-9a-f]{64}$/
const FAILURES = new Set(['PLATFORM_SKILL_PACKAGE_INVALID', 'PLATFORM_SKILL_DIGEST_MISMATCH', 'PLATFORM_SKILL_INSTALL_CONFLICT', 'PLATFORM_SKILL_INSTALL_IO_FAILED', 'PLATFORM_SKILL_INSTALL_DISABLED'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, expected) => object(value) && Object.keys(value).sort().join('\0') === expected.join('\0')
const require = (valid, code = 'PLATFORM_SKILL_COMMAND_INVALID') => {
  if (!valid) throw new PlatformSkillNativeError(code)
}
export class PlatformSkillNativeError extends Error {
  constructor(code) { super(code); this.name = 'PlatformSkillNativeError'; this.code = code }
}
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
const scopeText = value => typeof value === 'string' && value.length > 0 && value.length <= 50 && value === value.trim()
  && !/[\u0000-\u001f\u007f]/u.test(value) && !/[\ud800-\udfff]/u.test(value)
const loopback = hostname => {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127)
}

const nativeBaseUrl = wsUrl => {
  let url
  try { url = new URL(wsUrl) } catch { throw new PlatformSkillNativeError('PLATFORM_SKILL_NATIVE_FORBIDDEN') }
  require(['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'PLATFORM_SKILL_NATIVE_FORBIDDEN')
  require(url.protocol === 'wss:' || loopback(url.hostname), 'PLATFORM_SKILL_NATIVE_FORBIDDEN')
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/'
  return url
}

export const platformSkillApiOrigin = wsUrl => nativeBaseUrl(wsUrl).origin

/** Accept only the exact registered server scope and frozen platform package contract. Never creates a Codex prompt. */
export const validatePlatformSkillCommand = (message, runtimeScope, now = Date.now()) => {
  const wire = message?.rawPayload || message
  const p = wire?.payload
  require(exactKeys(wire, WIRE_FIELDS) && exactKeys(p, PAYLOAD_FIELDS))
  require(wire.schemaVersion === 1 && wire.messageType === 'command.dispatch' && wire.commandType === TYPE && p.schemaVersion === 1)
  require(runtimeScope?.scheme === 'native-runtime-v1' && runtimeScope.tenantId === '0' && scopeText(runtimeScope.clientId) && scopeText(runtimeScope.ownerJiacn)
    && runtimeScope.ownerJiacn !== '0' && id(runtimeScope.agentId) && id(runtimeScope.runtimeInstanceId))
  for (const field of ['tenantId', 'clientId', 'ownerJiacn']) require(wire[field] === runtimeScope[field])
  require(wire.targetAgentId === runtimeScope.agentId && id(wire.messageId))
  require(id(p.installationId) && id(p.challengeId))
  require(positive(p.bindingVersion) && p.skillKey === 'archive-maintainer' && p.skillVersion === '1.0.0' && SHA.test(p.packageSha256))
  require(p.packageRef === `/internal/agent/platform-skills/installations/${p.installationId}/package`)
  require(wire.taskId === p.installationId && wire.correlationId === p.installationId && wire.causationId === p.challengeId && wire.workItemId === null)
  require(Number.isSafeInteger(wire.attempt) && wire.attempt > 0 && wire.fencingToken === '1' && wire.deliveryEpoch === '1' && wire.executionEpoch === '1')
  require(Number.isSafeInteger(wire.issuedAt) && wire.issuedAt > 0 && Number.isSafeInteger(wire.expiresAt)
    && wire.expiresAt === wire.issuedAt + 3600000 && wire.issuedAt <= now && now < wire.expiresAt)
  const seed = [wire.tenantId, wire.clientId, wire.ownerJiacn, p.installationId, wire.targetAgentId, TYPE].join('\0')
  require(wire.commandId === `cmd_controlled_${sha256(Buffer.from(seed))}`)
  return Object.freeze({
    ...p,
    origin: ORIGIN,
    commandType: TYPE,
    messageId: wire.messageId,
    commandId: wire.commandId,
    attempt: wire.attempt,
    fencingToken: wire.fencingToken,
    deliveryEpoch: wire.deliveryEpoch,
    executionEpoch: wire.executionEpoch,
    tenantId: wire.tenantId,
    clientId: wire.clientId,
    ownerJiacn: wire.ownerJiacn,
    targetAgentId: wire.targetAgentId,
    runtimeInstanceId: runtimeScope.runtimeInstanceId
  })
}

const nativeUrl = (wsUrl, installationId, suffix) => {
  require(id(installationId), 'PLATFORM_SKILL_NATIVE_FORBIDDEN')
  const url = nativeBaseUrl(wsUrl)
  url.pathname = `/internal/agent/platform-skills/installations/${installationId}/${suffix}`
  return url
}
const headers = (runtimeScope, authorization, accept) => {
  require(typeof authorization === 'string' && /^AgentRuntime [0-9a-f]{32}$/.test(authorization), 'PLATFORM_SKILL_NATIVE_UNAUTHENTICATED')
  require(id(runtimeScope?.agentId) && id(runtimeScope?.runtimeInstanceId), 'PLATFORM_SKILL_NATIVE_UNAUTHENTICATED')
  return { Authorization: authorization, 'X-Agent-Id': runtimeScope.agentId, 'X-Agent-Runtime-Id': runtimeScope.runtimeInstanceId, Accept: accept }
}
const responseIsExact = (response, url) => {
  if (response?.status !== 200 || response.redirected !== false || typeof response.url !== 'string') return false
  try { return new URL(response.url).href === url.href } catch { return false }
}
const readBounded = async (response, maxBytes, exactLength = null) => {
  const reader = response.body?.getReader?.()
  require(reader && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'PLATFORM_SKILL_NATIVE_RESPONSE_INVALID')
  const parts = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const bytes = Buffer.from(next.value)
      length += bytes.length
      require(length <= maxBytes && (exactLength === null || length <= exactLength), 'PLATFORM_SKILL_NATIVE_RESPONSE_INVALID')
      parts.push(bytes)
    }
    require(exactLength === null || length === exactLength, 'PLATFORM_SKILL_NATIVE_RESPONSE_INVALID')
    return Buffer.concat(parts, length)
  } catch (error) {
    try { await reader.cancel() } catch { /* retain original failure */ }
    throw error
  } finally { reader.releaseLock() }
}

/** Downloads only; callers must use the secure package extractor and atomic no-replace activator. */
export const downloadPlatformSkillPackage = async ({ wsUrl, command, runtimeScope, authorization, fetchFn = globalThis.fetch, maxPackageBytes = 16 * 1024 * 1024 }) => {
  require(id(command?.installationId) && SHA.test(command?.packageSha256) && command.packageRef === `/internal/agent/platform-skills/installations/${command.installationId}/package`)
  const url = nativeUrl(wsUrl, command.installationId, 'package')
  const response = await fetchFn(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: headers(runtimeScope, authorization, 'application/zip') })
  require(responseIsExact(response, url), 'PLATFORM_SKILL_NATIVE_FORBIDDEN')
  const length = response.headers?.get('content-length')
  require(typeof length === 'string' && /^[1-9][0-9]*$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) <= maxPackageBytes, 'PLATFORM_SKILL_NATIVE_RESPONSE_INVALID')
  require(response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/zip', 'PLATFORM_SKILL_NATIVE_RESPONSE_INVALID')
  const bytes = await readBounded(response, maxPackageBytes, Number(length))
  require(sha256(bytes) === command.packageSha256, 'PLATFORM_SKILL_DIGEST_MISMATCH')
  return bytes
}

export const validatePlatformSkillReceipt = (receipt, command, runtimeScope, outcome, errorCode = null) => {
  require(exactKeys(receipt, RECEIPT_FIELDS) && receipt.installationId === command?.installationId && receipt.agentId === runtimeScope?.agentId
    && receipt.bindingVersion === command?.bindingVersion && receipt.skillKey === command?.skillKey && receipt.skillVersion === command?.skillVersion
    && receipt.packageSha256 === command?.packageSha256 && receipt.origin === ORIGIN && receipt.state === outcome
    && receipt.errorCode === errorCode && positive(receipt.revision), 'PLATFORM_SKILL_RECEIPT_UNKNOWN')
  return Object.freeze({ ...receipt })
}

/** Sends one exact persisted result. Retry policy belongs to the durable manager, never this helper. */
export const sendPlatformSkillResult = async ({ wsUrl, command, runtimeScope, authorization, outcome, errorCode = null, fetchFn = globalThis.fetch }) => {
  require(outcome === 'SUCCEEDED' && errorCode === null || outcome === 'FAILED' && FAILURES.has(errorCode), 'PLATFORM_SKILL_RESULT_INVALID')
  require(id(command?.installationId) && id(command?.commandId) && id(command?.challengeId) && SHA.test(command?.packageSha256)
    && Number.isSafeInteger(command?.attempt) && command.attempt > 0 && command.executionEpoch === '1', 'PLATFORM_SKILL_RESULT_INVALID')
  const url = nativeUrl(wsUrl, command.installationId, 'result')
  const body = { schemaVersion: 1, installationId: command.installationId, commandId: command.commandId, attempt: command.attempt,
    executionEpoch: command.executionEpoch, challengeId: command.challengeId, packageSha256: command.packageSha256, outcome, errorCode }
  const response = await fetchFn(url, { method: 'POST', redirect: 'error', credentials: 'omit', headers: { ...headers(runtimeScope, authorization, 'application/json'), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  require(responseIsExact(response, url), 'PLATFORM_SKILL_RECEIPT_UNKNOWN')
  require(response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json', 'PLATFORM_SKILL_RECEIPT_UNKNOWN')
  let receipt
  try { receipt = JSON.parse((await readBounded(response, 4096)).toString('utf8')) } catch { throw new PlatformSkillNativeError('PLATFORM_SKILL_RECEIPT_UNKNOWN') }
  return validatePlatformSkillReceipt(receipt, command, runtimeScope, outcome, errorCode)
}
