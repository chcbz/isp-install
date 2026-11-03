import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatDeltaCoalescer } from '../chat-delta-coalescer.mjs'
const fixture = (overrides = {}) => {
  const timers = new Map(), sent = [], errors = []; let id = 0
  const stream = createChatDeltaCoalescer({ send: text => sent.push(text), onError: error => errors.push(error),
    schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id }, cancel: key => timers.delete(key), ...overrides })
  const tick = () => { const batch = [...timers.values()]; timers.clear(); for (const { fn } of batch) fn() }
  return { stream, timers, sent, errors, tick }
}
test('first text is immediate and a 46-fragment burst preserves all Unicode and whitespace in two frames', () => {
  const f = fixture(), chunks = ['首', ...Array.from({ length: 45 }, (_, i) => i % 2 ? '🙂' : ' \n')]
  for (const c of chunks) f.stream.push(c)
  assert.deepEqual(f.sent, ['首']); assert.equal(f.timers.size, 1)
  f.stream.flush()
  assert.equal(f.sent.length, 2); assert.equal(f.sent.join(''), chunks.join('')); assert.equal(f.timers.size, 0)
  f.tick(); assert.equal(f.sent.length, 2)
})
test('only pending text owns a timer; a running turn continues to stream without an idle poll', () => {
  const f = fixture(); assert.equal(f.timers.size, 0)
  f.stream.push('a'); assert.equal(f.timers.size, 0)
  f.stream.push('b'); f.stream.push('c'); assert.equal([...f.timers.values()][0].ms, 200)
  f.tick(); assert.deepEqual(f.sent, ['a', 'bc']); assert.equal(f.timers.size, 0)
  f.stream.push('d'); f.tick(); assert.deepEqual(f.sent, ['a', 'bc', 'd'])
})
test('cancelled and disposed turns discard pending text and never emit after final or failure', () => {
  for (const how of ['cancel', 'close']) {
    let cancelled = false; const f = fixture({ isCancelled: () => cancelled })
    f.stream.push('a'); f.stream.push('b')
    if (how === 'cancel') cancelled = true; else f.stream.close()
    f.tick(); f.stream.push('c'); f.stream.flush()
    assert.deepEqual(f.sent, ['a']); assert.equal(f.timers.size, 0)
  }
})
test('timer send failures are reported once and close the stream, synchronous final flush failures propagate', () => {
  for (const timed of [true, false]) {
    let sends = 0; const boom = new Error('socket failed')
    const f = fixture({ send: () => { if (++sends > 1) throw boom } })
    f.stream.push('a'); f.stream.push('b')
    if (timed) { f.tick(); assert.deepEqual(f.errors, [boom]); f.stream.push('c'); f.tick(); assert.equal(sends, 2) }
    else { assert.throws(() => f.stream.flush(), boom); f.stream.close() }
    assert.equal(f.timers.size, 0)
  }
})
