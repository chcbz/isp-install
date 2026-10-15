import test from 'node:test'
import assert from 'node:assert/strict'
import { identityOf, validateRuntimeSession, runtimeSessionHeaders, validateCommandForManifest, validateRuntimeAckResult, validateEnrollmentResult } from '../lib/runtime-client.mjs'
const manifest = { installationId: 'rti_test', tenantId: 't', clientId: 'c', canonicalAgentId: 'a', manifestVersion: '1', manifestSha256: `sha256:${'a'.repeat(64)}` }
const session = () => ({ runtimeInstallationId: manifest.installationId, tenantId: 't', clientId: 'c', canonicalAgentId: 'a', hostId: 'h', runtimeInstanceId: 'r', sessionGeneration: '9007199254740993', scheme: 'AgentRuntime', sessionToken: `rts1_${'b'.repeat(64)}`, websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' })
test('public identity adapts from unchanged private manifest', () => {
  const wire = identityOf(manifest)
  assert.equal(wire.runtimeInstallationId, manifest.installationId)
  assert.equal(Object.hasOwn(wire, 'installationId'), false)
  assert.equal(manifest.installationId, 'rti_test')
})
test('session generation retains full Long precision through headers', () => {
  const value = validateRuntimeSession(session(), { manifest, hostId: 'h', runtimeInstanceId: 'r', previousGeneration: '9007199254740992' })
  assert.equal(value.sessionGeneration, '9007199254740993')
  assert.equal(runtimeSessionHeaders(value)['X-Agent-Session-Generation'], '9007199254740993')
  for (const generation of [1, '01', '-1', '9223372036854775808']) assert.throws(() => validateRuntimeSession({ ...session(), sessionGeneration: generation }, { manifest, hostId: 'h', runtimeInstanceId: 'r' }))
  assert.throws(() => validateRuntimeSession({ ...session(), runtimeInstallationId: undefined, installationId: 'rti_test' }, { manifest, hostId: 'h', runtimeInstanceId: 'r' }))
})
test('ACK result compares decimal versions without Number rounding', () => {
  assert.equal(validateRuntimeAckResult({ kind: 'ADVANCED', status: 'STARTED', deliveryVersion: '9007199254740993' }, 'STARTED', '9007199254740992').deliveryVersion, '9007199254740993')
  assert.throws(() => validateRuntimeAckResult({ kind: 'ADVANCED', status: 'STARTED', deliveryVersion: '9007199254740992' }, 'STARTED', '9007199254740992'))
  assert.throws(() => validateRuntimeAckResult({ kind: 'ADVANCED', status: 'STARTED', deliveryVersion: 1 }, 'STARTED'))
})
test('ACK command accepts epoch milliseconds, not legacy ISO wire', () => {
  const command = { runtimeInstallationId: 'rti_test', tenantId: 't', clientId: 'c', canonicalAgentId: 'a', messageId: 'm', correlationId: 'c', commandId: 'cmd', taskId: 'task', workItemId: null, payloadReference: null, expiresAt: 2000 }
  assert.equal(validateCommandForManifest(command, manifest, 'RECEIVED', 1000).expiresAt, 2000)
  assert.throws(() => validateCommandForManifest({ ...command, expiresAt: '1970-01-01T00:00:02Z' }, manifest, 'RECEIVED', 1000))
})
test('enrollment wire changes do not rename private authorization fields', () => {
  const value = validateEnrollmentResult({ installation: { ...identityOf(manifest), enrollmentExpiresAt: 2000, status: 'ACTIVE', lastHeartbeatAt: null }, runtimeAuthorization: `rta1_${'b'.repeat(64)}` }, manifest)
  assert.equal(value.installationId, manifest.installationId)
  assert.equal(Object.hasOwn(value, 'runtimeInstallationId'), false)
})
