import test from 'node:test'
import assert from 'node:assert/strict'
import { disposeAppServerState, disposeProfileState } from '../agent-client.mjs'

test('app-server disposal joins callers and retains only failed adapters for explicit retry', async () => {
  let rejectClose, attempts = 0, stoppedPeer = 0
  const adapter = { shutdown: () => { attempts++; return new Promise((resolve, reject) => { rejectClose = reject }) } }
  const peer = { shutdown: async () => { stoppedPeer++ } }
  const state = { appServerAdapter: adapter, retainedChatAdapters: new Set([adapter, peer]) }
  const first = disposeAppServerState(state)
  assert.equal(disposeAppServerState(state), first)
  const rejected = assert.rejects(first, /shutdown is unconfirmed/)
  rejectClose(new Error('private detail')); await rejected
  assert.equal(state.disposed, true); assert.equal(state.appServerShutdownPending.has(adapter), true)
  assert.equal(state.appServerShutdownPending.has(peer), false); assert.equal(stoppedPeer, 1)
  adapter.shutdown = async () => { attempts++ }
  await disposeAppServerState(state)
  await disposeAppServerState(state)
  assert.equal(attempts, 2); assert.equal(stoppedPeer, 1); assert.equal(state.appServerShutdownPending.size, 0)
})

test('profile retry does not skip failed child shutdown or re-enable admission', async () => {
  let attempts = 0, fail = true, profileStops = 0
  const state = { profile: { agentId: 'shutdown-retry-fixture', runtimeIdentity: {} },
    processor: { pause() {}, stop() {}, waitForIdle: async () => {} },
    registration: { disconnect() {} },
    appServerAdapter: { shutdown: async () => { attempts++; if (fail) throw new Error('still running') } },
    typedInspectionProfileRuntime: { dispose: async () => { profileStops++ } } }
  const first = disposeProfileState(state)
  assert.equal(disposeProfileState(state), first)
  await assert.rejects(first, /shutdown is unconfirmed/)
  assert.equal(state.profileShutdownPromise, null); assert.equal(state.disposed, true)
  assert.equal(profileStops, 0)
  fail = false; await disposeProfileState(state)
  assert.equal(attempts, 2); assert.equal(profileStops, 1); assert.equal(state.runtimeTransport, null)
  await disposeProfileState(state); assert.equal(profileStops, 1)
})
