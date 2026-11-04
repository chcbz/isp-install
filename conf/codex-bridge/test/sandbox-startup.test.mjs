import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, readlinkSync, statSync } from 'node:fs'
import { observeSandboxStartup, waitForSandboxStartup } from '../sandbox-startup.mjs'

const fixture = () => {
  const pipe = new PassThrough()
  const child = Object.assign(new EventEmitter(), { exitCode: null, stdio: [null, null, null, pipe] })
  observeSandboxStartup(child)
  return { pipe, child }
}

test('startup pipe handles split JSON, accepts harmless additional fields and releases listeners', async () => {
  const { child, pipe } = fixture()
  pipe.write('{"child-pid":12,'); pipe.end('"net-namespace":34,"mnt-namespace":56}\n')
  assert.deepEqual(await waitForSandboxStartup(child), { pid: 12, netNamespaceIno: '34' })
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(pipe.listenerCount('data'), 0)
})

test('invalid/truncated startup information never becomes ready', async () => {
  for (const text of ['', '{', '{}', '{"child-pid":0,"net-namespace":34}', '{"child-pid":12,"net-namespace":"34"}']) {
    const { child, pipe } = fixture(); pipe.end(text)
    await assert.rejects(waitForSandboxStartup(child), { code: 'TYPED_INSPECTION_SANDBOX_INFO_INVALID' })
  }
})

test('process exit, pipe loss and error wake startup waiters without timers', async () => {
  for (const reason of ['exit', 'close', 'error']) {
    const { child, pipe } = fixture()
    if (reason === 'exit') child.emit('exit', 1)
    if (reason === 'close') pipe.destroy()
    if (reason === 'error') pipe.emit('error', new Error('synthetic-pipe-error'))
    await assert.rejects(waitForSandboxStartup(child))
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(pipe.listenerCount('data'), 0)
  }
})

test('cancellation wakes a pending startup waiter and the owner can still close its child', async () => {
  const { child } = fixture(), controller = new AbortController()
  const waiting = waitForSandboxStartup(child, controller.signal)
  controller.abort()
  await assert.rejects(waiting, { code: 'TYPED_INSPECTION_EGRESS_CANCELLED' })
  child.emit('exit', 1)
  await assert.rejects(waitForSandboxStartup(child))
  await assert.rejects(waitForSandboxStartup(child, controller.signal), { code: 'TYPED_INSPECTION_EGRESS_CANCELLED' })
})

test('missing startup channel has no process-scanning fallback', async () => {
  assert.throws(() => observeSandboxStartup({}), { code: 'TYPED_INSPECTION_SANDBOX_INFO_PIPE_REQUIRED' })
  await assert.rejects(waitForSandboxStartup({}), { code: 'TYPED_INSPECTION_SANDBOX_INFO_PIPE_REQUIRED' })
})

// Explicit, low-cost local integration: no network, credentials or model call.
test('real bwrap info identifies a stable reaper, not the sandbox application', { skip: process.env.CYF_SANDBOX_STARTUP_PROBE !== '1' }, async t => {
  const child = observeSandboxStartup(spawn('/usr/bin/bwrap', [
    '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--info-fd', '3', '--', '/bin/cat'
  ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }))
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', x => { stderr += x })
  try {
    const started = performance.now(), info = await waitForSandboxStartup(child)
    assert.notEqual(info.pid, child.pid)
    assert.equal(readlinkSync(`/proc/${info.pid}/exe`), '/usr/bin/bwrap')
    assert.equal(String(statSync(`/proc/${info.pid}/ns/net`, { bigint: true }).ino), info.netNamespaceIno)
    assert.notEqual(readlinkSync(`/proc/${info.pid}/ns/net`), readlinkSync('/proc/self/ns/net'))
    const echoed = once(child.stdout, 'data'); child.stdin.write('ready\n')
    assert.equal(String((await echoed)[0]), 'ready\n')
    assert.equal(readlinkSync(`/proc/${info.pid}/exe`), '/usr/bin/bwrap', 'reaper identity must remain stable after application starts')
    const children = readFileSync(`/proc/${info.pid}/task/${info.pid}/children`, 'utf8').trim().split(/\s+/)
    assert.ok(children.some(pid => readlinkSync(`/proc/${pid}/exe`) === '/usr/bin/cat'))
    t.diagnostic(JSON.stringify({ startupAndEchoMs: performance.now() - started, reaperPid: info.pid, networkUsed: false }))
  } finally { child.stdin.end(); await exited; assert.equal(stderr, '') }
})

test('real sandbox binds network by reaper and verifies application only after protocol readiness', { skip: process.env.CYF_SANDBOX_STARTUP_PROBE !== '1' }, async t => {
  const { AppServerAdapter, verifySpawnedAppServerExecutableTree } = await import('../app-server-adapter.mjs')
  const { RestrictedProviderEgress } = await import('../typed-inspection-network.mjs')
  const { inspectExecutable } = await import('../executable-integrity.mjs')
  const executable = await inspectExecutable(process.execPath), wrapper = await inspectExecutable('/usr/bin/bwrap')
  const egress = new RestrictedProviderEgress({ providerBaseUrl: 'https://provider.invalid', networkConnectTimeoutMs: 1000 })
  const measurement = { measured: true, snapshotPath: process.execPath, snapshotIdentity: { ...executable, sha256: executable.sha256.replace(/^sha256:/, '') } }
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);if(f.id)console.log(JSON.stringify({id:f.id,result:{data:[]}}))})`
  let child, adapter, exited
  try {
    await egress.start()
    child = observeSandboxStartup(spawn('/usr/bin/bwrap', [
      '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--info-fd', '3', '--', process.execPath, '-e', script
    ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { LANG: 'C.UTF-8' } }))
    exited = once(child, 'exit')
    adapter = new AppServerAdapter({ child, schemaMeasurement: measurement, spawnedExecutableVerifier: verifySpawnedAppServerExecutableTree })
    const began = performance.now(), owner = await egress.bindOwner(child, wrapper)
    const boundMs = performance.now() - began
    assert.equal(readlinkSync(`/proc/${owner.pid}/exe`), '/usr/bin/bwrap')
    const network = await egress.attach()
    assert.equal(network.directInternetBlocked, true)
    assert.equal(network.otherHostPortBlocked, true)
    const readback = await adapter.initialize()
    assert.equal(readback.processExecutable.measured, true)
    assert.notEqual(readback.processExecutable.pid, owner.pid)
    assert.equal(readlinkSync(`/proc/${readback.processExecutable.pid}/ns/net`), owner.namespace.link)
    t.diagnostic(JSON.stringify({ bindMs: boundMs, appPid: readback.processExecutable.pid, reaperPid: owner.pid, modelCalled: false, syntheticProtocol: true }))
  } finally {
    child?.stdin.end()
    if (adapter) await adapter.shutdown({ timeoutMs: 1000 })
    await egress.dispose()
    if (exited) await exited
  }
})

test('actual app-server initializes in bwrap from an empty Home without model or credentials', { skip: process.env.CYF_SANDBOX_STARTUP_PROBE !== '1' }, async t => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { AppServerAdapter, measureCodexAppServerBinaryAsync, verifySpawnedAppServerExecutableTree } = await import('../app-server-adapter.mjs')
  const home = mkdtempSync(join(tmpdir(), 'cyf-startup-events-'))
  const profile = { codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: home }
  let adapter
  try {
    const measurement = await measureCodexAppServerBinaryAsync(profile)
    adapter = await AppServerAdapter.spawnAsync(profile, {
      cwd: home, schemaMeasurement: measurement, spawnedExecutableVerifier: verifySpawnedAppServerExecutableTree,
      spawnFn: (bin, args, options) => observeSandboxStartup(spawn('/usr/bin/bwrap', [
        '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--bind', home, home,
        '--proc', '/proc', '--chdir', home, '--info-fd', '3', '--', bin, ...args
      ], { ...options, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }))
    })
    const began = performance.now(), readback = await adapter.initialize()
    assert.ok(readback.initialize)
    assert.equal(readback.processExecutable.measured, true)
    assert.equal(readback.processExecutable.sha256, measurement.snapshotIdentity.sha256)
    assert.notEqual(readlinkSync(`/proc/${readback.processExecutable.pid}/ns/net`), readlinkSync('/proc/self/ns/net'))
    t.diagnostic(JSON.stringify({ initializedMs: performance.now() - began, actualAppServer: true, modelCalled: false, credentialsUsed: false }))
  } finally { await adapter?.shutdown({ timeoutMs: 1000 }); rmSync(home, { recursive: true, force: true }) }
})
