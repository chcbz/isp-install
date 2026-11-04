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
  return { root, raw, directory, prepare, load }
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
