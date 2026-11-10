import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PersistentChatInbox } from '../chat-runtime.mjs'
import { ChatUsageDelivery } from '../chat-usage-delivery.mjs'

function fixture(t) {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'cyf-chat-usage-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const profile = { agentId: 'fixture-agent' }
  const inbox = new PersistentChatInbox({ rootDir, profile }); inbox.initialize()
  const item = { key: 'a'.repeat(64), record: { message: { dispatchId: 'dispatch' } } }
  return { rootDir, profile, inbox, item }
}
const receipt = phase => ({ dispatchId: 'dispatch', attemptId: 'b'.repeat(64), revision: phase === 'STARTED' ? '1' : '2', status: 'PENDING_USAGE', costYuan: null })

test('start survives restart independently of business archive; terminal follows its own ACK', t => {
  const { inbox, item, rootDir, profile } = fixture(t)
  inbox.recordUsage(item, 'STARTED', 'requested-model')
  inbox.recordUsage(item, 'TERMINAL', null, { last: { inputTokens: 10 } })
  const restarted = new PersistentChatInbox({ rootDir, profile, archiveMaxFiles: 0 }); restarted.initialize()
  let pending = restarted.pendingUsage(); assert.equal(pending.length, 1); assert.equal(pending[0].payload.phase, 'STARTED')
  restarted.acknowledgeUsage(pending[0], receipt('STARTED'))
  pending = restarted.pendingUsage(); assert.equal(pending[0].payload.phase, 'TERMINAL')
  assert.equal(pending[0].payload.requestedModel, 'requested-model'); assert.equal(pending[0].payload.usageEvidence.last.inputTokens, 10)
  restarted.acknowledgeUsage(pending[0], receipt('TERMINAL'))
  assert.deepEqual(restarted.pendingUsage(), []); assert.equal(readdirSync(restarted.usageAcknowledged).length, 1)
  restarted.recordUsage(item, 'TERMINAL', null, { last: { inputTokens: 999 } })
  assert.equal(JSON.parse(readFileSync(resolve(restarted.usageAcknowledged, `${item.key}.json`))).observations.TERMINAL.usageEvidence.last.inputTokens, 10)
})

test('historical terminal cannot fabricate start, and changed start or ACK identity cannot rewrite cost source', t => {
  const { inbox, item } = fixture(t)
  assert.equal(inbox.recordUsage(item, 'TERMINAL', null, {}), false)
  assert.deepEqual(inbox.pendingUsage(), [])
  inbox.recordUsage(item, 'STARTED', 'requested')
  assert.throws(() => inbox.recordUsage(item, 'STARTED', 'changed'), /SOURCE_CONFLICT/)
  const pending = inbox.pendingUsage()[0]
  for (const wrong of [{ dispatchId: 'other' }, { revision: '2' }, { costYuan: '0.000000' }, { attemptId: 'invalid' }]) {
    assert.throws(() => inbox.acknowledgeUsage(pending, { ...receipt('STARTED'), ...wrong }), /UNCONFIRMED/)
  }
  assert.equal(inbox.pendingUsage().length, 1)
})

test('lost HTTP reply retries exact evidence without a new invocation or inferred price', async t => {
  const { inbox, item } = fixture(t)
  inbox.recordUsage(item, 'STARTED', 'requested')
  let now = 100, calls = [], fail = true
  const delivery = new ChatUsageDelivery({ inbox, apiOrigin: 'http://localhost', now: () => now,
    nativeFetch: async (endpoint, options) => {
      calls.push(JSON.parse(options.body))
      if (fail) throw new Error('response lost')
      return { status: 200, url: endpoint.href, headers: new Headers({ 'X-Request-Id': 'fixture' }),
        text: async () => JSON.stringify({ protocolVersion: 1, requestId: 'fixture', code: 'E0', msg: '', data: receipt('STARTED') }) }
    } })
  assert.equal((await delivery.deliver()).length, 1)
  const retryAt = delivery.nextRecoveryAt(); assert.ok(retryAt > now)
  await delivery.deliver(); assert.equal(calls.length, 1)
  now = retryAt; fail = false
  const errors = await delivery.deliver()
  assert.deepEqual(errors, []); assert.deepEqual(calls[0], calls[1])
  assert.equal(delivery.nextRecoveryAt(), Infinity)
  inbox.recordUsage(item, 'TERMINAL', null, null)
  assert.equal(delivery.nextRecoveryAt(), now)
})

for (const terminal of [false, true]) test(`stopped CHAT flush accepts unknown usage without inventing terminal (terminal=${terminal})`, async t => {
  const { inbox, item } = fixture(t), calls = []
  inbox.recordUsage(item, 'STARTED', 'requested')
  if (terminal) inbox.recordUsage(item, 'TERMINAL', null, { last: { inputTokens: 10 } })
  const delivery = new ChatUsageDelivery({ inbox, apiOrigin: 'http://localhost', nativeFetch: async (endpoint, options) => {
    const payload = JSON.parse(options.body); calls.push(payload)
    assert.equal(endpoint.pathname, '/internal/agent/chat/dispatches/dispatch/usage')
    return { status: 200, url: endpoint.href, headers: new Headers({ 'X-Request-Id': 'fixture' }),
      text: async () => JSON.stringify({ protocolVersion: 1, requestId: 'fixture', code: 'E0', msg: '', data: receipt(payload.phase) }) }
  } })
  assert.deepEqual(await delivery.flush(), { confirmed: true, pending: 0, errors: [] })
  assert.equal(calls.length, terminal ? 2 : 1)
  assert.equal((await delivery.flush()).confirmed, true)
  assert.equal(calls.length, terminal ? 2 : 1)
})

test('stopped CHAT flush cannot confirm a lost ACK or bypass existing retry delay', async t => {
  const { inbox, item } = fixture(t); inbox.recordUsage(item, 'STARTED', 'requested')
  let calls = 0
  const delivery = new ChatUsageDelivery({ inbox, apiOrigin: 'http://localhost', nativeFetch: async () => { calls++; throw new Error('lost') } })
  assert.equal((await delivery.flush()).confirmed, false)
  assert.equal((await delivery.flush()).confirmed, false)
  assert.equal(calls, 1); assert.equal(inbox.pendingUsage().length, 1)
})
