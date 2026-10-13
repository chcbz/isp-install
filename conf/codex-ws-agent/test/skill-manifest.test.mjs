import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseSkillManifest, validateSkillParameters, resolveSkillEntrypoint } from '../skill-manifest.mjs'
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
