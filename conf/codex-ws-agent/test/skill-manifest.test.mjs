import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseSkillManifest, validateSkillParameters, resolveSkillEntrypoint, skillPackageTreeDigest } from '../skill-manifest.mjs'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/skill-manifest-contract-v1.json', import.meta.url)))
for (const c of fixture.cases) test(`shared fixture: ${c.id}`, () => {
  const validate = () => c.kind === 'manifest' ? parseSkillManifest(c.json, c) : validateSkillParameters(c.schema, c.json)
  if (c.expected) assert.doesNotThrow(validate)
  else assert.throws(validate)
})
test('instruction-only package is allowed but not executable', () => assert.equal(parseSkillManifest(null, {}), null))
test('hash is original bytes and fees never change them', () => {
  const c = fixture.cases.find(c => c.id === 'bad-cost-only')
  const result = parseSkillManifest(c.json, c)
  assert.equal(result.costInfo.mode, 'UNKNOWN'); assert.deepEqual(result.metadataWarnings, ['SKILL_COST_INFO_INVALID'])
  assert.equal(result.manifestSha256, createHash('sha256').update(c.json).digest('hex'))
  assert.ok(Object.isFrozen(result.parametersSchema))
})
test('parameters not modified by validation', () => {
  const schema = fixture.cases.find(c => c.id === 'valid-chinese').schema
  const input = { name: '原值', count: 1 }; const before = JSON.stringify(input)
  validateSkillParameters(schema, input); assert.equal(JSON.stringify(input), before)
})
test('package local script cannot escape by symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'cyf-skill-manifest-'))
  try {
    mkdirSync(join(root, 'package')); writeFileSync(join(root, 'outside.py'), 'secret')
    symlinkSync(join(root, 'outside.py'), join(root, 'package', 'script.py'))
    assert.throws(() => resolveSkillEntrypoint(join(root, 'package'), 'script.py'))
    symlinkSync(root, join(root, 'package', 'scripts'))
    assert.throws(() => resolveSkillEntrypoint(join(root, 'package'), 'scripts/outside.py'))
    writeFileSync(join(root, 'package', 'ok.py'), 'print(1)')
    assert.equal(resolveSkillEntrypoint(join(root, 'package'), 'ok.py'), join(root, 'package', 'ok.py'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('executable package tree identity binds every file/directory and rejects writable or linked dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'cyf-skill-tree-'))
  try {
    writeFileSync(join(root, 'main.mjs'), 'original', { mode: 0o600 })
    const first = skillPackageTreeDigest(root)
    assert.match(first, /^[a-f0-9]{64}$/)
    writeFileSync(join(root, '.cyf-installation.json'), '{}', { mode: 0o600 })
    assert.equal(skillPackageTreeDigest(root), first)
    mkdirSync(join(root, 'deps'), { mode: 0o700 })
    assert.notEqual(skillPackageTreeDigest(root), first)
    writeFileSync(join(root, 'deps/helper.mjs'), 'one', { mode: 0o600 }); const second = skillPackageTreeDigest(root)
    writeFileSync(join(root, 'deps/helper.mjs'), 'two'); assert.notEqual(skillPackageTreeDigest(root), second)
    chmodSync(join(root, 'deps/helper.mjs'), 0o622); assert.throws(() => skillPackageTreeDigest(root), /SKILL_PACKAGE_TREE_UNSAFE/)
    chmodSync(join(root, 'deps/helper.mjs'), 0o600)
    linkSync(join(root, 'main.mjs'), join(root, 'hardlink.mjs')); assert.throws(() => skillPackageTreeDigest(root), /SKILL_PACKAGE_TREE_UNSAFE/)
    rmSync(join(root, 'hardlink.mjs'))
    symlinkSync(join(root, 'main.mjs'), join(root, 'alias.mjs')); assert.throws(() => skillPackageTreeDigest(root), /SKILL_PACKAGE_TREE_UNSAFE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('skill declares its own input count without a generic 32 cap; int overflow still rejected', () => {
  const c = fixture.cases.find(c => c.id === 'image-edit')
  const manifest = JSON.parse(c.json)
  manifest.inputs.maxItems = 129
  assert.equal(parseSkillManifest(JSON.stringify(manifest), c).inputs.maxItems, 129)
  manifest.inputs.maxItems = 2147483648
  assert.throws(() => parseSkillManifest(JSON.stringify(manifest), c))
})
