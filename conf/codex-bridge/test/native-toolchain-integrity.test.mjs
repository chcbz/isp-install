import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { measureMinimalNativeExecutionToolchain, validateNativeExecutionToolchain, validateNativeExecutionToolchainAsync } from '../native-execution-profile.mjs'

const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-tool-integrity-')); chmodSync(root, 0o700)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = resolve(root, 'tools'); mkdirSync(directory, { mode: 0o755 })
  const path = resolve(directory, 'sample'); writeFileSync(path, 'good', { mode: 0o600 })
  const base = measureMinimalNativeExecutionToolchain()
  return { path, directory, toolchain: { shell: base.shell, files: [...base.files, { sourcePath: path, sandboxPath: '/usr/lib/cyf-sample', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }] } }
}

test('worker-verified immutable manifest reuses hashes only with exact metadata', async t => {
  const f = fixture(t)
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 1)
  let verified
  try { verified = await validateNativeExecutionToolchainAsync(f.toolchain) } finally { clearInterval(timer) }
  assert.ok(ticks > 0, 'initial SHA verification must yield to the main event loop')
  assert.ok(Object.isFrozen(verified) && Object.isFrozen(verified.files) && verified.files.every(Object.isFrozen))
  assert.equal(validateNativeExecutionToolchain(verified), verified)
  const serialized = JSON.parse(JSON.stringify(verified))
  assert.notEqual(validateNativeExecutionToolchain(serialized), serialized, 'caller data cannot mint cached integrity evidence')
  const before = statSync(f.path)
  writeFileSync(f.path, 'evil'); utimesSync(f.path, before.atime, before.mtime)
  assert.throws(() => validateNativeExecutionToolchain(verified), /TOOLCHAIN_DRIFT/)
  await assert.rejects(validateNativeExecutionToolchainAsync(verified), /TOOLCHAIN_DRIFT/)
})

test('ancestor permission changes invalidate reused integrity; same-byte replacement is rehashed', async t => {
  const f = fixture(t), verified = await validateNativeExecutionToolchainAsync(f.toolchain)
  chmodSync(f.directory, 0o775)
  assert.throws(() => validateNativeExecutionToolchain(verified), /TOOLCHAIN_UNSAFE/)
  chmodSync(f.directory, 0o755)
  writeFileSync(f.path, 'good')
  assert.notEqual(validateNativeExecutionToolchain(verified), verified)
})
