import { isManagementMessage, parseManagementMessage } from './skill-management-wire.mjs'
import { randomUUID } from 'node:crypto'
import { decodeMessage, eventMessage, validateMessage } from './message-envelope.mjs'

// Projection only: the engine's checkpoints and signed business preimages are not wire DTOs.
const controlTypes = Object.freeze({
  'connection.established': 'connected', 'connection.ping': 'ping', 'connection.pong': 'pong',
  'agent.registered': 'agent_registered', 'agent.capability.index': 'agent_capability_index',
  'agent.status': 'agent_status', 'agent.status.updated': 'agent_status_updated', 'chat.message.receipt': 'agent_message_saved',
  'chat.dispatch.receipt': 'chat_dispatch_acknowledged', 'task.report.receipt': 'task_reported',
  'chat.stream.started': 'started', 'chat.stream.delta': 'delta', 'chat.stream.completed': 'done', 'chat.stream.stopped': 'stopped'
})
const revisions = ['sessionGeneration', 'requestRevision', 'conversationGeneration', 'deltaSeq', 'sequence', 'grantRevision', 'deliveryEpoch', 'fencingToken', 'eventSequence', 'eventVersion', 'finalSeq']
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw Object.assign(new Error('AGENT_MESSAGE_INVALID'), { code: 'AGENT_MESSAGE_INVALID' }) }
const rename = (data, from, to) => {
  if (!Object.hasOwn(data, from)) return
  if (Object.hasOwn(data, to)) invalid()
  data[to] = data[from]; delete data[from]
}
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n
const retiredManagement = data => data.resultType === 'SKILL_INSTALL_RESULT' || ['SKILL_INSTALL', 'SKILL_SET_ENABLED', 'SKILL_RECONCILE'].includes(data.commandType)
const publicType = type => ({ ping: 'connection.ping', pong: 'connection.pong', protocol_error: 'protocol.error', error: 'protocol.error' })[type] || type
export function toAgentWire(privateMessage, session = null) {
  if (isManagementMessage(privateMessage)) return parseManagementMessage(privateMessage)
  if (!object(privateMessage) || retiredManagement(privateMessage)) invalid()
  const data = { ...privateMessage }
  const type = publicType(data.messageType), messageId = data.messageId || randomUUID()
  const requestId = data.requestId || messageId
  delete data.messageType; delete data.messageId; delete data.type; delete data.channel
  for (const key of revisions) {
    if (!Object.hasOwn(data, key)) continue
    if (Number.isSafeInteger(data[key]) && data[key] >= 0) data[key] = String(data[key])
    if (!decimal(data[key])) invalid()
  }
  for (const key of ['issuedAt', 'sentAt', 'occurredAt', 'expiresAt']) {
    if (!Object.hasOwn(data, key)) continue
    if (typeof data[key] === 'string' && decimal(data[key]) && BigInt(data[key]) <= BigInt(Number.MAX_SAFE_INTEGER)) data[key] = Number(data[key])
    if (!Number.isSafeInteger(data[key]) || data[key] < 0) invalid()
  }
  rename(data, 'installationId', 'runtimeInstallationId')
  if (type === 'connection.pong') {
    const correlationId = data.correlationId; delete data.correlationId
    return validateMessage({ protocolVersion: 1, requestId, messageType: type, messageId, data, correlationId, code: 'E0', msg: 'ok' })
  }
  return eventMessage(requestId, type, messageId, data)
}
export function fromAgentWire(text) {
  const message = decodeMessage(text)
  if (isManagementMessage(message)) return parseManagementMessage(text)
  if (!object(message.data)) invalid()
  const data = { ...message.data }; if (retiredManagement(data)) invalid()
  if (['messageType', 'messageId', 'protocolVersion', 'type', 'channel', 'installationId'].some(key => Object.hasOwn(data, key))) invalid()
  for (const key of revisions) if (Object.hasOwn(data, key) && !decimal(data[key])) invalid()
  rename(data, 'runtimeInstallationId', 'installationId')
  if (object(data.runtimeAuth)) {
    data.runtimeAuth = { ...data.runtimeAuth }
    rename(data.runtimeAuth, 'runtimeInstallationId', 'installationId')
  }
  for (const key of ['issuedAt', 'sentAt', 'occurredAt', 'expiresAt']) {
    if (Object.hasOwn(data, key) && (!Number.isSafeInteger(data[key]) || data[key] < 0)) invalid()
  }
  // The private durable-chat schema retains exact decimal times in its private validation/hash input.
  if (data.deliverySemantics === 'AT_LEAST_ONCE_DURABLE_DEDUPE_REQUIRED') {
    for (const key of ['sentAt', 'occurredAt']) {
      if (Object.hasOwn(data, key)) data[key] = String(data[key])
    }
  }
  // Public decimal strings are projected back only at the private legacy file bridge.
  if (message.messageType === 'command.dispatch' && data.commandType === 'WORKSPACE_FILE_EXECUTE') {
    if (!object(data.payload) || !Array.isArray(data.payload.inputManifest) || !Array.isArray(data.payload.outputManifest)) invalid()
    const length = (value, positive) => {
      if (!decimal(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER) || (positive && value === '0')) invalid()
      return Number(value)
    }
    data.payload = { ...data.payload,
      inputManifest: data.payload.inputManifest.map(input => ({ ...input, length: length(input.length, false) })),
      outputManifest: data.payload.outputManifest.map(output => ({ ...output, maxLength: length(output.maxLength, true) })) }
  }
  data.messageId = message.messageId
  if (message.correlationId !== undefined) {
    data.correlationId = message.correlationId
    data.code = message.code; data.message = message.msg
  }
  if (controlTypes[message.messageType]) {
    data.type = controlTypes[message.messageType]
    if (message.correlationId !== undefined) data.messageId = message.correlationId
  } else data.messageType = message.messageType
  // Restore the private durable inbox shape only after validating the public persistence receipt.
  if (message.messageType === 'chat.message.receipt') {
    if (message.code !== 'E0' || !message.correlationId || !decimal(data.persistedMessageId) || data.persistedMessageId === '0') invalid()
    data.messageId = data.persistedMessageId; delete data.persistedMessageId
    data.channel = 'agent'
  }
  // Registration observes only validated transport correlation, never a supplied data.messageId.
  if (message.messageType === 'agent.registered' && (message.code !== 'E0' || !message.correlationId)) invalid()
  if (message.messageType === 'protocol.error') {
    data.type = 'protocol_error'; if (message.correlationId) data.messageId = message.correlationId
  }
  if (!Object.hasOwn(data, 'requestId')) data.requestId = message.requestId
  return data
}
