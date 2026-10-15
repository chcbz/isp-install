// Test-only projection of explicit private business fixtures onto the frozen public network contract.
// Deliberately malformed nested/root wrappers are returned unchanged to test their rejection.
import { randomUUID } from 'node:crypto'
export function agentMessageFixture(frame) {
  if (frame.protocolVersion || (!frame.messageType && (frame.data || frame.payload))) return frame
  if (frame.type && Object.hasOwn(frame, 'messageType')) return frame
  const data = { ...frame }, oldType = data.messageType || data.type
  const messageType = ({ agent_registered: 'agent.registered', agent_status_updated: 'agent.status.updated',
    agent_message_saved: 'chat.message.receipt', chat_dispatch_acknowledged: 'chat.dispatch.receipt',
    task_reported: 'task.report.receipt', connected: 'connection.established', ping: 'connection.ping', pong: 'connection.pong',
    error: 'protocol.error', protocol_error: 'protocol.error' })[oldType] || oldType
  const originalId = Object.hasOwn(data, 'messageId') ? data.messageId : randomUUID(), requestId = data.requestId || originalId
  const resultReceipt = messageType === 'work.result.receipt' && data.resultType === 'SKILL_INSTALL_RESULT'
  const correlationId = resultReceipt ? data.correlationId : originalId
  if (resultReceipt) delete data.correlationId
  delete data.type; delete data.messageType; delete data.messageId; delete data.channel
  const skill = data.resultType === 'SKILL_INSTALL_RESULT' || data.commandType === 'SKILL_INSTALL'
  if (Object.hasOwn(data, 'installationId')) { data[skill ? 'skillInstallationId' : 'runtimeInstallationId'] = data.installationId; delete data.installationId }
  for (const key of ['sessionGeneration', 'requestRevision', 'conversationGeneration', 'deltaSeq', 'sequence', 'grantRevision', 'deliveryEpoch', 'fencingToken', 'eventSequence', 'eventVersion', 'finalSeq']) {
    if (Number.isSafeInteger(data[key]) && data[key] >= 0) data[key] = String(data[key])
  }
  for (const key of ['issuedAt', 'sentAt', 'occurredAt', 'expiresAt']) if (typeof data[key] === 'string' && /^\d+$/.test(data[key])) data[key] = Number(data[key])
  if (data.runtimeAuth) { data.runtimeAuth = { ...data.runtimeAuth, runtimeInstallationId: data.runtimeAuth.installationId, sessionGeneration: String(data.runtimeAuth.sessionGeneration) }; delete data.runtimeAuth.installationId }
  if (skill && typeof data.packageDigest === 'string') { data.packageSha256 = data.packageDigest.slice(7); delete data.packageDigest }
  const reply = ['agent.registered', 'agent.status.updated', 'chat.message.receipt', 'chat.dispatch.receipt', 'task.report.receipt', 'work.result.receipt', 'protocol.error'].includes(messageType)
  return { protocolVersion: 1, requestId, messageType, messageId: reply && !resultReceipt ? `${originalId}:${messageType}` : originalId, data,
    ...(reply ? { correlationId, code: 'E0', msg: 'ok' } : {}) }
}
export function httpFixture(options, data) {
  const requestId = new Headers(options.headers).get('X-Request-Id')
  return { status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json', 'X-Request-Id': requestId }),
    text: async () => JSON.stringify({ protocolVersion: 1, requestId, code: 'E0', msg: 'ok', data }) }
}
