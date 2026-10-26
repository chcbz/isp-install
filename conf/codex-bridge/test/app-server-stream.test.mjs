import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { AppServerAdapter } from '../app-server-adapter.mjs'

function childWith(stdin) {
  const child = new EventEmitter()
  Object.assign(child, { stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false })
  child.kill = () => { child.killed = true; return true }
  return child
}

test('app-server stdin EPIPE rejects pending RPCs without crashing Runtime or claiming success', async () => {
  const failure = Object.assign(new Error('closed pipe'), { code: 'EPIPE' })
  const child = childWith(new Writable({ write(_chunk, _encoding, done) { done(failure) } }))
  const adapter = new AppServerAdapter({ child })
  let exits = 0; adapter.on('exit', () => { exits++ })
  await assert.rejects(adapter.request('thread/unsubscribe', { threadId: 'fixture' }), error => error === failure)
  assert.equal(adapter.closed, true)
  assert.equal(adapter.pending.size, 0)
  assert.equal(child.killed, true)
  assert.equal(exits, 1)
  child.emit('exit', 0)
  assert.doesNotThrow(() => child.stdin.emit('error', failure))
  assert.equal(exits, 1)
  await assert.rejects(adapter.request('thread/start'), /APP_SERVER_CLOSED/)
})

test('app-server late pipe failure after normal close stays idempotent', () => {
  const child = childWith(new PassThrough())
  const adapter = new AppServerAdapter({ child })
  let exits = 0; adapter.on('exit', () => { exits++ })
  adapter.close()
  assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' })))
  assert.equal(exits, 1)
})
