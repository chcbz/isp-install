import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentMessageProcessor } from '../agent-client.mjs'

test('a paused or stopped CHAT lane leaves queued work unclaimed for normal resume', async () => {
  for (const stopped of [false, true]) {
    let queued; let claims = 0
    const item = { key: 'queued', record: { message: { route: 'CHAT' } } }
    const processor = Object.assign(Object.create(AgentMessageProcessor.prototype), {
      paused: false, stopped: false, activeChats: new Map(),
      lanes: { enqueue: (_lane, _fairness, task) => { queued = task; return Promise.resolve() } },
      chatInbox: { claim: () => { claims++; assert.fail('must not claim while paused') } },
      _chatFairness: () => 'owner', _chatTurnKey: () => 'turn', onReject: assert.fail
    })
    processor._scheduleChat(item)
    processor.paused = !stopped; processor.stopped = stopped
    await queued()
    assert.equal(claims, 0); assert.equal(processor.activeChats.size, 0)
  }
})
