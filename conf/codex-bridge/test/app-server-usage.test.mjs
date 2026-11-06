import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { AppServerAdapter } from '../app-server-adapter.mjs'
import { usageEvidenceFromNotification } from '../app-server-usage.mjs'

const notification = (turnId = 'turn', count = 10) => ({ threadId: 'thread', turnId, tokenUsage: { last: { inputTokens: count, cachedInputTokens: 2 }, total: { inputTokens: count + 100 }, modelContextWindow: null } })

test('usage evidence preserves separate snapshots without inventing billing or copying unrelated content', () => {
  const input = notification(); input.tokenUsage.last.secret = 'omit'; input.secret = 'omit'
  const result = usageEvidenceFromNotification(input)
  assert.equal(result.status, 'UNVERIFIED'); assert.equal(result.tokenUsage.last.inputTokens, 10)
  assert.equal(result.tokenUsage.total.inputTokens, 110); assert.equal(result.tokenUsage.modelContextWindow, null)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  input.tokenUsage.last.inputTokens = 999
  assert.equal(result.tokenUsage.last.inputTokens, 10)
  assert.equal(usageEvidenceFromNotification({ ...input, turnId: null }), null)
  assert.equal(usageEvidenceFromNotification({ ...input, tokenUsage: null }), null)
})

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`matching turn retains only latest usage snapshot on ${status}, never sums duplicate notifications`, async () => {
    const child = new EventEmitter()
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} })
    const emit = frame => child.stdout.write(JSON.stringify(frame) + '\n')
    const adapter = new AppServerAdapter({ child, send: frame => {
      if (frame.method !== 'turn/start') return
      queueMicrotask(() => {
        // Notifications may precede start acknowledgement; binding is checked after it.
        emit({ method: 'thread/tokenUsage/updated', params: notification('turn', 5) })
        emit({ id: frame.id, result: { turn: { id: 'turn' } } })
        setImmediate(() => {
          for (const turnId of ['turn', 'turn', 'foreign']) emit({ method: 'thread/tokenUsage/updated', params: notification(turnId, turnId === 'foreign' ? 999 : 10) })
          emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status } } })
        })
      })
    } })
    try {
      const pending = adapter.runTurn({ threadId: 'thread', clientUserMessageId: 'message', input: 'fixture' })
      const result = status === 'completed' ? await pending : await pending.catch(error => error)
      if (status !== 'completed') assert.equal(result.code, `TURN_${status.toUpperCase()}`)
      assert.equal(result.usageEvidence.tokenUsage.last.inputTokens, 10)
      assert.equal(result.usageEvidence.tokenUsage.total.inputTokens, 110)
      assert.equal(adapter.listenerCount('usage'), 0)
    } finally { adapter.close() }
  })
}
