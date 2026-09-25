// Mirrors ChatDeliberationService eventPayload + ChatDeliberationOutboxRelay.hostedWire at API 0e879cc9dd8ff2927a9a5e56ea8cadc781105cb1.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('integral safe numbers only')
  return JSON.stringify(value)
}
const sourceVector = {
  conversationGeneration: '3', messageHighWatermark: '101', taskRevision: '7', executionRevision: null,
  bindingVersion: null, summaryRevision: null, workspaceTreeSha: null
}
const factsManifest = {
  schemaVersion: '1',
  conversation: { id: '42', generation: '3', scopeType: 'TASK', scopeKey: 'task-9' },
  targetAgentId: 'hosted-a', participantAgentIds: ['hosted-a', 'hosted-b'],
  task: { id: 'task-9', title: '聚义厅议事', status: 'IN_PROGRESS', assignedAgentId: 'hosted-a', assignedAgentIds: ['hosted-a'], revision: '7' },
  inputRefs: [{ type: 'conversation', id: '42' }, { type: 'message', id: '101' }, { type: 'task', id: 'task-9' }],
  userMessage: { id: '101' }, responsePolicy: { mustNotClaimToolUse: true, mustStateMissingFacts: true }
}
const contextHash = `sha256:${createHash('sha256').update(canonical({ sourceVector, facts: factsManifest })).digest('hex')}`
const eventPayload = {
  tenantId: 'tenant-a', ownerJiacn: 'owner-a', clientId: 'client-a', conversationId: '42', conversationGeneration: '3',
  requestId: 'req-1', requestRevision: '1', turnId: 'turn-h', dispatchId: 'dispatch-h', targetAgentId: 'hosted-a',
  contextSnapshotId: 'snapshot-1', contextHash, route: 'CHAT', content: '议事', conversationType: 'JUYITING', agentId: 'hosted-a',
  senderType: 'user', senderName: '用户',
  metadata: { requestId: 'req-1', requestRevision: 1, route: 'CHAT', conversationScopeType: 'TASK', conversationScopeKey: 'task-9', targetAgentIds: ['hosted-a', 'hosted-b'] },
  sentAt: '1790294400123', timestamp: '1790294400123', conversationScopeType: 'TASK', conversationScopeKey: 'task-9', taskId: 'task-9',
  sourceVector, factsManifest
}
const wire = {
  ...eventPayload, schemaVersion: 1, messageType: 'chat.message', messageId: 'evt-h', dispatchAckType: 'chat.dispatch.ack',
  ackRequired: true, deliverySemantics: 'AT_LEAST_ONCE_DURABLE_DEDUPE_REQUIRED',
  dedupeKey: 'tenant-a:owner-a:client-a:dispatch-h', correlationId: '42', tenantId: 'tenant-a', clientId: 'client-a', targetAgentId: 'hosted-a',
  contextSnapshot: { schemaVersion: '1', contextSnapshotId: 'snapshot-1', contextHash, sourceVector, facts: factsManifest }
}
wire.payload = structuredClone(wire)
writeFileSync(resolve(import.meta.dirname, '..', 'test', 'fixtures', 'api-hosted-wire-0e879cc9.json'), `${JSON.stringify(wire, null, 2)}\n`)
