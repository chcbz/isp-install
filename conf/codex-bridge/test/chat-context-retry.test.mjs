import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistentChatInbox, validateChatDispatch, canonicalSha256, buildChatDispatchAck } from '../chat-runtime.mjs'
import { contextBootstrapRejection } from '../chat-context-delivery.mjs'
import { AgentMessageProcessor, runFastChat } from '../agent-client.mjs'
import { toAgentWire } from '../agent-message-wire.mjs'

const raw = JSON.parse(readFileSync(new URL('../contracts/api-hosted-wire-v1.json', import.meta.url)))
const profile = { profileId: 'context-retry-test', agentId: raw.targetAgentId }
const delta = { schemaVersion: 1, mode: 'DELTA', baseTurnId: 'previous-turn', engineThreadId: 'native-A', afterMessageId: '1', throughMessageId: '2' }
const makeMessage = (dispatchId = 'delta-attempt', plan = delta) => {
  const wire = structuredClone(raw)
  Object.assign(wire, { route: 'CHAT', dispatchId, messageId: `evt-${dispatchId}`, contextSnapshotId: `ctx-${dispatchId}`,
    dedupeKey: `${wire.tenantId}:${wire.ownerJiacn}:${wire.clientId}:${dispatchId}` })
  wire.factsManifest.contextDelivery = plan
  wire.contextHash = canonicalSha256({ sourceVector: wire.sourceVector, facts: wire.factsManifest })
  wire.contextSnapshot = { schemaVersion: '1', contextSnapshotId: wire.contextSnapshotId, contextHash: wire.contextHash,
    sourceVector: wire.sourceVector, facts: wire.factsManifest }
  delete wire.payload
  wire.payload = structuredClone(wire)
  return validateChatDispatch(wire)
}
const bootstrap = () => makeMessage('bootstrap-attempt', { schemaVersion: 1, mode: 'BOOTSTRAP', baseTurnId: null,
  engineThreadId: null, afterMessageId: '0', throughMessageId: '2', replacesDispatchId: 'delta-attempt' })
const setup = t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'cyf-context-retry-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const inbox = new PersistentChatInbox({ rootDir, profile }); inbox.initialize()
  return { rootDir, inbox }
}
const reject = async inbox => {
  const accepted = await inbox.accept(makeMessage())
  const item = inbox.claim(accepted.key)
  inbox.recoveryRequired(item, 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED', 'RECOVERY_REQUIRED', true)
  return item
}
const ack = { status: 'recovery_required', errorCode: 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED', executionStarted: false }

test('pre-start rejection is durable, duplicate-safe and never made executable on restart', async t => {
  const { rootDir, inbox } = setup(t); await reject(inbox)
  const restarted = new PersistentChatInbox({ rootDir, profile }); restarted.initialize()
  const duplicate = await restarted.accept(makeMessage())
  assert.equal(duplicate.accepted, false)
  assert.deepEqual(contextBootstrapRejection(duplicate.item.record), ack)
  assert.equal(restarted.listPending().length, 0)
  assert.equal(restarted.listRecovery().length, 1)
})

test('restart between rejection write and rename preserves non-execution proof', async t => {
  const { rootDir, inbox } = setup(t); const item = await reject(inbox)
  renameSync(item.path, inbox.path('processing', item.key))
  const restarted = new PersistentChatInbox({ rootDir, profile }); restarted.initialize()
  assert.deepEqual(contextBootstrapRejection(restarted.findByKey(item.key).record), ack)
})

test('running/unknown turns and error text alone cannot certify non-execution', async t => {
  const { inbox } = setup(t)
  const accepted = await inbox.accept(makeMessage()); const item = inbox.claim(accepted.key)
  inbox.markRunning(item, { threadId: 'native-A', turnId: 'already-accepted' })
  assert.throws(() => inbox.recoveryRequired(item, 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED', 'RECOVERY_REQUIRED', true), /NOT_PRE_EXECUTION/)
  const unknown = inbox.recoveryRequired(item, 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED', 'ACCEPTANCE_UNKNOWN')
  assert.equal(contextBootstrapRejection(unknown), null)
  assert.equal(contextBootstrapRejection({ state: 'RECOVERY_REQUIRED', recoveryReason: 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED' }), null)
})

test('new bootstrap retires only the matching unexecuted attempt and final lookup sees only the replacement', async t => {
  const { inbox } = setup(t); const old = await reject(inbox)
  const message = bootstrap(); const next = await inbox.accept(message)
  inbox.retireReplacedContext(message)
  assert.equal(inbox.listRecovery().length, 0)
  assert.equal(inbox.findByKey(old.key).record.state, 'CANCELLED')
  assert.deepEqual(inbox._findFinalSavedTurn(message.turnId).map(x => x.key), [next.key])
  inbox.retireReplacedContext(message) // Restart/repeated schedule is idempotent.
  // Archive GC must not turn an obsolete replay into a generic received/duplicate acknowledgement.
  unlinkSync(inbox.findByKey(old.key).path)
  const duplicate = await inbox.accept(makeMessage())
  assert.equal(duplicate.item.state, 'ledger')
  assert.deepEqual(contextBootstrapRejection(duplicate.item.record), ack)
})

test('replacement cannot retire an actually started attempt or a different request', async t => {
  const { inbox } = setup(t); const accepted = await inbox.accept(makeMessage()); const item = inbox.claim(accepted.key)
  inbox.markRunning(item, { threadId: 'native-A', turnId: 'actual-turn' })
  inbox.recoveryRequired(item, 'TURN_ACCEPTANCE_UNKNOWN', 'ACCEPTANCE_UNKNOWN')
  assert.throws(() => inbox.retireReplacedContext(bootstrap()), /REPLACEMENT_CONFLICT/)
  assert.equal(inbox.findByKey(item.key).record.state, 'ACCEPTANCE_UNKNOWN')
})

test('reconnect uses existing recovery walk to replay proof without model calls or timers', async t => {
  const { inbox } = setup(t); await reject(inbox); const frames = []
  const processor = Object.assign(Object.create(AgentMessageProcessor.prototype), {
    chatInbox: inbox, paused: false, stopped: false,
    _emitChatAck: (message, extra) => frames.push({ message, extra }),
    _scheduleChat: () => assert.fail('no model retry'), _scheduleChatRecovery: () => assert.fail('no reconciliation of unexecuted request')
  })
  processor._scheduleRecoveryChats()
  assert.equal(frames.length, 1); assert.deepEqual(frames[0].extra, ack)
})

test('same error code after native turn attempt is uncertainty, never a bootstrap retry', async () => {
  let calls = 0, reconciliations = 0
  const adapter = { readback: {}, startOrResumeThread: async () => ({ threadId: 'native-A', state: 'HOT' }),
    runTurn: async () => { calls++; throw Object.assign(new Error('adapter failure'), { code: 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED' }) },
    reconcileTurn: async () => { reconciliations++ } }
  await assert.rejects(runFastChat({ ...profile, fastChatEnabled: true, appServerEnabled: true }, makeMessage(), {
    adapter, chatWorkdir: '/runtime-owned-empty-chat',
    bindingStore: { get: () => ({ threadId: 'native-A', state: 'HOT' }), put: () => {}, markRecovery: () => {} },
    sendProtocolFn: () => assert.fail('no completed reply')
  }), { code: 'TURN_ACCEPTANCE_UNKNOWN' })
  assert.equal(calls, 1); assert.equal(reconciliations, 1)
})

test('non-execution proof uses the existing public dispatch ACK data without another message type', () => {
  const wire = toAgentWire(buildChatDispatchAck(profile, makeMessage(), ack))
  assert.equal(wire.messageType, 'chat.dispatch.ack')
  assert.equal(wire.data.executionStarted, false)
  assert.equal(wire.data.errorCode, 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED')
})
