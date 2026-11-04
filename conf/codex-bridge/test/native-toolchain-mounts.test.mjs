import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { nativeToolchainMountArgs, validateNativeExecutionToolchain, validateNativeExecutionToolchainAsync } from '../native-execution-profile.mjs'

const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-mounts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = []
  const add = (relative, target = `/usr/lib/${relative}`, content = relative) => {
    const sourcePath = resolve(root, relative); mkdirSync(resolve(sourcePath, '..'), { recursive: true, mode: 0o755 })
    writeFileSync(sourcePath, content, { mode: 0o755 })
    const file = { sourcePath, sandboxPath: target, sha256: createHash('sha256').update(content).digest('hex') }; files.push(file); return file
  }
  add('shell', '/bin/bash'); add('sh', '/bin/sh')
  add('package/a'); add('package/nested/b'); add('package/nested/c')
  return { root, files, add, raw: () => ({ shell: '/bin/bash', files: [...files] }) }
}
const binds = toolchain => {
  const args = nativeToolchainMountArgs(toolchain), pairs = []
  for (let i = 0; i < args.length; i++) if (args[i] === '--ro-bind') pairs.push([args[i + 1], args[i + 2]])
  return pairs
}
const grouped = (f, toolchain) => binds(toolchain).some(([source, target]) => source === resolve(f.root, 'package') && target === '/usr/lib/package')

test('verified exact directory closure uses maximal read-only group without changing file contract', t => {
  const f = fixture(t), raw = f.raw(), verified = validateNativeExecutionToolchain(raw)
  assert.equal(binds(raw).length, 5, 'unverified manifests cannot claim a grouped directory')
  assert.equal(grouped(f, verified), true); assert.equal(binds(verified).length, 3)
  assert.deepEqual(verified.files, [...raw.files].sort((a,b) => a.sandboxPath.localeCompare(b.sandboxPath)))
  assert.equal(validateNativeExecutionToolchain(verified), verified)
})

test('worker validation transfers its plan only with the existing metadata guard', async t => {
  const f = fixture(t), verified = await validateNativeExecutionToolchainAsync(f.raw())
  assert.equal(grouped(f, verified), true); assert.equal(binds(verified).length, 3)
  assert.equal(validateNativeExecutionToolchain(verified), verified)
})

for (const kind of ['file', 'symlink', 'empty-directory']) test(`unlisted ${kind} prevents parent grouping, retaining safe child group`, t => {
  const f = fixture(t), path = resolve(f.root, 'package/unlisted')
  if (kind === 'file') writeFileSync(path, 'not authorized')
  else if (kind === 'symlink') symlinkSync('/etc', path)
  else mkdirSync(path)
  const verified = validateNativeExecutionToolchain(f.raw())
  assert.equal(grouped(f, verified), false)
  assert.equal(binds(verified).length, 4)
  assert.ok(binds(verified).some(([, target]) => target === '/usr/lib/package/nested'))
  assert.ok(binds(verified).every(([, target]) => !target.includes('unlisted')))
})

test('new files invalidate grouped directory plan even after restoring parent mtime', t => {
  const f = fixture(t), initial = validateNativeExecutionToolchain(f.raw()), directory = resolve(f.root, 'package/nested')
  const before = statSync(directory); writeFileSync(resolve(directory, 'unlisted'), 'hidden'); utimesSync(directory, before.atime, before.mtime)
  const current = validateNativeExecutionToolchain(initial)
  assert.notEqual(current, initial); assert.equal(grouped(f, current), false)
  assert.equal(binds(current).length, 5)
})

test('changed bytes and writable directories keep the original integrity rejection', t => {
  const f = fixture(t), initial = validateNativeExecutionToolchain(f.raw())
  chmodSync(resolve(f.root, 'package'), 0o777)
  assert.throws(() => validateNativeExecutionToolchain(initial), /TOOLCHAIN_UNSAFE/)
  chmodSync(resolve(f.root, 'package'), 0o755)
  writeFileSync(resolve(f.root, 'package/a'), 'changed')
  assert.throws(() => validateNativeExecutionToolchain(initial), /TOOLCHAIN_DRIFT/)
})

test('renamed targets and mixed source parents retain exact per-file mappings', t => {
  const f = fixture(t); f.files.find(file => file.sandboxPath.endsWith('/nested/b')).sandboxPath = '/usr/lib/package/nested/renamed'
  const verified = validateNativeExecutionToolchain(f.raw())
  assert.equal(grouped(f, verified), false)
  assert.ok(binds(verified).some(([source,target]) => source.endsWith('/nested/b') && target.endsWith('/nested/renamed')))
  assert.equal(binds(verified).length, 5)
})
