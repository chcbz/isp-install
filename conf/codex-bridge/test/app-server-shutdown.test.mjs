import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { AppServerAdapter } from '../app-server-adapter.mjs'

function fixture() {
  const child = new EventEmitter()
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, killed: false })
  const signals = []
  child.kill = signal => { signals.push(signal); child.killed = true; return true }
  return { child, signals, adapter: new AppServerAdapter({ child }) }
}

test('shutdown does not report success after SIGKILL without close confirmation', async () => {
  const { child, signals, adapter } = fixture()
  let finished = false
  const closing = adapter.shutdown({ timeoutMs: 5 }).then(() => { finished = true })
  await delay(150)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(finished, false)
  child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL')
  await delay(1); assert.equal(finished, false)
  child.emit('close', null, 'SIGKILL'); await closing
  assert.equal(finished, true)
})

test('concurrent shutdown joins one lifecycle and already closed child is idempotent', async () => {
  const { child, signals, adapter } = fixture()
  const first = adapter.shutdown({ timeoutMs: 50 })
  assert.equal(adapter.shutdown(), first)
  child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0)
  await first; await adapter.shutdown(); await delay(60)
  assert.deepEqual(signals, ['SIGTERM'])
})

test('child closed before shutdown does not wait for a second close event', async () => {
  const { child, signals, adapter } = fixture()
  child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0)
  await adapter.shutdown(); assert.deepEqual(signals, [])
})

test('failed signal does not authorize private cleanup', async () => {
  const { child, adapter } = fixture()
  child.kill = () => { throw new Error('EPERM fixture') }
  let finished = false
  const closing = adapter.shutdown({ timeoutMs: 1 }).then(() => { finished = true })
  await delay(120); assert.equal(finished, false)
  child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0)
  await closing
})

test('real owned child ignoring SIGTERM is reaped before shutdown completes', async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], { stdio: ['pipe', 'pipe', 'pipe'] })
  const adapter = new AppServerAdapter({ child })
  t.after(async () => {
    if (!adapter.childClosed) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed }
  })
  await once(child.stdout, 'data')
  let closed = false; child.once('close', () => { closed = true })
  await adapter.shutdown({ timeoutMs: 10 })
  assert.equal(child.signalCode, 'SIGKILL'); assert.equal(closed, true)
  await adapter.shutdown()
})
