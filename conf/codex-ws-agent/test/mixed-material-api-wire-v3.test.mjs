import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { normalizeInboundMessage, runFastChat, MESSAGE_TYPES } from '../agent-client.mjs'
import { canonicalSha256, buildContextEnvelope, validateChatDispatch } from '../chat-runtime.mjs'
import { resolveActionChatRequest } from '../juyiting-action-outcome.mjs'
import { TypedInspectionMaterializer, resolveTypedInspectionRequest, runTypedInspection, recoverTypedInspection } from '../typed-inspection-runtime.mjs'
import { CODEX_APP_SERVER_SCHEMA_CONTRACTS } from '../app-server-adapter.mjs'

const file = resolve(import.meta.dirname, 'fixtures/mixed-material-api-wire-v3.json')
const raw = readFileSync(file)
const fixture = JSON.parse(raw)
const provenance = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/mixed-material-api-wire-v3.provenance.json')))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const schema = CODEX_APP_SERVER_SCHEMA_CONTRACTS['codex-cli-0.159.2']
const profile = { profileId: 'runtime-profile', agentId: 'agent', typedInspectionEnabled: true,
  typedDeliberationEnabled: true, appServerSchemaContractId: schema.contractId, chatModel: 'no-provider-test' }
const normalize = value => normalizeInboundMessage(JSON.stringify(value))
const inspect = () => normalize(fixture.inspection)
let chatFinal
const expectedBytes = new Map(fixture.materials.map(item => [item.sourceRefId, Buffer.from(item.bytesBase64, 'base64')]))

test('whole platform CHAT and automatic INSPECT frames retain 32 mixed inputs and one original USER', () => {
  assert.equal(sha(raw), provenance.fixtureSha256)
  assert.match(provenance.apiCommit, /^[a-f0-9]{40}$/)
  const chat = normalize(fixture.chat), inspection = inspect()
  const facts = resolveActionChatRequest(profile, chat)
  const typed = resolveTypedInspectionRequest(profile, inspection)
  assert.equal(facts.schemaVersion, 3)
  assert.equal(facts.availableSources.length, 32)
  assert.equal(typed.manifest.sources.length, 32)
  assert.deepEqual(typed.discussionFacts.inspectedSourceRefIds, [])
  assert.deepEqual(new Set(typed.manifest.sources.map(s => s.mediaKind)), new Set(['text', 'image', 'audio', 'file']))
  assert.deepEqual(new Set(typed.manifest.sources.map(s => s.selector.purpose)), new Set(['INPUT', 'REFERENCE']))
  assert.deepEqual(facts.availableSources, typed.discussionFacts.availableSources)
  assert.equal(canonicalSha256(typed.manifest), typed.manifestDigest)
  const envelope = buildContextEnvelope(inspection)
  assert.equal(inspection.content, chat.content)
  assert.equal(envelope.authoritative.facts.actionContinuation.originalUserMessageId, fixture.expectedOriginalUserMessageId)
  assert.equal(envelope.authoritative.facts.actionContinuation.instruction, '逐项核对所选资料并汇总。'.repeat(400))
  assert.equal(envelope.currentUserMessage.content, '请整理资料')
  assert.equal(chat.contextSnapshot.facts.typedInspection, undefined, 'ordinary CHAT has metadata, not materialized bytes')
})

test('actual platform CHAT frame runs metadata-only and emits the original automatic inspection action', async () => {
  const message = normalize(fixture.chat), facts = resolveActionChatRequest(profile, message), frames = []
  const outcome = { schemaVersion: 3, kind: 'ACTION_REQUEST', text: '继续处理', clarification: null,
    action: { actionId: 'inspect-materials', instruction: '逐项核对所选资料并汇总。'.repeat(400),
      sourceRefIds: facts.availableSources.map(s => s.sourceRefId) } }
  const adapter = { closed: false, readback: { initialize: {}, account: {}, models: {}, config: {}, tools: {},
    schema: { ...schema, schemaContractId: schema.contractId, measured: true } },
    startOrResumeThread: async (_prior, policy) => { assert.equal(policy.config.network, false); return { threadId: 'mixed-chat-thread' } },
    runTurn: async options => {
      assert.equal(typeof options.input, 'string', 'CHAT sends one text envelope, not native media inputs')
      const envelope = JSON.parse(options.input)
      assert.equal(envelope.currentUserMessage.content, '请整理资料')
      assert.equal(envelope.authoritative.facts.typedDeliberation.availableSources.length, 32)
      assert.equal(envelope.authoritative.facts.typedInspection, undefined)
      const content = JSON.stringify(outcome)
      options.onAccepted({ threadId: 'mixed-chat-thread', turnId: 'mixed-chat-turn' })
      options.onDelta({ content })
      return { threadId: 'mixed-chat-thread', turnId: 'mixed-chat-turn', content }
    }, interrupt: async () => {}
  }
  const result = await runFastChat({ ...profile, fastChatEnabled: true, appServerEnabled: true, trueDeltaEnabled: true,
    chatEngine: 'app-server', chatSandbox: 'read-only', chatToolPolicy: 'read-only-constrained' }, message,
  { adapter, chatWorkdir: '/empty-chat', sendProtocolFn: (type, payload) => frames.push({ type, payload }) })
  assert.equal(result.status, 'completed')
  chatFinal = frames.at(-1).payload
  assert.equal(frames.at(-1).type, MESSAGE_TYPES.CHAT_MESSAGE)
  assert.equal(chatFinal.outcomeContractVersion, 3); assert.deepEqual(chatFinal.interactionOutcome, outcome)
  assert.equal(frames.filter(f => f.type === MESSAGE_TYPES.CHAT_MESSAGE_DELTA).map(f => f.payload.content).join(''), outcome.text)
  assert.equal(chatFinal.inspectionInputReceipt, undefined)
})

test('actual API dispatch fetches original bytes, prepares native inputs and sends a replay-stable 32-source receipt', async t => {
  const message = inspect(), typed = resolveTypedInspectionRequest(profile, message)
  const root = mkdtempSync(resolve(tmpdir(), 'api-mixed-wire-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fetched = [], frames = []
  let starts = 0, prepared
  const formats = [...new Map(typed.manifest.sources.map(s => [s.mimeType, s])).values()]
  const isolation = { schemaVersion: 1, measured: true, ...typed.manifest.profile, toolPolicy: 'MANIFEST_READ_ONLY',
    recovery: 'durable-inbox-turn-readback-v1', supportedInputs: formats.map(s => ({ mediaKind: s.mediaKind,
      mimeType: s.mimeType, carrier: s.carrier, carrierContractDigest: s.carrierContractDigest })) }
  const materializer = new TypedInspectionMaterializer({ apiOrigin: 'https://platform.example/', rootDir: root,
    agentId: profile.agentId, runtimeInstanceId: 'runtime-1', getRuntimeAuth: () => `AgentRuntime ${'b'.repeat(32)}`,
    parsers: { 'application/json': { parserConfigDigest: `sha256:${sha(Buffer.from('json-topic-parser'))}`, parse: ({ bytes }) => JSON.parse(bytes.toString('utf8')).topic } },
    fetchFn: async (url, options) => {
      const source = typed.manifest.sources.find(s => url.endsWith(`/${s.sourceRefId}/content`))
      assert.ok(source, url); fetched.push(source.sourceRefId)
      assert.equal(options.headers['X-Inspection-Manifest-Digest'], typed.manifestDigest)
      const bytes = expectedBytes.get(source.sourceRefId)
      assert.equal(sha(bytes), source.sha256)
      return { status: 200, redirected: false, url,
        headers: { get: name => ({ 'content-type': source.mimeType, 'content-length': String(bytes.length) }[name.toLowerCase()] ?? null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    }
  })
  const adapter = { closed: false, readback: { initialize: {}, schema: { ...schema, schemaContractId: schema.contractId, measured: true }, models: {}, config: {} },
    startOrResumeThread: async () => ({ threadId: 'mixed-api-thread' }),
    runTurn: async options => {
      starts++; assert.equal(options.input.length, 33)
      typed.manifest.sources.forEach((source, index) => {
        const input = options.input[index + 1]
        if (source.mediaKind === 'image' || source.mediaKind === 'audio') {
          assert.equal(input.type, source.mediaKind === 'image' ? 'localImage' : 'localAudio')
          assert.deepEqual(readFileSync(input.path), expectedBytes.get(source.sourceRefId))
        } else {
          assert.equal(input.type, 'text'); assert.match(input.text, /^UNTRUSTED INSPECTION MATERIAL/)
          const bytes = expectedBytes.get(source.sourceRefId)
          assert.ok(input.text.includes(source.mediaKind === 'file' ? JSON.parse(bytes).topic : bytes.toString('utf8')))
        }
      })
      options.onAccepted({ threadId: 'mixed-api-thread', turnId: 'mixed-api-turn' })
      return { threadId: 'mixed-api-thread', turnId: 'mixed-api-turn', content: JSON.stringify({ schemaVersion: 3,
        kind: 'ANSWER', text: '已查阅全部资料。\n验证短语：Quartz river 729.', clarification: null, action: null }) }
    }
  }
  await runTypedInspection(profile, message, { adapter, materializer, isolationReadback: isolation,
    nativeInputAdapters: {
      localImage: { supportedMimeTypes: ['image/png'], toNativeInput: ({ path }) => ({ type: 'localImage', path }) },
      localAudio: { supportedMimeTypes: ['audio/wav'], toNativeInput: ({ path }) => ({ type: 'localAudio', path }) }
    },
    controls: { markPrepared: () => {}, markRunning: () => {}, markFinalPrepared: value => { prepared = value }, markFinalPublication: () => {}, isCancelled: () => false },
    sendFinal: (_profile, _message, content, extra) => { frames.push({ content, extra }); return false }
  })
  assert.equal(starts, 1); assert.deepEqual(fetched, typed.manifest.sources.map(s => s.sourceRefId))
  assert.equal(frames.length, 1); assert.equal(frames[0].extra.inspectionInputReceipt.sources.length, 32)
  assert.deepEqual(frames[0].extra.inspectionInputReceipt.sources.map(s => s.sha256), typed.manifest.sources.map(s => s.sha256))
  await recoverTypedInspection(profile, message, { finalPrepared: prepared }, {
    adapter: { runTurn: () => assert.fail('no provider replay') }, controls: { markFinalPublication: () => {} },
    sendFinal: (_profile, _message, content, extra) => { frames.push({ content, extra }); return true }
  })
  assert.deepEqual(frames[0], frames[1]); assert.equal(starts, 1)
  if (process.env.MMD_MIXED_WIRE_FINAL_OUTPUT) writeFileSync(process.env.MMD_MIXED_WIRE_FINAL_OUTPUT,
    JSON.stringify({ schemaVersion: 1, apiFixtureSha256: sha(raw), chat: fixture.chat, chatFinal, inspection: fixture.inspection, final: frames[0] }) + '\n')
})

test('API snapshot or native manifest scope corruption is rejected, never silently truncated or rebound', () => {
  for (const mutate of [
    value => { value.payload.contextSnapshot.facts.typedInspection.manifest.scope.ownerJiacn = 'foreign' },
    value => { value.payload.contextSnapshot.facts.typedInspection.manifest.sources[0].selector.purpose = 'OUTPUT' },
    value => { value.payload.contextSnapshot.facts.typedInspection.manifest.sources.pop() }
  ]) {
    const value = structuredClone(fixture.inspection); mutate(value)
    assert.throws(() => { const message = normalize(value); validateChatDispatch(message); resolveTypedInspectionRequest(profile, message) })
  }
})
