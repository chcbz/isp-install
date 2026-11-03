import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentMessageProcessor } from '../agent-client.mjs'
const fixture = (state = 'WS_WRITE_ACCEPTED_PERSISTENCE_UNCONFIRMED') => {
  const item = { key: 'turn-key', state: 'recovery', record: { message: { route: 'CHAT' }, finalPublication: { state } } }
  const p = Object.assign(Object.create(AgentMessageProcessor.prototype), { stopped: false, paused: false,
    chatRecoveryRetryBaseMs: 250, chatRecoveryRetryMaxMs: 30000, chatRecoveryRetries: new Map(), activeChats: new Map(),
    chatInbox: { findByKey: () => item }, _replayChatAcks: () => {}, drain: async () => {}, _schedulePendingChats: () => {} })
  return { p, item }
}
test('all unconfirmed finals use existing bounded exponential backoff without a fixed ACK delay', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const state of ['WS_WRITE_ACCEPTED_PERSISTENCE_UNCONFIRMED', 'NOT_SENT']) {
    const { p, item } = fixture(state); let calls = 0
    p._scheduleChatRecovery = () => calls++
    p._retryChatRecovery(item); p._retryChatRecovery(item)
    t.mock.timers.tick(250)
    assert.equal(calls, 1)
    t.mock.timers.tick(29750); assert.equal(calls, 1)
    p._clearChatRecoveryRetry(item.key)
  }
})
test('ordinary resume cannot bypass retry, actual paused transport resumes immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, item } = fixture(); let scheduled = 0
  p._scheduleRecoveryChats = () => p._scheduleChatRecovery(item)
  p._chatFairness = () => 'owner'; p._chatTurnKey = () => 'turn'
  p.lanes = { enqueue: () => { scheduled++; return Promise.resolve() } }
  p._retryChatRecovery(item); p.resume(); p.resume(); assert.equal(scheduled, 0)
  p.pause(); p.resume(); assert.equal(scheduled, 1)
  t.mock.timers.tick(30000); assert.equal(scheduled, 1, 'cancelled timer must not enqueue again')
})
test('ACK arriving while recovery waits in lane prevents a stale final replay', async () => {
  const { p, item } = fixture(); let run, recoveries = 0
  p._chatFairness = () => 'owner'; p._chatTurnKey = () => 'turn'
  p.lanes = { enqueue: (_lane, _owner, fn) => { run = fn; return Promise.resolve() } }
  p.recoverChat = async () => { recoveries++ }
  p._scheduleChatRecovery(item)
  item.state = 'archive'; item.record.state = 'COMPLETED'
  await run(); assert.equal(recoveries, 0); assert.equal(p.activeChats.size, 0)
})
test('confirmed receipt cancels compensation without requiring another send', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { p, item } = fixture(); let calls = 0
  p._scheduleChatRecovery = () => calls++
  p._retryChatRecovery(item); p._clearChatRecoveryRetry(item.key)
  t.mock.timers.tick(60000); assert.equal(calls, 0); assert.equal(p.chatRecoveryRetries.size, 0)
})

test('paused or stopped processor never schedules a publication retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const state of ['paused', 'stopped']) {
    const { p, item } = fixture(); p[state] = true
    p.lanes = { enqueue: () => assert.fail('inactive transport must not enqueue') }
    p._retryChatRecovery(item); p._scheduleChatRecovery(item)
    t.mock.timers.tick(60000)
    assert.equal(p.chatRecoveryRetries.size, 0)
    assert.equal(p.activeChats.size, 0)
  }
})
