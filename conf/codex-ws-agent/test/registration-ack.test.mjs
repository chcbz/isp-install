import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  RegistrationAckObserver,
  sendRegistrationWithAckObservation
} from '../registration-ack.mjs'

const secret = {
  agentId: 'sensitive-agent-identity',
  apiKey: 'secret-api-key',
  token: 'a'.repeat(32),
  payload: 'secret-full-payload'
}
const profile = {
  profileId: 'sensitive-profile-identity',
  agentId: secret.agentId,
  agentName: 'Sensitive Agent Name',
  personaName: 'Sensitive Persona',
  codexWorkdir: process.cwd()
}
const runtimeInstanceId = 'runtime-fixture'

const fixture = () => {
  let sequence = 0
  const scheduled = new Map()
  const logs = []
  const observer = new RegistrationAckObserver({
    agentId: profile.agentId,
    runtimeInstanceId,
    timeoutMs: 25,
    schedule: callback => {
      const id = ++sequence
      scheduled.set(id, callback)
      return id
    },
    cancel: id => scheduled.delete(id),
    logger: {
      log: message => logs.push(message),
      warn: message => logs.push(message)
    }
  })
  return {
    observer,
    logs,
    fireTimers: () => {
      const callbacks = [...scheduled.values()]
      scheduled.clear()
      callbacks.forEach(callback => callback())
    },
    timerCount: () => scheduled.size
  }
}

const send = (f, result = true) => {
  const envelope = {
    messageType: 'agent.register',
    messageId: `registration-${Date.now()}-${Math.random()}`,
    runtimeInstanceId,
    agentId: profile.agentId,
    apiKey: secret.apiKey,
    payload: secret.payload
  }
  const sent = sendRegistrationWithAckObservation({
    observer: f.observer,
    envelope,
    send: () => result
  })
  return { sent, envelope }
}

const ack = envelope => ({
  type: 'agent_registered',
  messageId: envelope.messageId,
  runtimeInstanceId,
  agentId: secret.agentId,
  status: 'online',
  token: secret.token,
  runtimeAuth: {
    scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client-confirmed', ownerJiacn: 'owner-confirmed',
    agentId: secret.agentId, runtimeInstanceId, contextPackEnabled: true
  },
  payload: secret.payload
})

test('registration send stays pending until the matching applied ACK', () => {
  const f = fixture()
  const { sent, envelope } = send(f)
  assert.equal(sent, true)
  assert.deepEqual(f.observer.snapshot(), { stage: 'pending_ack', registered: false })
  assert.equal(f.timerCount(), 1)

  assert.equal(f.observer.observe({ ...ack(envelope), type: 'agent_status' }), null)
  assert.equal(f.observer.observe({ ...ack(envelope), messageId: 'stale-request' }), null)
  assert.equal(f.observer.observe({ ...ack(envelope), runtimeInstanceId: 'old-runtime' }), null)
  assert.equal(f.observer.registered, false)

  assert.equal(f.observer.observe(ack(envelope)), 'registered')
  assert.deepEqual(f.observer.snapshot(), { stage: 'registered', registered: true })
  assert.equal(f.timerCount(), 0)
  assert.deepEqual(f.logs, [
    'registration stage=pending_ack',
    'registration stage=registered'
  ])
})

test('valid runtime tokens are held only in memory and cleared before a new registration or disconnect', () => {
  const f = fixture()
  const { envelope } = send(f)
  assert.equal(f.observer.observe({ ...ack(envelope), token: 'a'.repeat(32) }), 'registered')
  assert.equal(f.observer.runtimeAuthHeader, `AgentRuntime ${'a'.repeat(32)}`)
  assert.equal(JSON.stringify(f.observer.snapshot()).includes('a'.repeat(32)), false)
  f.observer.begin('next-registration')
  assert.equal(f.observer.runtimeAuthHeader, '')
  f.observer.disconnect()
  assert.equal(f.observer.runtimeAuthHeader, '')
})

test('legacy ACK preserves ordinary registration but confers no controlled native authority', () => {
  const f = fixture()
  const { envelope } = send(f)
  const legacy = ack(envelope)
  delete legacy.runtimeAuth
  legacy.token = 'legacy-registration-token'
  assert.equal(f.observer.observe(legacy), 'registered')
  assert.equal(f.observer.registered, true)
  assert.equal(f.observer.runtimeScope, null)
  assert.equal(f.observer.runtimeAuthHeader, '')
  assert.equal(f.observer.nativeRuntimeAuthHeader, '')

  const hex = fixture()
  const { envelope: hexEnvelope } = send(hex)
  const legacyHex = ack(hexEnvelope)
  delete legacyHex.runtimeAuth
  assert.equal(hex.observer.observe(legacyHex), 'registered')
  assert.equal(hex.observer.runtimeAuthHeader, `AgentRuntime ${secret.token}`)
  assert.equal(hex.observer.nativeRuntimeAuthHeader, '')
})

test('exact native receipt is retained in memory and cleared with its token', () => {
  const f = fixture()
  const { envelope } = send(f)
  assert.equal(f.observer.observe(ack(envelope)), 'registered')
  assert.deepEqual(f.observer.runtimeScope, ack(envelope).runtimeAuth)
  assert.equal(f.observer.nativeRuntimeAuthHeader, `AgentRuntime ${secret.token}`)
  assert.equal(JSON.stringify(f.observer.snapshot()).includes('client-confirmed'), false)
  f.observer.disconnect()
  assert.equal(f.observer.runtimeScope, null)
  assert.equal(f.observer.runtimeAuthHeader, '')
})

test('invalid legacy acknowledgement remains pending while malformed claimed native authority rejects', () => {
  for (const changed of [{ agentId: 'other-agent' }, { status: 'offline' }]) {
    const f = fixture()
    const { envelope } = send(f)
    assert.equal(f.observer.observe({ ...ack(envelope), ...changed }), null)
    assert.equal(f.observer.registered, false)
  }
  for (const changed of [{ token: '' }, { token: `bad
token` }, { runtimeAuth: { scheme: 'native-runtime-v1' } }]) {
    const f = fixture()
    const { envelope } = send(f)
    assert.equal(f.observer.observe({ ...ack(envelope), ...changed }), 'rejected')
    assert.equal(f.observer.registered, false)
    assert.equal(f.observer.nativeRuntimeAuthHeader, '')
  }
})

test('matching server rejection records only a redacted stage', () => {
  const f = fixture()
  const { envelope } = send(f)
  const rawServerMessage = `denied ${secret.apiKey} ${secret.agentId} ${secret.payload}`
  assert.equal(f.observer.observe({
    type: 'protocol_error',
    messageType: 'protocol.error',
    messageId: envelope.messageId,
    runtimeInstanceId,
    code: `SECRET_KEY_${secret.apiKey}`,
    message: rawServerMessage,
    token: secret.token
  }), 'rejected')
  assert.deepEqual(f.observer.snapshot(), { stage: 'rejected', registered: false })
  assert.equal(f.timerCount(), 0)
  assert.equal(f.logs.at(-1), 'registration stage=rejected')
  const output = f.logs.join('\n')
  for (const value of Object.values(secret)) assert.equal(output.includes(value), false)
  assert.equal(output.includes(rawServerMessage), false)
})

test('ACK timeout and send failure remain unregistered with explicit stages', () => {
  const timedOut = fixture()
  send(timedOut)
  timedOut.fireTimers()
  assert.deepEqual(timedOut.observer.snapshot(), { stage: 'ack_timeout', registered: false })
  assert.equal(timedOut.logs.at(-1), 'registration stage=ack_timeout')

  const failed = fixture()
  const result = send(failed, false)
  assert.equal(result.sent, false)
  assert.deepEqual(failed.observer.snapshot(), { stage: 'send_failed', registered: false })
  assert.equal(failed.timerCount(), 0)
  assert.equal(failed.logs.at(-1), 'registration stage=send_failed')
})

test('late exact ACK after observation timeout completes current registration', () => {
  const f = fixture()
  const { envelope } = send(f)
  f.fireTimers()
  assert.equal(f.observer.observe({ ...ack(envelope), token: 'b'.repeat(32) }), 'registered')
  assert.deepEqual(f.observer.snapshot(), { stage: 'registered', registered: true })
  assert.equal(f.observer.runtimeAuthHeader, `AgentRuntime ${'b'.repeat(32)}`)
  assert.equal(f.timerCount(), 0)
})

test('disconnect cancels pending timeout and a new registration rejects stale ACKs', () => {
  const f = fixture()
  const first = send(f).envelope
  f.observer.disconnect()
  assert.deepEqual(f.observer.snapshot(), { stage: 'disconnected', registered: false })
  assert.equal(f.timerCount(), 0)
  f.fireTimers()
  assert.equal(f.observer.snapshot().stage, 'disconnected')

  const second = send(f).envelope
  assert.equal(f.observer.observe(ack(first)), null)
  assert.equal(f.observer.observe(ack(second)), 'registered')
})

test('agent runtime wires send, inbound control, timeout, and disconnect to the observer', () => {
  const source = readFileSync(new URL('../agent-client.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ RegistrationAckObserver, sendRegistrationWithAckObservation \} from '\.\/registration-ack\.mjs'/)
  assert.match(source, /const envelope = buildProtocolEnvelope\(\s*MESSAGE_TYPES\.AGENT_REGISTER,/)
  assert.match(source, /sendRegistrationWithAckObservation\(\{\s*observer: state\.registration,\s*envelope,/)
  assert.match(source, /if \(profile\.managedGeneration && managedHostModule\?\.managedRegistration\(parsed, profile, PROCESS_RUNTIME_INSTANCE_ID\)\)/)
  assert.match(source, /const registrationOutcome = state\?\.registration\.observe\(parsed\)/)
  assert.match(source, /state\.workspaceFileRuntimeAuthHeader = state\.registration\.runtimeAuthHeader/)
  assert.match(source, /workspaceFileRuntimeAuthHeader: state\.workspaceFileRuntimeAuthHeader/)
  assert.match(source, /registrationAckTimeoutMs: parseNonNegativeMs\(process\.env\.REGISTRATION_ACK_TIMEOUT_MS, 10000\)/)
  assert.ok((source.match(/registration\.disconnect\(\)/g) || []).length >= 3)
})


test('observation timeout never weakens identity, correlation or native receipt validation', () => {
  for (const changed of [
    { messageId: 'wrong-request' }, { runtimeInstanceId: 'wrong-runtime' },
    { agentId: 'wrong-agent' }, { status: 'offline' }, { token: '' },
    { token: 'bad\ntoken' }, { runtimeAuth: { scheme: 'native-runtime-v1' } }
  ]) {
    const f = fixture()
    const { envelope } = send(f)
    f.fireTimers()
    const outcome = f.observer.observe({ ...ack(envelope), ...changed })
    if (changed.messageId || changed.runtimeInstanceId || changed.agentId || changed.status) assert.equal(outcome, null)
    else assert.equal(outcome, 'rejected')
    assert.equal(f.observer.registered, false)
    assert.equal(f.observer.runtimeAuthHeader, '')
    assert.equal(f.observer.runtimeScope, null)
  }
})

test('new attempt, disconnect and send failure invalidate late timeout ACKs', () => {
  for (const action of ['new-attempt', 'disconnect', 'send-failed']) {
    const f = fixture()
    const first = send(f).envelope
    f.fireTimers()
    if (action === 'new-attempt') send(f)
    if (action === 'disconnect') f.observer.disconnect()
    if (action === 'send-failed') send(f, false)
    assert.equal(f.observer.observe(ack(first)), null)
    assert.equal(f.observer.runtimeAuthHeader, '')
  }
})

test('correlated rejection after observation timeout remains terminal for that attempt', () => {
  const f = fixture()
  const { envelope } = send(f)
  f.fireTimers()
  assert.equal(f.observer.observe({ type: 'error', messageId: envelope.messageId, runtimeInstanceId }), 'rejected')
  assert.equal(f.observer.observe(ack(envelope)), null)
  assert.equal(f.observer.runtimeAuthHeader, '')
})

test('late nested ACK cannot rotate token again after exact registration completes', () => {
  const f = fixture()
  const { envelope } = send(f)
  f.fireTimers()
  assert.equal(f.observer.observe({ type: 'agent_registered', data: { ...ack(envelope), token: 'c'.repeat(32) } }), 'registered')
  assert.equal(f.observer.observe({ ...ack(envelope), token: 'd'.repeat(32) }), null)
  assert.equal(f.observer.runtimeAuthHeader, `AgentRuntime ${'c'.repeat(32)}`)
  for (const value of Object.values(secret)) assert.equal(f.logs.join('\n').includes(value), false)
  assert.equal(f.logs.join('\n').includes('c'.repeat(32)), false)
})

test('native readiness waits for the latest exact registration ACK across supersession and slow ACK', async () => {
  const f = fixture(); f.observer.begin('before-measurement')
  f.observer.observe({ type: 'agent_registered', agentId: profile.agentId, status: 'online', token: 'a'.repeat(32), messageId: 'before-measurement', runtimeInstanceId })
  f.observer.begin('inspection-measured'); let released = false
  const pending = f.observer.waitForRegistration().then(value => { released = true; return value })
  f.observer.begin('latest-measured'); f.fireTimers()
  f.observer.observe({ type: 'agent_registered', agentId: profile.agentId, status: 'online', token: 'b'.repeat(32), messageId: 'inspection-measured', runtimeInstanceId })
  await Promise.resolve(); assert.equal(released, false)
  f.observer.observe({ type: 'agent_registered', agentId: profile.agentId, status: 'online', token: 'c'.repeat(32), messageId: 'latest-measured', runtimeInstanceId })
  assert.deepEqual(await pending, { stage: 'registered', registered: true })
  assert.equal(f.observer.runtimeAuthHeader, `AgentRuntime ${'c'.repeat(32)}`)
  assert.equal(JSON.stringify(f.logs).includes('c'.repeat(32)), false)
})

test('native readiness rejects disconnected, rejected and failed registrations without exposing credentials', async () => {
  for (const terminal of ['disconnect', 'rejected', 'sendFailed']) {
    const f = fixture(); f.observer.begin('inspection-measured')
    const pending = assert.rejects(f.observer.waitForRegistration(), error => error.code === 'NATIVE_RUNTIME_REGISTRATION_UNAVAILABLE')
    if (terminal === 'rejected') f.observer.observe({ messageType: 'protocol.error', messageId: 'inspection-measured', runtimeInstanceId })
    else f.observer[terminal](...terminal === 'sendFailed' ? ['inspection-measured'] : [])
    await pending; assert.equal(f.observer.waiters.size, 0)
    await assert.rejects(f.observer.waitForRegistration(), error => error.code === 'NATIVE_RUNTIME_REGISTRATION_REQUIRED')
  }
})


test('merged readiness waiters release only after exact native receipt authority is installed', async () => {
  const f = fixture(); const first = send(f).envelope
  const waiting = f.observer.waitForRegistration().then(snapshot => ({ snapshot, scope: f.observer.runtimeScope, header: f.observer.nativeRuntimeAuthHeader }))
  const latest = send(f).envelope
  assert.equal(f.observer.observe(ack(first)), null)
  assert.equal(f.observer.nativeRuntimeAuthHeader, '')
  assert.equal(f.observer.observe(ack(latest)), 'registered')
  const ready = await waiting
  assert.deepEqual(ready.snapshot, { stage: 'registered', registered: true })
  assert.deepEqual(ready.scope, ack(latest).runtimeAuth)
  assert.equal(ready.header, `AgentRuntime ${secret.token}`)
  const generation = f.observer.generation
  f.observer.disconnect()
  assert.ok(f.observer.generation > generation)
  assert.equal(f.observer.nativeRuntimeAuthHeader, '')
  assert.equal(f.observer.runtimeScope, null)
  assert.equal(f.observer.observe(ack(latest)), null)
})

test('merged readiness waiters cannot acquire controlled authority from malformed or legacy ACKs', async () => {
  const invalid = fixture(); const envelope = send(invalid).envelope
  const denied = assert.rejects(invalid.observer.waitForRegistration(), error => error.code === 'NATIVE_RUNTIME_REGISTRATION_UNAVAILABLE')
  assert.equal(invalid.observer.observe({ ...ack(envelope), runtimeAuth: { ...ack(envelope).runtimeAuth, agentId: 'another-agent' } }), 'rejected')
  await denied
  assert.equal(invalid.observer.runtimeScope, null)
  assert.equal(invalid.observer.nativeRuntimeAuthHeader, '')
  const legacy = fixture(); const legacyEnvelope = send(legacy).envelope
  const waiting = legacy.observer.waitForRegistration()
  const { runtimeAuth, ...legacyReceipt } = ack(legacyEnvelope)
  assert.equal(legacy.observer.observe(legacyReceipt), 'registered')
  assert.deepEqual(await waiting, { stage: 'registered', registered: true })
  assert.equal(legacy.observer.runtimeScope, null)
  assert.equal(legacy.observer.nativeRuntimeAuthHeader, '')
})
