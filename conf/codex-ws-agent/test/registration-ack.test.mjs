import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { RegistrationAckObserver, sendRegistrationWithAckObservation } from '../registration-ack.mjs'

const proof = { installationId: 'synthetic-installation', hostId: 'synthetic-host', sessionGeneration: 7 }
function fixture() {
  const callbacks = new Map(); const logs = []; let next = 0
  const observer = new RegistrationAckObserver({ agentId: 'agent-a', runtimeInstanceId: 'boot-a', sessionProof: proof,
    schedule: callback => { callbacks.set(++next, callback); return next }, cancel: id => callbacks.delete(id),
    logger: { log: line => logs.push(line), warn: line => logs.push(line) } })
  const send = (id = 'register-a', result = true) => sendRegistrationWithAckObservation({ observer, envelope: { messageId: id }, send: () => result })
  return { observer, logs, send, fire: () => { const all = [...callbacks.values()]; callbacks.clear(); all.forEach(fn => fn()) }, callbacks }
}
const ack = (patch = {}) => ({ type: 'agent_registered', agentId: 'agent-a', runtimeInstanceId: 'boot-a', messageId: 'register-a', status: 'online',
  ...proof, durableStateHealthy: true, readyCommandTypes: ['TASK_INVITE'], ...patch })

test('token-free receipt is strictly correlated to request/identity/boot/session proof', () => {
  const f = fixture(); f.send()
  for (const patch of [{ type: 'agent_status' }, { agentId: 'foreign' }, { messageId: 'stale' }, { runtimeInstanceId: 'old' },
    { installationId: 'foreign' }, { hostId: 'foreign' }, { sessionGeneration: 6 }, { sessionGeneration: undefined }, { status: 'offline' },
    { token: 'retired' }, { sessionToken: 'rts1_' + 'a'.repeat(64) }, { durableStateHealthy: undefined }, { readyCommandTypes: null }]) {
    assert.equal(f.observer.observe(ack(patch)), null); assert.equal(f.observer.registered, false)
  }
  assert.equal(f.observer.observe(ack()), 'registered'); assert.equal(f.callbacks.size, 0)
  assert.deepEqual(f.observer.snapshot(), { stage: 'registered', registered: true }); assert.equal(f.observer.runtimeAuthHeader, undefined)
});

test('unhealthy or zero-adapter channel receipt authenticates but does not invent capabilities', () => {
  const f = fixture(); f.send(); assert.equal(f.observer.observe(ack({ durableStateHealthy: false, readyCommandTypes: [] })), 'registered')
});

test('slow exact registration receipt remains valid after observational timeout', async () => {
  const f = fixture(); f.send(); const pending = f.observer.waitForRegistration(); f.fire()
  assert.equal(f.observer.snapshot().stage, 'ack_timeout'); assert.equal(f.observer.observe(ack()), 'registered')
  assert.deepEqual(await pending, { stage: 'registered', registered: true })
});

test('new attempt, disconnect and send failure invalidate old receipt', () => {
  for (const action of ['new', 'disconnect', 'failed']) {
    const f = fixture(); f.send(); f.fire()
    if (action === 'new') f.send('register-b')
    else if (action === 'disconnect') f.observer.disconnect()
    else f.send('register-b', false)
    assert.equal(f.observer.observe(ack()), null); assert.equal(f.observer.registered, false)
  }
});

test('correlated rejection and disconnect release waiters without raw payload logging', async () => {
  for (const action of ['reject', 'disconnect', 'failed']) {
    const f = fixture(); f.send()
    const pending = assert.rejects(f.observer.waitForRegistration(), error => error.code === 'NATIVE_RUNTIME_REGISTRATION_UNAVAILABLE')
    if (action === 'reject') f.observer.observe({ type: 'protocol_error', messageId: 'register-a', runtimeInstanceId: 'boot-a', message: 'synthetic-private-payload' })
    else if (action === 'disconnect') f.observer.disconnect()
    else f.observer.sendFailed('register-a')
    await pending; assert.equal(f.logs.join('\n').includes('synthetic-private-payload'), false)
    await assert.rejects(f.observer.waitForRegistration(), error => error.code === 'NATIVE_RUNTIME_REGISTRATION_REQUIRED')
  }
});

test('nested data receipt works once; duplicate cannot rotate any credential', () => {
  const f = fixture(); f.send(); assert.equal(f.observer.observe({ type: 'agent_registered', data: ack() }), 'registered')
  assert.equal(f.observer.observe(ack({ sessionToken: 'retired' })), null); assert.equal(f.observer.runtimeAuthHeader, undefined)
});

test('superseded registration retains readiness waiter until latest exact receipt', async () => {
  const f = fixture(); f.send(); const pending = f.observer.waitForRegistration()
  f.send('register-b'); f.fire(); assert.equal(f.observer.observe(ack()), null)
  assert.equal(f.observer.observe(ack({ messageId: 'register-b' })), 'registered'); assert.equal((await pending).registered, true)
});

test('source uses unified adapter lifecycle, no legacy connect/auth entry', () => {
  const source = readFileSync(new URL('../agent-client.mjs', import.meta.url), 'utf8')
  assert.match(source, /UNIFIED_RUNTIME_ENTRY_REQUIRED/); assert.doesNotMatch(source, /const connectProfile =/)
  assert.doesNotMatch(source, /const startProfileWatcher =/); assert.doesNotMatch(source, /registration\.runtimeAuthHeader/)
});
