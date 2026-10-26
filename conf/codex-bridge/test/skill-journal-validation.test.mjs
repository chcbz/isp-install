import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, linkSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillInstallManager } from '../skill-install-manager.mjs'
import { managementDigest } from '../skill-management-wire.mjs'
import { binding, examples } from './fixtures/skill-management-fixture.mjs'

// Small synthetic evidence only: no initialize, installation, subprocess or live state.
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'cyf-journal-validation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = Object.create(SkillInstallManager.prototype)
  manager.statePath = join(root, 'journal.json'); manager.scope = structuredClone(binding.scope)
  let validations = 0
  const validate = manager._validateJournal
  manager._validateJournal = function (value) { validations++; return validate.call(this, value) }
  const state = { formatVersion: 2, scope: manager.scope, identity: null, commands: {}, messages: {}, installations: {}, skills: {}, fences: {} }
  const write = value => writeFileSync(manager.statePath, JSON.stringify({ ...value, journalSha256: managementDigest('cyf.skill.journal.v2', value) }), { mode: 0o600 })
  write(state)
  return { root, manager, state, write, validations: () => validations }
}

test('identical complete bytes reuse validation; returned nested values never alias the snapshot', t => {
  const f = fixture(t), first = f.manager._load()
  first.scope.agentId = 'modified'; first.skills.newSkill = { enabled: true }
  assert.deepEqual(f.manager._load(), f.state)
  assert.equal(f.validations(), 1)
  const second = f.manager._load(); second.messages.x = { wire: 'mutated' }
  assert.deepEqual(f.manager._load(), f.state)
  assert.equal(f.validations(), 1)
})

test('changed valid bytes and writes require full validation, not a save shortcut', t => {
  const f = fixture(t); f.manager._load()
  const next = { ...f.state, identity: { test: 'updated' } }
  f.manager._save(next)
  assert.deepEqual(f.manager._load(), next); assert.equal(f.validations(), 2)
  f.manager._load(); assert.equal(f.validations(), 2)
})

test('same-length changed content cannot hit; malformed, duplicate and digest failures remain failures', t => {
  const f = fixture(t); f.manager._load()
  const good = readFileSync(f.manager.statePath, 'utf8')
  const bad = good.replace('owner_demo', 'owner_fail'); assert.equal(bad.length, good.length)
  for (const bytes of [bad, '{', good.replace('"formatVersion":2', '"formatVersion":2,"formatVersion":2')]) {
    writeFileSync(f.manager.statePath, bytes)
    assert.throws(() => f.manager._load())
    assert.throws(() => f.manager._load())
  }
  writeFileSync(f.manager.statePath, good)
  assert.deepEqual(f.manager._load(), f.state)
})

test('new valid journal digest never exempts schema or receipt association validation', t => {
  const f = fixture(t); f.manager._load()
  const envelope = structuredClone(examples.cases.find(c => c.name === 'prepare-command').value)
  const state = { ...f.state, commands: { one: { envelope, receipt: {} } } }
  f.write(state)
  assert.throws(() => f.manager._load(), /receipt without result/)
  assert.throws(() => f.manager._load(), /receipt without result/)
  delete state.commands.one.receipt; state.commands.one.envelope.data.commandSha256 = '0'.repeat(64)
  f.write(state); assert.throws(() => f.manager._load())
})

test('cached bytes still reject unsafe permissions, hardlinks and symbolic links', t => {
  const f = fixture(t); f.manager._load()
  chmodSync(f.manager.statePath, 0o666)
  assert.throws(() => f.manager._load(), /unsafe durable evidence/)
  chmodSync(f.manager.statePath, 0o600)
  const other = join(f.root, 'other.json'); linkSync(f.manager.statePath, other)
  assert.throws(() => f.manager._load(), /unsafe journal/)
  unlinkSync(f.manager.statePath); symlinkSync(other, f.manager.statePath)
  assert.throws(() => f.manager._load(), /unsafe journal/)
})

test('scope, canonical path and manager instance changes cannot inherit validation', t => {
  const f = fixture(t); f.manager._load()
  f.manager.scope = { ...f.manager.scope, agentId: 'other' }
  assert.throws(() => f.manager._load(), /scope conflict/)
  f.manager.scope = structuredClone(binding.scope)
  const next = join(f.root, 'next.json'); writeFileSync(next, readFileSync(f.manager.statePath), { mode: 0o600 })
  f.manager.statePath = next
  assert.deepEqual(f.manager._load(), f.state); assert.equal(f.validations(), 3)
  const independent = Object.create(SkillInstallManager.prototype)
  independent.statePath = next; independent.scope = f.manager.scope
  let checked = false
  independent._validateJournal = function (value) { checked = true; return SkillInstallManager.prototype._validateJournal.call(this, value) }
  assert.deepEqual(independent._load(), f.state); assert.equal(checked, true)
})

test('cached valid results reject subsequently mismatched receipts even with a recomputed journal hash', t => {
  const f = fixture(t), copy = name => structuredClone(examples.cases.find(c => c.name === name).value)
  const envelope = copy('activate-command'), result = copy('activated-result'), receipt = copy('result-receipt')
  const state = { ...f.state, commands: { one: { envelope, result, resultWire: JSON.stringify(result), receipt, executionRuntimeInstanceId: 'boot_demo' } } }
  f.write(state); f.manager._load(); f.manager._load(); assert.equal(f.validations(), 1)
  state.commands.one.receipt.correlationId = 'different_result'
  f.write(state); assert.throws(() => f.manager._load(), /receipt integrity conflict/)
  assert.throws(() => f.manager._load(), /receipt integrity conflict/)
  delete state.commands.one.receipt
  state.commands.one.resultWire += ' '
  f.write(state); assert.throws(() => f.manager._load(), /result integrity conflict/)
})

test('content change back to an earlier snapshot validates again after another successful load', t => {
  const f = fixture(t); f.manager._load()
  f.write({ ...f.state, identity: { changed: true } }); f.manager._load()
  f.write(f.state); f.manager._load()
  assert.equal(f.validations(), 3)
})
