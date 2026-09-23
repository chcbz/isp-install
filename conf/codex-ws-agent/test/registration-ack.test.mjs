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
  token: 'secret-registration-token',
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

test('invalid acknowledgement identity, status, or token never marks registered', () => {
  for (const changed of [
    { agentId: 'other-agent' },
    { status: 'offline' },
    { token: '' },
    { token: `bad\ntoken` }
  ]) {
    const f = fixture()
    const { envelope } = send(f)
    assert.equal(f.observer.observe({ ...ack(envelope), ...changed }), null)
    assert.equal(f.observer.registered, false)
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


test('observation timeout never weakens identity, correlation or token validation', () => {
  const f = fixture()
  const { envelope } = send(f)
  f.fireTimers()
  for (const changed of [
    { messageId: 'wrong-request' }, { runtimeInstanceId: 'wrong-runtime' },
    { agentId: 'wrong-agent' }, { status: 'offline' }, { token: '' },
    { token: 'bad\ntoken' }
  ]) {
    assert.equal(f.observer.observe({ ...ack(envelope), ...changed }), null)
    assert.equal(f.observer.registered, false)
    assert.equal(f.observer.runtimeAuthHeader, '')
  }
  assert.equal(f.observer.observe(ack(envelope)), 'registered')
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
