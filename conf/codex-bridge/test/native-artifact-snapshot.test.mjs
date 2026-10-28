import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotNativeArtifact } from '../native-artifact-snapshot.mjs'

test('snapshots output by anchored path and remains unchanged when draft changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-snapshot-'))
  try {
    const draftsDirectory = join(root, 'drafts'), snapshotDirectory = join(root, 'private')
    mkdirSync(draftsDirectory); mkdirSync(snapshotDirectory); mkdirSync(join(draftsDirectory, 'sub'))
    const draft = join(draftsDirectory, 'sub', 'result.txt'); writeFileSync(draft, '中文结果')
    const result = snapshotNativeArtifact({ draftsDirectory, snapshotDirectory, path: '/outputs/sub/result.txt' })
    assert.equal(result.byteLength, String(Buffer.byteLength('中文结果')))
    assert.equal(result.sha256, createHash('sha256').update('中文结果').digest('hex'))
    writeFileSync(draft, 'changed'); assert.equal(readFileSync(result.path, 'utf8'), '中文结果')
    writeFileSync(draft, ''); assert.equal(snapshotNativeArtifact({ draftsDirectory, snapshotDirectory, path: '/outputs/sub/result.txt' }).byteLength, '0')
    for (const path of ['/outputs/../secret', '/outputs/sub/../secret', '/outputs//secret', '/etc/passwd']) assert.throws(() => snapshotNativeArtifact({ draftsDirectory, snapshotDirectory, path }))
    symlinkSync(root, join(draftsDirectory, 'link')); assert.throws(() => snapshotNativeArtifact({ draftsDirectory, snapshotDirectory, path: '/outputs/link/secret' }))
    symlinkSync(draft, join(draftsDirectory, 'file-link')); assert.throws(() => snapshotNativeArtifact({ draftsDirectory, snapshotDirectory, path: '/outputs/file-link' }))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
