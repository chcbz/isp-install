import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentRegistrationPayload, buildAgentPresencePayload, buildProtocolEnvelope } from '../agent-client.mjs'
import { toAgentWire } from '../agent-message-wire.mjs'
import { SkillRegistry } from '../skill-registry.mjs'

const digest = 'a'.repeat(64)
const scope = { tenantId: '1', clientId: 'client', ownerJiacn: 'owner', agentId: 'agent' }
const fence = { installationId: 'installation', hostId: 'host', runtimeInstanceId: 'runtime', sessionGeneration: '1' }
const nativeExecution = { schemaVersion: 1, executionProtocolVersion: 5, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1',
  outputMimeTypes: ['text/plain', 'text/markdown', 'text/html', 'application/json', 'image/png'], supportedToolPolicyRefs: ['NATIVE_SKILL_SCRIPT_V1'] }
const inputs = count => Array.from({ length: count }, (_, i) => ({ mediaKind: 'file', mimeType: `application/x-fixture-${i}`,
  carrier: 'PARSED_TEXT', carrierContractDigest: `sha256:${digest}` }))
const row = i => ({ skillKey: `skill-${String(i).padStart(4, '0')}`, skillInstallationId: `installed-${String(i).padStart(4, '0')}`,
  productVersionId: 'product-0001', skillVersion: '1.0.0', packageSha256: digest, manifestSha256: null,
  kind: 'INSTRUCTION', manifest: null, enabled: true, policyRevision: '1' })
const wire = (profile, registry, supportedInputs) => JSON.stringify(toAgentWire(buildProtocolEnvelope('agent.register', {
  ...buildAgentRegistrationPayload(profile, null, true, null, {
    declaration: () => ({ supportedInputs, enginePolicyDigest: 'LOCAL_ONLY', recovery: 'LOCAL_ONLY' }),
    nativeExecutionDeclaration: () => nativeExecution
  }, null, registry), durableStateHealthy: true, readyCommandTypes: ['WORK_ITEM_EXECUTE'],
  tenantId: '1', clientId: 'client', hostId: 'host', installationId: 'installation', sessionGeneration: '1'
}, profile, 'runtime')))

test('registration growth follows current catalog, not refresh count or retained history; status stays constant', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'registration-footprint-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const profile = { agentId: 'agent', agentName: 'agent', personaName: 'agent', codexWorkdir: directory,
    typedDeliberationEnabled: true, workspaceFileApiOrigin: 'https://example.test', workspaceFileRootDir: directory }
  let rows = []; let retainedReads = 0
  const registry = new SkillRegistry({ scope, loadInstalled: () => rows,
    loadRetained: () => { retainedReads++; return Array.from({ length: 1000 }, (_, i) => row(i)) }, now: () => 1793232000000 })
  registry.setSession(fence)
  const observations = []
  for (const count of [0, 1, 4, 10, 100, 1000]) {
    rows = Array.from({ length: count }, (_, i) => row(i)); await registry.refresh()
    const text = wire(profile, registry, inputs(9)), parsed = JSON.parse(text)
    assert.equal(parsed.data.skillExecution.skills.length, count, 'never silently truncate valid skills')
    assert.equal(Object.hasOwn(parsed.data, 'inputCarriers'), false)
    assert.deepEqual(parsed.data.typedDeliberation.materialsInput.supportedInputs, inputs(9))
    assert.deepEqual(parsed.data.typedDeliberation.nativeExecution, nativeExecution)
    assert.equal(text.includes('LOCAL_ONLY'), false)
    assert.equal((text.match(/"supportedInputs":/g) || []).length, 1)
    observations.push({ skills: count, utf8Bytes: Buffer.byteLength(text), utf16Units: text.length })
  }
  assert.equal(retainedReads, 0)
  rows = Array.from({ length: 4 }, (_, i) => row(i)); await registry.refresh()
  const stable = registry.declaration()
  for (let i = 0; i < 100; i++) await registry.refresh()
  assert.deepEqual(registry.declaration(), stable, 'registration must replace, not append catalog snapshots')
  rows = [row(0)]; await registry.refresh()
  assert.equal(registry.declaration().skills.length, 1, 'removal shrinks current discovery without deleting retained packages')
  assert.equal(observations.find(x => x.skills === 4).utf16Units < 8192, true, 'small complete registration fits actual old container default')
  assert.equal(observations.find(x => x.skills === 100).utf16Units > 8192, true, 'cleanup is not an unlimited catalog capacity fix')
  const small = wire(profile, registry, inputs(9)), large = wire(profile, registry, inputs(90))
  assert.equal(large.length - small.length, JSON.stringify(inputs(90)).length - JSON.stringify(inputs(9)).length)
  const explosive = { declaration() { assert.fail('status must not measure or include catalogs') } }
  const status = buildAgentPresencePayload(profile, 'online', { skillRegistry: explosive, typedInspectionProfileRuntime: explosive,
    appServerAdapter: { get readback() { assert.fail('status must not inspect engine capabilities') } } })
  assert.deepEqual(status, { status: 'online', currentTaskId: '', currentTaskTitle: '', errorMessage: '' })
  console.log('REGISTRATION_GROWTH ' + JSON.stringify({ observations, inputTypes: [9, 90], inputGrowthBytes: Buffer.byteLength(large) - Buffer.byteLength(small), retainedReads }))
})

// Exact same public envelope is consumed by the Java capability regression.
test('shared compact registration preserves all consumed declarations and native execution', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/registration-compact-v1.json', import.meta.url)))
  const actual = buildAgentRegistrationPayload({ agentId: 'fixture-agent', codexWorkdir: '/nonexistent/registration-fixture' })
  assert.deepEqual(fixture.data.runtimeCapabilities, actual.runtimeCapabilities)
  assert.equal(fixture.messageType, 'agent.register')
  assert.equal(fixture.data.typedDeliberation.materialsInput.supportedInputs.length, 9)
  assert.deepEqual(fixture.data.typedDeliberation.nativeExecution, nativeExecution)
  assert.equal(fixture.data.skillExecution.skills.length, 4)
  assert.equal(Object.hasOwn(fixture.data, 'inputCarriers'), false)
})


test('registration does not read or publish user profile metadata or workspace abilities', () => {
  const profile = { agentId: 'fixture-agent',
    get agentName() { assert.fail('registration must not read name') },
    get personaName() { assert.fail('registration must not read persona') },
    get codexWorkdir() { assert.fail('registration must not scan workdir for user abilities') } }
  const registration = buildAgentRegistrationPayload(profile)
  for (const key of ['name', 'avatar', 'personaCode', 'personaName', 'abilities']) {
    assert.equal(Object.hasOwn(registration, key), false)
  }
  assert.ok(registration.runtimeCapabilities)
  assert.deepEqual(buildAgentPresencePayload(profile, 'busy', { taskId: 'task-1', title: '工作中' }),
    { status: 'busy', currentTaskId: 'task-1', currentTaskTitle: '工作中', errorMessage: '' })
})
