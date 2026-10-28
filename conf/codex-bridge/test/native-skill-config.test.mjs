import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadNativeSkillConfiguration, nativeSkillOrigins } from '../native-skill-config.mjs'
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'native-config-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const scope = { tenantId: 'tenant', ownerJiacn: 'owner', clientId: 'client', agentId: 'agent' }
  const descriptor = { skillInstallationId: 'installed1', skillKey: 'test-skill', packageSha256: 'a'.repeat(64) }
  const command = { toolPolicyRef: 'NATIVE_SKILL_SCRIPT_V1', skills: [{ skill: { key: descriptor.skillKey, packageSha256: descriptor.packageSha256 }, taskSkillBinding: { skillInstallationId: 'installed1' } }] }
  const config = { schemaVersion: 1, scope, installations: {
    installed1: { configuration: { apiKey: 'synthetic-one' }, networkOrigins: ['https://example.invalid'] },
    installed2: { configuration: { apiKey: 'synthetic-foreign' }, networkOrigins: ['https://other.invalid'] }
  } }
  const file = resolve(root, 'config.json'), write = () => writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  write(); return { root, file, scope, command, entries: [{ descriptor }], config, write }
}
test('only the authorized installation receives its customer configuration and exact origins', t => {
  const f = fixture(t), result = loadNativeSkillConfiguration(f)
  assert.equal(result.length, 1); assert.equal(result[0].configuration.apiKey, 'synthetic-one')
  assert.deepEqual(result[0].networkOrigins, ['https://example.invalid'])
  assert.equal(JSON.stringify(result).includes('synthetic-foreign'), false)
  assert.match(result[0].digest, /^[a-f0-9]{64}$/)
})
test('local-only and empty-skill executions never open customer configuration', t => {
  const f = fixture(t)
  assert.deepEqual(loadNativeSkillConfiguration({ ...f, file: '/missing', command: { ...f.command, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1' } }), [])
  assert.deepEqual(loadNativeSkillConfiguration({ ...f, file: '/missing', entries: [] }), [])
})
test('scope, installation, private-file mode and symlink boundaries are enforced', t => {
  const f = fixture(t)
  assert.throws(() => loadNativeSkillConfiguration({ ...f, scope: { ...f.scope, ownerJiacn: 'foreign' } }), /SCOPE_MISMATCH/)
  assert.throws(() => loadNativeSkillConfiguration({ ...f, command: { ...f.command, skills: [] } }), /BINDING_INVALID/)
  chmodSync(f.file, 0o644); assert.throws(() => loadNativeSkillConfiguration(f), /UNSAFE/)
  chmodSync(f.file, 0o600); const link = resolve(f.root, 'link'); symlinkSync(f.file, link)
  assert.throws(() => loadNativeSkillConfiguration({ ...f, file: link }), /UNSAFE/)
})
test('missing installation config is not borrowed; updated values produce a different local binding', t => {
  const f = fixture(t), first = loadNativeSkillConfiguration(f)[0]
  f.config.installations.installed1.configuration.apiKey = 'changed'; f.write()
  assert.notEqual(loadNativeSkillConfiguration(f)[0].digest, first.digest)
  delete f.config.installations.installed1; f.write(); assert.deepEqual(loadNativeSkillConfiguration(f), [])
})
test('network scope is exact HTTPS origins, never arbitrary URLs or embedded credentials', () => {
  assert.deepEqual(nativeSkillOrigins(['https://example.invalid', 'https://example.invalid']), ['https://example.invalid'])
  for (const value of ['http://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/path', 'https://example.invalid?key=secret', '*']) assert.throws(() => nativeSkillOrigins([value]), /NETWORK_INVALID/)
})

test('missing configured file is an execution-scoped recoverable failure', t => {
  const f = fixture(t)
  rmSync(f.file)
  assert.throws(() => loadNativeSkillConfiguration(f), { code: 'NATIVE_SKILL_CONFIG_UNAVAILABLE' })
  f.write()
  assert.equal(loadNativeSkillConfiguration(f)[0].skillInstallationId, 'installed1')
})
