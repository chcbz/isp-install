import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createExecutionAdapterFactory } from '../lib/execution-adapter.mjs'
import { examples } from '../../codex-bridge/test/fixtures/skill-management-fixture.mjs'
import { managementDigest } from '../../codex-bridge/skill-management-wire.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
const durableSkillResult = () => {
  const result = structuredClone(examples.cases.find(c => c.valid && c.definition === 'Result').value)
  result.data.agentId = 'agent'; result.data.runtimeInstallationId = 'rti_1'
  result.data.executionRuntimeInstanceId = 'execution-boot'
  const { resultSha256, ...preimage } = result.data
  result.data.resultSha256 = managementDigest('cyf.skill.result.v2', preimage)
  return result
}
const session = Object.freeze({ tenantId: '1', clientId: 'cyf-local', canonicalAgentId: 'agent', installationId: 'rti_1', hostId: 'host', runtimeInstanceId: 'boot', sessionGeneration: '9007199254740993' })
async function fixture(t) {
  const accepted = [], sent = [], sockets = [], logs = []
  const state = { profile: { agentId: 'agent' }, processor: { pause() {} } }
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open') }) }
    send(text) { sent.push(JSON.parse(text)) }
    receive(message) { this.emit('message', Buffer.from(typeof message === 'string' ? message : JSON.stringify(message))) }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', code)) }
  }
  const agent = { subjectKey: 'subject', manifest: {}, stateRoot: '/unused', profile: state.profile }
  const client = { currentSession: null, async session() { this.currentSession = session; return session }, invalidateSession() { this.currentSession = null },
    sessionHeaders: () => ({}), websocketUrl: () => 'wss://no-network.invalid', websocketOptions: () => ({}) }
  const factory = await createExecutionAdapterFactory({ config: { agents: [agent], hostId: 'host' }, instanceId: 'boot', apiOrigin: 'https://no-network.invalid', socketFactory: Socket,
    clientFactory: () => client, logger: (event, data) => logs.push({ event, ...data }), loadEngine: async () => ({
      buildProtocolEnvelope: (messageType, data) => ({ schemaVersion: 1, messageType, ...data }),
      createRuntimeExecutionHost: () => ({ createExecutor: () => ({
        state: () => state, initialize: async () => {}, durableStateHealthy: () => true, readyCommandTypes: () => ['TASK_INVITE'], chatReady: () => true,
        registrationPayload: () => ({}), bindTransport: transport => { state.transport = transport }, attachSocket() {}, disconnected() {}, resume: async () => {},
        acceptFrame: async frame => accepted.push(frame), suspendAdmission() {}, close: async () => {},
        matchesSkillInstallResult: value => JSON.stringify(value) === JSON.stringify(durableSkillResult())
      }), close: async () => {} })
    }) })
  t.after(() => factory.close())
  const executor = factory.createExecutor({ subjectKey: 'subject', agent }); await executor.initialize()
  const activation = executor.activate(); await tick()
  const ack = () => {
    const request = sent[0]
    return { protocolVersion: 1, requestId: request.requestId, messageType: 'agent.registered', messageId: 'registration-reply', correlationId: request.messageId, code: 'E0', msg: 'ok',
      data: { schemaVersion: 1, agentId: 'agent', runtimeInstanceId: 'boot', runtimeInstallationId: 'rti_1', hostId: 'host', sessionGeneration: session.sessionGeneration,
        status: 'online', durableStateHealthy: true, readyCommandTypes: ['TASK_INVITE'] } }
  }
  return { factory, executor, activation, socket: sockets[0], sent, ack, accepted, state, logs }
}
test('actual adapter requires M registration reply and preserves exact session generation', async t => {
  const f = await fixture(t)
  assert.equal(f.sent[0].messageType, 'agent.register'); assert.equal(f.sent[0].data.runtimeInstallationId, 'rti_1')
  assert.equal(f.sent[0].data.sessionGeneration, session.sessionGeneration); assert.equal(f.sent[0].installationId, undefined)
  f.socket.receive({ type: 'agent_registered', messageId: f.sent[0].messageId, ...f.ack().data }); await tick(); assert.equal(f.executor.ready(), false)
  f.socket.receive({ ...f.ack(), correlationId: 'wrong' }); await tick(); assert.equal(f.executor.ready(), false)
  f.socket.receive(f.ack()); await f.activation; assert.equal(f.executor.ready(), true)
  const command = { protocolVersion: 1, requestId: 'command-request', messageId: 'command-message', messageType: 'command.dispatch', data: { schemaVersion: 1,
    tenantId: '1', clientId: 'cyf-local', targetAgentId: 'agent', commandType: 'TASK_INVITE', commandId: 'cmd', payload: { instruction: 'synthetic' } } }
  f.socket.receive(command); await tick(); assert.equal(f.accepted.length, 1); assert.equal(f.accepted[0].commandId, 'cmd')
  f.socket.receive({ ...command, data: { ...command.data, targetAgentId: 'foreign' } }); await tick(); assert.equal(f.accepted.length, 1)
  f.socket.receive({ ...command, data: { ...command.data, sessionGeneration: '9007199254740994' } }); await tick(); assert.equal(f.accepted.length, 1)
})
test('actual adapter never changes the durable skill result execution identity on reconnect', async t => {
  const f = await fixture(t); f.socket.receive(f.ack()); await f.activation
  const result = durableSkillResult()
  const bytes = JSON.stringify(result)
  assert.equal(f.state.transport.send(result), true)
  const wire = f.sent.at(-1)
  assert.deepEqual(wire, result, 'transport cannot inject current boot/session or rewrite durable SM-C1 facts')
  assert.equal(wire.data.executionRuntimeInstanceId, 'execution-boot')
  assert.equal(Object.hasOwn(wire.data, 'runtimeInstanceId'), false)
  assert.equal(wire.data.runtimeInstallationId, 'rti_1')
  assert.equal(JSON.stringify(result), bytes)
  for (const data of [{ agentId: 'foreign' }, { runtimeInstallationId: 'foreign' }, { executionRuntimeInstanceId: 'foreign' }, { resultSha256: 'f'.repeat(64) }]) {
    assert.equal(f.state.transport.send({ ...result, data: { ...result.data, ...data } }), false)
  }
})
test('public ping produces a correlated pong rather than a flat control alias', async t => {
  const f = await fixture(t); f.socket.receive(f.ack()); await f.activation
  f.socket.receive({ protocolVersion: 1, requestId: 'ping-request', messageType: 'connection.ping', messageId: 'ping-message', data: {} }); await tick()
  assert.equal(f.sent.at(-1).messageType, 'connection.pong'); assert.equal(f.sent.at(-1).correlationId, 'ping-message')
  assert.equal(f.sent.at(-1).requestId, 'ping-request'); assert.equal(f.sent.at(-1).code, 'E0')
})
