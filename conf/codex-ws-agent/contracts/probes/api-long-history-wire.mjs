/** Cross-repository diagnostic: feed actual API-produced scoped history through the Client runtime. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildContextEnvelope } from '../../chat-runtime.mjs'
import { normalizeInboundMessage, runFastChat } from '../../agent-client.mjs'

const wirePath = process.env.CYF_LONG_HISTORY_WIRE_INPUT
if (!wirePath) throw new Error('CYF_LONG_HISTORY_WIRE_INPUT must point at actual API generatedWire(true) output')

test('API long-history wire is accepted and cold CHAT treats omissions as data, not materialized files', async () => {
  const raw = JSON.parse(readFileSync(wirePath, 'utf8'))
  const message = normalizeInboundMessage(JSON.stringify(raw))
  const snapshot = buildContextEnvelope(message)
  const context = snapshot.authoritative.facts.authorizedContext
  const materials = snapshot.authoritative.facts.taskMaterials
  assert.equal(snapshot.mode, 'CHAT')
  assert.equal(context.coverage, 'BOUNDED_EXTRACTIVE_NOT_COMPLETE')
  assert.equal(context.sourceMessageCount, 200)
  assert.ok(context.availableRefsOmittedCount > 0)
  assert.ok(materials.omittedCount > 0)
  assert.equal(materials.complete, false)
  assert.deepEqual(context.materializedRefs, [])
  assert.equal(snapshot.currentUserMessage.content, raw.content)
  assert.ok(Buffer.byteLength(JSON.stringify(context), 'utf8') <= 8192)
  assert.ok(Buffer.byteLength(JSON.stringify(materials), 'utf8') <= 8192)
  assert.ok(snapshot.instructionPolicy.untrustedDataSources.includes('availableRefs'))
  const frames = []
  let observedCold = false
  const adapter = {
    readback: { initialize: {}, account: { account: { type: 'apiKey' } }, models: {}, config: {}, tools: { tools: [] } },
    startOrResumeThread: async previous => {
      assert.equal(previous, null)
      observedCold = true
      return { threadId: 'api-long-history-cold-thread', state: 'HOT' }
    },
    runTurn: async options => {
      const received = JSON.parse(options.input)
      assert.deepEqual(received.authoritative, snapshot.authoritative)
      assert.deepEqual(received.currentUserMessage, snapshot.currentUserMessage)
      assert.equal(received.authoritative.facts.authorizedContext.coverage, 'BOUNDED_EXTRACTIVE_NOT_COMPLETE')
      assert.deepEqual(received.authoritative.facts.authorizedContext.materializedRefs, [])
      options.onAccepted({ threadId: 'api-long-history-cold-thread', turnId: 'engine-cold-turn' })
      return { threadId: 'api-long-history-cold-thread', turnId: 'engine-cold-turn', content: '已收到有限历史摘要，未读取参考图。' }
    },
    interrupt: async () => {}, reconcileTurn: async () => ({ status: 'READBACK' })
  }
  const result = await runFastChat({
    profileId: 'api-contract-profile', agentId: raw.targetAgentId,
    fastChatEnabled: true, appServerEnabled: true, trueDeltaEnabled: true
  }, message, {
    adapter, chatWorkdir: '/runtime-owned-empty-chat',
    bindingStore: { get: () => null, put: () => {}, markRecovery: () => {} },
    sendProtocolFn: (type, payload) => frames.push({ type, payload })
  })
  assert.equal(observedCold, true)
  assert.equal(result.status, 'completed')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].payload.content, '已收到有限历史摘要，未读取参考图。')
})
