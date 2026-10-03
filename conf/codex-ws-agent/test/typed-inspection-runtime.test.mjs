import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { canonicalSha256, buildThreadKey, PersistentChatInbox, validateChatDispatch } from '../chat-runtime.mjs'
import { CODEX_APP_SERVER_SCHEMA_CONTRACTS } from '../app-server-adapter.mjs'
import {
  BUILTIN_TYPED_INSPECTION_DECODERS, TypedInspectionMaterializer, decodePngInspectionInput, decodeWavInspectionInput,
  recoverTypedInspection, resolveTypedInspectionRequest, runTypedInspection
} from '../typed-inspection-runtime.mjs'
import { TYPED_INSPECTION_OUTPUT_SCHEMA, validateTypedInspectionOutcome, validateTypedInteractionOutcome } from '../juyiting-typed-outcome.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const prefixed = value => `sha256:${digest(Buffer.from(value))}`
const contract = CODEX_APP_SERVER_SCHEMA_CONTRACTS['codex-cli-0.159.2']
const ids = {
  tenantId: 'tenant-a', ownerJiacn: 'owner-a', clientId: 'client-a', conversationId: '42', conversationGeneration: '7',
  taskId: 'task-1', requestId: 'request-1', requestRevision: '1', targetAgentId: 'agent-1', turnId: 'turn-1'
}
const discussionFacts = {
  schemaVersion: 1, referenceMode: 'AVAILABLE', supportedOperations: ['GENERATE_IMAGE', 'EDIT_IMAGE'],
  availableSources: [{ sourceRefId: 'source-1', kind: 'TASK_WORKSPACE_FILE', mediaType: 'text' }]
}
const sourceFor = (bytes = Buffer.from('bird\n'), overrides = {}) => ({
  sourceRefId: 'source-1',
  selector: { kind: 'TASK_LINKED_WORKSPACE_VERSION', fileId: 'file-1', version: '2', purpose: 'REFERENCE', assetId: null, assetRevision: null },
  mediaKind: 'text', mimeType: 'text/plain', byteLength: String(bytes.length), sha256: digest(bytes), carrier: 'DIRECT_TEXT',
  carrierContractDigest: prefixed('direct-text-v1'), ...overrides
})
const manifestFor = (source = sourceFor()) => ({
  schemaVersion: 1, purpose: 'INSPECT',
  scope: { tenantId: ids.tenantId, ownerJiacn: ids.ownerJiacn, clientId: ids.clientId, conversationId: ids.conversationId, conversationGeneration: ids.conversationGeneration, taskId: ids.taskId, assignmentRevision: '3', requestId: ids.requestId, requestRevision: ids.requestRevision, targetAgentId: ids.targetAgentId },
  profile: {
    profileId: 'inspection-profile', engineContractId: 'engine-contract-v1', enginePolicyDigest: prefixed('engine'),
    toolPolicyDigest: prefixed('tool'), inputPolicyDigest: prefixed('input')
  }, sources: [source]
})
const markerFor = manifest => ({
  schemaVersion: 1, contract: 'juyiting-typed-inspection-v1', purpose: 'INSPECT', discussionFacts,
  manifest, manifestDigest: canonicalSha256(manifest), authorizationId: `inspection_${'a'.repeat(40)}`
})
const messageFor = (source = sourceFor(), overrides = {}) => {
  const manifest = manifestFor(source); const typedInspection = markerFor(manifest)
  const sourceVector = { conversationGeneration: ids.conversationGeneration, messageHighWatermark: '10', taskRevision: '2', executionRevision: null, bindingVersion: '3', summaryRevision: null }
  const facts = {
    conversation: { id: ids.conversationId, generation: ids.conversationGeneration, scopeType: 'bounty' },
    task: { id: ids.taskId }, targetAgentId: ids.targetAgentId, typedInspection
  }
  const contextHash = canonicalSha256({ sourceVector, facts })
  return validateChatDispatch({
    schemaVersion: 1, messageType: 'chat.message', ...ids, dispatchId: 'dispatch-1', messageId: 'message-1', route: 'INSPECT', content: 'Describe the selected material.',
    contextSnapshotId: 'snapshot-1', contextHash, sourceVector, factsManifest: facts,
    contextSnapshot: { schemaVersion: '1', contextSnapshotId: 'snapshot-1', contextHash, sourceVector, facts },
    ownerJiacn: ids.ownerJiacn, dedupeKey: `${ids.tenantId}:${ids.ownerJiacn}:${ids.clientId}:dispatch-1`,
    dispatchAckType: 'chat.dispatch.ack', ackRequired: true, deliverySemantics: 'AT_LEAST_ONCE_DURABLE_DEDUPE_REQUIRED', ...overrides
  })
}
const profile = {
  profileId: 'runtime-profile', agentId: ids.targetAgentId, typedInspectionEnabled: true,
  appServerSchemaContractId: contract.contractId, chatModel: 'no-paid-call-in-test'
}
const readback = typed => ({
  schemaVersion: 1, measured: true, ...typed.manifest.profile, toolPolicy: 'MANIFEST_READ_ONLY', recovery: 'durable-inbox-turn-readback-v1',
  supportedInputs: typed.manifest.sources.map(source => ({ mediaKind: source.mediaKind, mimeType: source.mimeType, carrier: source.carrier, carrierContractDigest: source.carrierContractDigest }))
})
const adapterReadback = () => ({ initialize: {}, schema: { ...contract, schemaContractId: contract.contractId, measured: true }, models: {}, config: {} })
const response = ({ url, bytes, mimeType = 'text/plain', length = String(bytes.length), status = 200, redirected = false }) => ({
  status, redirected, url, headers: { get: name => ({ 'content-type': mimeType, 'content-length': length }[name.toLowerCase()] ?? null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
})

test('non-empty fixed-origin materialization succeeds without freezing Buffer views and writes private immutable bytes', async () => {
  const bytes = Buffer.from('abcde'); const source = sourceFor(bytes); const message = messageFor(source); const typed = resolveTypedInspectionRequest(profile, message)
  const root = mkdtempSync(resolve(tmpdir(), 'typed-inspection-materializer-')); chmodSync(root, 0o700)
  const calls = []
  const materializer = new TypedInspectionMaterializer({
    apiOrigin: 'https://platform.example/', rootDir: root, getRuntimeAuth: () => `AgentRuntime ${'b'.repeat(32)}`,
    agentId: ids.targetAgentId, runtimeInstanceId: 'runtime-1', fetchFn: async (url, options) => { calls.push({ url, options }); return response({ url, bytes }) }
  })
  const result = await materializer.materialize({ message, typed })
  assert.equal(result.sources.length, 1); assert.equal(Buffer.isBuffer(result.sources[0].bytes), true); assert.deepEqual(result.sources[0].bytes, bytes)
  assert.deepEqual(readFileSync(result.sources[0].path), bytes)
  assert.equal(lstatSync(result.directory).mode & 0o077, 0); assert.equal(lstatSync(result.sources[0].path).mode & 0o777, 0o400)
  assert.equal(calls[0].options.redirect, 'manual'); assert.equal(calls[0].options.headers.Authorization, `AgentRuntime ${'b'.repeat(32)}`)
  assert.equal(calls[0].options.headers['X-Inspection-Manifest-Digest'], typed.manifestDigest)
  assert.equal(new URL(calls[0].url).origin, 'https://platform.example')
  await assert.rejects(() => materializer.materialize({ message, typed }), error => error.code === 'TYPED_INSPECTION_REQUEST_DIRECTORY_EXISTS')
})

test('materializer rejects redirect, response URL drift, MIME, declared length and digest mismatch before native conversion', async () => {
  const bytes = Buffer.from('abcde'); const source = sourceFor(bytes); const message = messageFor(source); const typed = resolveTypedInspectionRequest(profile, message)
  const variants = [
    ({ url }) => response({ url, bytes, status: 302 }),
    ({ url }) => response({ url: `${url}?redirected=1`, bytes }),
    ({ url }) => response({ url, bytes, mimeType: 'application/octet-stream' }),
    ({ url }) => response({ url, bytes, length: '4' }),
    ({ url }) => response({ url, bytes: Buffer.from('xxxxx') })
  ]
  const codes = ['TYPED_INSPECTION_REDIRECT_FORBIDDEN', 'TYPED_INSPECTION_RESPONSE_URL_MISMATCH', 'TYPED_INSPECTION_CONTENT_TYPE_MISMATCH', 'TYPED_INSPECTION_CONTENT_LENGTH_MISMATCH', 'TYPED_INSPECTION_CONTENT_DIGEST_MISMATCH']
  for (let index = 0; index < variants.length; index++) {
    const root = mkdtempSync(resolve(tmpdir(), 'typed-inspection-reject-')); chmodSync(root, 0o700)
    const materializer = new TypedInspectionMaterializer({ apiOrigin: 'https://platform.example/', rootDir: root, getRuntimeAuth: () => `AgentRuntime ${'b'.repeat(32)}`,
      agentId: ids.targetAgentId, runtimeInstanceId: 'runtime-1', fetchFn: (url, options) => variants[index]({ url, options }) })
    await assert.rejects(() => materializer.materialize({ message, typed }), error => error.code === codes[index])
  }
})

test('private root symlink is rejected and concrete PNG decoder inflates actual scanlines', () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'typed-inspection-symlink-')); chmodSync(parent, 0o700)
  const real = resolve(parent, 'real'); const link = resolve(parent, 'link')
  mkdirPrivate(real); symlinkSync(real, link)
  assert.throws(() => new TypedInspectionMaterializer({ apiOrigin: 'https://platform.example/', rootDir: link, getRuntimeAuth: () => `AgentRuntime ${'b'.repeat(32)}`, agentId: ids.targetAgentId, runtimeInstanceId: 'runtime-1', fetchFn: async () => null }), error => error.code === 'TYPED_INSPECTION_PRIVATE_DIRECTORY_UNSAFE')
  const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) } return (crc ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
  const decoded = decodePngInspectionInput(png)
  assert.deepEqual({ width: decoded.width, height: decoded.height, channels: decoded.channels }, { width: 1, height: 1, channels: 4 })
  assert.match(decoded.pixelDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(BUILTIN_TYPED_INSPECTION_DECODERS['image/png'].decoderId, 'png-rgba8-rgb8-noninterlaced-v1')
  const wav = Buffer.alloc(46); wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(2, 40); wav.writeInt16LE(1234, 44)
  const decodedWav = decodeWavInspectionInput(wav)
  assert.deepEqual({ channels: decodedWav.channels, sampleRate: decodedWav.sampleRate, frameCount: decodedWav.frameCount }, { channels: 1, sampleRate: 8000, frameCount: 1 })
  assert.match(decodedWav.sampleDigest, /^sha256:[a-f0-9]{64}$/)
})
const mkdirPrivate = path => { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700) }

test('unmeasured profile and conflicting CHAT/INSPECT markers fail before materialization or engine start', async () => {
  const message = messageFor(); const typed = resolveTypedInspectionRequest(profile, message); let materializations = 0; let starts = 0
  const adapter = { closed: false, readback: adapterReadback(), startOrResumeThread: async () => { starts++; return { threadId: 'forbidden' } } }
  await assert.rejects(() => runTypedInspection(profile, message, { adapter, isolationReadback: null, materializer: { materialize: async () => { materializations++; return null } }, sendFinal: () => {} }), error => error.code === 'TYPED_INSPECTION_PROFILE_NOT_MEASURED')
  assert.equal(materializations, 0); assert.equal(starts, 0)
  const conflicting = structuredClone(message); conflicting.contextSnapshot.facts.typedDeliberation = structuredClone(discussionFacts)
  conflicting.factsManifest = conflicting.contextSnapshot.facts; conflicting.contextHash = canonicalSha256({ sourceVector: conflicting.sourceVector, facts: conflicting.factsManifest }); conflicting.contextSnapshot.contextHash = conflicting.contextHash
  assert.throws(() => resolveTypedInspectionRequest(profile, validateChatDispatch(conflicting)), error => error.code === 'TYPED_INSPECTION_MARKER_CONFLICT')
  assert.ok(typed)
})

test('native INSPECT durably prepares a fixed v2 final before publication and never weakens CHAT v1', async () => {
  const bytes = Buffer.from('bird\n'); const message = messageFor(sourceFor(bytes)); const typed = resolveTypedInspectionRequest(profile, message)
  const events = []; const finals = []; const bindings = new Map()
  const adapter = {
    closed: false, readback: adapterReadback(),
    startOrResumeThread: async (prior, policy) => { events.push(['thread', prior, policy]); return { threadId: 'engine-thread-1', state: 'HOT' } },
    runTurn: async options => { events.push(['turn', options]); options.onAccepted({ threadId: 'engine-thread-1', turnId: 'engine-turn-1' }); return { threadId: 'engine-thread-1', turnId: 'engine-turn-1', content: JSON.stringify({ schemaVersion: 2, kind: 'ANSWER', text: 'Observed bird.', clarification: null, proposal: null }) } },
    interrupt: async () => {}
  }
  const result = await runTypedInspection(profile, message, {
    adapter, isolationReadback: readback(typed),
    materializer: { materialize: async () => ({ directory: '/private/request-1', sources: [{ ...sourceFor(bytes), bytes }] }) },
    nativeInputAdapters: {}, bindingStore: { get: key => bindings.get(key), put: (key, value) => bindings.set(key, value), markRecovery: () => {} },
    controls: {
      markPrepared: value => events.push(['prepared', value]), markRunning: (_cancel, value) => events.push(['running', value]),
      markFinalPrepared: value => events.push(['final-prepared', value]), markFinalPublication: value => events.push(['final-publication', value]), isCancelled: () => false
    },
    sendFinal: (_profile, _message, content, extra) => { finals.push({ content, extra }); return true }
  })
  assert.equal(result.status, 'recovery_required'); assert.equal(result.computationStatus, 'completed'); assert.equal(result.serverPersistence, 'unconfirmed')
  assert.deepEqual(events.map(event => event[0]), ['prepared', 'thread', 'prepared', 'turn', 'running', 'final-prepared', 'final-publication'])
  assert.equal(events[0][1].engineThreadId, undefined); assert.equal(events[2][1].engineThreadId, 'engine-thread-1')
  assert.equal(events[3][1].input[0].type, 'text'); assert.equal(events[3][1].input[1].type, 'text')
  assert.deepEqual(events[3][1].policy.outputSchema, TYPED_INSPECTION_OUTPUT_SCHEMA)
  assert.equal(finals[0].extra.outcomeContractVersion, 2); assert.equal(finals[0].extra.inspectionInputReceipt.engineThreadId, 'engine-thread-1'); assert.equal(finals[0].extra.inspectionInputReceipt.engineTurnId, 'engine-turn-1')
  assert.equal(events[5][1].outboundMessageId, finals[0].extra.outboundMessageId); assert.equal(events[5][1].finalDigest, result.finalDigest)
  assert.equal(events[6][1].state, 'WS_WRITE_ACCEPTED_PERSISTENCE_UNCONFIRMED')
  assert.throws(() => validateTypedInteractionOutcome(finals[0].extra.interactionOutcome, discussionFacts), error => error.code === 'TYPED_OUTCOME_SHAPE_INVALID')
  assert.deepEqual(validateTypedInspectionOutcome(finals[0].extra.interactionOutcome, discussionFacts), finals[0].extra.interactionOutcome)
  assert.throws(() => validateTypedInspectionOutcome({ schemaVersion: 1, kind: 'ANSWER', text: 'legacy', clarification: null, proposal: null }, discussionFacts), error => error.code === 'TYPED_OUTCOME_SHAPE_INVALID')
})

test('existing durable inbox persists preparation and original engine binding across restart recovery', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'typed-inspection-inbox-')); chmodSync(root, 0o700)
  const inbox = new PersistentChatInbox({ rootDir: root, profile: { profileId: profile.profileId, agentId: profile.agentId } }); inbox.initialize()
  const message = messageFor(); const accepted = await inbox.accept(message); const claimed = inbox.claim(accepted.key)
  const preparation = { schemaVersion: 1, contract: 'juyiting-typed-inspection-v1', inputDigest: prefixed('input'), threadKey: 'thk:original' }
  inbox.markPrepared(claimed, preparation); inbox.markRunning(claimed, { threadId: 'engine-thread-original', turnId: 'engine-turn-original' })
  const restarted = new PersistentChatInbox({ rootDir: root, profile: { profileId: profile.profileId, agentId: profile.agentId } })
  const state = restarted.initialize(); const recovered = restarted.listRecovery()
  assert.equal(state.recoveryRequired, 1); assert.equal(recovered.length, 1)
  assert.deepEqual(recovered[0].record.preparation, preparation)
  assert.deepEqual(recovered[0].record.engine, { threadId: 'engine-thread-original', turnId: 'engine-turn-original' })
  assert.equal(recovered[0].record.message.messageId, message.messageId)
})

test('INSPECT thread key binds authority inputs while CHAT key remains byte-compatible and ignores new fields', () => {
  const base = { tenantId: 't', clientId: 'c', ownerJiacn: 'o', profileId: 'p', agentId: 'a', conversationId: 'v', mode: 'CHAT', workspaceScopeHash: 'none', cwd: '/chat', enginePolicyHash: 'e', toolPolicyHash: 't', instructionSourceHash: 'i', modelConfigHash: 'm', conversationGeneration: '1' }
  assert.equal(buildThreadKey(base), buildThreadKey({ ...base, authorizationId: 'ignored', manifestDigest: 'ignored', inputPolicyDigest: 'ignored' }))
  const inspect = { ...base, mode: 'INSPECT', authorizationId: 'auth-1', manifestDigest: prefixed('manifest-1'), inputPolicyDigest: prefixed('policy-1') }
  assert.notEqual(buildThreadKey(inspect), buildThreadKey({ ...inspect, authorizationId: 'auth-2' }))
  assert.notEqual(buildThreadKey(inspect), buildThreadKey({ ...inspect, manifestDigest: prefixed('manifest-2') }))
  assert.notEqual(buildThreadKey(inspect), buildThreadKey({ ...inspect, inputPolicyDigest: prefixed('policy-2') }))
})

test('unknown acceptance recovery performs only thread/read reconciliation and finalizes with recovered actual IDs', async () => {
  const message = messageFor(); const typed = resolveTypedInspectionRequest(profile, message); const finals = []; let reads = 0; let starts = 0
  const prepared = {
    schemaVersion: 1, contract: typed.contract, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest,
    inputPolicyDigest: typed.manifest.profile.inputPolicyDigest, inputDigest: prefixed('input'), threadKey: 'thk:recovered', engineThreadId: 'engine-thread-r',
    inspectionInputReceiptDraft: { schemaVersion: 1, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest, inputDigest: '', sources: [] }
  }
  const source = sourceFor(); const contributionDigest = prefixed('contribution')
  prepared.inspectionInputReceiptDraft.sources = [{ sourceRefId: source.sourceRefId, sha256: source.sha256, byteLength: source.byteLength, carrier: source.carrier, contributionDigest }]
  prepared.inspectionInputReceiptDraft.inputDigest = canonicalSha256({ schemaVersion: 1, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest, sources: prepared.inspectionInputReceiptDraft.sources })
  prepared.inputDigest = prepared.inspectionInputReceiptDraft.inputDigest
  const adapter = {
    closed: false, readback: adapterReadback(), startOrResumeThread: async () => { starts++; throw new Error('must not start') }, runTurn: async () => { starts++; throw new Error('must not start') },
    reconcileTurn: async binding => { reads++; assert.deepEqual(binding, { threadId: 'engine-thread-r', turnId: null, clientUserMessageId: message.messageId }); return {
      status: 'TERMINAL', terminalStatus: 'completed', turnId: 'engine-turn-r', result: { thread: { id: 'engine-thread-r' } },
      turn: { id: 'engine-turn-r', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify({ schemaVersion: 2, kind: 'ANSWER', text: 'Recovered.', clarification: null, proposal: null }) }] }
    } }
  }
  let finalPrepared = null
  const result = await recoverTypedInspection(profile, message, { preparation: prepared }, {
    adapter, isolationReadback: readback(typed),
    controls: { markFinalPrepared: value => { finalPrepared = value }, markFinalPublication: () => {} },
    sendFinal: (_profile, _message, content, extra) => { finals.push({ content, extra }); return true }
  })
  assert.equal(result.status, 'recovery_required'); assert.equal(result.computationStatus, 'completed'); assert.equal(reads, 1); assert.equal(starts, 0)
  assert.equal(finals[0].extra.inspectionInputReceipt.engineTurnId, 'engine-turn-r'); assert.equal(finalPrepared.outboundMessageId, result.outboundMessageId)
})



test('recovery preserves request engine state when durable final persistence itself fails', async () => {
  const message = messageFor(); const typed = resolveTypedInspectionRequest(profile, message); const source = sourceFor()
  const receiptSources = [{ sourceRefId: source.sourceRefId, sha256: source.sha256, byteLength: source.byteLength, carrier: source.carrier, contributionDigest: prefixed('recovery-preserve') }]
  const inputDigest = canonicalSha256({ schemaVersion: 1, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest, sources: receiptSources })
  const preparation = {
    schemaVersion: 1, contract: typed.contract, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest,
    inputPolicyDigest: typed.manifest.profile.inputPolicyDigest, inputDigest, threadKey: 'thk:recovery-preserve', engineThreadId: 'engine-thread-preserve', inputDirectory: '/private/request-preserve',
    inspectionInputReceiptDraft: { schemaVersion: 1, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest, inputDigest, sources: receiptSources }
  }
  let releases = 0
  const adapter = { closed: false, readback: adapterReadback(), reconcileTurn: async () => ({
    status: 'TERMINAL', terminalStatus: 'completed', turnId: 'engine-turn-preserve', result: { thread: { id: 'engine-thread-preserve' } },
    turn: { id: 'engine-turn-preserve', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify({ schemaVersion: 2, kind: 'ANSWER', text: 'Recovered durable result.', clarification: null, proposal: null }) }] }
  }) }
  await assert.rejects(() => recoverTypedInspection(profile, message, { preparation }, {
    adapter, profileRuntime: { releaseAdapter: async () => { releases++ } }, isolationReadback: readback(typed),
    controls: { markFinalPrepared: () => { throw new Error('SIMULATED_FINAL_FSYNC_FAILURE') } }, sendFinal: () => assert.fail('must not publish without durable final')
  }), error => error.code === 'TYPED_INSPECTION_FINAL_DURABILITY_FAILED' && error.preserveEngineState === true)
  assert.equal(releases, 0)
})

test('durable final survives false, throw and unconfirmed write publication, replays after restart with one fixed identity, and never restarts the engine', async () => {
  for (const mode of ['false', 'throw', 'true-unconfirmed']) {
    const root = mkdtempSync(resolve(tmpdir(), `typed-inspection-final-${mode}-`)); chmodSync(root, 0o700)
    const inbox = new PersistentChatInbox({ rootDir: root, profile: { profileId: profile.profileId, agentId: profile.agentId } }); inbox.initialize()
    const bytes = Buffer.from('bird\n'); const message = messageFor(sourceFor(bytes), { dispatchId: `dispatch-${mode}`, dedupeKey: `${ids.tenantId}:${ids.ownerJiacn}:${ids.clientId}:dispatch-${mode}` })
    const typed = resolveTypedInspectionRequest(profile, message); const accepted = await inbox.accept(message); const claimed = inbox.claim(accepted.key)
    let starts = 0; let releases = 0
    const adapter = {
      closed: false, readback: adapterReadback(), startOrResumeThread: async () => ({ threadId: 'engine-thread-1', state: 'HOT' }),
      runTurn: async options => { starts++; options.onAccepted({ threadId: 'engine-thread-1', turnId: 'engine-turn-1' }); return { threadId: 'engine-thread-1', turnId: 'engine-turn-1', content: JSON.stringify({ schemaVersion: 2, kind: 'ANSWER', text: 'Observed bird.', clarification: null, proposal: null }) } },
      interrupt: async () => {}
    }
    const controls = {
      markPrepared: value => inbox.markPrepared(claimed, value), markRunning: (_cancel, value) => inbox.markRunning(claimed, value),
      markFinalPrepared: value => inbox.markFinalPrepared(claimed, value), markFinalPublication: value => inbox.markFinalPublication(claimed, value), isCancelled: () => false
    }
    const first = await runTypedInspection(profile, message, {
      adapter, profileRuntime: { releaseAdapter: async () => { releases++ } }, isolationReadback: readback(typed),
      materializer: { materialize: async () => ({ directory: '/private/request-1', sources: [{ ...sourceFor(bytes), bytes }] }) },
      controls, sendFinal: () => { if (mode === 'throw') throw new Error('SIMULATED_WS_WRITE_FAILURE'); return mode === 'true-unconfirmed' }
    })
    assert.equal(first.status, 'recovery_required')
    assert.equal(first.publicationState, mode === 'true-unconfirmed' ? 'WS_WRITE_ACCEPTED_PERSISTENCE_UNCONFIRMED' : 'NOT_SENT')
    assert.equal(first.serverPersistence, 'unconfirmed'); assert.equal(starts, 1); assert.equal(releases, 1)
    assert.equal(claimed.record.state, 'FINAL_PREPARED'); assert.equal(claimed.record.finalPrepared.outboundMessageId, first.outboundMessageId)
    inbox.recoveryRequired(claimed, first.recoveryReason)
    const restarted = new PersistentChatInbox({ rootDir: root, profile: { profileId: profile.profileId, agentId: profile.agentId } }); restarted.initialize()
    const recovered = restarted.listRecovery()[0]; const replayed = []
    const replay = await recoverTypedInspection(profile, message, recovered.record, {
      controls: { markFinalPublication: value => restarted.markFinalPublication(recovered, value) },
      sendFinal: (_profile, _message, content, extra) => { replayed.push({ content, extra }); return true }
    })
    assert.equal(replay.status, 'recovery_required'); assert.equal(replay.publicationState, 'WS_WRITE_ACCEPTED_PERSISTENCE_UNCONFIRMED')
    assert.equal(starts, 1); assert.equal(replayed[0].extra.outboundMessageId, first.outboundMessageId)
    assert.equal(replay.finalDigest, first.finalDigest); assert.equal(replayed[0].content, recovered.record.finalPrepared.content)
  }
})

test('missing runtime authentication and unavailable parser fail before fetch or native start', async () => {
  const directMessage = messageFor(); const directTyped = resolveTypedInspectionRequest(profile, directMessage)
  let fetches = 0; let starts = 0
  const adapter = { closed: false, readback: adapterReadback(), startOrResumeThread: async () => { starts++; return { threadId: 'forbidden' } } }
  const unauthenticated = new TypedInspectionMaterializer({
    apiOrigin: 'https://platform.example/', rootDir: mkdtempSync(resolve(tmpdir(), 'typed-inspection-noauth-')),
    getRuntimeAuth: () => '', agentId: ids.targetAgentId, runtimeInstanceId: 'runtime-1',
    fetchFn: async () => { fetches++; throw new Error('must not fetch') }
  })
  await assert.rejects(() => runTypedInspection(profile, directMessage, {
    adapter, isolationReadback: readback(directTyped), materializer: unauthenticated, sendFinal: () => {}
  }), error => error.code === 'TYPED_INSPECTION_RUNTIME_AUTH_REQUIRED')
  assert.equal(fetches, 0); assert.equal(starts, 0)

  const bytes = Buffer.from('opaque document bytes')
  const parsedSource = sourceFor(bytes, { mediaKind: 'document', mimeType: 'application/pdf', carrier: 'PARSED_TEXT', carrierContractDigest: prefixed('parsed-text-v1') })
  const parsedMessage = messageFor(parsedSource); const parsedTyped = resolveTypedInspectionRequest(profile, parsedMessage)
  const root = mkdtempSync(resolve(tmpdir(), 'typed-inspection-noparser-')); chmodSync(root, 0o700)
  const noParser = new TypedInspectionMaterializer({
    apiOrigin: 'https://platform.example/', rootDir: root, getRuntimeAuth: () => `AgentRuntime ${'b'.repeat(32)}`,
    agentId: ids.targetAgentId, runtimeInstanceId: 'runtime-1', fetchFn: async url => { fetches++; return response({ url, bytes, mimeType: parsedSource.mimeType }) }
  })
  await assert.rejects(() => runTypedInspection(profile, parsedMessage, {
    adapter, isolationReadback: readback(parsedTyped), materializer: noParser, sendFinal: () => {}
  }), error => error.code === 'TYPED_INSPECTION_PARSER_UNAVAILABLE')
  assert.equal(fetches, 1); assert.equal(starts, 0)
})

test('recovery rejects mismatched terminal bindings and ambiguous model finals', async () => {
  const message = messageFor(); const typed = resolveTypedInspectionRequest(profile, message)
  const source = sourceFor(); const receiptSources = [{
    sourceRefId: source.sourceRefId, sha256: source.sha256, byteLength: source.byteLength,
    carrier: source.carrier, contributionDigest: prefixed('contribution')
  }]
  const inputDigest = canonicalSha256({ schemaVersion: 1, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest, sources: receiptSources })
  const record = { preparation: {
    schemaVersion: 1, contract: typed.contract, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest,
    inputPolicyDigest: typed.manifest.profile.inputPolicyDigest, inputDigest, threadKey: 'thk:recovered', engineThreadId: 'engine-thread-r',
    inspectionInputReceiptDraft: { schemaVersion: 1, authorizationId: typed.authorizationId, manifestDigest: typed.manifestDigest, inputDigest, sources: receiptSources }
  }, engine: { threadId: 'engine-thread-r', turnId: 'engine-turn-r' } }
  const base = { status: 'TERMINAL', terminalStatus: 'completed', turnId: 'engine-turn-r', result: { thread: { id: 'engine-thread-r' } },
    turn: { id: 'engine-turn-r', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify({ schemaVersion: 2, kind: 'ANSWER', text: 'Recovered.', clarification: null, proposal: null }) }] } }
  const attempt = reconciliation => recoverTypedInspection(profile, message, record, {
    adapter: { closed: false, readback: adapterReadback(), reconcileTurn: async () => reconciliation },
    isolationReadback: readback(typed), sendFinal: () => assert.fail('invalid recovery must not publish')
  })
  await assert.rejects(() => attempt({ ...base, result: { thread: { id: 'other-thread' } } }), error => error.code === 'TYPED_INSPECTION_ENGINE_BINDING_MISMATCH')
  await assert.rejects(() => attempt({ ...base, turnId: 'other-turn', turn: { ...base.turn, id: 'other-turn' } }), error => error.code === 'TYPED_INSPECTION_ENGINE_BINDING_MISMATCH')
  await assert.rejects(() => attempt({ ...base, turn: { ...base.turn, items: [...base.turn.items, ...base.turn.items] } }), error => error.code === 'TYPED_INSPECTION_RECOVERED_FINAL_INVALID')
})


test('inspection resolves exact INPUT and REFERENCE selectors and neutral conversation assets', () => {
  const base = sourceFor().selector
  const valid = [{ ...base, purpose: 'INPUT' }, base,
    { kind: 'CURRENT_CONVERSATION_ASSET', fileId: null, version: null, purpose: null, assetId: 'asset-1', assetRevision: '9007199254740993' }]
  for (const selector of valid) {
    const value = resolveTypedInspectionRequest(profile, messageFor(sourceFor(undefined, { selector })))
    assert.deepEqual(value.manifest.sources[0].selector, selector)
  }
  for (const selector of [{ ...base, purpose: 'OUTPUT' }, { ...base, purpose: 'input' }, { ...base, version: '2147483648' },
    { ...base, version: '02' }, { ...base, assetId: 'asset-1' }, { ...valid[2], purpose: 'REFERENCE' }, { ...base, kind: 'UNKNOWN' }]) {
    assert.throws(() => resolveTypedInspectionRequest(profile, messageFor(sourceFor(undefined, { selector }))),
      error => error.code === 'TYPED_INSPECTION_MANIFEST_INVALID')
  }
})

test('inspection resolves the complete 32-item catalogue without truncation', () => {
  const message = structuredClone(messageFor()); const typed = message.contextSnapshot.facts.typedInspection
  typed.manifest.sources = Array.from({ length: 32 }, (_, index) => sourceFor(undefined, {
    sourceRefId: `source-${String(index).padStart(2, '0')}`,
    selector: { ...sourceFor().selector, fileId: `file-${index}`, purpose: index % 2 ? 'REFERENCE' : 'INPUT' }
  }))
  typed.discussionFacts.availableSources = typed.manifest.sources.map(source => ({ sourceRefId: source.sourceRefId, kind: 'TASK_WORKSPACE_FILE', mediaType: 'text' }))
  typed.manifestDigest = canonicalSha256(typed.manifest)
  assert.equal(resolveTypedInspectionRequest(profile, message).manifest.sources.length, 32)
  const excess = structuredClone(message); const extra = excess.contextSnapshot.facts.typedInspection
  extra.manifest.sources.push(sourceFor(undefined, { sourceRefId: 'source-32' }))
  extra.manifestDigest = canonicalSha256(extra.manifest)
  assert.throws(() => resolveTypedInspectionRequest(profile, excess), error => error.code === 'TYPED_INSPECTION_MANIFEST_INVALID')
})


const actionMessage = () => {
  const message = structuredClone(messageFor())
  message.contextSnapshot.facts.typedInspection.discussionFacts = {
    schemaVersion: 3, availableSources: structuredClone(discussionFacts.availableSources), inspectedSourceRefIds: [],
    availableActions: [
      { actionId: 'inspect', kind: 'INSPECT_INPUTS', operation: 'INSPECT_INPUTS', inputMediaTypes: ['text', 'image', 'audio', 'file'], minSources: 1, maxSources: 32 },
      { actionId: 'document', kind: 'EXECUTE', operation: 'CREATE_DOCUMENT', inputMediaTypes: ['text', 'image', 'audio', 'file'], minSources: 0, maxSources: 32 }
    ]
  }
  message.factsManifest = message.contextSnapshot.facts
  message.contextHash = canonicalSha256({ sourceVector: message.sourceVector, facts: message.factsManifest }); message.contextSnapshot.contextHash = message.contextHash
  return validateChatDispatch(message)
}

test('v3 native INSPECT returns non-image action with bound receipt; durable replay publishes only, never starts provider', async () => {
  const { ACTION_OUTCOME_SCHEMA } = await import('../juyiting-action-outcome.mjs')
  const message = actionMessage(); const typed = resolveTypedInspectionRequest(profile, message); const frames = []
  const outcome = { schemaVersion: 3, kind: 'ACTION_REQUEST', text: '已查阅资料，现在生成报告。', clarification: null, action: { actionId: 'document', instruction: '整理资料为报告', sourceRefIds: ['source-1'] } }
  let starts = 0; let finalPrepared = null
  const adapter = {
    closed: false, readback: adapterReadback(),
    startOrResumeThread: async (_prior, policy) => { assert.match(policy.developerInstructions, /version-3/); return { threadId: 'v3-inspect-thread' } },
    runTurn: async options => {
      starts++; assert.deepEqual(options.policy.outputSchema, ACTION_OUTCOME_SCHEMA)
      assert.equal(options.input[1].type, 'text')
      options.onAccepted({ threadId: 'v3-inspect-thread', turnId: 'v3-inspect-turn' })
      return { threadId: 'v3-inspect-thread', turnId: 'v3-inspect-turn', content: JSON.stringify(outcome) }
    }
  }
  const result = await runTypedInspection(profile, message, {
    adapter, isolationReadback: readback(typed),
    materializer: { materialize: async () => ({ directory: '/private/v3-inspect', sources: [{ ...sourceFor(), bytes: Buffer.from('bird\n') }] }) }, nativeInputAdapters: {},
    controls: { markPrepared: () => {}, markRunning: () => {}, markFinalPrepared: value => { finalPrepared = value }, markFinalPublication: () => {}, isCancelled: () => false },
    sendFinal: (_profile, _message, content, extra) => { frames.push({ content, extra }); return false }
  })
  assert.equal(result.serverPersistence, 'unconfirmed')
  assert.equal(frames[0].extra.outcomeContractVersion, 3)
  assert.deepEqual(frames[0].extra.interactionOutcome, outcome)
  assert.equal(frames[0].extra.inspectionInputReceipt.engineTurnId, 'v3-inspect-turn')
  await recoverTypedInspection(profile, message, { finalPrepared }, {
    adapter: { runTurn: () => assert.fail('must not restart generation') },
    controls: { markFinalPublication: () => {} }, sendFinal: (_profile, _message, content, extra) => { frames.push({ content, extra }); return true }
  })
  assert.deepEqual(frames[1], frames[0]); assert.equal(starts, 1)
})

test('v3 rejects catalogue mismatch before fetching and prevents an inspection loop over already-provided inputs', async () => {
  const message = actionMessage(); const typed = resolveTypedInspectionRequest(profile, message)
  const changed = structuredClone(message); changed.contextSnapshot.facts.typedInspection.discussionFacts.availableSources[0].mediaType = 'audio'
  assert.throws(() => resolveTypedInspectionRequest(profile, changed), /ACTION_INSPECTION_CATALOG_MISMATCH/)
  const adapter = {
    closed: false, readback: adapterReadback(), startOrResumeThread: async () => ({ threadId: 'loop-thread' }),
    runTurn: async () => ({ threadId: 'loop-thread', turnId: 'loop-turn', content: JSON.stringify({ schemaVersion: 3, kind: 'ACTION_REQUEST', text: 'read again', clarification: null,
      action: { actionId: 'inspect', instruction: 'read the same input', sourceRefIds: ['source-1'] } }) })
  }
  await assert.rejects(() => runTypedInspection(profile, message, {
    adapter, isolationReadback: readback(typed), materializer: { materialize: async () => ({ directory: '/private/v3-loop', sources: [{ ...sourceFor(), bytes: Buffer.from('bird\n') }] }) }, nativeInputAdapters: {},
    controls: { markPrepared: () => {}, markRunning: () => {}, markFinalPrepared: () => assert.fail('must not save invalid action'), isCancelled: () => false },
    sendFinal: () => assert.fail('must not publish invalid action')
  }), /ACTION_INSPECTION_NO_PROGRESS/)
})
