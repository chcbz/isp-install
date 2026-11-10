import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { skillInventorySnapshot, observeInstalledSkillInventory } from '../skill-inventory.mjs'

const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'skill-inventory-'))
  const home = resolve(root, 'home'), cwd = resolve(root, 'work')
  mkdirSync(home); mkdirSync(cwd)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const skill = (name, base = resolve(home, 'skills'), enabled = true) => {
    const dir = resolve(base, name); mkdirSync(dir, { recursive: true })
    const path = resolve(dir, 'SKILL.md'); writeFileSync(path, `---\nname: ${name}\ndescription: Synthetic inventory fixture.\n---\nDo not invoke providers.\n`)
    return { name, path, enabled, scope: 'user' }
  }
  const snapshot = (skills, managed = []) => skillInventorySnapshot({ discovery: { data: [{ cwd, skills, errors: [] }] }, managed, cwd, codexHome: home })
  return { home, cwd, skill, snapshot }
}
const managed = (skillKey, enabled = true) => ({ skillKey, enabled, active: true, installationId: 'installed-' + skillKey,
  skillVersion: '1', packageTreeDigest: 'a'.repeat(64), productVersionId: 'pv-' + skillKey, kind: 'INSTRUCTION', packageSha256: 'b'.repeat(64), manifestSha256: null })

test('complete native discovery includes manual and repository skills, excludes system, counts disabled current managed once', t => {
  const f = fixture(t), manual = f.skill('manual'), repo = f.skill('repo', resolve(f.cwd, '.agents/skills'))
  const paid = f.skill('paid'), system = { ...f.skill('builtin', resolve(f.home, 'skills/.system')), scope: 'system' }
  const result = f.snapshot([manual, repo, paid, system], [managed('paid'), managed('disabled', false)])
  assert.equal(result.installedSkillCount, '4')
  assert.deepEqual(result.skills.map(x => x.skillKey), ['disabled', 'manual', 'paid', 'repo'])
  assert.equal(JSON.stringify(result).includes(f.home), false)
  assert.equal(result.skills[0].installation.skillInstallationId, 'installed-disabled')
  assert.equal(result.skills.find(skill => skill.skillKey === 'manual').installation, null)
  assert.equal(result.inventorySha256, f.snapshot([repo, system, paid, manual], [managed('disabled', false), managed('paid')]).inventorySha256)
})
test('inventory fingerprint changes with definition, installed revision, enabled state or removal', t => {
  const f = fixture(t), row = f.skill('manual'), before = f.snapshot([row], [managed('paid')]).inventorySha256
  writeFileSync(row.path, 'changed public skill definition')
  assert.notEqual(f.snapshot([row], [managed('paid')]).inventorySha256, before)
  const base = f.snapshot([], [managed('paid')]).inventorySha256
  for (const rows of [[], [managed('paid', false)], [{ ...managed('paid'), skillVersion: '2' }]])
    assert.notEqual(f.snapshot([], rows).inventorySha256, base)
})
test('incomplete discovery, duplicate kind collisions and historical-only journal rows cannot become a zero quote', t => {
  const f = fixture(t), row = f.skill('same'), other = f.skill('same', resolve(f.cwd, '.agents/skills'))
  assert.throws(() => f.snapshot([row, other]), /SKILL_INVENTORY_UNCONFIRMED/)
  assert.throws(() => f.snapshot([], [{ ...managed('old'), active: false }]), /SKILL_INVENTORY_UNCONFIRMED/)
  assert.throws(() => skillInventorySnapshot({ discovery: { data: [{ cwd: f.cwd, skills: [], errors: [{}] }] }, cwd: f.cwd, codexHome: f.home }), /SKILL_INVENTORY_UNCONFIRMED/)
  assert.throws(() => f.snapshot([{ ...row, enabled: undefined }]), /SKILL_INVENTORY_UNCONFIRMED/)
})
test('managed inventory requires exact public installation references and explicit enabled state', t => {
  const f = fixture(t)
  for (const changed of [{ enabled: undefined }, { productVersionId: null }, { packageSha256: 'unknown' },
    { kind: 'EXECUTABLE', manifestSha256: null }, { kind: 'INSTRUCTION', manifestSha256: 'a'.repeat(64) }])
    assert.throws(() => f.snapshot([], [{ ...managed('paid'), ...changed }]), /SKILL_INVENTORY_UNCONFIRMED/)
  const row = { ...managed('paid'), kind: 'EXECUTABLE', manifestSha256: 'a'.repeat(64) }
  assert.equal(f.snapshot([], [row]).skills[0].installation.manifestSha256, row.manifestSha256)
})
test('observation forces native reload, has no turn request, detects concurrent installation and always shuts down', async t => {
  const f = fixture(t), calls = [], rows = [[], [managed('new')]]
  const adapter = { initialize: async value => calls.push(['initialize', value]),
    request: async (method, body) => { calls.push([method, body]); return { data: [{ cwd: f.cwd, skills: [], errors: [] }] } },
    shutdown: async () => calls.push(['shutdown']) }
  await assert.rejects(observeInstalledSkillInventory({ profile: { codexHome: f.home, codexWorkdir: f.cwd },
    manager: { listInstalledSkills: () => rows.shift() }, measure: async () => ({}), spawn: async () => adapter }), /SKILL_INVENTORY_UNCONFIRMED/)
  assert.deepEqual(calls, [['initialize', { catalogOnly: true }], ['skills/list', { cwds: [f.cwd], forceReload: true }], ['shutdown']])
})
test('native engine parses valid YAML and repo discovery without provider or conversation calls', { skip: !process.env.CYF_INVENTORY_CODEX_BIN }, async t => {
  const f = fixture(t), local = f.skill('manual-yaml'), repo = f.skill('repository-skill', resolve(f.cwd, '.agents/skills')), disabled = f.skill('disabled-native')
  writeFileSync(resolve(f.home, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(disabled.path)}\nenabled = false\n`)
  writeFileSync(local.path, '---\nname: "manual-yaml"\ndescription: >-\n  Valid folded YAML, not the managed preview subset.\nmetadata:\n  arbitrary: [one, two]\n---\nPublic skill only.\n')
  // No provider credential/config and no conversation. The observer only initializes
  // the owned process then requests skills/list, with account/model/MCP readback disabled.
  const result = await observeInstalledSkillInventory({ profile: { codexHome: f.home, codexWorkdir: f.cwd,
    codexBin: process.env.CYF_INVENTORY_CODEX_BIN } })
  assert.equal(result.installedSkillCount, '3')
  assert.deepEqual(result.skills.map(x => x.skillKey), [disabled.name, local.name, repo.name])
})
