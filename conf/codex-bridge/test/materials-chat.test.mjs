import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { AppServerAdapter } from '../app-server-adapter.mjs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { bindProfileChatAdapter, unbindProfileChatAdapter, restoreProfileChatIdleAdapter, normalizeInboundMessage, runFastChat, recoverMaterialsChat, buildAgentRegistrationPayload, buildAgentPresencePayload, publishTypedInspectionReadiness, MESSAGE_TYPES } from '../agent-client.mjs'
import { canonicalSha256, validateChatDispatch, PersistentChatInbox } from '../chat-runtime.mjs'
import { resolveChatMaterials, chatConversationKey, prepareChatMaterials } from '../materials-chat.mjs'
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
    assert.match(policy.developerInstructions, /Context Envelope, the conversation history already present in this same native thread/);
    assert.match(policy.developerInstructions, /authorized material carriers attached to this turn/);
    assert.match(policy.developerInstructions, /inputMimeTypes list restricts that skill execution, not native reading/);
    assert.match(policy.developerInstructions, /if a carrier is absent or genuinely unreadable/);
    assert.equal(prior, null); assert.equal(policy.cwd, '/inputs'); assert.deepEqual(policy.config, { network: false, project_doc_max_bytes: 0 }); return { threadId: 'materials-thread' }
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
    suspendAdapter: async () => { events.push('suspend'); return true },
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
  assert.ok(c.events.indexOf('final-durable') < c.events.indexOf('publish')); assert.ok(c.events.indexOf('publish') < c.events.indexOf('suspend'))
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
test('registration alone exposes exact measured materials; status does not duplicate declarations', () => {
  const adapter = { closed: false, readback: { schema: { ...schema, measured: true, schemaContractId: schema.contractId } } }
  const runtime = { declaration: () => ({ supportedInputs: formats }) }
  const registered = buildAgentRegistrationPayload(profile, null, true, adapter, runtime)
  assert.deepEqual(registered.typedDeliberation.materialsInput, { schemaVersion: 1, supportedInputs: formats })
  assert.equal(buildAgentRegistrationPayload(profile, null, false, adapter, runtime).typedDeliberation.materialsInput, undefined)
  assert.equal(buildAgentPresencePayload(profile, 'online', { appServerAdapter: adapter, typedInspectionProfileRuntime: runtime }).typedDeliberation, undefined)
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
  const runtime = { declaration: () => ({ supportedInputs: formats }) }
  const native = { nativeExecutionDeclaration: () => declaration }
  const readyProfile = { ...profile, workspaceFileApiOrigin: 'https://platform.example', workspaceFileRootDir: '/synthetic/private-root' }
  const registered = buildAgentRegistrationPayload(readyProfile, null, true, adapter, runtime, null, null, native)
  assert.deepEqual(registered.typedDeliberation.nativeExecution, declaration)
  assert.equal(buildAgentPresencePayload(readyProfile, 'busy', { appServerAdapter: adapter, typedInspectionProfileRuntime: runtime }).typedDeliberation, undefined)
  assert.equal(buildAgentRegistrationPayload(readyProfile, null, false, adapter, runtime, null, null, native).typedDeliberation.nativeExecution, undefined)
  assert.equal(buildAgentPresencePayload(readyProfile, 'offline', { appServerAdapter: adapter, typedInspectionProfileRuntime: runtime }).typedDeliberation, undefined)
  assert.equal(buildAgentRegistrationPayload(profile, null, true, adapter, runtime, null, null, native).typedDeliberation.nativeExecution, undefined)
  assert.equal(buildAgentRegistrationPayload(readyProfile, null, true, adapter, { declaration: runtime.declaration }).typedDeliberation.nativeExecution, undefined)
  assert.equal(buildAgentRegistrationPayload(readyProfile, null, true, adapter, runtime, null, null, { nativeExecutionDeclaration: () => null }).typedDeliberation.nativeExecution, undefined)
})


test('native-only measured readiness refreshes registration without claiming read-only carriers', () => {
  let refreshed = 0, statuses = 0
  const state = { disposed: false, typedInspectionProfileRuntime: null, nativeExecutionProfileRuntime: { nativeExecutionDeclaration: () => ({ executionProtocolVersion: 5 }) },
    runtimeTransport: { refreshCapabilities: () => { refreshed++; return true } } }
  const p = { ...profile, runtimeIdentity: {} }
  assert.equal(publishTypedInspectionReadiness(p, state, { sendStatusFn: () => { statuses++; return true }, busyFn: () => false }), true)
  assert.equal(refreshed, 1); assert.equal(statuses, 1)
  state.nativeExecutionProfileRuntime.nativeExecutionDeclaration = () => null
  assert.equal(publishTypedInspectionReadiness(p, state), false)
  assert.equal(refreshed, 1)
})

test('successive material requests share conversation memory but retain distinct request receipts', async t => {
  const first = context(t)
  const nextMessage = structuredClone(messageFixture())
  nextMessage.requestId = 'request-next'; nextMessage.turnId = 'turn-next'; nextMessage.messageId = 'message-next'; nextMessage.dispatchId = 'dispatch-next'
  nextMessage.dedupeKey = `${nextMessage.tenantId}:${nextMessage.ownerJiacn}:${nextMessage.clientId}:${nextMessage.dispatchId}`
  const material = nextMessage.contextSnapshot.facts.materialsInput
  for (const source of material.manifest.sources) source.downloadUrl = `/internal/agent/chat/requests/${nextMessage.requestId}/turns/${nextMessage.turnId}/materials/inputs/${source.sourceRefId}/content`
  const binding = Object.fromEntries(['tenantId','ownerJiacn','clientId','conversationId','conversationGeneration','taskId','requestId','turnId','targetAgentId'].map(key => [key, String(nextMessage[key])]))
  material.manifestDigest = canonicalSha256({ domain: 'juyiting.materials-input', binding, manifest: material.manifest })
  material.authorizationId = `materials_${material.manifestDigest.slice(7,47)}`
  const second = context(t, validateChatDispatch(reseal(nextMessage)))
  const values = new Map(), store = { get: key => values.get(key), put: (key, value) => values.set(key, value) }
  await runFastChat(profile, first.message, { ...first.options, bindingStore: store })
  let resumed = false
  second.adapter.startOrResumeThread = async prior => { assert.equal(prior.threadId, 'materials-thread'); resumed = true; return prior }
  await runFastChat(profile, second.message, { ...second.options, bindingStore: store })
  assert.ok(resumed); assert.equal(values.size, 1)
  const a = first.preparations.at(-1), b = second.preparations.at(-1)
  assert.equal(a.conversationKey, b.conversationKey); assert.equal(a.threadKey, b.threadKey)
  assert.notEqual(a.engineStateBinding.requestKey, b.engineStateBinding.requestKey)
  assert.notEqual(a.manifestDigest, b.manifestDigest)
  assert.equal(first.starts, 1); assert.equal(second.starts, 1)
  const changed = structuredClone(second.message); changed.ownerJiacn = 'another-owner'
  assert.notEqual(chatConversationKey(profile, changed, second.runtime), b.conversationKey)
  changed.ownerJiacn = second.message.ownerJiacn; changed.contextSnapshot.facts.taskAuthority = { grantId: 'another-grant' }
  assert.notEqual(chatConversationKey(profile, changed, second.runtime), b.conversationKey)
})

test('material recovery reopens the recorded conversation Home and clears only its matching recovery binding', async t => {
  const c = context(t); await runFastChat(profile, c.message, c.options)
  const preparation = c.preparations.at(-1); let reopened = false, suspended = false, updated
  const runtime = { contractReadback: c.runtime.contractReadback,
    openAdapter: async (_directory, key, binding, options) => {
      reopened = true; assert.equal(key, c.message.dedupeKey)
      assert.deepEqual(binding, preparation.engineStateBinding)
      assert.deepEqual(options, { requireExistingState: true, conversationKey: preparation.conversationKey })
      return { reconcileTurn: async () => ({ status: 'TERMINAL', terminalStatus: 'completed', turnId: 'materials-turn', turn: { items: [{ type: 'agent_message', text: JSON.stringify(c.outcome) }] } }) }
    }, suspendAdapter: async () => { suspended = true } }
  const store = { get: () => ({ threadId: 'materials-thread', state: 'RECOVERY_REQUIRED', recoveryMessageId: c.message.messageId }), put: (key, value) => { updated = { key, value } } }
  await recoverMaterialsChat(profile, c.message, { preparation, engine: { threadId: 'materials-thread', turnId: 'materials-turn' } }, {
    profileRuntime: runtime, bindingStore: store, controls: { markFinalPrepared: () => {} }, sendFinal: () => false })
  assert.ok(reopened && suspended); assert.equal(updated.key, preparation.threadKey); assert.equal(updated.value.state, 'IDLE')
  assert.equal(c.starts, 1)
})

test('failure before a material turn releases its engine without replaying the turn', async t => {
  const c = context(t)
  c.adapter.startOrResumeThread = async () => { throw new Error('SYNTHETIC_THREAD_RESUME_FAILURE') }
  await assert.rejects(runFastChat(profile, c.message, c.options), /SYNTHETIC_THREAD_RESUME_FAILURE/)
  assert.equal(c.starts, 0); assert.ok(c.events.includes('suspend'))
})

test('material terminal failure releases the engine, but unknown acceptance never replays or interrupts it', async t => {
  for (const code of ['TURN_FAILED', 'TURN_INTERRUPTED', 'TURN_ACCEPTANCE_UNKNOWN']) {
    const c = context(t); let runs = 0, recovery = null
    c.adapter.runTurn = async () => { runs++; throw Object.assign(new Error(code), { code, reconciliation: { status: 'RECOVERY_REQUIRED' } }) }
    const store = { get: () => null, put: (_key, value) => { if (value.state === 'RECOVERY_REQUIRED') { recovery = value.recoveryReason; assert.equal(value.recoveryMessageId, c.message.messageId) } } }
    await assert.rejects(runFastChat(profile, c.message, { ...c.options, bindingStore: store }), error => error.code === code)
    assert.equal(runs, 1); assert.equal(c.events.includes('publish'), false)
    assert.equal(c.events.includes('suspend'), code !== 'TURN_ACCEPTANCE_UNKNOWN')
    if (code === 'TURN_ACCEPTANCE_UNKNOWN') assert.equal(recovery, code)
  }
})

test('late final replay cannot clear a newer unknown turn on the same material thread', async t => {
  const c = context(t); await runFastChat(profile, c.message, c.options)
  const bindingStore = { get: () => ({ threadId: 'materials-thread', state: 'RECOVERY_REQUIRED', recoveryMessageId: 'newer-message' }),
    put: () => assert.fail('late replay must not clear another turn recovery') }
  const result = await recoverMaterialsChat(profile, c.message, { finalPrepared: c.finalPrepared }, { bindingStore, controls: {}, sendFinal: () => false })
  assert.equal(result.serverPersistence, 'unconfirmed'); assert.equal(c.starts, 1)
})


test('material conversation identity survives grant renewal within one assignment without changing dispatch facts', () => {
  const message = messageFixture()
  message.contextSnapshot.facts.taskAuthority = { grantId: 'grant-a', grantVersion: '1', assignmentRevision: '7', requirementRevision: '1' }
  const runtime = { contractReadback: { toolPolicy: 'MANIFEST_READ_ONLY' } }
  const before = structuredClone(message)
  const key = chatConversationKey(profile, message, runtime)
  assert.deepEqual(message, before)
  message.contextSnapshot.facts.taskAuthority.requirementRevision = '2'
  assert.equal(chatConversationKey(profile, message, runtime), key)
  assert.equal(message.contextSnapshot.facts.taskAuthority.requirementRevision, '2')
  message.contextSnapshot.facts.taskAuthority.grantVersion = '2'
  message.contextSnapshot.facts.taskAuthority.grantId = 'skill-baseline-grant'
  assert.equal(chatConversationKey(profile, message, runtime), key)
  message.contextSnapshot.facts.taskAuthority.assignmentRevision = '8'
  assert.notEqual(chatConversationKey(profile, message, runtime), key)
})

test('material CHAT uses its canonical conversation cwd for thread resume and turn, not a request path', async t => {
  const c = context(t)
  const cwd = '/synthetic/conversations/a/chat'
  c.adapter.typedInspectionEngineState = { chatWorkdir: cwd }
  c.adapter.startOrResumeThread = async (_prior, policy) => {
    assert.equal(policy.cwd, cwd)
    return { threadId: 'materials-thread' }
  }
  const runTurn = c.adapter.runTurn
  c.adapter.runTurn = async options => {
    assert.equal(options.policy.cwd, cwd)
    return runTurn(options)
  }
  await runFastChat(profile, c.message, c.options)
  assert.equal(c.preparations.at(-1).engineThreadId, 'materials-thread')
})

for (const fileTools of [false, true]) test(`production CHAT wiring retains one thread across warm text, material sandbox, and warm text (file tools=${fileTools})`, async t => {
  const c = context(t), root = mkdtempSync(resolve(tmpdir(), 'chat-continuity-wiring-'))
  const source = resolve(root, 'source'); mkdirSync(source, { mode: 0o700 }); writeFileSync(resolve(source, 'auth.json'), '{}', { mode: 0o600 })
  const selectedProfile = { ...profile, codexHome: source, typedInspectionProviderNetwork: 'restricted-proxy',
    typedInspectionProviderId: 'synthetic', typedInspectionProviderBaseUrl: 'https://provider.example/v1' }
  const readback = { ...c.adapter.readback, tools: { data: [] }, processExecutable: { pid: process.pid },
    config: { config: { model_provider: 'synthetic', model_providers: { synthetic: { base_url: 'https://provider.example/v1', wire_api: 'responses', requires_openai_auth: true } } } } }
  const spawned = [], priors = [], turns = [], stopped = []
  const createAdapter = kind => {
    const adapter = Object.assign(new EventEmitter(), { closed: false, chatFileTools: fileTools, readback: structuredClone(readback),
      verifySpawnedExecutable: async () => {}, initialize: async () => {},
      startOrResumeThread: async (prior, policy) => { priors.push(prior); assert.equal(policy.developerInstructions.includes('Python already provides docx, openpyxl and pypdf'), fileTools); assert.equal(policy.cwd, adapter.typedInspectionEngineState.chatWorkdir); return prior || { threadId: 'one-continuous-thread' } },
      runTurn: async options => {
        turns.push(options); const turnId = `native-turn-${turns.length}`
        options.onAccepted({ threadId: options.threadId, turnId })
        return { threadId: options.threadId, turnId, finishReason: 'completed', content: JSON.stringify(c.outcome) }
      }, shutdown: async () => { adapter.closed = true; stopped.push(kind); adapter.emit('exit') } })
    // Different incidental startup/catalog readback must not split native memory.
    if (kind === 'material') { adapter.readback.initialize = { environment: 'sandbox' }; adapter.readback.models = { data: [{ id: 'catalog-changed' }] } }
    spawned.push({ kind, adapter }); return adapter
  }
  const runtime = Object.assign(Object.create(TypedInspectionProfileRuntime.prototype), {
    profile: selectedProfile, stateRoot: root, activeAdapters: new Map(), conversationOwners: new Map(),
    contractReadback: c.runtime.contractReadback, nativeReadback: readback,
    measure: async () => ({ contractReady: true }),
    egressFactory: () => ({ start: async () => {}, bindOwner: async () => {}, attach: async () => {}, dispose: async () => {} }),
    _spawnAdapter: async ({ engineState }) => { const adapter = createAdapter('material'); adapter.typedInspectionEngineState = engineState; return adapter },
    _initializeAndSeal: async adapter => { unlinkSync(adapter.typedInspectionEngineState.authPath) },
    mapInputPath: path => path
  })
  const original = AppServerAdapter.spawnAsync
  AppServerAdapter.spawnAsync = async () => createAdapter('warm')
  t.after(async () => { await runtime.dispose(); AppServerAdapter.spawnAsync = original; rmSync(root, { recursive: true, force: true }) })
  const values = new Map(), store = { get: key => values.get(key), put: (key, value) => values.set(key, value) }
  const state = { disposed: false, chatProviderShared: true, typedInspectionProfileRuntime: runtime }
  let restarts = 0
  const lifecycle = { onExit: () => { restarts++ } }
  await bindProfileChatAdapter(state, createAdapter('bootstrap'), lifecycle)
  runtime.chatAdapterLifecycle = {
    ready: adapter => bindProfileChatAdapter(state, adapter, lifecycle),
    closing: adapter => unbindProfileChatAdapter(state, adapter)
  }
  const run = async message => {
    try { return await runFastChat(selectedProfile, message, { ...c.options, adapter: state.appServerAdapter,
      conversationRuntime: runtime, materialsRuntime: runtime, bindingStore: store }) }
    finally { if (!state.appServerAdapter) await restoreProfileChatIdleAdapter(state) }
  }

  const plain = suffix => {
    const message = structuredClone(c.message); delete message.contextSnapshot.facts.materialsInput
    message.messageId = `message-${suffix}`; message.requestId = `request-${suffix}`; message.turnId = `turn-${suffix}`; message.dispatchId = `dispatch-${suffix}`
    message.dedupeKey = `${message.tenantId}:${message.ownerJiacn}:${message.clientId}:${message.dispatchId}`
    return validateChatDispatch(reseal(message))
  }
  await run(plain('first'))
  await run(plain('second'))
  assert.deepEqual(spawned.map(item => item.kind), ['bootstrap', 'warm'], 'consecutive text turns must not cold start')
  assert.equal(runtime.warmChatAdapters.size, 1)
  await run(c.message)
  assert.deepEqual(stopped, ['bootstrap', 'warm', 'material'])
  assert.equal(runtime.warmChatAdapters.size, 1)
  assert.equal(state.appServerAdapter.closed, false)
  assert.equal(spawned.filter(item => !item.adapter.closed).length, 1)
  await run(plain('third'))
  await run(plain('fourth'))
  assert.deepEqual(spawned.map(item => item.kind), ['bootstrap', 'warm', 'material', 'warm'])
  assert.equal(values.size, 1)
  assert.equal(priors[0], undefined)
  assert.ok(priors.slice(1).every(prior => prior.threadId === 'one-continuous-thread'))
  assert.equal(new Set(spawned.filter(item => item.kind !== 'bootstrap').map(item => item.adapter.typedInspectionEngineState.codexHome)).size, 1)
  assert.equal(new Set(turns.map(turn => turn.policy.cwd)).size, 1)
  assert.equal(Array.isArray(turns[2].input), true)
  assert.equal(typeof turns[3].input, 'string')
  assert.equal(runtime.warmChatAdapters.size, 1)
  assert.equal(spawned.filter(item => !item.adapter.closed).length, 1)
  assert.equal(restarts, 0, 'intentional handoff must not restart the bootstrap')
  const live = state.appServerAdapter
  assert.equal(buildAgentRegistrationPayload(selectedProfile, null, true, live).typedDeliberation.state, 'READY')
  live.closed = true; live.emit('exit')
  assert.equal(state.appServerAdapter, null); assert.equal(restarts, 1)
  assert.equal(buildAgentRegistrationPayload(selectedProfile, null, true, state.appServerAdapter).typedDeliberation.state, 'UNAVAILABLE')
})

test('generic file manifest keeps real MIME and prepares a path descriptor, not decoded content', async () => {
  const message = structuredClone(messageFixture()), data = Buffer.from([0xff, 0x00, 0x22])
  const original = message.contextSnapshot.facts.materialsInput.manifest.sources[0]
  const format = { mediaKind: 'file', mimeType: '*/*', carrier: 'LOCAL_FILE', carrierContractDigest: `sha256:${'d'.repeat(64)}` }
  const source = { ...original, mimeType: 'application/x-custom', carrier: 'LOCAL_FILE',
    carrierContractDigest: format.carrierContractDigest, byteLength: String(data.length), sha256: sha(data) }
  const manifest = { schemaVersion: 1, profile: { schemaVersion: 1, supportedInputs: [format] }, sources: [source] }
  const binding = Object.fromEntries(['tenantId','ownerJiacn','clientId','conversationId','conversationGeneration','taskId','requestId','turnId','targetAgentId'].map(key => [key, String(message[key])]))
  const manifestDigest = canonicalSha256({ domain: 'juyiting.materials-input', binding, manifest })
  message.contextSnapshot.facts.materialsInput = { schemaVersion: 1, manifestDigest, authorizationId: `materials_${manifestDigest.slice(7,47)}`, manifest }
  const materials = resolveChatMaterials(profile, reseal(message))
  assert.equal(materials.manifest.sources[0].mimeType, 'application/x-custom')
  let fetched = 0
  const result = await prepareChatMaterials({ profile, message, materials,
    materializer: { materialize: async options => {
      fetched++; assert.equal(options.contract, 'materials')
      return { directory: '/private/current', sources: [{ ...source, bytes: data, path: '/private/current/0000.input' }] }
    } },
    profileRuntime: { contractReadback: { measured: true, toolPolicy: 'MANIFEST_READ_ONLY', recovery: 'durable-inbox-turn-readback-v1', supportedInputs: [format] },
      mapInputPath: (path, directory) => { assert.equal(directory, '/private/current'); assert.equal(path, '/private/current/0000.input'); return '/inputs/0000.input' } }
  })
  assert.equal(fetched, 1)
  assert.equal(JSON.parse(result.nativeInputs[0].text.split('\n')[1]).path, '/inputs/0000.input')
  assert.equal(result.inspectionInputReceiptDraft.sources[0].carrier, 'LOCAL_FILE')
})

// Use the real CHAT manifest resolution, download, integrity checks and final
// material directory. Do not rename a fixture to bypass the delivery filename.
async function materializeFile(t, mimeType, data, carrier = 'LOCAL_FILE') {
  const message = structuredClone(messageFixture())
  const original = message.contextSnapshot.facts.materialsInput.manifest.sources[0]
  const format = { mediaKind: carrier === 'DIRECT_TEXT' ? 'text' : 'file', mimeType: carrier === 'LOCAL_FILE' ? '*/*' : mimeType,
    carrier, carrierContractDigest: `sha256:${'d'.repeat(64)}` }
  const source = { ...original, mimeType, carrier, carrierContractDigest: format.carrierContractDigest,
    byteLength: String(data.length), sha256: sha(data) }
  const manifest = { schemaVersion: 1, profile: { schemaVersion: 1, supportedInputs: [format] }, sources: [source] }
  const binding = Object.fromEntries(['tenantId','ownerJiacn','clientId','conversationId','conversationGeneration','taskId','requestId','turnId','targetAgentId'].map(key => [key, String(message[key])]))
  const manifestDigest = canonicalSha256({ domain: 'juyiting.materials-input', binding, manifest })
  message.contextSnapshot.facts.materialsInput = { schemaVersion: 1, manifestDigest, authorizationId: `materials_${manifestDigest.slice(7,47)}`, manifest }
  const materials = resolveChatMaterials(profile, reseal(message))
  const root = mkdtempSync(resolve(tmpdir(), 'chat-material-extension-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let downloads = 0
  const materializer = new TypedInspectionMaterializer({ apiOrigin: 'https://platform.example', rootDir: root,
    agentId: profile.agentId, runtimeInstanceId: 'runtime1', getRuntimeHeaders: () => ({ Authorization: `AgentRuntime rts1_${'b'.repeat(64)}`,
      'X-Agent-Id': profile.agentId, 'X-Agent-Runtime-Id': 'runtime1', 'X-Agent-Installation-Id': 'install1', 'X-Agent-Host-Id': 'host1', 'X-Agent-Session-Generation': '1' }),
    fetchFn: async url => {
      downloads++; assert.equal(url, `https://platform.example${source.downloadUrl}`)
      return { status: 200, redirected: false, url, headers: new Headers({ 'content-type': mimeType, 'content-length': String(data.length) }), arrayBuffer: async () => data }
    } })
  const result = await materializer.materialize({ message, typed: materials, contract: 'materials' })
  assert.equal(downloads, 1)
  const file = result.sources[0]
  assert.deepEqual(readFileSync(file.path), data)
  assert.equal(statSync(file.path).mode & 0o777, 0o400)
  assert.equal(file.sha256, sha(data))
  assert.ok(file.path.startsWith(`${result.directory}/`))
  return file.path
}

test('LOCAL_FILE MIME suffixes preserve bytes and readonly paths; unknown MIME is not rejected', async t => {
  const cases = [
    ['text/plain', 'txt'], ['text/markdown', 'md'], ['text/csv', 'csv'], ['application/json', 'json'],
    ['application/pdf', 'pdf'], ['application/octet-stream', 'bin'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['application/msword', 'doc'], ['application/vnd.ms-excel', 'xls'], ['application/vnd.ms-powerpoint', 'ppt'],
    ['application/x-custom', 'input']
  ]
  for (const [mime, suffix] of cases) {
    const path = await materializeFile(t, mime, Buffer.from('original bytes'))
    assert.match(path, new RegExp(`/0000-[a-f0-9]{24}\\.${suffix}$`))
  }
  assert.match(await materializeFile(t, 'text/plain', Buffer.from('text'), 'DIRECT_TEXT'), /\.input$/)
})

test('real materialized XLSX opens directly with openpyxl on the first attempt', {
  skip: !process.env.CYF_CHAT_FILE_PROBE_PYTHON && 'requires installed document toolchain (enabled in Flow)'
}, async t => {
  const python = process.env.CYF_CHAT_FILE_PROBE_PYTHON
  const workbook = execFileSync(python, ['-I', '-B', '-c',
    'import io,sys,openpyxl; w=openpyxl.Workbook(); w.active["A1"]="materialized-first-read"; b=io.BytesIO(); w.save(b); sys.stdout.buffer.write(b.getvalue())'])
  const path = await materializeFile(t, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook)
  const output = execFileSync(python, ['-I', '-B', '-c',
    'import sys,openpyxl; w=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=True); print(w.active["A1"].value); w.close()', path], { encoding: 'utf8' })
  assert.equal(output.trim(), 'materialized-first-read')
})

test('invalid business output cannot discard terminal CHAT cost evidence', async t => {
  const c = context(t), usage = []
  const run = c.adapter.runTurn
  c.adapter.runTurn = async options => ({ ...await run(options), content: 'invalid business output', usageEvidence: { status: 'UNVERIFIED' } })
  c.options.controls.recordUsage = (phase, model, evidence) => usage.push({ phase, model, evidence })
  await assert.rejects(runFastChat(profile, c.message, c.options))
  assert.deepEqual(usage.map(item => item.phase), ['STARTED', 'TERMINAL'])
  assert.deepEqual(usage[1].evidence, { status: 'UNVERIFIED' })
  assert.equal(c.frames.length, 0)
})
