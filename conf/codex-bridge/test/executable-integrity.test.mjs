import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, utimesSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createExecutableInspector } from '../executable-integrity.mjs'
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
test('executable measurement yields while hashing and reuses only exact metadata', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-exe-integrity-'))
  try {
    const path = resolve(root, 'program'); const bytes = Buffer.alloc(8 * 1024 * 1024, 1); writeFileSync(path, bytes)
    const inspect = createExecutableInspector(); let yielded = false; setImmediate(() => { yielded = true })
    const first = await inspect(path); assert.equal(yielded, true); assert.equal(first.sha256, sha(bytes))
    assert.deepEqual(await inspect(path), first)
    const before = statSync(path); bytes.fill(2); writeFileSync(path, bytes); utimesSync(path, before.atime, before.mtime)
    const changed = await inspect(path); assert.notEqual(changed.stamp, first.stamp); assert.equal(changed.sha256, sha(bytes))
    const replacement = resolve(root, 'replacement'); writeFileSync(replacement, bytes); renameSync(replacement, path)
    const replaced = await inspect(path); assert.notEqual(replaced.ino, changed.ino); assert.equal(replaced.sha256, changed.sha256)
    await assert.rejects(inspect(root), /EXECUTABLE_NOT_REGULAR/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('different paths and concurrent callers share bytes, not path authority; cache stays bounded', async () => {
  const { open } = await import('node:fs/promises'); const { linkSync } = await import('node:fs')
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-exe-shared-'))
  const counts = { reads: 0, opens: 0 }
  const inspect = createExecutableInspector({ openFile: async (...args) => {
    counts.opens++; const fd = await open(...args)
    return { stat: (...a) => fd.stat(...a), close: () => fd.close(), read: (...a) => { counts.reads++; return fd.read(...a) } }
  } })
  try {
    const first = resolve(root, 'engine'); const alias = resolve(root, 'other-pid'); writeFileSync(first, Buffer.alloc(2 * 1024 * 1024, 3)); linkSync(first, alias)
    const pair = await Promise.all([inspect(first), inspect(alias)])
    assert.deepEqual(pair[0], pair[1]); assert.equal(counts.reads, 2); assert.equal(counts.opens, 4)
    await inspect(alias); assert.equal(counts.reads, 2); assert.equal(counts.opens, 6)
    // Two unrelated executable identities evict the old digest, without denying it.
    for (const name of ['wrapper', 'helper']) { const path = resolve(root, name); writeFileSync(path, name); await inspect(path) }
    const before = counts.reads; await inspect(first); assert.equal(counts.reads, before + 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cached identity still reopens each caller path and rejects replacement during awaits', async () => {
  const { open } = await import('node:fs/promises'); const { linkSync } = await import('node:fs')
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-exe-reopen-'))
  let swap = false, calls = 0
  const path = resolve(root, 'pid-exe'), replacement = resolve(root, 'replacement'), alias = resolve(root, 'warm-pid')
  try {
    writeFileSync(path, 'trusted'); linkSync(path, alias); writeFileSync(replacement, 'changed')
    const inspect = createExecutableInspector({ openFile: async (...args) => {
      calls++; if (swap && args[0] === path && calls === 4) renameSync(replacement, path)
      return open(...args)
    } })
    await inspect(alias); swap = true
    await assert.rejects(inspect(path), /EXECUTABLE_DRIFT/)
    assert.equal((await inspect(path)).sha256, sha('changed'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed concurrent measurement is not cached and a subsequent call reads again', async () => {
  const { open } = await import('node:fs/promises'); const { linkSync } = await import('node:fs')
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-exe-retry-')); let fail = true, reads = 0
  try {
    const path = resolve(root, 'engine'), alias = resolve(root, 'other-pid'); writeFileSync(path, 'engine'); linkSync(path, alias)
    const inspect = createExecutableInspector({ openFile: async (...args) => {
      const fd = await open(...args)
      return { stat: (...a) => fd.stat(...a), close: () => fd.close(), read: async (...a) => {
        reads++; await new Promise(resolve => setImmediate(resolve)); if (fail) throw new Error('SYNTHETIC_READ_ERROR'); return fd.read(...a)
      } }
    } })
    const failed = await Promise.allSettled([inspect(path), inspect(alias)])
    assert.ok(failed.every(r => r.status === 'rejected' && /SYNTHETIC_READ_ERROR/.test(r.reason.message)))
    fail = false; const before = reads; assert.equal((await inspect(path)).sha256, sha('engine')); assert.equal(reads, before + 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mutation during a read is rejected even if size and mtime are restored', async () => {
  const { open } = await import('node:fs/promises')
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-exe-drift-')); const path = resolve(root, 'engine'); let mutate = true
  try {
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 1)); const before = statSync(path)
    const inspect = createExecutableInspector({ openFile: async (...args) => {
      const fd = await open(...args)
      return { stat: (...a) => fd.stat(...a), close: () => fd.close(), read: async (...a) => {
        const result = await fd.read(...a)
        if (mutate) { mutate = false; writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 2)); utimesSync(path, before.atime, before.mtime) }
        return result
      } }
    } })
    await assert.rejects(inspect(path), /EXECUTABLE_DRIFT/)
    assert.equal((await inspect(path)).sha256, sha(Buffer.alloc(2 * 1024 * 1024, 2)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
