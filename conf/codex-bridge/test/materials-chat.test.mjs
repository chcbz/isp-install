import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { normalizeInboundMessage, runFastChat, recoverMaterialsChat, buildAgentRegistrationPayload, buildAgentPresencePayload, publishTypedInspectionReadiness, MESSAGE_TYPES } from '../agent-client.mjs'
import { canonicalSha256, validateChatDispatch, PersistentChatInbox } from '../chat-runtime.mjs'
import { resolveChatMaterials } from '../materials-chat.mjs'
import { TypedInspectionMaterializer } from '../typed-inspection-runtime.mjs'
import { CODEX_APP_SERVER_SCHEMA_CONTRACTS } from './fixtures/recorded-app-server-schemas.mjs'
import { materialsChatHttpScope } from '../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
const fixtureBytes = readFileSync(new URL('./fixtures/mixed-material-api-wire-v3.json', import.meta.url))
const fixture = JSON.parse(fixtureBytes)
const provenance = JSON.parse(readFileSync(new URL('./fixtures/mixed-material-api-wire-v3.provenance.json', import.meta.url)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const schema = CODEX_APP_SERVER_SCHEMA_CONTRACTS['codex-cli-0.159.2']
const profile = { profileId: 'runtime-profile', agentId: 'agent', typedDeliberationEnabled: true, fastChatEnabled: true,
  appServerEnabled: true, chatEngine: 'app-server', chatSandbox: 'read-only', chatToolPolicy: 'read-only-constrained',
  appServerSchemaContractId: schema.contractId, chatModel: 'no-provider-test' }
const bytes = new Map(fixture.materials.map(item => [item.sourceRefId, Buffer.from(item.bytesBase64, 'base64')]))
const historicalSources = fixture.inspection.payload.contextSnapshot.facts.typedInspection.manifest.sources
const formats = [...new Map(historicalSources.map(source => [source.mimeType, { mediaKind: source.mediaKind, mimeType: source.mimeType,
  carrier: source.carrier, carrierContractDigest: source.carrierContractDigest }])).values()]
const reseal = message => { message.factsManifest = message.contextSnapshot.facts; message.contextHash = canonicalSha256({ sourceVector: message.sourceVector, facts: message.factsManifest }); message.contextSnapshot.contextHash = message.contextHash; return message }
function messageFixture() {
  const message = structuredClone(normalizeInboundMessage(JSON.stringify(fixture.chat))), facts = message.contextSnapshot.facts
  const sources = historicalSources.map(source => ({ sourceRefId: source.sourceRefId, sourceKind: 'TASK_WORKSPACE_FILE', sha256: source.sha256,
    byteLength: source.byteLength, mimeType: source.mimeType, carrier: source.carrier, carrierContractDigest: source.carrierContractDigest,
    downloadUrl: `/internal/agent/chat/requests/${message.requestId}/turns/${message.turnId}/materials/inputs/${source.sourceRefId}/content` }))
  facts.typedDeliberation = { schemaVersion: 5, availableActions: [], availableSources: historicalSources.map(source => ({ sourceRefId: source.sourceRefId,
    kind: 'TASK_WORKSPACE_FILE', mediaType: source.mediaKind, contentMimeType: source.mimeType })), inspectedSourceRefIds: [] }
  const manifest = { schemaVersion: 1, profile: { schemaVersion: 1, supportedInputs: formats }, sources }
  const binding = Object.fromEntries(['tenantId','ownerJiacn','clientId','conversationId','conversationGeneration','taskId','requestId','turnId','targetAgentId'].map(key => [key, String(message[key])]))
  const manifestDigest = canonicalSha256({ domain: 'juyiting.materials-input', binding, manifest })
  facts.materialsInput = { schemaVersion: 1, authorizationId: `materials_${manifestDigest.slice(7,47)}`, manifestDigest, manifest }
  return validateChatDispatch(reseal(message))
}
function context(t, message = messageFixture(), outcome = { revision: null, schemaVersion: 5, kind: 'ANSWER', text: 'Synthetic carrier-only test result, not verified image understanding.',
  clarification: null, action: null, deliverable: false, deliveryRelation: null }) {
  const root = mkdtempSync(resolve(tmpdir(), 'runtime-materials-chat-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const fetched = [], frames = [], events = [], preparations = []; let finalPrepared = null, starts = 0
  const readback = { initialize: {}, account: {}, models: {}, config: {}, tools: {}, schema: { ...schema, schemaContractId: schema.contractId, measured: true } }
  const adapter = { closed: false, readback, startOrResumeThread: async (prior, policy) => {
    assert.match(policy.developerInstructions, /Context Envelope and the authorized material carriers actually attached/);
    assert.match(policy.developerInstructions, /inputMimeTypes list restricts that skill execution, not native reading/);
    assert.match(policy.developerInstructions, /if a carrier is absent or genuinely unreadable/);
    assert.equal(prior, null); assert.equal(policy.cwd, '/inputs'); assert.equal(policy.config.network, false); return { threadId: 'materials-thread' }
  }, runTurn: async options => {
    starts++; events.push('turn'); assert.equal(options.input.length, 33)
    assert.equal(JSON.parse(options.input[0].text).currentUserMessage.content, '请整理资料')
    historicalSources.forEach((source, index) => {
      const input = options.input[index + 1]
      if (source.carrier === 'LOCAL_IMAGE' || source.carrier === 'LOCAL_AUDIO') {
        assert.equal(input.type, source.carrier === 'LOCAL_IMAGE' ? 'localImage' : 'localAudio')
        assert.deepEqual(readFileSync(input.path), bytes.get(source.sourceRefId))
      } else { assert.equal(input.type, 'text'); assert.match(input.text, /UNTRUSTED/)
        assert.ok(input.text.includes(source.carrier === 'PARSED_TEXT' ? JSON.parse(bytes.get(source.sourceRefId)).topic : bytes.get(source.sourceRefId).toString('utf8'))) }
    })
    options.onAccepted({ threadId: 'materials-thread', turnId: 'materials-turn' })
    return { threadId: 'materials-thread', turnId: 'materials-turn', content: JSON.stringify(outcome), finishReason: 'completed' }
  }, interrupt: async () => {} }
  const materializer = new TypedInspectionMaterializer({ apiOrigin: 'https://platform.example', rootDir: root,
    agentId: profile.agentId, runtimeInstanceId: 'runtime1', getRuntimeHeaders: () => ({ Authorization: `AgentRuntime rts1_${'b'.repeat(64)}`,
      'X-Agent-Id': profile.agentId, 'X-Agent-Runtime-Id': 'runtime1', 'X-Agent-Installation-Id': 'install1', 'X-Agent-Host-Id': 'host1', 'X-Agent-Session-Generation': '1' }),
    parsers: { 'application/json': { parserConfigDigest: `sha256:${sha('json-parser-fixture')}`, parse: ({ bytes }) => JSON.parse(bytes).topic } },
    fetchFn: async (url, options) => {
      const source = historicalSources.find(source => url.endsWith(`/${source.sourceRefId}/content`)); assert.ok(source)
      assert.equal(options.headers['X-Materials-Manifest-Digest'], message.contextSnapshot.facts.materialsInput.manifestDigest)
      assert.equal(options.headers['X-Inspection-Manifest-Digest'], undefined); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
      assert.match(url, /\/materials\/inputs\//); fetched.push(source.sourceRefId)
      const content = bytes.get(source.sourceRefId)
      return { status: 200, redirected: false, url, headers: new Headers({ 'content-type': source.mimeType, 'content-length': String(content.length) }), arrayBuffer: async () => content }
    } })
  const runtime = { contractReadback: { schemaVersion: 1, measured: true, inputPolicyDigest: `sha256:${'c'.repeat(64)}`,
    toolPolicy: 'MANIFEST_READ_ONLY', recovery: 'durable-inbox-turn-readback-v1', supportedInputs: formats },
    openAdapter: async (_dir, _key, binding) => { assert.equal(binding.authorizationId, message.contextSnapshot.facts.materialsInput.authorizationId); return adapter }, mapInputPath: path => path }
  const controls = { markPrepared: preparation => { preparations.push(preparation); events.push('prepare') },
    markRunning: () => events.push('running'), markFinalPrepared: value => { finalPrepared = value; events.push('final-durable') },
    markFinalPublication: () => events.push('publication'), isCancelled: () => false }
  const options = { controls, chatWorkdir: '/empty-chat', materialsRuntime: runtime, materialsMaterializer: materializer,
    materialsInputAdapters: { localImage: { supportedMimeTypes: ['image/png'], toNativeInput: ({ path }) => ({ type: 'localImage', path }) },
      localAudio: { supportedMimeTypes: ['audio/wav'], toNativeInput: ({ path }) => ({ type: 'localAudio', path }) } },
    sendProtocolFn: (type, payload) => { frames.push({ type, payload }); events.push('publish'); return false } }
  return { root, message, options, fetched, frames, events, preparations, runtime, adapter, outcome, get finalPrepared() { return finalPrepared }, get starts() { return starts } }
}
test('public CHAT consumes the same 32 real mixed bytes, host receipts, durable final replay without another model turn', async t => {
  assert.equal(sha(fixtureBytes), provenance.fixtureSha256)
  const c = context(t)
  const result = await runFastChat(profile, c.message, c.options)
  assert.equal(result.serverPersistence, 'unconfirmed'); assert.equal(c.starts, 1); assert.equal(c.fetched.length, 32)
  assert.deepEqual(c.fetched, historicalSources.map(source => source.sourceRefId))
  assert.ok(c.events.indexOf('final-durable') < c.events.indexOf('publish'))
  const first = c.frames[0]; assert.equal(first.type, MESSAGE_TYPES.CHAT_MESSAGE); assert.equal(first.payload.routeUsed, 'CHAT_FAST')
  const receipt = first.payload.inspectionInputReceipt; assert.equal(receipt.sources.length, 32)
  assert.equal(receipt.engineThreadId, 'materials-thread'); assert.equal(receipt.engineTurnId, 'materials-turn')
  assert.deepEqual(receipt.sources.map(source => source.sha256), historicalSources.map(source => source.sha256))
  assert.deepEqual(new Set(receipt.sources.map(source => source.carrier)), new Set(['DIRECT_TEXT','LOCAL_IMAGE','LOCAL_AUDIO','PARSED_TEXT']))
  const replayMessage = structuredClone(c.message); delete replayMessage.__deltaSeq
  await recoverMaterialsChat(profile, replayMessage, { finalPrepared: c.finalPrepared }, { controls: {}, sendFinal: (_p, _m, content, extra) => {
    assert.equal(content, first.payload.content); assert.deepEqual(extra, c.finalPrepared.extra); return true
  }, adapter: { runTurn: () => assert.fail('no model replay'), reconcileTurn: () => assert.fail('persisted final needs no engine') } })
  assert.equal(c.starts, 1); assert.equal(c.fetched.length, 32)
})
test('material digest/identity/exact download path are rejected before any fetch or model', async t => {
  for (const mutate of [m => { m.ownerJiacn = 'other' }, m => { m.contextSnapshot.facts.materialsInput.manifest.sources[0].downloadUrl = 'https://evil.example/content' },
    m => { m.contextSnapshot.facts.materialsInput.manifest.sources.pop() }, m => { m.contextSnapshot.facts.materialsInput.authorizationId = 'materials_other' }]) {
    const message = structuredClone(messageFixture()); mutate(message); reseal(message); const c = context(t, message)
    await assert.rejects(runFastChat(profile, message, c.options), /MATERIALS_|CHAT_OWNER_MISMATCH/); assert.equal(c.fetched.length, 0); assert.equal(c.starts, 0)
  }
})
test('missing measured carrier and tool isolation fails before native turn, never treats ability text as readiness', async t => {
  const c = context(t); c.runtime.contractReadback.supportedInputs = []
  await assert.rejects(runFastChat(profile, c.message, c.options), /MATERIALS_CARRIER_BINDING_CHANGED/)
  assert.equal(c.starts, 0); assert.equal(c.fetched.length, 0)
})
test('completed material CHAT terminal readback is recovered without model execution or refetch', async t => {
  const c = context(t); await runFastChat(profile, c.message, c.options)
  let persisted
  const result = await recoverMaterialsChat(profile, c.message, { preparation: c.preparations.at(-1), engine: { threadId: 'materials-thread', turnId: 'materials-turn' } }, {
    adapter: { reconcileTurn: async () => ({ status: 'TERMINAL', terminalStatus: 'completed', turnId: 'materials-turn', turn: { items: [{ type: 'agent_message', text: JSON.stringify(c.outcome) }] } }), runTurn: () => assert.fail('no re-execution') },
    controls: { markFinalPrepared: value => { persisted = value } }, sendFinal: () => false })
  assert.equal(result.serverPersistence, 'unconfirmed'); assert.deepEqual(persisted, c.finalPrepared); assert.equal(c.starts, 1)
})
test('unknown/absent terminal readback never restarts model and altered durable receipt is rejected', async t => {
  const c = context(t); await runFastChat(profile, c.message, c.options)
  for (const status of ['ABSENT','ACCEPTED','RECOVERY_REQUIRED']) {
    const result = await recoverMaterialsChat(profile, c.message, { preparation: c.preparations.at(-1), engine: { threadId: 'materials-thread' } }, {
      adapter: { reconcileTurn: async () => ({ status }), runTurn: () => assert.fail('no replay') }, sendFinal: () => assert.fail('no invented final') })
    assert.equal(result.status, 'recovery_required')
  }
  const final = structuredClone(c.finalPrepared); final.extra.inspectionInputReceipt.sources[0].sha256 = '0'.repeat(64)
  const { finalDigest, ...preimage } = final; final.finalDigest = canonicalSha256(preimage)
  await assert.rejects(recoverMaterialsChat(profile, c.message, { finalPrepared: final }, { sendFinal: () => assert.fail('no invalid final') }), /MATERIALS_RECEIPT_BINDING_INVALID/)
})
test('materials final requires exact existing server save ACK before inbox completion; no standalone INSPECT', async t => {
  const c = context(t), inbox = new PersistentChatInbox({ rootDir: resolve(c.root, 'inbox'), profile })
  inbox.initialize(); const accepted = await inbox.accept(c.message), item = inbox.claim(accepted.key)
  const controls = { markPrepared: value => inbox.markPrepared(item, value), markRunning: (_cancel, value) => inbox.markRunning(item, value),
    markFinalPrepared: value => inbox.markFinalPrepared(item, value), markFinalPublication: value => inbox.markFinalPublication(item, value), isCancelled: () => false }
  await runFastChat(profile, c.message, { ...c.options, controls })
  assert.equal(inbox.findByKey(item.key).record.state, 'FINAL_PREPARED')
  const ack = { type: 'agent_message_saved', channel: 'agent', turnId: c.message.turnId, messageId: '1001', eventId: 'event1', duplicate: false }
  assert.equal(inbox.confirmFinalSaved(ack).status, 'confirmed')
  assert.equal(inbox.findByKey(item.key).record.result.serverPersistence, 'confirmed')
  assert.equal(inbox.confirmFinalSaved(ack).status, 'duplicate')
  await assert.rejects(runFastChat(profile, { ...c.message, route: 'INSPECT' }, c.options), error => error.code === 'FAST_CHAT_ROUTE_INVALID')
})
test('v4 registration and presence expose exact nested materials declaration only after measurement', () => {
  const adapter = { closed: false, readback: { schema: { ...schema, measured: true, schemaContractId: schema.contractId } } }
  const runtime = { declaration: () => ({ supportedInputs: formats }) }
  const registered = buildAgentRegistrationPayload(profile, null, true, adapter, runtime)
  assert.deepEqual(registered.typedDeliberation.materialsInput, { schemaVersion: 1, supportedInputs: formats })
  assert.equal(buildAgentRegistrationPayload(profile, null, false, adapter, runtime).typedDeliberation.materialsInput, undefined)
  assert.deepEqual(buildAgentPresencePayload(profile, 'online', { appServerAdapter: adapter, typedInspectionProfileRuntime: runtime }).typedDeliberation.materialsInput, registered.typedDeliberation.materialsInput)
})
test('public materials transport allows only exact GET content route, no aliases/query/body/wider internal namespace', () => {
  const path = '/internal/agent/chat/requests/request/turns/turn/materials/inputs/ref/content'
  assert.equal(materialsChatHttpScope(new URL(`https://platform.example${path}`)), true)
  for (const suffix of ['?x=1','/extra']) assert.equal(materialsChatHttpScope(new URL(`https://platform.example${path}${suffix}`)), false)
  assert.equal(materialsChatHttpScope(new URL(`https://platform.example${path.replace('/ref/', '/%72ef/')}`)), false)
  for (const options of [{ method: 'POST' }, { body: '{}' }]) assert.equal(materialsChatHttpScope(new URL(`https://platform.example${path}`), options), false)
})

test('native local-file capability is a separate online declaration and requires the execution transport', () => {
  const adapter = { closed: false, readback: { schema: { ...schema, measured: true, schemaContractId: schema.contractId } } }
  const declaration = { schemaVersion: 1, executionProtocolVersion: 5, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1', outputMimeTypes: ['text/plain', 'text/markdown', 'text/html', 'application/json'] }
  const runtime = { declaration: () => ({ supportedInputs: formats }), nativeExecutionDeclaration: () => declaration }
  const readyProfile = { ...profile, workspaceFileApiOrigin: 'https://platform.example', workspaceFileRootDir: '/synthetic/private-root' }
  const registered = buildAgentRegistrationPayload(readyProfile, null, true, adapter, runtime)
  assert.deepEqual(registered.typedDeliberation.nativeExecution, declaration)
  assert.deepEqual(buildAgentPresencePayload(readyProfile, 'busy', { appServerAdapter: adapter, typedInspectionProfileRuntime: runtime }).typedDeliberation.nativeExecution, declaration)
  assert.equal(buildAgentRegistrationPayload(readyProfile, null, false, adapter, runtime).typedDeliberation.nativeExecution, undefined)
  assert.equal(buildAgentPresencePayload(readyProfile, 'offline', { appServerAdapter: adapter, typedInspectionProfileRuntime: runtime }).typedDeliberation.nativeExecution, undefined)
  assert.equal(buildAgentRegistrationPayload(profile, null, true, adapter, runtime).typedDeliberation.nativeExecution, undefined)
  assert.equal(buildAgentRegistrationPayload(readyProfile, null, true, adapter, { declaration: runtime.declaration }).typedDeliberation.nativeExecution, undefined)
  assert.equal(buildAgentRegistrationPayload(readyProfile, null, true, adapter, { ...runtime, nativeExecutionDeclaration: () => null }).typedDeliberation.nativeExecution, undefined)
})


test('native-only measured readiness refreshes registration without claiming read-only carriers', () => {
  let refreshed = 0, statuses = 0
  const state = { disposed: false, typedInspectionProfileRuntime: { declaration: () => null,
    nativeExecutionDeclaration: () => ({ executionProtocolVersion: 5 }) },
    runtimeTransport: { refreshCapabilities: () => { refreshed++; return true } } }
  const p = { ...profile, runtimeIdentity: {} }
  assert.equal(publishTypedInspectionReadiness(p, state, { sendStatusFn: () => { statuses++; return true }, busyFn: () => false }), true)
  assert.equal(refreshed, 1); assert.equal(statuses, 1)
  state.typedInspectionProfileRuntime.nativeExecutionDeclaration = () => null
  assert.equal(publishTypedInspectionReadiness(p, state), false)
  assert.equal(refreshed, 1)
})
