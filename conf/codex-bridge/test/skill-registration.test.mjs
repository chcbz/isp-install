import test from 'node:test'
import assert from 'node:assert/strict'
import { fromAgentWire } from '../agent-message-wire.mjs'
import { command, packageFixture } from './fixtures/skill-management-fixture.mjs'
import { skillSessionBinding } from '../../cyf-agent-runtime-v1/lib/execution-adapter.mjs'
import { bindMeasuredSkillSession, refreshMeasuredSkills, buildAgentRegistrationPayload, buildAgentPresencePayload, runManagedCommand } from '../agent-client.mjs'

const session = { tenantId: '0', clientId: 'client', canonicalAgentId: 'agent', installationId: 'rti_1',
  hostId: 'host', runtimeInstanceId: 'runtime', sessionGeneration: '24', sessionToken: 'NEVER_COPY' }
const receipt = (overrides = {}) => ({ runtimeAuth: { scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client',
  ownerJiacn: 'owner', agentId: 'agent', installationId: 'rti_1', hostId: 'host', runtimeInstanceId: 'runtime',
  sessionGeneration: '24', contextPackEnabled: true, ...overrides } })
const state = (loadInstalled = () => []) => {
  let publishes = 0
  return { profile: { agentId: 'agent', runtimeIdentity: session, runtimeInstanceId: 'runtime' },
    skillInstallManager: { listInstalledSkills: loadInstalled, bindSession(binding) { this.session = binding } }, disposed: false,
    runtimeTransport: { reportReady: () => true, refreshCapabilities: () => { publishes++; return true } },
    publications: () => publishes }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('authenticated receipt yields only frozen scope/fence, never session secret or endpoint', () => {
  const bound = skillSessionBinding(receipt({ token: 'OTHER_SECRET', endpoint: '/private' }), session)
  assert.equal(bound.scope.ownerJiacn, 'owner'); assert.equal(bound.fence.sessionGeneration, '24')
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
  assert.deepEqual([...current.skillRunners.keys()], ['local-script'])
  assert.equal(typeof current.skillRunners.get('local-script').run, 'function')
  assert.equal(typeof current.skillRunners.get('local-script').probe, 'function')
  assert.equal(typeof current.skillRegistry.tools.get('node'), 'function')
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
  // Presence is status-only; only acknowledged registration publishes the catalog.
  assert.equal(buildAgentPresencePayload(current.profile, 'online', { skillRegistry: current.skillRegistry }).skillExecution, undefined)
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
  bindMeasuredSkillSession(current, skillSessionBinding(receipt({ sessionGeneration: '25' }), { ...session, sessionGeneration: '25' }))
  pending[1]([]); await tick(); assert.equal(current.publications(), 1)
  pending[0]([]); await tick(); assert.equal(current.publications(), 1)
  assert.equal(current.skillRegistry.fence.sessionGeneration, '25')
})
test('SM-C1 delegates unchanged to durable manager; retired callbacks never rewrite result or error', async () => {
  const message = command(packageFixture().target)
  const output = { resultEnvelope: { data: { evidence: { outcome: 'PREPARED' } } } }
  let handled = 0
  const options = { profile: {}, message,
    runCodexFn: () => assert.fail('management cannot execute as a task'),
    onSkillInstallChanged: () => assert.fail('retired task callback cannot own management lifecycle') }
  const manager = { handle: async received => { assert.equal(received, message); handled++; return output },
    execute: () => assert.fail('management must be durably received before execution') }
  assert.equal(await runManagedCommand({ ...options, skillInstallManager: manager }), output)
  assert.equal(handled, 1)
  const failure = new Error('actual durable management failure')
  await assert.rejects(runManagedCommand({ ...options, skillInstallManager: { handle: async () => { throw failure } } }), error => error === failure)
  for (const commandType of ['SKILL_INSTALL', 'SKILL_SET_ENABLED', 'SKILL_RECONCILE']) {
    await assert.rejects(runManagedCommand({ ...options, message: { commandType }, skillInstallManager: manager }), { code: 'SKILL_MANAGEMENT_SCHEMA_REQUIRED' })
  }
  assert.equal(handled, 1)
})
test('refresh errors remove catalog and publication failure does not change measurement', async () => {
  const current = state(); bindMeasuredSkillSession(current, skillSessionBinding(receipt(), session)); await tick()
  current.skillRegistry.loadInstalled = () => { throw new Error('private state') }
  assert.equal(await refreshMeasuredSkills(current), null); assert.equal(current.publications(), 2)
  current.skillRegistry.loadInstalled = () => []; current.runtimeTransport.refreshCapabilities = () => { throw new Error('disconnected') }
  assert.deepEqual((await refreshMeasuredSkills(current)).skills, [])
})

// Regression for the actual public r1 ACK -> native binding -> measured catalog chain.
test('public string session generation reaches measured registration without losing int64 precision', async () => {
  for (const version of ['38', '9007199254740993', '9223372036854775807']) {
    const current = state()
    const nativeSession = { ...session, sessionGeneration: version }
    const auth = { ...receipt({ sessionGeneration: version }).runtimeAuth }
    auth.runtimeInstallationId = auth.installationId; delete auth.installationId
    const decoded = fromAgentWire(JSON.stringify({ protocolVersion: 1, requestId: 'r', messageId: 'reply',
      messageType: 'agent.registered', correlationId: 'registration', code: 'E0', msg: 'ok',
      data: { schemaVersion: 1, sessionGeneration: version, runtimeAuth: auth } }))
    assert.equal(bindMeasuredSkillSession(current, skillSessionBinding(decoded, nativeSession)), true)
    await tick()
    assert.equal(current.skillRegistry.fence.sessionGeneration, version)
    assert.deepEqual(current.skillRegistry.declaration().skills, [])
    assert.equal(current.publications(), 1)
  }
})


test('real Runtime task-readiness projection never advertises taskless management as D06 commands', async () => {
  const { runtimeReadyCommandTypes } = await import('../agent-client.mjs')
  const current = { processor: {}, skillInstallManager: { enabled: true }, workspaceManager: {}, commandAdapterReady: true }
  const taskTypes = ['TASK_INVITE', 'WORK_ITEM_EXECUTE', 'WORK_ITEM_RESUME', 'REQUEST_RESPOND', 'REVIEW_EXECUTE', 'CONTEXT_REFRESH']
  assert.deepEqual(runtimeReadyCommandTypes(current), taskTypes)
  current.skillInstallManager.enabled = false
  assert.deepEqual(runtimeReadyCommandTypes(current), taskTypes)
  current.commandAdapterReady = false
  current.skillInstallManager.enabled = true
  assert.deepEqual(runtimeReadyCommandTypes(current), [], 'management readiness does not grant task adapter readiness')
  current.commandAdapterReady = true
  current.processor.failClosedError = new Error('durable inbox unavailable')
  assert.deepEqual(runtimeReadyCommandTypes(current), [])
  delete current.processor.failClosedError
  current.disposed = true
  assert.deepEqual(runtimeReadyCommandTypes(current), [])
  assert.deepEqual(runtimeReadyCommandTypes(null), [])
})
