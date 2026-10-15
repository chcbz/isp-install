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
  return { installationId: 'si_a', packageRoot: '/fixture/immutable/package', packageSha256: hash,
    manifestSha256: manifest.manifestSha256, manifest }
}
const runner = { run() { assert.fail('readiness must not execute a runner') }, probe: () => ({ ready: true, digest: hash }) }
const create = ({ rows = [installed({ runner: 'native-model' })], ...options } = {}) => {
  const registry = new SkillRegistry({ scope, loadInstalled: () => rows,
    runnerRegistry: new Map([['native-model', runner], ['local-script', runner], ['provider-operation', runner]]), ...options })
  registry.setSession(fence); return registry
}
const binding = overrides => ({ ready: true, scope, bindingId: 'approved', revision: '4', digest: hash, ...overrides })

test('unregistered runners never become READY, even with a valid installed descriptor', async () => {
  const registry = create({ runnerRegistry: new Map() })
  const declaration = await registry.refresh()
  assert.equal(declaration.skills[0].readiness, 'UNAVAILABLE')
  assert.equal(declaration.skills[0].reasonCode, 'SKILL_RUNNER_MISSING')
  const probeOnly = create({ runnerRegistry: new Map([['native-model', { probe: runner.probe }]]) })
  assert.equal((await probeOnly.refresh()).skills[0].readiness, 'UNAVAILABLE')
})
test('local scripts require actual measured tools, not tool names or booleans', async () => {
  const rows = [installed({ runner: 'local-script', entrypoint: 'scripts/run.py', requirements: { tools: ['python3'] } })]
  for (const probe of [undefined, () => ({ ready: true }), () => ({ ready: false, digest: hash })]) {
    const registry = create({ rows, toolProbes: new Map([['python3', probe]]) })
    const result = await registry.refresh(); assert.equal(result.skills[0].readiness, 'UNAVAILABLE')
  }
  const registry = create({ rows, toolProbes: new Map([['python3', () => ({ ready: true, digest: hash })]]) })
  assert.equal((await registry.refresh()).skills[0].readiness, 'READY')
})
test('provider runner requires an explicit current-subject binding and revision', async () => {
  const rows = [installed({ requirements: { providerAlias: 'image' } })]
  for (const resolveBinding of [null, () => binding({ ready: false }), () => binding({ revision: null }),
    () => binding({ scope: { ...scope, ownerJiacn: 'foreign' } })]) {
    assert.equal((await create({ rows, resolveBinding }).refresh()).skills[0].readiness, 'UNAVAILABLE')
  }
  const registry = create({ rows, resolveBinding: ({ scope: supplied, fence: suppliedFence, alias }) => {
    assert.deepEqual(supplied, scope); assert.deepEqual(suppliedFence, fence); assert.equal(alias, 'image')
    return binding({ endpoint: 'secret-endpoint', token: 'DO_NOT_EXPOSE' })
  } })
  const declaration = await registry.refresh(); assert.equal(declaration.skills[0].readiness, 'READY')
  assert.equal(declaration.skills[0].bindingRevision, '4')
  assert.equal(JSON.stringify(declaration).includes('DO_NOT_EXPOSE'), false)
  assert.equal(JSON.stringify(declaration).includes('secret-endpoint'), false)
  assert.equal((await create({ rows: [installed({ requirements: {} })], resolveBinding: () => binding() }).refresh()).skills[0].readiness, 'UNAVAILABLE')
})
test('ordinary SKILL.md packages coexist without fabricated executable capability', async () => {
  const registry = create({ rows: [{ installationId: 'ordinary', manifest: null }, installed({ runner: 'native-model' })] })
  assert.equal((await registry.refresh()).skills.length, 1)
  const plain = create({ rows: [{ installationId: 'ordinary', manifest: null }] })
  assert.deepEqual((await plain.refresh()).skills, [])
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
test('execution lookup rechecks immutable hashes, tool measurement and binding revision', async () => {
  let revision = '4', toolDigest = hash
  const row = installed({ requirements: { providerAlias: 'image' } })
  const registry = create({ rows: [row], runnerRegistry: new Map([['provider-operation', {
    run: runner.run, probe: () => ({ ready: true, digest: toolDigest }) }]]), resolveBinding: () => binding({ revision }) })
  const item = (await registry.refresh()).skills[0]
  const guards = { toolchainDigest: item.toolchainDigest, bindingRevision: item.bindingRevision }
  const entry = await registry.requireExact(item, guards); assert.equal(typeof entry.cacheKey, 'string')
  revision = '5'; await assert.rejects(registry.requireExact(item, guards), /SKILL_EXECUTION_BINDING_CHANGED/)
  revision = '4'; toolDigest = 'c'.repeat(64)
  await assert.rejects(registry.requireExact(item, guards), /SKILL_EXECUTION_BINDING_CHANGED/)
  toolDigest = hash
  await assert.rejects(registry.requireExact({ ...item, packageSha256: 'd'.repeat(64) }, guards), /SKILL_EXECUTION_BINDING_CHANGED/)
})
test('fee-only deployment information does not change readiness or cache identity', async () => {
  let fee = 'UNKNOWN'; const row = installed({ runner: 'native-model' })
  const registry = create({ loadInstalled: () => [{ ...row, informationRevision: fee }] })
  const before = await registry.refresh(), beforeEntry = await registry.requireExact(before.skills[0], { toolchainDigest: before.skills[0].toolchainDigest })
  fee = '999'; const after = await registry.refresh()
  const afterEntry = await registry.requireExact(after.skills[0], { toolchainDigest: after.skills[0].toolchainDigest })
  assert.equal(before.catalogRevision, after.catalogRevision); assert.equal(beforeEntry.cacheKey, afterEntry.cacheKey)
  assert.equal(Object.hasOwn(after.skills[0], 'costInfo'), false)
})
test('duplicate installations do not pick a callable winner', async () => {
  const first = installed({ runner: 'native-model' }), second = { ...first, installationId: 'si_b' }
  const registry = create({ rows: [first, second] }); const result = await registry.refresh()
  assert.equal(result.skills.length, 1); assert.equal(result.skills[0].reasonCode, 'SKILL_INSTALLATION_AMBIGUOUS')
  assert.equal(result.skills[0].readiness, 'UNAVAILABLE')
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
  const row = installed({ runner: 'native-model' }), registry = create({ rows: [row] })
  const result = await registry.refresh(), entry = await registry.requireExact(result.skills[0], { toolchainDigest: result.skills[0].toolchainDigest })
  row.packageRoot = '/changed'
  assert.equal(entry.descriptor.packageRoot, '/fixture/immutable/package')
  assert.throws(() => result.skills.push({}), TypeError)
  assert.throws(() => { result.skills[0].readiness = 'FAKE' }, TypeError)
})

test('probe hashes and reason codes reject newline suffixes', async () => {
  const registry = create({ runnerRegistry: new Map([['native-model', {
    run: runner.run, probe: () => ({ ready: true, digest: hash + '\n', reasonCode: 'FAKE\n' }) }]]) })
  const item = (await registry.refresh()).skills[0]
  assert.equal(item.readiness, 'UNAVAILABLE'); assert.equal(item.reasonCode, 'SKILL_DEPENDENCY_UNAVAILABLE')
})

test('session generation rejects old numeric, noncanonical and overflowing fences', () => {
  const registry = new SkillRegistry({ scope, loadInstalled: () => [] })
  for (const sessionGeneration of [1, 0, '0', '01', '-1', '+1', '1.0', '1\n', '9223372036854775808'])
    assert.throws(() => registry.setSession({ ...fence, sessionGeneration }), /SKILL_SESSION_INVALID/)
})
