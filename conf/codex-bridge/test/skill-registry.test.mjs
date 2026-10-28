import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SkillRegistry } from '../skill-registry.mjs'
import { parseSkillManifest } from '../skill-manifest.mjs'

const scope = { tenantId: '0', clientId: 'client', ownerJiacn: 'owner', agentId: 'agent' }
const fence = { installationId: 'rti_a', hostId: 'host', runtimeInstanceId: 'runtime', sessionGeneration: '24' }
const hash = 'a'.repeat(64)
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/skill-manifest-contract-v1.json', import.meta.url)))
const installed = (overrides = {}) => {
  const raw = JSON.parse(fixtures.cases.find(c => c.id === 'image-edit').json)
  raw.requirements = {}; Object.assign(raw, overrides)
  const manifest = parseSkillManifest(JSON.stringify(raw), { skillKey: raw.skillKey, skillVersion: raw.skillVersion })
  return { installationId: 'si_a', skillInstallationId: 'si_a', productVersionId: 'spv_a', skillKey: manifest.skillKey, skillVersion: manifest.skillVersion, kind: 'EXECUTABLE', enabled: true, policyRevision: '1', packageRoot: '/fixture/immutable/package', packageSha256: hash,
    manifestSha256: manifest.manifestSha256, manifest }
}
const runner = { run() { assert.fail('readiness must not execute a runner') }, probe: () => ({ ready: true, digest: hash }) }
const create = ({ rows = [installed({ runner: 'local-script', entrypoint: 'scripts/run.py' })], ...options } = {}) => {
  const registry = new SkillRegistry({ scope, loadInstalled: () => rows,
    runnerRegistry: new Map([['native-model', runner], ['local-script', runner], ['provider-operation', runner]]), ...options })
  registry.setSession(fence); return registry
}
const binding = overrides => ({ ready: true, scope, bindingId: 'approved', revision: '4', digest: hash, ...overrides })

test('unregistered runners never become READY, even with a valid installed descriptor', async () => {
  const registry = create({ runnerRegistry: new Map() })
  const declaration = await registry.refresh()
  assert.equal(declaration.skills[0].readiness, 'DEPENDENCY_MISSING')
  assert.equal(declaration.skills[0].reasonCode, 'DEPENDENCY_MISSING')
  const probeOnly = create({ runnerRegistry: new Map([['native-model', { probe: runner.probe }]]) })
  assert.equal((await probeOnly.refresh()).skills[0].readiness, 'DEPENDENCY_MISSING')
})
test('local scripts require actual measured tools, not tool names or booleans', async () => {
  const rows = [installed({ runner: 'local-script', entrypoint: 'scripts/run.py', requirements: { tools: ['python3'] } })]
  for (const probe of [undefined, () => ({ ready: true }), () => ({ ready: false, digest: hash })]) {
    const registry = create({ rows, toolProbes: new Map([['python3', probe]]) })
    const result = await registry.refresh(); assert.equal(result.skills[0].readiness, 'DEPENDENCY_MISSING')
  }
  const registry = create({ rows, toolProbes: new Map([['python3', () => ({ ready: true, digest: hash })]]) })
  assert.equal((await registry.refresh()).skills[0].readiness, 'READY')
})
test('retired executable runners are unavailable without calling runner or provider probes', async () => {
  for (const name of ['native-model', 'provider-operation']) {
    const rows = [installed({ runner: name })]
    const registry = create({ rows, runnerRegistry: new Map([[name, {
      run: () => assert.fail('run'), probe: () => assert.fail('retired probe') }]]),
      resolveBinding: () => assert.fail('retired provider probe') })
    const item = (await registry.refresh()).skills[0]
    assert.equal(item.kind, 'EXECUTABLE'); assert.equal(item.readiness, 'DEPENDENCY_MISSING')
  }
})
test('ordinary SKILL.md stays visible as NOT_EXECUTABLE, never fabricated executable capability', async () => {
  const ordinary = { installationId: 'ordinary', skillInstallationId: 'ordinary', productVersionId: 'spv_instruction',
    skillKey: 'instruction', skillVersion: '1.0.0', packageSha256: hash, manifestSha256: null, kind: 'INSTRUCTION',
    enabled: true, policyRevision: '2', manifest: null }
  const registry = create({ rows: [ordinary, installed({ runner: 'native-model' })] })
  const skills = (await registry.refresh()).skills
  assert.equal(skills.length, 2); assert.equal(skills.find(row => row.kind === 'INSTRUCTION').readiness, 'NOT_EXECUTABLE')
  assert.equal(skills.find(row => row.kind === 'INSTRUCTION').runner, null)
})
test('heartbeat is cached; tool probes run once per refresh for a shared tool', async () => {
  let loads = 0, probes = 0
  const rows = [installed({ skillKey: 'pdf-export', runner: 'local-script', requirements: { tools: ['python3'] } }),
    installed({ skillKey: 'xlsx-export', runner: 'local-script', requirements: { tools: ['python3'] } })]
  const registry = create({ loadInstalled: () => { loads++; return rows }, toolProbes: new Map([['python3', () => { probes++; return { ready: true, digest: hash } }]]) })
  const result = await registry.refresh()
  for (let i = 0; i < 10; i++) assert.equal(registry.declaration(), result)
  assert.equal(loads, 1); assert.equal(probes, 1)
  assert.equal((await registry.refresh()).catalogRevision, result.catalogRevision)
  assert.equal(loads, 2); assert.equal(probes, 2)
})
test('full session and configuration invalidation removes cached readiness immediately', async () => {
  const registry = create(); await registry.refresh()
  registry.setSession(null); assert.equal(registry.declaration(), null); assert.equal(await registry.refresh(), null)
  registry.setSession({ ...fence, sessionGeneration: '25' }); assert.equal(registry.declaration(), null)
  const result = await registry.refresh(); assert.equal(result.skills[0].readiness, 'READY')
  registry.invalidate(); assert.equal(registry.declaration(), null)
  assert.throws(() => registry.setSession({ ...fence, sessionGeneration: 0 }), /SKILL_SESSION_INVALID/)
})
test('refresh from an old session cannot resurrect a catalog after disconnect', async () => {
  let resolve; const registry = create({ loadInstalled: () => new Promise(done => { resolve = done }) })
  const pending = registry.refresh(); registry.setSession(null); resolve([installed({ runner: 'native-model' })])
  assert.equal(await pending, null); assert.equal(registry.declaration(), null)
})
test('concurrent refresh only commits the latest installation measurement', async () => {
  const resolvers = []; const registry = create({ loadInstalled: () => new Promise(done => resolvers.push(done)) })
  const first = registry.refresh(), second = registry.refresh()
  resolvers[1]([installed({ skillKey: 'current', runner: 'native-model' })]); await second
  resolvers[0]([installed({ skillKey: 'old', runner: 'native-model' })]); assert.equal(await first, null)
  assert.equal(registry.declaration().skills[0].skillKey, 'current')
})
test('local execution lookup rechecks immutable hashes and tool measurement', async () => {
  let toolDigest = hash
  const row = installed({ runner: 'local-script', entrypoint: 'scripts/run.py', requirements: { tools: ['python3'] } })
  const registry = create({ rows: [row], toolProbes: new Map([['python3', () => ({ ready: true, digest: toolDigest })]]) })
  const item = (await registry.refresh()).skills[0]
  const guards = { toolchainDigest: item.toolchainDigest }
  assert.equal(typeof (await registry.requireExact(item, guards)).cacheKey, 'string')
  toolDigest = 'c'.repeat(64)
  await assert.rejects(registry.requireExact(item, guards), /SKILL_EXECUTION_BINDING_CHANGED/)
  await assert.rejects(registry.requireExact({ ...item, packageSha256: 'd'.repeat(64) }), /SKILL_EXECUTION_BINDING_CHANGED/)
})
test('fee-only deployment information does not change readiness or cache identity', async () => {
  let fee = 'UNKNOWN'; const row = installed({ runner: 'local-script', entrypoint: 'scripts/run.py' })
  const registry = create({ loadInstalled: () => [{ ...row, informationRevision: fee }] })
  const before = await registry.refresh(), beforeEntry = await registry.requireExact(before.skills[0], { toolchainDigest: before.skills[0].toolchainDigest })
  fee = '999'; const after = await registry.refresh()
  const afterEntry = await registry.requireExact(after.skills[0], { toolchainDigest: after.skills[0].toolchainDigest })
  assert.equal(before.catalogRevision, after.catalogRevision); assert.equal(beforeEntry.cacheKey, afterEntry.cacheKey)
  assert.equal(Object.hasOwn(after.skills[0], 'costInfo'), false)
})
test('duplicate installations remove the catalog instead of picking a callable winner', async () => {
  const first = installed({ runner: 'native-model' }), second = { ...first, installationId: 'si_b', skillInstallationId: 'si_b' }
  const registry = create({ rows: [first, second] })
  assert.equal(await registry.refresh(), null); assert.equal(registry.lastErrorCode, 'SKILL_CATALOG_UNAVAILABLE')
})
test('invalid digest or corrupt source clears the last successful directory without leaking error details', async () => {
  let rows = [installed({ runner: 'native-model' })]
  const registry = create({ loadInstalled: () => rows }); await registry.refresh()
  rows = [{ ...rows[0], manifestSha256: 'b'.repeat(64) }]
  assert.equal(await registry.refresh(), null); assert.equal(registry.declaration(), null)
  assert.equal(registry.lastErrorCode, 'SKILL_CATALOG_UNAVAILABLE')
  registry.loadInstalled = () => { throw new Error('secret/path/token') }
  assert.equal(await registry.refresh(), null); assert.equal(JSON.stringify(registry.declaration()).includes('secret'), false)
})
test('public directory and descriptor snapshots cannot be mutated after refresh', async () => {
  const row = installed({ runner: 'local-script', entrypoint: 'scripts/run.py' }), registry = create({ rows: [row] })
  const result = await registry.refresh(), entry = await registry.requireExact(result.skills[0], { toolchainDigest: result.skills[0].toolchainDigest })
  row.packageRoot = '/changed'
  assert.equal(entry.descriptor.packageRoot, '/fixture/immutable/package')
  assert.throws(() => result.skills.push({}), TypeError)
  assert.throws(() => { result.skills[0].readiness = 'FAKE' }, TypeError)
})

test('probe hashes and reason codes reject newline suffixes', async () => {
  const registry = create({ rows: [installed({ runner: 'local-script', entrypoint: 'scripts/run.py' })], runnerRegistry: new Map([['local-script', {
    run: runner.run, probe: () => ({ ready: true, digest: hash + '\n', reasonCode: 'FAKE\n' }) }]]) })
  const item = (await registry.refresh()).skills[0]
  assert.equal(item.readiness, 'DEPENDENCY_MISSING'); assert.equal(item.reasonCode, 'DEPENDENCY_MISSING')
})

test('session generation rejects old numeric, noncanonical and overflowing fences', () => {
  const registry = new SkillRegistry({ scope, loadInstalled: () => [] })
  for (const sessionGeneration of [1, 0, '0', '01', '-1', '+1', '1.0', '1\n', '9223372036854775808'])
    assert.throws(() => registry.setSession({ ...fence, sessionGeneration }), /SKILL_SESSION_INVALID/)
})

test('native package lookup binds retained identity without probing runners or granting tool capability', async () => {
  const row = { ...installed(), kind: 'INSTRUCTION', manifest: null, manifestSha256: null, packageTreeDigest: 'd'.repeat(64), approvedPermissionsSha256: 'e'.repeat(64) }
  const taskBinding = { executionId: 'execution', taskGrantId: 'grant', taskGrantVersion: '1', agentId: scope.agentId,
    skillKey: row.skillKey, skillInstallationId: row.skillInstallationId, productVersionId: row.productVersionId,
    skillVersion: row.skillVersion, packageSha256: row.packageSha256, manifestSha256: row.manifestSha256,
    approvedPermissionsSha256: row.approvedPermissionsSha256 }
  const registry = create({ loadRetained: async id => { assert.equal(id, row.skillInstallationId); return [row] },
    runnerRegistry: new Map([['provider-operation', { run: () => assert.fail('run'), probe: () => assert.fail('probe') }]]),
    resolveBinding: () => assert.fail('package lookup must not resolve provider') })
  const skill = Object.fromEntries(['skillKey', 'skillVersion', 'packageSha256', 'manifestSha256'].map(key => [key, row[key]]))
  const entry = await registry.requireNativePackage(skill, { taskBinding })
  assert.equal(entry.descriptor.packageTreeDigest, row.packageTreeDigest)
  assert.equal(Object.hasOwn(entry, 'item'), false)
  for (const [key, value] of [['agentId', 'another'], ['approvedPermissionsSha256', 'f'.repeat(64)], ['productVersionId', 'other'], ['skillVersion', '2.0.0']]) {
    await assert.rejects(registry.requireNativePackage(skill, { taskBinding: { ...taskBinding, [key]: value } }), /SKILL_EXECUTION_BINDING_CHANGED/)
  }
  registry.loadRetained = async () => [{ ...row, skillKey: 'wrong' }]
  await assert.rejects(registry.requireNativePackage(skill, { taskBinding }), /SKILL_EXECUTION_BINDING_CHANGED/)
  registry.loadRetained = async () => [row, row]
  await assert.rejects(registry.requireNativePackage(skill, { taskBinding }), /SKILL_EXECUTION_BINDING_CHANGED/)
})

test('native package lookup rejects a late retained response after session change', async () => {
  const row = { ...installed(), kind: 'INSTRUCTION', manifest: null, manifestSha256: null, packageTreeDigest: 'd'.repeat(64), approvedPermissionsSha256: 'e'.repeat(64) }
  const taskBinding = { executionId: 'execution', taskGrantId: 'grant', taskGrantVersion: '1', agentId: scope.agentId,
    skillKey: row.skillKey, skillInstallationId: row.skillInstallationId, productVersionId: row.productVersionId,
    skillVersion: row.skillVersion, packageSha256: row.packageSha256, manifestSha256: row.manifestSha256,
    approvedPermissionsSha256: row.approvedPermissionsSha256 }
  let resolve
  const registry = create({ loadRetained: () => new Promise(done => { resolve = done }) })
  const pending = registry.requireNativePackage(taskBinding, { taskBinding })
  registry.setSession(null); resolve([row])
  await assert.rejects(pending, /SKILL_EXECUTION_BINDING_CHANGED/)
})


test('ordinary instructions remain discoverable if another package runner probe fails', async () => {
  const ordinary = { skillInstallationId: 'si_instruction', productVersionId: 'spv_instruction', skillKey: 'instruction', skillVersion: '1.0.0',
    packageSha256: hash, manifestSha256: null, kind: 'INSTRUCTION', enabled: true, policyRevision: '1', manifest: null }
  const registry = create({ rows: [ordinary, installed()], runnerRegistry: new Map([['provider-operation', {
    run: runner.run, probe: () => { throw new Error('sensitive runner error') } }]]) })
  const declaration = await registry.refresh()
  assert.equal(declaration.skills.find(item => item.kind === 'INSTRUCTION').readiness, 'NOT_EXECUTABLE')
  assert.equal(declaration.skills.find(item => item.kind === 'EXECUTABLE').readiness, 'DEPENDENCY_MISSING')
  assert.equal(JSON.stringify(declaration).includes('sensitive'), false)
})

test('native binding resolves null-manifest instruction and forbids executable downgrade', async () => {
  const instruction = { skillInstallationId: 'si_instruction', productVersionId: 'spv_instruction', skillKey: 'instruction', skillVersion: '1.0.0',
    packageSha256: hash, packageTreeDigest: 'd'.repeat(64), approvedPermissionsSha256: 'e'.repeat(64), packageRoot: '/fixture/instruction',
    manifestSha256: null, kind: 'INSTRUCTION', enabled: true, policyRevision: '1', manifest: null }
  let rows = [instruction]
  const taskBinding = { executionId: 'execution', taskGrantId: 'grant', taskGrantVersion: '1', agentId: scope.agentId,
    skillKey: instruction.skillKey, skillInstallationId: instruction.skillInstallationId, productVersionId: instruction.productVersionId,
    skillVersion: instruction.skillVersion, packageSha256: instruction.packageSha256, manifestSha256: null,
    approvedPermissionsSha256: instruction.approvedPermissionsSha256 }
  const registry = create({ loadRetained: () => rows, runnerRegistry: new Map(), resolveBinding: () => assert.fail('no provider binding') })
  const entry = await registry.requireNativePackage(taskBinding, { taskBinding })
  assert.equal(entry.descriptor.kind, 'INSTRUCTION'); assert.equal(entry.descriptor.manifestSha256, null)
  assert.equal(entry.descriptor.packageTreeDigest, instruction.packageTreeDigest)
  rows = [{ ...instruction, kind: 'EXECUTABLE', manifest: { skillKey: instruction.skillKey, skillVersion: instruction.skillVersion, manifestSha256: null } }]
  await assert.rejects(registry.requireNativePackage(taskBinding, { taskBinding }), /SKILL_EXECUTION_BINDING_CHANGED/)
  rows = [{ ...instruction, kind: 'EXECUTABLE', manifestSha256: 'f'.repeat(64), manifest: { skillKey: instruction.skillKey, skillVersion: instruction.skillVersion, manifestSha256: 'f'.repeat(64) } }]
  await assert.rejects(registry.requireNativePackage(taskBinding, { taskBinding }), /SKILL_EXECUTION_BINDING_CHANGED/)
  rows = [{ ...instruction, manifest: { skillKey: instruction.skillKey } }]
  await assert.rejects(registry.requireNativePackage(taskBinding, { taskBinding }), /SKILL_EXECUTION_BINDING_CHANGED/)
})

 test('disabled ordinary package is advertised as disabled and cannot pass legacy lookup', async () => {
  const row = { skillInstallationId: 'si_instruction', productVersionId: 'spv_instruction', skillKey: 'instruction', skillVersion: '1.0.0', packageSha256: hash, manifestSha256: null, kind: 'INSTRUCTION', enabled: false, policyRevision: '1', manifest: null }
  const registry = create({ rows: [row] })
  const item = (await registry.refresh()).skills[0]
  assert.equal(item.enabled, false); assert.equal(item.readiness, 'NOT_EXECUTABLE')
  await assert.rejects(registry.requireExact(item), /SKILL_EXECUTION_BINDING_CHANGED/)
})
