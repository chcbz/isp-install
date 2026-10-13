import test from 'node:test'
import assert from 'node:assert/strict'
import { skillSessionBinding } from '../../cyf-agent-runtime-v1/lib/execution-adapter.mjs'
import { bindMeasuredSkillSession, refreshMeasuredSkills, buildAgentRegistrationPayload, buildAgentPresencePayload, runManagedCommand } from '../agent-client.mjs'

const session = { tenantId: '0', clientId: 'client', canonicalAgentId: 'agent', installationId: 'rti_1',
  hostId: 'host', runtimeInstanceId: 'runtime', sessionGeneration: 24, sessionToken: 'NEVER_COPY' }
const receipt = (overrides = {}) => ({ runtimeAuth: { scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client',
  ownerJiacn: 'owner', agentId: 'agent', installationId: 'rti_1', hostId: 'host', runtimeInstanceId: 'runtime',
  sessionGeneration: 24, contextPackEnabled: true, ...overrides } })
const state = (loadInstalled = () => []) => {
  let publishes = 0
  return { profile: { agentId: 'agent', runtimeIdentity: session, runtimeInstanceId: 'runtime' },
    skillInstallManager: { listInstalledSkills: loadInstalled }, disposed: false,
    runtimeTransport: { reportReady: () => true, refreshCapabilities: () => { publishes++; return true } },
    publications: () => publishes }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('authenticated receipt yields only frozen scope/fence, never session secret or endpoint', () => {
  const bound = skillSessionBinding(receipt({ token: 'OTHER_SECRET', endpoint: '/private' }), session)
  assert.equal(bound.scope.ownerJiacn, 'owner'); assert.equal(bound.fence.sessionGeneration, 24)
  assert.equal(JSON.stringify(bound).includes('SECRET'), false); assert.equal(JSON.stringify(bound).includes('/private'), false)
  assert.throws(() => { bound.scope.ownerJiacn = 'foreign' }, TypeError)
})
test('every scope/fence field must match current validated session; owner cannot come from profile', () => {
  for (const key of ['scheme', 'tenantId', 'clientId', 'agentId', 'installationId', 'hostId', 'runtimeInstanceId', 'sessionGeneration']) {
    assert.equal(skillSessionBinding(receipt({ [key]: 'foreign' }), session), null, key)
  }
  for (const ownerJiacn of [undefined, null, 5, '', ' owner', 'owner\n', 'o'.repeat(51)]) {
    assert.equal(skillSessionBinding(receipt({ ownerJiacn }), session), null)
  }
  assert.equal(skillSessionBinding({}, session), null); assert.equal(skillSessionBinding(receipt(), null), null)
})
test('ACK bootstraps the catalog once; repeated refresh ACK never starts a registration loop', async () => {
  let loads = 0; const current = state(() => { loads++; return [] })
  assert.equal(bindMeasuredSkillSession(current, skillSessionBinding(receipt(), session)), true)
  await tick(); assert.equal(loads, 1); assert.equal(current.publications(), 1)
  assert.deepEqual(current.skillRegistry.declaration().skills, [])
  for (let i = 0; i < 5; i++) assert.equal(bindMeasuredSkillSession(current, skillSessionBinding(receipt(), session)), false)
  await tick(); assert.equal(loads, 1); assert.equal(current.publications(), 1)
})
test('cached registration is IO free, unavailable before measurement and omitted offline', async () => {
  let loads = 0; const current = state(() => { loads++; return [] })
  assert.equal(buildAgentRegistrationPayload(current.profile).skillExecution, undefined)
  bindMeasuredSkillSession(current, skillSessionBinding(receipt(), session)); await tick()
  for (let i = 0; i < 5; i++) {
    const payload = buildAgentRegistrationPayload(current.profile, null, true, null, null, null, current.skillRegistry)
    assert.equal(payload.skillExecution, current.skillRegistry.declaration())
  }
  assert.equal(buildAgentRegistrationPayload(current.profile, null, false, null, null, null, current.skillRegistry).skillExecution, undefined)
  assert.equal(loads, 1)
  assert.equal(buildAgentPresencePayload(current.profile, 'online', { skillRegistry: current.skillRegistry }).skillExecution, current.skillRegistry.declaration())
  assert.equal(buildAgentPresencePayload(current.profile, 'offline', { skillRegistry: current.skillRegistry }).skillExecution, undefined)
})
test('owner/session replacement invalidates old snapshot; missing receipt cannot retain directory', async () => {
  const current = state(); bindMeasuredSkillSession(current, skillSessionBinding(receipt(), session)); await tick()
  const old = current.skillRegistry
  bindMeasuredSkillSession(current, skillSessionBinding(receipt({ ownerJiacn: 'next-owner' }), session)); await tick()
  assert.equal(old.declaration(), null); assert.equal(current.skillRegistry.scope.ownerJiacn, 'next-owner')
  bindMeasuredSkillSession(current, null); assert.equal(current.skillRegistry.declaration(), null)
  assert.throws(() => bindMeasuredSkillSession(current, { scope: { tenantId: 'foreign' }, fence: {} }), { code: 'SKILL_SESSION_SCOPE_MISMATCH' })
})
test('old asynchronous measurement never re-registers after disconnect or a new generation', async () => {
  const pending = []; const current = state(() => new Promise(resolve => pending.push(resolve)))
  bindMeasuredSkillSession(current, skillSessionBinding(receipt(), session))
  current.skillRegistry.setSession(null)
  bindMeasuredSkillSession(current, skillSessionBinding(receipt({ sessionGeneration: 25 }), { ...session, sessionGeneration: 25 }))
  pending[1]([]); await tick(); assert.equal(current.publications(), 1)
  pending[0]([]); await tick(); assert.equal(current.publications(), 1)
  assert.equal(current.skillRegistry.fence.sessionGeneration, 25)
})
test('install lifecycle preserves durable success and failure even when catalog callbacks fail', async () => {
  const phases = [], output = { status: 'SUCCESS', manifestSha256: 'a'.repeat(64) }
  const options = { profile: {}, message: { commandType: 'SKILL_INSTALL' },
    onSkillInstallChanged: phase => { phases.push(phase); throw new Error('catalog failed') } }
  assert.equal(await runManagedCommand({ ...options, skillInstallManager: { execute: async () => output } }), output)
  assert.deepEqual(phases, ['changing', 'changed']); phases.length = 0
  const failure = new Error('actual installation failure')
  await assert.rejects(runManagedCommand({ ...options, skillInstallManager: { execute: async () => { throw failure } } }), error => error === failure)
  assert.deepEqual(phases, ['changing', 'changed'])
})
test('refresh errors remove catalog and publication failure does not change measurement', async () => {
  const current = state(); bindMeasuredSkillSession(current, skillSessionBinding(receipt(), session)); await tick()
  current.skillRegistry.loadInstalled = () => { throw new Error('private state') }
  assert.equal(await refreshMeasuredSkills(current), null); assert.equal(current.publications(), 2)
  current.skillRegistry.loadInstalled = () => []; current.runtimeTransport.refreshCapabilities = () => { throw new Error('disconnected') }
  assert.deepEqual((await refreshMeasuredSkills(current)).skills, [])
})
