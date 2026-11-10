import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'inspection-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ca = resolve(root, 'ca'); mkdirSync(ca)
  const runtime = Object.assign(Object.create(TypedInspectionProfileRuntime.prototype), {
    activeAdapters: new Map(), warmChatAdapters: new Map(), conversationOwners: new Map(), providerCaTrust: { directory: ca }
  })
  return { root, ca, runtime }
}

test('failed active shutdown retains ownership and CA while other adapters still stop', async t => {
  const { runtime, ca } = fixture(t)
  let stops = 0; let refuse = true; let egressStops = 0
  const item = { engineState: { conversationKey: 'conversation' }, adapter: { shutdown: async () => {
    if (refuse) throw new Error('private shutdown detail')
  } }, egress: { dispose: async () => { egressStops++ } } }
  runtime.activeAdapters.set('first', item); runtime.conversationOwners.set('conversation', 'first')
  runtime.activeAdapters.set('other', { engineState: {}, adapter: { shutdown: async () => { stops++ } } })
  await assert.rejects(runtime.dispose(), error => error.message === 'TYPED_INSPECTION_SHUTDOWN_UNCONFIRMED')
  assert.equal(stops, 1); assert.equal(egressStops, 1); assert.equal(runtime.disposed, true)
  assert.equal(runtime.activeAdapters.get('first'), item); assert.equal(runtime.activeAdapters.has('other'), false)
  assert.equal(runtime.conversationOwners.get('conversation'), 'first'); assert.equal(existsSync(ca), true)
  refuse = false; await runtime.dispose()
  assert.equal(runtime.activeAdapters.size, 0); assert.equal(runtime.conversationOwners.size, 0); assert.equal(existsSync(ca), false)
})

test('warm egress failure retains private inputs and ownership until explicit successful retry', async t => {
  const { runtime, root, ca } = fixture(t); const inputs = resolve(root, 'inputs'); mkdirSync(inputs)
  let refuse = true
  const item = { owner: 'owner', emptyInputs: inputs, adapter: { shutdown: async () => {} },
    egress: { dispose: async () => { if (refuse) throw new Error('still open') } } }
  runtime.warmChatAdapters.set('warm', item); runtime.conversationOwners.set('warm', 'owner'); runtime.idleWarmChatKey = 'warm'
  await assert.rejects(runtime.dispose(), /SHUTDOWN_UNCONFIRMED/)
  assert.equal(runtime.warmChatAdapters.get('warm'), item); assert.equal(runtime.idleWarmChatKey, 'warm')
  assert.equal(existsSync(inputs), true); assert.equal(existsSync(ca), true)
  refuse = false; await runtime.dispose()
  assert.equal(runtime.warmChatAdapters.size, 0); assert.equal(runtime.idleWarmChatKey, null); assert.equal(existsSync(inputs), false)
})

test('pending close rejection is not converted into a successful profile disposal', async t => {
  const { runtime, ca } = fixture(t)
  let rejectClose
  runtime.closingAdapters = new Map([['closing', new Promise((resolve, reject) => { rejectClose = reject })]])
  const disposed = assert.rejects(runtime.dispose(), /SHUTDOWN_UNCONFIRMED/)
  rejectClose(new Error('unconfirmed close')); await disposed
  assert.equal(existsSync(ca), true)
})

test('failed idle warm close preserves private inputs and can be retried by disposal', async t => {
  const { runtime, root, ca } = fixture(t); const inputs = resolve(root, 'inputs'); mkdirSync(inputs)
  let refuse = true; let stops = 0
  const item = { idle: true, owner: 'owner', emptyInputs: inputs,
    adapter: { shutdown: async () => { stops++; if (refuse) throw new Error('unconfirmed') } },
    egress: { dispose: async () => {} } }
  runtime.warmChatAdapters.set('warm', item); runtime.conversationOwners.set('warm', 'owner')
  await assert.rejects(runtime._closeWarmChat('warm'), /unconfirmed/)
  assert.equal(item.closing, null); assert.equal(existsSync(inputs), true)
  assert.equal(runtime.warmChatAdapters.get('warm'), item); assert.equal(existsSync(ca), true)
  refuse = false; await runtime.dispose()
  assert.equal(stops, 2); assert.equal(existsSync(inputs), false); assert.equal(runtime.warmChatAdapters.size, 0)
})
