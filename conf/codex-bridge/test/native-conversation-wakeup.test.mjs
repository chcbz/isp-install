import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeConversationWakeup } from '../native-conversation-wakeup.mjs'
const fixture = overrides => {
  let now = 0, next = Infinity
  const timers = new Map(), calls = [], errors = []
  let serial = 0
  const loop = new NativeConversationWakeup({
    now: () => now, current: () => true, eventDriven: true,
    poll: async options => { calls.push(options); return { status: 'IDLE' } },
    nextRecoveryAt: () => next, onError: error => errors.push(error),
    schedule: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id },
    cancel: id => timers.delete(id), ...overrides
  })
  return { loop, timers, calls, errors, recovery: at => { next = at }, now: at => { now = at },
    async tick() {
      assert.equal(timers.size, 1)
      const [id, entry] = [...timers.entries()][0]; timers.delete(id); now = entry.at
      entry.fn(); await new Promise(resolve => setImmediate(resolve))
    } }
}
test('acknowledged idle lane performs startup discovery once then has no timer or HTTP polling', async () => {
  const f = fixture(); await f.loop.start()
  assert.deepEqual(f.calls, [{ discover: true }]); assert.equal(f.timers.size, 0)
  for (let i = 0; i < 1000; i++) f.loop.wake()
  assert.equal(f.timers.size, 1); await f.tick()
  assert.equal(f.calls.length, 2); assert.equal(f.timers.size, 0)
})
test('old API retains 3-second discovery and stop invalidates already queued callback', async () => {
  const f = fixture({ eventDriven: false }); await f.loop.start()
  assert.equal([...f.timers.values()][0].at, 3000)
  const old = [...f.timers.values()][0].fn; f.loop.stop(); old()
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0)
})
test('in-flight hints coalesce into one trailing discovery without overlap', async () => {
  let release, active = 0, peak = 0
  const calls = []
  const f = fixture({ poll: async options => {
    calls.push(options); active++; peak = Math.max(peak, active)
    if (calls.length === 1) await new Promise(resolve => { release = resolve })
    active--; return { status: 'IDLE' }
  } })
  const first = f.loop.start()
  for (let i = 0; i < 1000; i++) f.loop.wake()
  assert.equal(f.timers.size, 0); release(); await first; await f.tick()
  assert.equal(calls.length, 2); assert.equal(peak, 1); assert.equal(f.timers.size, 0)
})
test('UNKNOWN recovery fires at the recorded due time without an inbox request', async () => {
  const f = fixture(); f.recovery(15000); await f.loop.start()
  assert.equal([...f.timers.values()][0].at, 15000)
  f.recovery(Infinity); await f.tick()
  assert.deepEqual(f.calls, [{ discover: true }, { discover: false }]); assert.equal(f.timers.size, 0)
})
test('discovery errors retry and expired local recovery cannot become a busy loop', async () => {
  const f = fixture({ poll: async () => { throw new Error('offline') } })
  f.recovery(0); await f.loop.start()
  assert.equal([...f.timers.values()][0].at, 3000)
  f.loop.wake(); assert.equal([...f.timers.values()][0].at, 3000)
  await f.tick(); assert.equal([...f.timers.values()][0].at, 6000)
  assert.equal(f.errors.length, 2)
})
test('busy previous lifecycle retries startup and cannot lose discovery', async () => {
  let count = 0
  const f = fixture({ poll: async options => { assert.equal(options.discover, true); return { status: ++count === 1 ? 'BUSY' : 'IDLE' } } })
  await f.loop.start(); await f.tick(); assert.equal(count, 2); assert.equal(f.timers.size, 0)
})
test('full inbox drains immediately; stopping an in-flight pass never resurrects timers', async () => {
  let more = true
  const f = fixture({ hasMore: () => more }); await f.loop.start()
  assert.equal([...f.timers.values()][0].at, 0)
  more = false; await f.tick(); assert.equal(f.calls.length, 2)
  let release
  const g = fixture({ poll: () => new Promise(resolve => { release = resolve }) })
  const pending = g.loop.start(); g.loop.stop(); release({ status: 'IDLE' }); await pending
  assert.equal(g.timers.size, 0)
})
