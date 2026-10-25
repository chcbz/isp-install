import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { cleanupCodexAppServerSnapshots, measureCodexAppServerBinary, reclaimStaleCodexAppServerSnapshots, verifyCodexAppServerBinaryIdentity } from '../app-server-adapter.mjs'

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-snapshot-growth-')); chmodSync(root, 0o700)
  const bin = resolve(root, 'codex'); writeFileSync(bin, '#!/bin/sh\necho codex-cli fixture\n', { mode: 0o700 })
  const home = name => { const path = resolve(root, name); mkdirSync(path, { mode: 0o700 }); return path }
  const old = (home, name = '.cyf-app-server-bin-Ab12Cd', ageMs = 600_000) => {
    const path = resolve(home, name); mkdirSync(path, { mode: 0o700 })
    writeFileSync(resolve(path, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: 99999999, startTime: '1', nonce: 'fixture' }), { mode: 0o600 })
    writeFileSync(resolve(path, 'payload'), 'old program, not business state')
    const time = new Date(Date.now() - ageMs); utimesSync(path, time, time); return path
  }
  return { root, bin, home, old }
}
const probe = () => ({ status: 0, stdout: 'codex-cli fixture\n' })
const count = home => readdirSync(home).filter(name => name.startsWith('.cyf-app-server-bin-')).length

// Independent cache instances represent workers/processes, never fake trust from
// fixtures. The exact executable and companion/resource checks still run.
test('100 independent Agent HOMEs reuse one measured program, sweep every cached root, and preserve private state', () => {
  const f = fixture(); const cache = new Map(); const homes = []; let shared
  try {
    for (let i = 0; i < 100; i++) {
      const home = f.home(`agent-${i}`); homes.push(home); const stale = f.old(home)
      const auth = resolve(home, 'auth.json'); const state = resolve(home, 'state.sqlite')
      writeFileSync(auth, `private-${i}`, { mode: 0o600 }); writeFileSync(state, `business-${i}`, { mode: 0o600 })
      const profile = { codexBin: f.bin, codexHome: home }
      const measured = measureCodexAppServerBinary(profile, { cache, spawnSyncFn: probe })
      shared ||= measured
      assert.equal(measured, shared); assert.equal(existsSync(stale), false)
      assert.equal(readFileSync(auth, 'utf8'), `private-${i}`); assert.equal(readFileSync(state, 'utf8'), `business-${i}`)
      assert.equal(verifyCodexAppServerBinaryIdentity(profile, measured), true)
    }
    assert.equal(cache.size, 1); assert.equal(homes.reduce((total, home) => total + count(home), 0), 1)
    assert.notEqual(statSync(shared.snapshotPath).ino, statSync(f.bin).ino)
  } finally { cleanupCodexAppServerSnapshots(); rmSync(f.root, { recursive: true, force: true }) }
})

test('cache hits schedule a young orphan for guarded reclamation after the existing grace window', context => {
  const f = fixture(); const cache = new Map()
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  try {
    const first = f.home('first'); const second = f.home('second'); const stale = f.old(second, '.cyf-app-server-bin-Ab12Cd', 1000)
    const shared = measureCodexAppServerBinary({ codexBin: f.bin, codexHome: first }, { cache, spawnSyncFn: probe })
    assert.equal(measureCodexAppServerBinary({ codexBin: f.bin, codexHome: second }, { cache, spawnSyncFn: probe }), shared)
    assert.equal(existsSync(stale), true)
    context.mock.timers.tick(300_001)
    assert.equal(existsSync(stale), false); assert.equal(existsSync(shared.snapshotPath), true)
    assert.equal(count(first), 1); assert.equal(count(second), 0)
  } finally { cleanupCodexAppServerSnapshots(); context.mock.timers.reset(); rmSync(f.root, { recursive: true, force: true }) }
})

test('a deferred sweep rechecks the owner and preserves a newly live claim', context => {
  const f = fixture(); context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  try {
    const home = f.home('agent'); const stale = f.old(home, '.cyf-app-server-bin-Ab12Cd', 1000)
    measureCodexAppServerBinary({ codexBin: f.bin, codexHome: home }, { cache: new Map(), spawnSyncFn: probe })
    const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const startTime = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]
    writeFileSync(resolve(stale, 'owner.json'), JSON.stringify({ pid: process.pid, startTime }), { mode: 0o600 })
    context.mock.timers.tick(300_001)
    assert.equal(existsSync(stale), true)
  } finally { cleanupCodexAppServerSnapshots(); context.mock.timers.reset(); rmSync(f.root, { recursive: true, force: true }) }
})

test('repeated stopped-worker restarts retain one shared snapshot instead of one program per Agent per restart', () => {
  const f = fixture(); const homes = Array.from({ length: 10 }, (_, i) => f.home(`agent-${i}`))
  const moduleUrl = new URL('../app-server-adapter.mjs', import.meta.url).href
  const program = `import { measureCodexAppServerBinary } from ${JSON.stringify(moduleUrl)};\nconst homes=JSON.parse(process.argv[1]);const bin=process.argv[2];for(const codexHome of homes)measureCodexAppServerBinary({codexBin:bin,codexHome});`
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(homes), f.bin], { encoding: 'utf8', timeout: 15000 })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(homes.reduce((sum, home) => sum + count(home), 0), 1)
      // Age the stopped process's snapshot, not a live executable or business state.
      for (const home of homes) for (const name of readdirSync(home).filter(name => name.startsWith('.cyf-app-server-bin-'))) {
        const time = new Date(Date.now() - 600_000); utimesSync(resolve(home, name), time, time)
      }
    }
    assert.equal(homes.reduce((sum, home) => sum + reclaimStaleCodexAppServerSnapshots(home), 0), 1)
    assert.equal(homes.reduce((sum, home) => sum + count(home), 0), 0)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})


test('reclamation preserves unsafe owners, symlinks, unrelated directories and actual live executables', async () => {
  const f = fixture(); let child
  try {
    const home = f.home('agent'); const live = f.old(home); const unsafe = f.old(home, '.cyf-app-server-bin-Ef34Gh')
    chmodSync(resolve(unsafe, 'owner.json'), 0o666)
    const unrelated = resolve(home, 'private-task'); mkdirSync(unrelated, { mode: 0o700 })
    const outside = f.home('outside'); symlinkSync(outside, resolve(home, '.cyf-app-server-bin-Ij56Kl'))
    // Even a dead/missing owner is not authority to remove a running native inode.
    const bin = resolve(live, 'codex'); copyFileSync('/bin/sleep', bin); chmodSync(bin, 0o500)
    const time = new Date(Date.now() - 600_000); utimesSync(live, time, time)
    child = spawn(bin, ['30'], { stdio: 'ignore' })
    await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail) })
    assert.equal(reclaimStaleCodexAppServerSnapshots(home), 0)
    for (const path of [live, unsafe, unrelated, outside, resolve(home, '.cyf-app-server-bin-Ij56Kl')]) assert.equal(existsSync(path), true)
    const stopped = new Promise(ok => child.once('exit', ok)); child.kill('SIGTERM'); await stopped
    assert.equal(reclaimStaleCodexAppServerSnapshots(home), 1)
    assert.equal(existsSync(unsafe), true); assert.equal(existsSync(outside), true)
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }) }
})
