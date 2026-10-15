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
test('result transmission separates current session from immutable execution identity', () => {
  const result = { schemaVersion: 1, messageType: 'work.result', messageId: 'result', resultType: 'SKILL_INSTALL_RESULT', installationId: 'si_1', runtimeInstallationId: 'rti_1', runtimeInstanceId: 'old-boot', installedAt: '1000', packageDigest: `sha256:${'a'.repeat(64)}` }
  const saved = JSON.stringify(result), sent = toAgentWire(result, { runtimeInstanceId: 'new-boot' })
  assert.equal(sent.data.executionRuntimeInstanceId, 'old-boot'); assert.equal(sent.data.runtimeInstanceId, 'new-boot')
  assert.equal(sent.data.skillInstallationId, 'si_1'); assert.equal(sent.data.runtimeInstallationId, 'rti_1')
  assert.equal(sent.data.installedAt, 1000); assert.equal(sent.data.packageSha256, 'a'.repeat(64)); assert.equal(JSON.stringify(result), saved)
})
test('canonical command public metadata projects to the existing private command parser inputs', () => {
  const command = fromAgentWire(wire('command.dispatch', { schemaVersion: 1, commandType: 'SKILL_INSTALL', skillInstallationId: 'si_1', packageSha256: 'b'.repeat(64), payload: { privateFact: 'unchanged' } }))
  assert.equal(command.installationId, 'si_1'); assert.equal(command.packageDigest, `sha256:${'b'.repeat(64)}`)
  assert.deepEqual(command.payload, { privateFact: 'unchanged' }); assert.equal(command.messageType, 'command.dispatch')
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
