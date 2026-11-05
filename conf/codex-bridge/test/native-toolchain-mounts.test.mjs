import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, chmodSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { nativeToolchainMountArgs, readNativeToolchainImage, validateNativeExecutionToolchain, validateNativeExecutionToolchainAsync } from '../native-execution-profile.mjs'
import { prepareToolchainImage } from '../../cyf-agent-runtime-v1/lib/prepare-toolchain-image.mjs'

const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-image-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = []
  const add = (relative, target = `/usr/lib/${relative}`, content = relative) => {
    const sourcePath = resolve(root, 'source', relative); mkdirSync(resolve(sourcePath, '..'), { recursive: true, mode: 0o755 })
    writeFileSync(sourcePath, content, { mode: 0o755 })
    files.push({ sourcePath, sandboxPath: target, sha256: createHash('sha256').update(content).digest('hex') })
  }
  add('shell', '/bin/bash'); add('sh', '/bin/sh')
  add('package/a'); add('package/nested/b'); add('package/nested/c')
  const raw = { shell: '/bin/bash', files }, directory = resolve(root, 'image')
  const prepare = () => prepareToolchainImage({ directory, toolchain: raw })
  const load = () => readNativeToolchainImage(directory).toolchain
  return { root, raw, directory, prepare, load, prepareShared: () => prepareToolchainImage({ directory, toolchain: raw, sharedRoot: root }) }
}
const binds = toolchain => {
  const args = nativeToolchainMountArgs(toolchain), pairs = []
  for (let i = 0; i < args.length; i++) if (args[i] === '--ro-bind') pairs.push([args[i + 1], args[i + 2]])
  return pairs
}

test('prepared image has the same files but two fixed root mounts; no dynamic grouping', t => {
  const f = fixture(t), report = f.prepare(), verified = validateNativeExecutionToolchain(f.load())
  assert.equal(report.files, 5); assert.equal(report.mounts, 2)
  assert.equal(binds(f.raw).length, 5)
  assert.equal(binds(validateNativeExecutionToolchain(f.raw)).length, 5, 'removed temporary grouping algorithm')
  assert.equal(binds(f.load()).length, 5, 'unverified image cannot grant directories')
  assert.deepEqual(binds(verified), [[`${f.directory}/rootfs/bin`, '/bin'], [`${f.directory}/rootfs/usr`, '/usr']])
  assert.deepEqual(verified.files.map(({sandboxPath, sha256}) => ({sandboxPath, sha256})),
    [...f.raw.files].sort((a,b) => a.sandboxPath.localeCompare(b.sandboxPath)).map(({sandboxPath, sha256}) => ({sandboxPath, sha256})))
  assert.equal(validateNativeExecutionToolchain(verified), verified)
})

test('worker transfers verified image identity with existing metadata guard', async t => {
  const f = fixture(t); f.prepare()
  const verified = await validateNativeExecutionToolchainAsync(f.load())
  assert.equal(binds(verified).length, 2); assert.ok(Object.isFrozen(verified))
  assert.equal(validateNativeExecutionToolchain(verified), verified)
})

for (const kind of ['file', 'symlink', 'empty-directory']) test(`unlisted ${kind} is excluded at preparation and rejected if injected into image`, t => {
  const f = fixture(t), source = resolve(f.root, 'source/package/unlisted')
  if (kind === 'file') writeFileSync(source, 'private')
  else if (kind === 'symlink') symlinkSync('/etc', source)
  else mkdirSync(source)
  f.prepare(); const initial = validateNativeExecutionToolchain(f.load())
  const directory = resolve(f.directory, 'rootfs/usr/lib/package'), before = statSync(directory), extra = resolve(directory, 'unlisted')
  if (kind === 'file') writeFileSync(extra, 'private')
  else if (kind === 'symlink') symlinkSync('/etc', extra)
  else mkdirSync(extra)
  utimesSync(directory, before.atime, before.mtime)
  assert.throws(() => validateNativeExecutionToolchain(initial), /IMAGE_CLOSURE_INVALID/)
})

test('copied bytes are independent of old layout and image relocates without rebasing', t => {
  const f = fixture(t); f.prepare()
  writeFileSync(f.raw.files[0].sourcePath, 'mutated source')
  rmSync(resolve(f.root, 'source'), { recursive: true })
  const moved = resolve(f.root, 'published'); renameSync(f.directory, moved)
  const verified = validateNativeExecutionToolchain(readNativeToolchainImage(moved).toolchain)
  assert.equal(binds(verified).length, 2)
  assert.equal(readFileSync(resolve(moved, 'rootfs/bin/bash'), 'utf8'), 'shell')
  assert.ok(!readFileSync(resolve(moved, 'manifest.json'), 'utf8').includes(f.root))
})

test('changed bytes and writable directories retain integrity rejection', t => {
  const f = fixture(t); f.prepare(); const verified = validateNativeExecutionToolchain(f.load())
  const directory = resolve(f.directory, 'rootfs/usr/lib/package')
  chmodSync(directory, 0o777); assert.throws(() => validateNativeExecutionToolchain(verified), /TOOLCHAIN_UNSAFE/)
  chmodSync(directory, 0o755)
  const file = resolve(directory, 'a'), before = statSync(file)
  writeFileSync(file, 'changed'); utimesSync(file, before.atime, before.mtime)
  assert.throws(() => validateNativeExecutionToolchain(verified), /TOOLCHAIN_DRIFT/)
})

test('renamed targets and mixed source parents are laid out once at exact targets', t => {
  const f = fixture(t); f.raw.files.find(file => file.sandboxPath.endsWith('/nested/b')).sandboxPath = '/usr/lib/renamed/content'
  f.prepare(); const verified = validateNativeExecutionToolchain(f.load())
  assert.equal(binds(verified).length, 2)
  assert.equal(readFileSync(resolve(f.directory, 'rootfs/usr/lib/renamed/content'), 'utf8'), 'package/nested/b')
})

test('preparation refuses overwrite and preserves prior image', t => {
  const f = fixture(t); f.prepare(); const before = readFileSync(resolve(f.directory, 'manifest.json'))
  assert.throws(f.prepare, /IMAGE_EXISTS/)
  assert.deepEqual(readFileSync(resolve(f.directory, 'manifest.json')), before)
})

test('image root cannot grant files outside its declared mapping', t => {
  const f = fixture(t); f.prepare(); const image = f.load()
  image.files[0].sourcePath = f.raw.files.find(x => x.sandboxPath === image.files[0].sandboxPath).sourcePath
  assert.throws(() => validateNativeExecutionToolchain(image), /IMAGE_MAPPING_INVALID/)
})


test('installed files share one inode while unlisted source contents stay hidden', t => {
  const f = fixture(t)
  writeFileSync(resolve(f.root, 'source/private'), 'not granted')
  const report = f.prepareShared(), image = validateNativeExecutionToolchain(f.load())
  assert.equal(report.sharedFiles, 5); assert.equal(report.copiedFiles, 0)
  assert.equal(report.sharedBytes, f.raw.files.reduce((sum, f) => sum + statSync(f.sourcePath).size, 0))
  for (const file of image.files) {
    const source = f.raw.files.find(x => x.sandboxPath === file.sandboxPath)
    assert.equal(statSync(file.sourcePath).ino, statSync(source.sourcePath).ino)
    assert.equal(statSync(file.sourcePath).dev, statSync(source.sourcePath).dev)
    assert.equal(statSync(file.sourcePath).nlink, 2)
  }
  assert.equal(binds(image).length, 2)
})

test('external host dependencies remain independent even on the same filesystem', t => {
  const f = fixture(t), host = fixture(t), external = host.raw.files[0]
  f.raw.files.push({ ...external, sandboxPath: '/usr/lib/host-shell' })
  const report = f.prepareShared(), target = resolve(f.directory, 'rootfs/usr/lib/host-shell')
  assert.equal(report.sharedFiles, 5); assert.equal(report.copiedFiles, 1)
  assert.notEqual(statSync(external.sourcePath).ino, statSync(target).ino)
  writeFileSync(external.sourcePath, 'host package update')
  assert.equal(readFileSync(target, 'utf8'), 'shell')
  validateNativeExecutionToolchain(f.load())
})

test('shared aliases relocate together and image survives removing old aliases', t => {
  const f = fixture(t); f.prepareShared()
  const moved = f.root + '-published'; renameSync(f.root, moved)
  t.after(() => rmSync(moved, { recursive: true, force: true }))
  const image = resolve(moved, 'image'), source = resolve(moved, 'source/shell')
  assert.equal(statSync(source).ino, statSync(resolve(image, 'rootfs/bin/bash')).ino)
  rmSync(resolve(moved, 'source'), { recursive: true })
  assert.equal(binds(validateNativeExecutionToolchain(readNativeToolchainImage(image).toolchain)).length, 2)
  assert.equal(statSync(resolve(image, 'rootfs/bin/bash')).nlink, 1)
})

test('writes through a shared source alias are rejected by existing integrity guard', t => {
  const f = fixture(t); f.prepareShared(); const verified = validateNativeExecutionToolchain(f.load())
  const source = f.raw.files[0].sourcePath, before = statSync(source)
  writeFileSync(source, 'tampered'); utimesSync(source, before.atime, before.mtime)
  assert.throws(() => validateNativeExecutionToolchain(verified), /TOOLCHAIN_DRIFT/)
})

test('failed preparation unlinks only its own aliases and leaves sources unchanged', t => {
  const f = fixture(t)
  // Valid individual targets but an impossible directory closure, after shell
  // links have been created: preparation must unwind without deleting sources.
  f.raw.files.push({ ...f.raw.files[0], sandboxPath: '/usr/lib/package' })
  const before = f.raw.files.map(file => [file.sourcePath, readFileSync(file.sourcePath), statSync(file.sourcePath).nlink])
  assert.throws(f.prepareShared)
  assert.throws(() => statSync(f.directory), { code: 'ENOENT' })
  for (const [path, bytes, links] of before) {
    assert.deepEqual(readFileSync(path), bytes); assert.equal(statSync(path).nlink, links)
  }
})

test('sharing cannot be declared outside the containing installation', t => {
  const f = fixture(t)
  assert.throws(() => prepareToolchainImage({ directory: f.directory, toolchain: f.raw, sharedRoot: resolve(f.root, 'source') }), /SHARED_ROOT_INVALID/)
})
