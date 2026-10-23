import test from 'node:test'
import assert from 'node:assert/strict'
import { toAgentWire, fromAgentWire } from '../agent-message-wire.mjs'
import { RegistrationAckObserver } from '../registration-ack.mjs'
const wire = (type, data, extra = {}) => JSON.stringify({ protocolVersion: 1, requestId: 'r', messageType: type, messageId: 'reply', data, ...extra })
test('registration is a strict message and no transport field is added to durable input', () => {
  const input = { schemaVersion: 1, messageType: 'agent.register', messageId: 'm', installationId: 'rti_1', sessionGeneration: '9007199254740993' }
  const saved = JSON.stringify(input), result = toAgentWire(input)
  assert.equal(result.data.runtimeInstallationId, 'rti_1'); assert.equal(result.data.sessionGeneration, '9007199254740993')
  assert.equal(result.data.messageId, undefined); assert.equal(JSON.stringify(input), saved)
  assert.throws(() => fromAgentWire(JSON.stringify(input)))
  assert.throws(() => fromAgentWire(wire('agent.registered', { messageId: 'injected' })))
  assert.throws(() => fromAgentWire(wire('agent.status.updated', { sessionGeneration: 1 })))
  assert.throws(() => fromAgentWire(wire('agent.status.updated', {}).replace('"data":{}', '"data":{},"data":{}')))
})
test('real registration observer only accepts the public correlated reply after strict projection', () => {
  const observer = new RegistrationAckObserver({ agentId: 'agent', runtimeInstanceId: 'boot', schedule: () => 1, cancel() {}, logger: { log(){}, warn(){} } })
  observer.begin('registration')
  const data = { schemaVersion: 1, agentId: 'agent', runtimeInstanceId: 'boot', status: 'online', durableStateHealthy: true, readyCommandTypes: [] }
  const reply = wire('agent.registered', data, { correlationId: 'registration', code: 'E0', msg: 'ok' })
  assert.equal(observer.observe(fromAgentWire(reply)), 'registered')
  assert.throws(() => fromAgentWire(wire('agent.registered', data)))
})
test('retired skill schema1 command/result never create a parallel wire projection', () => {
  assert.throws(() => toAgentWire({ messageType: 'work.result', resultType: 'SKILL_INSTALL_RESULT' }))
  assert.throws(() => fromAgentWire(wire('command.dispatch', { schemaVersion: 1, commandType: 'SKILL_INSTALL' })))
  assert.throws(() => fromAgentWire(wire('work.result', { resultType: 'SKILL_INSTALL_RESULT' })))
})

test('workspace queue wire lengths are strict strings while private durable input remains numeric', () => {
  const payload = { taskId: 'task', runId: 'run', inputManifest: [{ length: '7' }], outputManifest: [{ maxLength: '9' }] }
  const data = { schemaVersion: 1, commandType: 'WORKSPACE_FILE_EXECUTE', payload }
  const saved = JSON.stringify(data), result = fromAgentWire(wire('command.dispatch', data))
  assert.equal(result.payload.inputManifest[0].length, 7)
  assert.equal(result.payload.outputManifest[0].maxLength, 9)
  assert.equal(JSON.stringify(data), saved)
  for (const value of [7, '01', '-1', '9007199254740993']) {
    assert.throws(() => fromAgentWire(wire('command.dispatch', { ...data, payload: { ...payload, inputManifest: [{ length: value }] } })))
  }
})

test('status broadcast projection is distinct from the correlated presence receipt', () => {
  const event = fromAgentWire(wire('agent.status', { tenantId: '0', ownerJiacn: 'owner', status: 'online' }));
  assert.equal(event.type, 'agent_status'); assert.equal(event.messageType, undefined);
  assert.equal(event.tenantId, '0'); assert.equal(event.ownerJiacn, 'owner');
  const receipt = fromAgentWire(wire('agent.status.updated', { status: 'online' }, { correlationId: 'presence', code: 'E0', msg: 'ok' }));
  assert.equal(receipt.type, 'agent_status_updated'); assert.equal(receipt.messageId, 'presence');
});

test('saved chat receipt restores private inbox identity without confusing transport correlation', () => {
  const data = { persistedMessageId: '123', turnId: 'turn', duplicate: false, eventId: 'event' };
  const extra = { correlationId: 'final-message', code: 'E0', msg: 'ok' };
  const result = fromAgentWire(wire('chat.message.receipt', data, extra));
  assert.equal(result.messageId, '123'); assert.equal(result.correlationId, 'final-message');
  assert.equal(result.channel, 'agent'); assert.equal(result.type, 'agent_message_saved');
  assert.throws(() => fromAgentWire(wire('chat.message.receipt', data)));
  for (const persistedMessageId of [123, '0', '01']) assert.throws(() => fromAgentWire(wire('chat.message.receipt', { ...data, persistedMessageId }, extra)));
});
