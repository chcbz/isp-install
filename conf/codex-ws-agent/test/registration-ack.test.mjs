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

test('matching server rejection records only a redacted stage and safe code', () => {
  const f = fixture()
  const { envelope } = send(f)
  const rawServerMessage = `denied ${secret.apiKey} ${secret.agentId} ${secret.payload}`
  assert.equal(f.observer.observe({
    type: 'protocol_error',
    messageType: 'protocol.error',
    messageId: envelope.messageId,
    runtimeInstanceId,
    code: `BAD CODE ${secret.apiKey}`,
    message: rawServerMessage,
    token: secret.token
  }), 'rejected')
  assert.deepEqual(f.observer.snapshot(), { stage: 'rejected', registered: false })
  assert.equal(f.timerCount(), 0)
  assert.equal(f.logs.at(-1), 'registration stage=rejected | code=SERVER_REJECTED')
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
  assert.match(source, /const registrationOutcome = state\?\.registration\.observe\(parsed\)/)
  assert.match(source, /registrationOutcome === 'registered'.*managedHostModule\?\.managedRegistration/s)
  assert.match(source, /registrationAckTimeoutMs: parseNonNegativeMs\(process\.env\.REGISTRATION_ACK_TIMEOUT_MS, 10000\)/)
  assert.ok((source.match(/registration\.disconnect\(\)/g) || []).length >= 3)
})
