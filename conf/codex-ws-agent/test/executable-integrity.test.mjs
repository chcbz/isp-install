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
