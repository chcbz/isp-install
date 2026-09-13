import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const source = resolve(import.meta.dirname, '..')
const checker = resolve(source, 'release-manifest-check.mjs')
const run = (root, layout) => spawnSync(process.execPath, [checker, '--layout', layout], {
  cwd: root, encoding: 'utf8', env: { ...process.env }
})
const manifest = () => JSON.parse(readFileSync(resolve(source, 'release-manifest.json'), 'utf8'))
const releaseFixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'codex-ws-agent-release-manifest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  copyFileSync(resolve(source, 'release-manifest.json'), resolve(root, 'release-manifest.json'))
  for (const entry of manifest().files) {
    copyFileSync(resolve(source, entry.source), resolve(root, entry.target))
    chmodSync(resolve(root, entry.target), Number.parseInt(entry.mode, 8))
  }
  return root
}

test('source candidate and staged release match the exact versioned manifest', t => {
  const sourceResult = run(source, 'source')
  assert.equal(sourceResult.status, 0, `${sourceResult.stdout}\n${sourceResult.stderr}`)
  assert.match(sourceResult.stdout, /version=1\.1\.0-m4\.20260913/)
  assert.match(sourceResult.stdout, /files=15/)
  assert.doesNotMatch(sourceResult.stdout, /api.?key|bearer|token/i)

  const root = releaseFixture(t)
  const releaseResult = run(root, 'release')
  assert.equal(releaseResult.status, 0, `${releaseResult.stdout}\n${releaseResult.stderr}`)
})

test('release verification rejects byte, mode, symlink, and catalog substitution', async t => {
  await t.test('bytes', () => {
    const root = releaseFixture(t)
    writeFileSync(resolve(root, 'agent-client.mjs'), 'substituted\n')
    assert.notEqual(run(root, 'release').status, 0)
  })
  await t.test('mode', () => {
    const root = releaseFixture(t)
    chmodSync(resolve(root, 'agent-client.mjs'), 0o600)
    assert.notEqual(run(root, 'release').status, 0)
  })
  await t.test('symlink', () => {
    const root = releaseFixture(t)
    rmSync(resolve(root, 'agent-client.mjs'))
    symlinkSync('/dev/null', resolve(root, 'agent-client.mjs'))
    assert.notEqual(run(root, 'release').status, 0)
  })
  await t.test('catalog', () => {
    const root = releaseFixture(t)
    const value = JSON.parse(readFileSync(resolve(root, 'release-manifest.json'), 'utf8'))
    value.files.pop()
    writeFileSync(resolve(root, 'release-manifest.json'), `${JSON.stringify(value)}\n`)
    assert.notEqual(run(root, 'release').status, 0)
  })
})
