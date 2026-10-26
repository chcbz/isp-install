import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { measureLocalToolFile } from '../skill-runners/local-tool-measurement.mjs'
const fixture = t => {
  // Unlike /tmp, the interpreter trust contract forbids world-writable parents.
  const root = mkdtempSync(resolve(homedir(), '.cyf-local-tool-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = resolve(root, 'node'), bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x61)
  writeFileSync(file, bytes, { mode: 0o500 })
  return { root, file, bytes }
}

test('streaming local tool measurement preserves full digest/identity and yields before completing', async t => {
  const { file, bytes } = fixture(t), stat = lstatSync(file)
  let yielded = false
  const pending = measureLocalToolFile(file)
  setImmediate(() => { yielded = true })
  const result = await pending
  assert.equal(yielded, true)
  assert.deepEqual(result, { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) })
  assert.deepEqual(readFileSync(file), bytes)
})

test('local tool measurement rereads every call, including same-size replacement', async t => {
  const { root, file, bytes } = fixture(t), first = await measureLocalToolFile(file)
  const replacement = resolve(root, 'replacement')
  writeFileSync(replacement, Buffer.alloc(bytes.length, 0x62), { mode: 0o500 }); renameSync(replacement, file)
  const second = await measureLocalToolFile(file)
  assert.notEqual(second.sha256, first.sha256); assert.notEqual(second.ino, first.ino)
  assert.equal(second.size, first.size)
})

test('local tool replacement during async read is rejected, not measured as mixed bytes', async t => {
  const { root, file, bytes } = fixture(t), replacement = resolve(root, 'replacement')
  writeFileSync(replacement, Buffer.alloc(bytes.length, 0x62), { mode: 0o500 })
  const pending = measureLocalToolFile(file)
  renameSync(replacement, file)
  await assert.rejects(pending, { code: 'SKILL_LOCAL_TOOL_UNTRUSTED' })
  // Failed measurement closes its descriptor and does not poison later reads.
  assert.equal((await measureLocalToolFile(file)).sha256, createHash('sha256').update(Buffer.alloc(bytes.length, 0x62)).digest('hex'))
})

test('local tool modification during async read and unsafe modes are rejected', async t => {
  const { file, bytes } = fixture(t)
  const pending = measureLocalToolFile(file)
  chmodSync(file, 0o700); writeFileSync(file, Buffer.alloc(bytes.length, 0x63)); chmodSync(file, 0o500)
  await assert.rejects(pending, { code: 'SKILL_LOCAL_TOOL_UNTRUSTED' })
  chmodSync(file, 0o522)
  await assert.rejects(measureLocalToolFile(file), { code: 'SKILL_LOCAL_TOOL_UNTRUSTED' })
})

test('configured tool alias retargeting is rejected while stable aliases remain compatible', async t => {
  const { root, file, bytes } = fixture(t), alias = resolve(root, 'alias'), other = resolve(root, 'other')
  symlinkSync(file, alias); writeFileSync(other, bytes, { mode: 0o500 })
  assert.deepEqual(await measureLocalToolFile(alias), await measureLocalToolFile(file))
  const pending = measureLocalToolFile(alias)
  unlinkSync(alias); symlinkSync(other, alias)
  await assert.rejects(pending, { code: 'SKILL_LOCAL_TOOL_UNTRUSTED' })
})

test('unrelated directory contents do not invalidate measurement, but parent permission changes do', async t => {
  const { root, file } = fixture(t)
  const pending = measureLocalToolFile(file)
  writeFileSync(resolve(root, 'unrelated'), 'safe sibling', { mode: 0o600 })
  assert.match((await pending).sha256, /^[0-9a-f]{64}$/)
  const changed = measureLocalToolFile(file)
  chmodSync(root, 0o702)
  await assert.rejects(changed, { code: 'SKILL_LOCAL_TOOL_UNTRUSTED' })
  chmodSync(root, 0o700)
  assert.match((await measureLocalToolFile(file)).sha256, /^[0-9a-f]{64}$/)
})
