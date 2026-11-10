import { beginProviderUsage } from '../../skills/native-image/scripts/provider-usage.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SkillConversationLane, parseSkillInputSnapshot, validateCommittedSkillResult, skillCommandFromWire } from '../skill-conversation.mjs'
import { skillDigest, skillHash, skillCanonicalJson } from '../skill-executor.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { skillConversationHttpScope } from '../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
const partial = async (promise, code, processed = 0, executionId = 'pwe_1') => {
  const report = await promise
  assert.deepEqual(report, { status: 'PARTIAL', processed, deferred: 0, executionErrors: [{ executionId, code }] })
  return report
}
const scope = { tenantId: 'tenant', clientId: 'client', ownerJiacn: 'owner', agentId: 'agent' }
const command = () => ({ executionProtocolVersion: 5, executionId: 'pwe_1', taskId: 'task', runId: 'run', conversationId: 'conversation', conversationGeneration: '1', commandId: 'cmd', messageId: 'msg',
  skills: [], toolPolicyRef: 'NATIVE_LOCAL_FILES_V1',
  snapshotDigest: 'c'.repeat(64), parameters: {}, instruction: '分析资料', inputRefs: [], outputs: { dataSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: false } })
const wireCommand = ({ snapshotDigest, ...command }) => ({ ...command, snapshotSha256: snapshotDigest })
const headers = () => ({ Authorization: `AgentRuntime rts1_${'0'.repeat(64)}`, 'X-Agent-Id': 'agent', 'X-Agent-Installation-Id': 'installation', 'X-Agent-Host-Id': 'host', 'X-Agent-Runtime-Id': 'runtime', 'X-Agent-Session-Generation': '1' })
const response = (url, value, status = 200, headers = {}) => {
  const reply = new Response(JSON.stringify({ protocolVersion: 1, requestId: 'skill-test', code: 'E0', msg: 'ok', data: value }), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'skill-test', ...headers } }); Object.defineProperty(reply, 'url', { value: url.href }); return reply
}
const fixture = (t, displayName) => {
  const root = mkdtempSync(resolve(tmpdir(), 'skill-lane-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const c = command(), calls = [], uploadedNames = [], effects = new Map(); let modelCalls = 0, serverManifest = null, loseCommit = false, loseStage = false, inboxEmpty = false, corruptDigest = false
  const descriptor = { manifest: { runner: 'native-model', parametersSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false }, inputs: { minItems: 0, maxItems: 32, acceptedMimeTypes: ['text/plain'] }, outputs: c.outputs } }
  const lease = () => ({ executionId: c.executionId, version: '9007199254740993', token: '00000000-0000-0000-0000-000000000001', expiresAt: Date.now() + 600000 })
  // Transport test double, not engine/model acceptance evidence. Native engine
  // acceptance/reconciliation is tested separately by native-execution tests.
  const runNative = async ({ store }) => {
    if (effects.has('native-model')) throw Object.assign(new Error('acceptance unknown'), { code: 'SKILL_RESULT_UNKNOWN' })
    modelCalls++
    const artifacts = []
    if (c.outputs.artifactsRequired) {
      const bytes = Buffer.from('真实正文'); store.writeBlob('output_1', bytes)
      artifacts.push({ ...(displayName ? { displayName } : {}), outputId: 'output_1', contentMimeType: 'text/plain', sha256: skillHash(bytes), byteLength: String(bytes.length) })
    }
    return store.persistNativeResult({ data: { summary: '由模型实际返回' }, artifacts, inputReceipts: [], effectDependencies: [] })
  }
  const fetchFn = async (url, opts) => {
    assert.equal(opts.redirect, 'error'); assert.equal(opts.headers['X-Agent-Id'], 'agent'); assert.equal(Object.hasOwn(opts.headers, 'x-api-key'), false)
    calls.push(url.pathname); const body = opts.body instanceof FormData ? opts.body : opts.body ? JSON.parse(opts.body) : null
    if (url.pathname.endsWith('/commands')) return response(url, { items: inboxEmpty ? [] : [wireCommand(c)] })
    if (url.pathname.endsWith('/lease') || url.pathname.endsWith('/lease/renew')) return response(url, lease())
    if (url.pathname.endsWith('/resume')) return response(url, { lease: lease(), resultManifest: serverManifest, phase: serverManifest ? 'ARCHIVING' : 'RUNNING', allowedWork: serverManifest ? ['STAGE_OUTPUTS', 'COMMIT_RESULT', 'PROJECT_RESULT'] : ['EXECUTE'] })
    if (url.pathname.endsWith('/inputs')) return response(url, { schemaVersion: 5, executionId: c.executionId, leaseVersion: '9007199254740993', snapshotSha256: c.snapshotDigest, noReferencedMaterials: true, inputs: [] })
    if (/\/outputs\/[^/]+\/content$/.test(url.pathname)) {
      uploadedNames.push(body.get('file').name)
      const bytes = Buffer.from(await body.get('file').arrayBuffer()); assert.equal(body.get('sha256'), skillHash(bytes)); assert.equal(body.get('byteLength'), String(bytes.length)); assert.equal(body.has('length'), false)
      if (loseStage) { loseStage = false; throw Object.assign(new Error('stage reply lost'), { code: 'ECONNRESET' }) }
      return response(url, { outputId: 'output_1', sha256: skillHash(bytes), byteLength: String(bytes.length), state: 'STAGED' }, 201)
    }
    if (url.pathname.includes('/result-commits/')) {
      assert.deepEqual(Object.keys(body).sort(), ['artifacts', 'data', 'effectDependencies', 'fence', 'inputReceipts', 'snapshotSha256'])
      for (const artifact of body.artifacts) { assert.deepEqual(Object.keys(artifact).sort(), ['byteLength', 'outputId', 'sha256']); assert.equal(typeof artifact.byteLength, 'string') }
      const preimage = { schemaVersion: 2, data: body.data, effectDependencies: body.effectDependencies, artifacts: body.artifacts.map(item => ({ ...item, byteLength: Number(item.byteLength) })), inputReceipts: body.inputReceipts }
      serverManifest = { ...preimage, resultDigest: skillDigest(preimage), manifestId: url.pathname.split('/').at(-1) }
      if (loseCommit) { loseCommit = false; throw Object.assign(new Error('commit response lost'), { code: 'ECONNRESET' }) }
      return response(url, { manifestId: url.pathname.split('/').at(-1), state: 'RESULT_COMMITTED', phase: 'ARCHIVING', resultSha256: corruptDigest ? '0'.repeat(64) : serverManifest.resultDigest })
    }
    throw new Error(`unexpected path: ${url.pathname}`)
  }
  const options = { apiOrigin: 'https://api.example.test', rootDir: root, scope, agentId: 'agent', runtimeInstanceId: 'runtime', getRuntimeHeaders: headers, fetchFn,
    registry: { requireExact: async () => ({ descriptor, binding: null }) }, runNative, runners: new Map() }
  return { c, calls, uploadedNames, effects, options, lane: new SkillConversationLane(options), descriptor, modelCalls: () => modelCalls,
    loseCommit: () => { loseCommit = true }, loseStage: () => { loseStage = true }, emptyInbox: () => { inboxEmpty = true }, corruptDigest: () => { corruptDigest = true },
    serverManifest: () => serverManifest }
}
test('protocol5 empty-skill transport commits data without legacy effects or output-commit', async t => {
  const f = fixture(t); assert.deepEqual(await f.lane.poll(), { status: 'PROGRESSED', processed: 1, deferred: 0, executionErrors: [] }); assert.equal(f.modelCalls(), 1)
  assert.ok(f.calls.some(path => path.includes('/result-commits/'))); assert.ok(!f.calls.some(path => /consent|provider-start|output-commits/.test(path)))
  assert.equal(f.effects.size, 0)
})
test('lost final response reads back the identical committed result without a second write or model call', async t => {
  const f = fixture(t); f.loseCommit(); await f.lane.poll(); assert.equal(f.modelCalls(), 1)
  assert.equal(f.calls.filter(path => path.endsWith('/resume')).length, 1)
  assert.equal(f.calls.filter(path => path.includes('/result-commits/')).length, 1)
})
test('stage uncertainty resumes from saved manifest after reconstruction, same output/hash and no model repeat', async t => {
  const f = fixture(t); f.c.outputs.artifactsRequired = true; f.loseStage()
  await partial(f.lane.poll(), 'SKILL_TRANSPORT_UNKNOWN'); assert.equal(f.modelCalls(), 1)
  await new SkillConversationLane(f.options).poll(); assert.equal(f.modelCalls(), 1)
  assert.equal(f.calls.filter(path => path.endsWith('/outputs/output_1/content')).length, 2)
})
test('native UNKNOWN is returned without falsely committing or claiming completion', async t => {
  const f = fixture(t); f.effects.set('native-model', { status: 'START_RECORDED' })
  await partial(f.lane.poll(), 'SKILL_RESULT_UNKNOWN'); assert.equal(f.modelCalls(), 0)
})
test('exact native conversation routes reject legacy writes, wildcard routes and encoded aliases', () => {
  const url = path => new URL(path, 'https://api.example.test')
  for (const path of ['effects/generate/start', 'effects/generate/result', 'resume', 'result-commits/manifest_1', 'inputs/input_1/content'])
    assert.equal(skillConversationHttpScope(url(`/internal/agent/tasks/t/runs/r/conversation/${path}`), { method: 'POST' }), true, path)
  for (const path of ['provider-start', 'controlled-image-v3-start', 'output-commits/manifest1', 'effects/generate/delete', 'anything', 'inputs/%69nput_1/content'])
    assert.equal(skillConversationHttpScope(url(`/internal/agent/tasks/t/runs/r/conversation/${path}`), { method: 'POST' }), false, path)
  assert.equal(skillConversationHttpScope(url('/internal/agent/tasks/conversation-executions/controlled-image-v3-commands'), { method: 'GET' }), false)
  assert.equal(skillConversationHttpScope(url('/internal/agent/tasks/conversation-executions/commands?token=x'), { method: 'GET' }), false)
})

test('committed server envelope resumes without local blob/staging or a runnable dependency', async t => {
  const f = fixture(t); f.c.outputs.artifactsRequired = true; await f.lane.poll()
  f.options.runners.clear()
  // Inbox is deliberate redelivery; retained server truth is authoritative.
  await new SkillConversationLane(f.options).poll()
  assert.equal(f.modelCalls(), 1)
  assert.equal(f.calls.filter(path => path.endsWith('/outputs/output_1/content')).length, 1)
  assert.equal(f.calls.filter(path => path.includes('/result-commits/')).length, 1)
})
test('reconstruction resumes saved command even when server inbox only lists QUEUED work', async t => {
  const f = fixture(t); f.c.outputs.artifactsRequired = true; f.loseStage()
  await partial(f.lane.poll(), 'SKILL_TRANSPORT_UNKNOWN')
  f.emptyInbox(); await new SkillConversationLane(f.options).poll()
  assert.equal(f.modelCalls(), 1)
  assert.equal(f.calls.filter(path => path.endsWith('/outputs/output_1/content')).length, 2)
})
test('syntactically valid but incorrect result digest is not a commit receipt', async t => {
  const f = fixture(t); f.corruptDigest()
  await partial(f.lane.poll(), 'SKILL_COMMIT_UNCONFIRMED')
})
test('frozen §6 source kinds/identities and safe Java lengths preserve MIME/hash; absence is explicit', () => {
  const c = command(); c.inputRefs = ['input_1']
  const input = { inputRef: 'input_1', sourceKind: 'TASK_LINKED_WORKSPACE_VERSION', sourceIdentity: { fileId: 'f', version: 1, purpose: 'INPUT' }, contentMimeType: 'text/plain', byteLength: '4', sha256: 'a'.repeat(64) }
  const envelope = { schemaVersion: 5, executionId: c.executionId, leaseVersion: '9007199254740993', snapshotSha256: c.snapshotDigest, noReferencedMaterials: false, inputs: [input] }
  assert.deepEqual(parseSkillInputSnapshot(envelope, c, { version: '9007199254740993' })[0], { ...input, byteLength: '4' })
  for (const patch of [{ sourceKind: 'URL' }, { byteLength: Number.MAX_SAFE_INTEGER + 1 }, { byteLength: '-1' }, { sourceIdentity: null }])
    assert.throws(() => parseSkillInputSnapshot({ ...envelope, inputs: [{ ...input, ...patch }] }, c, { version: '9007199254740993' }), /SNAPSHOT_INVALID/)
  assert.throws(() => parseSkillInputSnapshot({ ...envelope, noReferencedMaterials: true }, c, { version: '9007199254740993' }), /SNAPSHOT_INVALID/)
})

test('only the real committed receipt permits execution-owned carrier adapter release', async t => {
  const f = fixture(t); const released = []
  f.options.onCommitted = (command, receipt) => { released.push([command.executionId, receipt.state]) }
  f.loseCommit(); await new SkillConversationLane(f.options).poll()
  assert.deepEqual(released, [['pwe_1', 'RESULT_COMMITTED']])
  const missing = fixture(t); let unsafeRelease = 0
  missing.options.onCommitted = () => { unsafeRelease++ }; missing.corruptDigest()
  await partial(new SkillConversationLane(missing.options).poll(), 'SKILL_COMMIT_UNCONFIRMED')
  assert.equal(unsafeRelease, 0)
})

test('a pending UNKNOWN retains its error but does not starve unrelated next inbox execution', async t => {
  const first = fixture(t), second = fixture(t)
  first.effects.set('native-model', { status: 'START_RECORDED' })
  await partial(first.lane.poll(), 'SKILL_RESULT_UNKNOWN')
  second.c.executionId = 'pwe_2'; second.c.runId = 'run_2'; second.c.commandId = 'cmd_2'; second.c.messageId = 'msg_2'
  let now = 0
  const options = { ...first.options, now: () => now, random: () => 1, runNative: request => (request.command.executionId === first.c.executionId ? first.options : second.options).runNative(request), fetchFn: async (url, opts) => {
    if (url.pathname.endsWith('/commands')) return response(url, { items: [wireCommand(second.c)] })
    return (url.pathname.includes('/runs/run_2/') ? second.options : first.options).fetchFn(url, opts)
  } }
  const lane = new SkillConversationLane(options)
  for (let attempt = 0; attempt < 2; attempt++) {
    now += 300000
    await partial(lane.poll(), 'SKILL_RESULT_UNKNOWN', 1, first.c.executionId)
  }
  assert.equal(first.modelCalls(), 0); assert.equal(second.modelCalls(), 1)
  assert.equal(second.calls.filter(path => path.includes('/result-commits/')).length, 1)
  // A saved pre-management command has no binding. Never fabricate one or replay it.
  const store = new SkillExecutionStore({ rootDirectory: first.lane.root, scope: { ...scope, apiOrigin: first.lane.origin }, command: first.c })
  const legacy = JSON.parse(readFileSync(store.path('command'), 'utf8')); legacy.executionProtocolVersion = 4
  writeFileSync(store.path('command'), JSON.stringify(legacy)); const before = readFileSync(store.path('command'))
  await partial(lane.poll(), 'SKILL_COMMAND_INVALID', 1, first.c.executionId)
  assert.deepEqual(readFileSync(store.path('command')), before)
  assert.equal(first.modelCalls(), 0); assert.equal(second.modelCalls(), 1)
})

test('shared store or session failures immediately halt poll instead of crossing the security boundary', async t => {
  for (const code of ['SKILL_SESSION_CHANGED', 'SKILL_STORE_UNSAFE', 'SKILL_STORE_IDENTITY_CONFLICT']) {
    const f = fixture(t), calls = [], original = Object.assign(new Error(code), { code, cause: new Error('actual cause') })
    const second = { ...command(), executionId: 'pwe_2', runId: 'run_2' };
    f.lane.fetch = async url => response(url, { items: [wireCommand(f.c), wireCommand(second)] })
    f.lane.process = async command => { calls.push(command.executionId); throw original }
    await assert.rejects(f.lane.poll(), error => error === original)
    assert.deepEqual(calls, ['pwe_1']); assert.equal(f.lane.active, false)
  }
})

test('isolated poll failures report scoped codes without leaking provider response data', async t => {
  const f = fixture(t), cause = Object.assign(new Error('private provider response'), { code: 'ECONNRESET' })
  const original = Object.assign(new Error('SKILL_TRANSPORT_UNKNOWN'), { code: 'SKILL_TRANSPORT_UNKNOWN', cause })
  f.lane.process = async () => { throw original }
  const report = await partial(f.lane.poll(), 'SKILL_TRANSPORT_UNKNOWN')
  assert.equal(JSON.stringify(report).includes('private provider response'), false)
  assert.equal(original.cause, cause)
  assert.equal(f.lane.active, false)
})


test('native local-file committed results bind receipts without legacy runner identity', () => {
  const c = command(); c.inputRefs = ['input_1']
  const preimage = { schemaVersion: 2, effectDependencies: [], data: { summary: '实际持久结果' }, artifacts: [], inputReceipts: [{ inputRef: 'input_1', sha256: 'd'.repeat(64), carrier: 'local-file', delivery: 'DELIVERED' }] }
  const digest = skillDigest(preimage), manifest = { ...preimage, resultDigest: digest, manifestId: `manifest_${digest}` }
  assert.equal(validateCommittedSkillResult(manifest, c, null, 'ARCHIVING').state, 'RESULT_COMMITTED')
  assert.throws(() => validateCommittedSkillResult({ ...manifest, inputReceipts: [{ ...preimage.inputReceipts[0], inputRef: 'foreign' }] }, c, null, 'ARCHIVING'), /SKILL_RESULT_INPUT_RECEIPT_INVALID/)
})

test('numeric, noncanonical and overflowing public lease versions fail before executor work', async t => {
  for (const version of [1, '01', '0', '-1', '9223372036854775808']) {
    const f = fixture(t)
    const fetchFn = async (url, opts) => {
      const reply = await f.options.fetchFn(url, opts)
      if (!url.pathname.endsWith('/lease')) return reply
      const wire = await reply.json()
      return response(url, { ...wire.data, version })
    }
    await partial(new SkillConversationLane({ ...f.options, fetchFn }).poll(), 'SKILL_LEASE_UNCERTAIN')
    assert.equal(f.modelCalls(), 0)
  }
})

test('current native session header generation preserves all positive int64 values', async () => {
  const { nativeSessionHeaders, nativePositiveLong } = await import('../conversation-native.mjs')
  for (const generation of ['9007199254740993', '9223372036854775807']) {
    assert.equal(nativeSessionHeaders({ ...headers(), 'X-Agent-Session-Generation': generation }, 'agent', 'runtime')['X-Agent-Session-Generation'], generation)
  }
  for (const generation of ['01', '0', '-1', '9223372036854775808', 1, null]) assert.equal(nativePositiveLong(generation), false)
})

test('public command projection keeps private checkpoint hash preimage byte-for-byte', t => {
  const original = command(), bytes = JSON.stringify(original), digest = skillDigest(original)
  const publicCommand = wireCommand(original), publicBytes = JSON.stringify(publicCommand)
  const projected = skillCommandFromWire(publicCommand)
  // Check the actual checkpoint encoder, not irrelevant JavaScript insertion order.
  assert.equal(skillCanonicalJson(projected), skillCanonicalJson(original))
  assert.equal(JSON.stringify(original), bytes)
  const root = mkdtempSync(resolve(tmpdir(), 'skill-wire-checkpoint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const saved = new SkillExecutionStore({ rootDirectory: root, scope, command: original })
  const prior = readFileSync(saved.path('command'))
  new SkillExecutionStore({ rootDirectory: root, scope, command: projected })
  assert.deepEqual(readFileSync(saved.path('command')), prior)
  assert.equal(skillDigest(projected), digest)
  assert.equal(JSON.stringify(publicCommand), publicBytes)
  assert.throws(() => skillCommandFromWire(original), /SKILL_COMMAND_INVALID/)
  assert.throws(() => skillCommandFromWire({ ...publicCommand, snapshotDigest: original.snapshotDigest }), /SKILL_COMMAND_INVALID/)
})


test('UNKNOWN defers only its execution, avoids heavy process calls and resumes after exponential backoff', async t => {
  const f = fixture(t); let now = 0, calls = 0, recover = false
  const lane = new SkillConversationLane({ ...f.options, now: () => now, random: () => 1 })
  lane.process = async () => { calls++; if (!recover) throw Object.assign(new Error('unknown'), { code: 'SKILL_RESULT_UNKNOWN' }) }
  await partial(lane.poll(), 'SKILL_RESULT_UNKNOWN')
  for (now = 3000; now < 15000; now += 3000) assert.deepEqual(await lane.poll(), { status: 'DEFERRED', processed: 0, deferred: 1, executionErrors: [] })
  assert.equal(calls, 1)
  await partial(lane.poll(), 'SKILL_RESULT_UNKNOWN'); assert.equal(calls, 2)
  now = 44999; assert.deepEqual(await lane.poll(), { status: 'DEFERRED', processed: 0, deferred: 1, executionErrors: [] })
  now = 45000; recover = true; assert.deepEqual(await lane.poll(), { status: 'PROGRESSED', processed: 1, deferred: 0, executionErrors: [] })
  assert.equal(lane.unknownRetries.size, 0)
  assert.equal(f.modelCalls(), 0)
})
test('UNKNOWN delay is bounded without a deadline; unrelated commands continue during cooldown', async t => {
  const f = fixture(t); let now = 0; const visited = []
  const lane = new SkillConversationLane({ ...f.options, now: () => now, random: () => 0 })
  const other = { ...structuredClone(f.c), executionId: 'pwe_2', runId: 'run_2' };
  lane.fetch = async url => response(url, { items: [wireCommand(f.c), wireCommand(other)] })
  lane.process = async c => { visited.push(c.executionId); if (c.executionId === f.c.executionId) throw Object.assign(new Error('unknown'), { code: 'SKILL_RESULT_UNKNOWN' }) }
  await partial(lane.poll(), 'SKILL_RESULT_UNKNOWN', 1)
  visited.length = 0; assert.deepEqual(await lane.poll(), { status: 'PROGRESSED', processed: 1, deferred: 1, executionErrors: [] }); assert.deepEqual(visited, ['pwe_2'])
  for (let i = 0; i < 12; i++) {
    const retry = lane.unknownRetries.get(f.c.executionId)
    assert.ok(retry.nextAt - now >= 12000 && retry.nextAt - now <= 300000)
    now = retry.nextAt; await partial(lane.poll(), 'SKILL_RESULT_UNKNOWN', 1)
  }
})
test('reconstructing a lane preserves native UNKNOWN despite resetting scheduling delay', async t => {
  const f = fixture(t); f.effects.set('native-model', { status: 'START_RECORDED' })
  await partial(f.lane.poll(), 'SKILL_RESULT_UNKNOWN')
  await partial(new SkillConversationLane(f.options).poll(), 'SKILL_RESULT_UNKNOWN')
  assert.equal(f.modelCalls(), 0)
})
test('changed recoverable failure starts its own backoff and remains explicitly reported', async t => {
  const f = fixture(t); let now = 0, code = 'SKILL_RESULT_UNKNOWN'
  const lane = new SkillConversationLane({ ...f.options, now: () => now, random: () => 1 })
  lane.process = async () => { throw Object.assign(new Error(code), { code }) }
  await partial(lane.poll(), 'SKILL_RESULT_UNKNOWN')
  now = 15000; code = 'SKILL_TRANSPORT_UNKNOWN'
  await partial(lane.poll(), 'SKILL_TRANSPORT_UNKNOWN')
  assert.equal(lane.unknownRetries.get(f.c.executionId).nextAt, 30000)
  assert.equal(lane.unknownRetries.get(f.c.executionId).code, 'SKILL_TRANSPORT_UNKNOWN')
})


test('busy and empty polls report scheduling status without executing work', async t => {
  const f = fixture(t)
  f.lane.active = true
  assert.deepEqual(await f.lane.poll(), { status: 'BUSY', processed: 0, deferred: 0, executionErrors: [] })
  f.lane.active = false
  f.emptyInbox()
  assert.deepEqual(await f.lane.poll(), { status: 'IDLE', processed: 0, deferred: 0, executionErrors: [] })
  assert.equal(f.modelCalls(), 0)
})


test('late legacy inbox commands are rejected without executing them or starving current work', async t => {
  const f = fixture(t); const visited = []
  const legacy = { ...wireCommand(f.c), executionId: 'old_execution', executionProtocolVersion: 4 }
  f.lane.fetch = async url => response(url, { items: [legacy, wireCommand(f.c)] })
  f.lane.process = async c => { visited.push(c.executionId) }
  await partial(f.lane.poll(), 'SKILL_COMMAND_INVALID', 1, 'old_execution')
  assert.deepEqual(visited, [f.c.executionId])
  assert.equal(f.modelCalls(), 0)
})

for (const code of ['NATIVE_EXECUTION_TURN_FAILED', 'NATIVE_EXECUTION_TURN_INTERRUPTED']) {
  test(`confirmed ${code} reports a fenced failure without committing or replaying the model`, async t => {
    const f = fixture(t); let runs = 0, reports = 0, cleaned = 0
    const options = { ...f.options, runNative: async () => { runs++; throw Object.assign(new Error('confirmed engine terminal'), { code }) },
      onFailed: async (_command, receipt) => { cleaned++; assert.equal(receipt.state, 'FAILED') },
      fetchFn: async (url, opts) => {
        if (!url.pathname.endsWith('/failure')) return f.options.fetchFn(url, opts)
        reports++; const body = JSON.parse(opts.body)
        assert.equal(body.code, code); assert.equal(body.fence.version, '9007199254740993')
        return response(url, { executionId: f.c.executionId, taskId: f.c.taskId, runId: f.c.runId, targetAgentId: 'agent', state: 'FAILED', failureCode: 'AGENT_DELIVERY_FAILED' })
      } }
    const lane = new SkillConversationLane(options)
    assert.equal((await lane.poll()).status, 'PROGRESSED')
    assert.deepEqual(lane.pendingCommands(), [])
    await new SkillConversationLane(options).poll()
    assert.equal(runs, 1); assert.equal(reports, 1); assert.equal(cleaned, 1)
    assert.equal(f.calls.some(path => path.includes('/result-commits/')), false)
  })
}

test('unreported terminal resumes its authorized lease and reports only the original fact', async t => {
  const f = fixture(t); let runs = 0; const sent = []
  const options = { ...f.options, runNative: async () => { runs++; throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_FAILED' }) },
    fetchFn: async (url, opts) => {
      if (!url.pathname.endsWith('/failure')) return f.options.fetchFn(url, opts)
      sent.push(JSON.parse(opts.body))
      if (sent.length === 1) throw new Error('reply lost after commit')
      return response(url, { executionId: f.c.executionId, taskId: f.c.taskId, runId: f.c.runId, targetAgentId: 'agent', state: 'FAILED', failureCode: 'AGENT_DELIVERY_FAILED' })
    } }
  await partial(new SkillConversationLane(options).poll(), 'SKILL_TRANSPORT_UNKNOWN')
  await new SkillConversationLane(options).poll()
  assert.equal(runs, 1); assert.deepEqual(sent[0], sent[1])
  assert.equal(f.calls.filter(path => path.endsWith('/lease')).length, 1)
  assert.equal(f.calls.filter(path => path.endsWith('/resume')).length, 1)
})

test('known engine failure with server unresolved effects stays UNKNOWN and never re-enters the model', async t => {
  const f = fixture(t); let runs = 0
  const options = { ...f.options, runNative: async () => { runs++; throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_FAILED' }) },
    fetchFn: async (url, opts) => url.pathname.endsWith('/failure')
      ? response(url, { executionId: f.c.executionId, taskId: f.c.taskId, runId: f.c.runId, targetAgentId: 'agent', state: 'QUEUED', failureCode: null })
      : f.options.fetchFn(url, opts) }
  await partial(new SkillConversationLane(options).poll(), 'SKILL_RESULT_UNKNOWN')
  await partial(new SkillConversationLane(options).poll(), 'SKILL_RESULT_UNKNOWN')
  assert.equal(runs, 1)
})

test('unknown engine or RPC outcomes never become a failure report', async t => {
  for (const code of ['SKILL_RESULT_UNKNOWN', 'NATIVE_EXECUTION_ENGINE_UNAVAILABLE']) {
    const f = fixture(t)
    const options = { ...f.options, runNative: async () => { throw Object.assign(new Error('uncertain'), { code }) },
      fetchFn: async (url, opts) => { assert.equal(url.pathname.endsWith('/failure'), false); return f.options.fetchFn(url, opts) } }
    await partial(new SkillConversationLane(options).poll(), code)
  }
})

test('failure receipt must match the execution and agent before cleanup or terminal persistence', async t => {
  const f = fixture(t); let cleaned = false
  const lane = new SkillConversationLane({ ...f.options,
    runNative: async () => { throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_FAILED' }) },
    onFailed: async () => { cleaned = true },
    fetchFn: async (url, opts) => url.pathname.endsWith('/failure')
      ? response(url, { executionId: 'foreign', taskId: f.c.taskId, runId: f.c.runId, targetAgentId: 'agent', state: 'FAILED', failureCode: 'AGENT_DELIVERY_FAILED' })
      : f.options.fetchFn(url, opts) })
  await partial(lane.poll(), 'SKILL_FAILURE_UNCONFIRMED')
  assert.equal(cleaned, false); assert.equal(lane.pendingCommands().length, 1)
})

for (const turnFailureCode of ['NATIVE_EXECUTION_TURN_FAILED', null]) {
  test(`new runtime confirms lost failure response with null lease and ${turnFailureCode ?? 'unknown cause'}`, async t => {
    const f = fixture(t); let runs = 0, reports = 0, resumed = 0, cleaned = 0
    const options = { ...f.options,
      runNative: async () => { runs++; throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_FAILED' }) },
      onFailed: async (_command, receipt) => { cleaned++; assert.equal(receipt.engineCode, turnFailureCode); assert.equal(receipt.failureCode, null) },
      fetchFn: async (url, opts) => {
        if (url.pathname.endsWith('/failure')) { reports++; throw new Error('reply lost') }
        if (url.pathname.endsWith('/resume')) {
          resumed++; assert.equal(opts.headers['X-Agent-Runtime-Id'], 'runtime-new')
          assert.deepEqual(JSON.parse(opts.body), { executionId: f.c.executionId, snapshotSha256: f.c.snapshotDigest })
          return response(url, { phase: 'FAILED', lease: null, resultManifest: null, allowedWork: [], effects: {}, turnFailureCode })
        }
        return f.options.fetchFn(url, opts)
      } }
    await partial(new SkillConversationLane(options).poll(), 'SKILL_TRANSPORT_UNKNOWN')
    const lane = new SkillConversationLane({ ...options, runtimeInstanceId: 'runtime-new', getRuntimeHeaders: () => ({ ...headers(), 'X-Agent-Runtime-Id': 'runtime-new' }) })
    assert.equal((await lane.poll()).status, 'PROGRESSED')
    assert.equal(runs, 1); assert.equal(reports, 1); assert.equal(resumed, 1); assert.equal(cleaned, 1)
    assert.equal(f.calls.filter(path => path.endsWith('/lease')).length, 1)
    assert.deepEqual(lane.pendingCommands(), [])
  })
}

test('expired old lease is replaced before reporting persisted engine terminal without model replay', async t => {
  const f = fixture(t); let runs = 0; const reports = []
  const nextFence = { version: '9007199254740994', token: '00000000-0000-0000-0000-000000000002' }
  const options = { ...f.options,
    runNative: async () => { runs++; throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_INTERRUPTED' }) },
    fetchFn: async (url, opts) => {
      if (url.pathname.endsWith('/resume')) return response(url, { phase: 'RUNNING', allowedWork: ['EXECUTE'], resultManifest: null,
        turnFailureCode: null, lease: { executionId: f.c.executionId, ...nextFence, expiresAt: Date.now() + 600000 } })
      if (url.pathname.endsWith('/failure')) {
        reports.push(JSON.parse(opts.body))
        if (reports.length === 1) throw new Error('connection lost before server received fact')
        assert.deepEqual(reports[1], { fence: nextFence, code: 'NATIVE_EXECUTION_TURN_INTERRUPTED' })
        return response(url, { executionId: f.c.executionId, taskId: f.c.taskId, runId: f.c.runId, targetAgentId: 'agent', state: 'FAILED', failureCode: 'AGENT_DELIVERY_FAILED' })
      }
      return f.options.fetchFn(url, opts)
    } }
  await partial(new SkillConversationLane(options).poll(), 'SKILL_TRANSPORT_UNKNOWN')
  assert.equal((await new SkillConversationLane(options).poll()).status, 'PROGRESSED')
  assert.equal(runs, 1); assert.equal(reports.length, 2)
})

for (const [resume, expected] of [
  [{ phase: 'FAILED', lease: null, allowedWork: [], turnFailureCode: 'NATIVE_EXECUTION_TURN_INTERRUPTED' }, 'SKILL_ENGINE_TERMINAL_INVALID'],
  [{ phase: 'FAILED', lease: null, allowedWork: [], turnFailureCode: 'MADE_UP' }, 'SKILL_RESUME_INVALID'],
  [{ phase: 'RUNNING', lease: null, allowedWork: ['EXECUTE'], turnFailureCode: null }, 'SKILL_LEASE_UNCERTAIN']
]) {
  test(`terminal recovery rejects ${expected} without acquiring a fresh claim`, async t => {
    const f = fixture(t); let runs = 0, reports = 0, cleaned = 0
    const options = { ...f.options,
      runNative: async () => { runs++; throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_FAILED' }) },
      onFailed: async () => { cleaned++ },
      fetchFn: async (url, opts) => {
        if (url.pathname.endsWith('/failure')) { reports++; throw new Error('reply lost') }
        if (url.pathname.endsWith('/resume')) return response(url, { resultManifest: null, effects: {}, ...resume })
        return f.options.fetchFn(url, opts)
      } }
    await partial(new SkillConversationLane(options).poll(), 'SKILL_TRANSPORT_UNKNOWN')
    await partial(new SkillConversationLane(options).poll(), expected)
    assert.equal(runs, 1); assert.equal(reports, 1); assert.equal(cleaned, 0)
    assert.equal(f.calls.filter(path => path.endsWith('/lease')).length, 1)
  })
}

test('authoritative unresolved terminal remains UNKNOWN under renewed fence without input or model access', async t => {
  const f = fixture(t); let runs = 0, reports = 0
  const options = { ...f.options,
    runNative: async () => { runs++; throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_FAILED' }) },
    fetchFn: async (url, opts) => {
      if (url.pathname.endsWith('/resume')) return response(url, { phase: 'RESULT_UNKNOWN', allowedWork: ['QUERY_EFFECT'], resultManifest: null,
        turnFailureCode: 'NATIVE_EXECUTION_TURN_FAILED', effects: {}, lease: { executionId: f.c.executionId,
          version: '9007199254740994', token: '00000000-0000-0000-0000-000000000002', expiresAt: Date.now() + 600000 } })
      if (url.pathname.endsWith('/failure')) { reports++; return response(url, { executionId: f.c.executionId, taskId: f.c.taskId,
        runId: f.c.runId, targetAgentId: 'agent', state: 'QUEUED', failureCode: null }) }
      return f.options.fetchFn(url, opts)
    } }
  await partial(new SkillConversationLane(options).poll(), 'SKILL_RESULT_UNKNOWN')
  await partial(new SkillConversationLane(options).poll(), 'SKILL_RESULT_UNKNOWN')
  assert.equal(runs, 1); assert.equal(reports, 2)
  assert.equal(f.calls.filter(path => path.endsWith('/inputs')).length, 1)
})

test('server FAILED resume is authoritative even without a local engine-failure checkpoint', async t => {
  const f = fixture(t); let cleaned = 0
  const store = new SkillExecutionStore({ rootDirectory: resolve(f.options.rootDir, 'skill-runs'), scope: { ...scope, apiOrigin: f.options.apiOrigin }, command: f.c })
  store.write('attempt', { schemaVersion: 1, executionId: f.c.executionId })
  const lane = new SkillConversationLane({ ...f.options,
    onFailed: async () => { cleaned++ },
    fetchFn: async (url, opts) => url.pathname.endsWith('/resume')
      ? response(url, { phase: 'FAILED', lease: null, resultManifest: null, allowedWork: [], effects: {}, turnFailureCode: null })
      : f.options.fetchFn(url, opts) })
  assert.equal((await lane.poll()).status, 'PROGRESSED')
  assert.equal(f.modelCalls(), 0); assert.equal(cleaned, 1)
  assert.equal(f.calls.some(path => /\/(lease|inputs|failure)$/.test(path)), false)
  assert.deepEqual(lane.pendingCommands(), [])
})

test('unavailable skill configuration is scoped to its execution and does not block unrelated inbox work', async t => {
  const f = fixture(t), seen = [], second = { ...command(), executionId: 'pwe_2', runId: 'run_2' }
  f.lane.fetch = async url => response(url, { items: [wireCommand(f.c), wireCommand(second)] })
  f.lane.process = async command => {
    seen.push(command.executionId)
    if (command.executionId === f.c.executionId) throw Object.assign(new Error('NATIVE_SKILL_CONFIG_UNAVAILABLE'), { code: 'NATIVE_SKILL_CONFIG_UNAVAILABLE' })
  }
  await partial(f.lane.poll(), 'NATIVE_SKILL_CONFIG_UNAVAILABLE', 1)
  assert.deepEqual(seen, ['pwe_1', 'pwe_2'])
})

for (const displayName of ['plan.txt', '读书会安排.txt', undefined]) {
  test(`native upload preserves display name across stage recovery: ${displayName || 'legacy fallback'}`, async t => {
    const f = fixture(t, displayName); f.c.outputs.artifactsRequired = true; f.loseStage()
    await partial(f.lane.poll(), 'SKILL_TRANSPORT_UNKNOWN')
    await new SkillConversationLane(f.options).poll()
    assert.deepEqual(f.uploadedNames, [displayName || 'output_1', displayName || 'output_1'])
    assert.equal(f.modelCalls(), 1)
    assert.equal(f.serverManifest().artifacts[0].outputId, 'output_1')
  })
}

test('discovery retains only unresolved IDs and rescans history only on reset', async t => {
  const f = fixture(t)
  await f.lane.poll(); f.emptyInbox()
  assert.deepEqual(f.lane.pendingCommands(), [])
  assert.equal(f.lane.pendingExecutionIds.size, 0)
  const historical = { ...command(), executionId: 'history_1' }
  const store = new SkillExecutionStore({ rootDirectory: f.lane.root, scope: { ...scope, apiOrigin: f.lane.origin }, command: historical })
  const legacy = { ...historical, executionProtocolVersion: 4 }
  writeFileSync(store.path('command'), JSON.stringify(legacy))
  // A newly discovered historical file is not a live inbox or an execution signal.
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(f.lane.pendingCommands(), [])
    assert.deepEqual(f.lane.pendingCommandErrors, [])
  }
  f.lane.resetPendingDiscovery()
  assert.deepEqual(f.lane.pendingCommands(), [])
  assert.equal(f.lane.pendingCommandErrors[0].error.code, 'SKILL_COMMAND_INVALID')
  assert.equal(f.lane.pendingExecutionIds.size, 0)
  assert.deepEqual(f.lane.pendingCommands(), [])
  assert.deepEqual(f.lane.pendingCommandErrors, [])
  assert.equal(f.modelCalls(), 1)
})

test('new inbox work enters an initialized index and resumes uncertainty with an empty inbox', async t => {
  const f = fixture(t); f.c.outputs.artifactsRequired = true
  assert.deepEqual(f.lane.pendingCommands(), [])
  f.loseStage(); await partial(f.lane.poll(), 'SKILL_TRANSPORT_UNKNOWN')
  assert.deepEqual([...f.lane.pendingExecutionIds], [f.c.executionId])
  f.emptyInbox(); assert.equal((await f.lane.poll()).status, 'DEFERRED')
  f.lane.now = () => f.lane.unknownRetries.get(f.c.executionId)?.nextAt ?? Date.now()
  await f.lane.poll()
  assert.equal(f.modelCalls(), 1)
  assert.deepEqual(f.lane.pendingCommands(), [])
  assert.equal(f.lane.pendingExecutionIds.size, 0)
})

test('pending index never caches commands and an unsafe scan cannot publish a partial replacement', async t => {
  const f = fixture(t); f.effects.set('native-model', { status: 'START_RECORDED' })
  await partial(f.lane.poll(), 'SKILL_RESULT_UNKNOWN')
  const store = new SkillExecutionStore({ rootDirectory: f.lane.root, scope: { ...scope, apiOrigin: f.lane.origin }, command: f.c })
  const original = readFileSync(store.path('command'))
  writeFileSync(store.path('command'), JSON.stringify({ ...f.c, executionId: 'different' }))
  assert.throws(() => f.lane.pendingCommands(), /SKILL_STORE_IDENTITY_CONFLICT/)
  assert.deepEqual([...f.lane.pendingExecutionIds], [f.c.executionId])
  writeFileSync(store.path('command'), original)
  assert.equal(f.lane.pendingCommands().length, 1)
  f.emptyInbox()
  const report = await f.lane.poll()
  assert.equal(report.status, 'DEFERRED')
  assert.equal(f.modelCalls(), 0)
})

test('notification mode recovers local uncertainty at its due time without discovering the inbox', async t => {
  const f = fixture(t); f.c.outputs.artifactsRequired = true; f.loseStage()
  await partial(f.lane.poll(), 'SKILL_TRANSPORT_UNKNOWN')
  const inboxCalls = f.calls.filter(path => path.endsWith('/commands')).length
  assert.ok(Number.isFinite(f.lane.nextRecoveryAt()))
  assert.equal((await f.lane.poll({ discover: false })).status, 'DEFERRED')
  const due = f.lane.nextRecoveryAt(); f.lane.now = () => due
  await f.lane.poll({ discover: false })
  assert.equal(f.calls.filter(path => path.endsWith('/commands')).length, inboxCalls)
  assert.equal(f.modelCalls(), 1); assert.equal(f.lane.nextRecoveryAt(), Infinity)
})


test('authority 404 and incompatible retained environment do not cause 3-second heavy recovery or replay', async t => {
  for (const code of ['SKILL_API_RESPONSE_UNCONFIRMED','NATIVE_EXECUTION_RECOVERY_ENVIRONMENT_CHANGED','TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT']) {
    const f=fixture(t);let now=0,calls=0;
    const lane=new SkillConversationLane({...f.options,now:()=>now,random:()=>1});
    lane.process=async()=>{calls++;throw Object.assign(new Error(code),{code});};
    await partial(lane.poll(),code);
    for(now=3000;now<15000;now+=3000)assert.equal((await lane.poll()).deferred,1);
    assert.equal(calls,1);assert.equal(f.modelCalls(),0);
    now=15000;await partial(lane.poll(),code);assert.equal(calls,2);
  }
});

test('unconfirmed HTTP response cancels its body, records status and preserves pending recovery', async t => {
  const f=fixture(t);let cancelled=0
  f.lane.fetch=async(url,opts)=>url.pathname.endsWith('/commands')?f.options.fetchFn(url,opts):
    {status:404,url:url.href,body:{cancel:async()=>{cancelled++}}}
  const report=await f.lane.poll()
  assert.equal(report.executionErrors[0].httpStatus,404);assert.equal(cancelled,1)
  assert.equal(f.modelCalls(),0);assert.deepEqual([...f.lane.pendingExecutionIds],[f.c.executionId])
  assert.equal((await f.lane.poll({discover:false})).status,'DEFERRED');assert.equal(cancelled,1)
})

test('business failure recovery does not copy source-owned usage or replay the native turn', async t => {
  const f = fixture(t); let runs = 0; let reports = 0
  const usageEvidence = { source: 'codex-app-server/thread/tokenUsage/updated', status: 'UNVERIFIED', threadId: 'thread', turnId: 'turn', tokenUsage: { last: { inputTokens: 12 }, total: { inputTokens: 100 } } }
  const nextFence = { version: '9007199254740994', token: '00000000-0000-0000-0000-000000000002' }
  const options = { ...f.options,
    runNative: async () => { runs++; throw Object.assign(new Error('failed'), { code: 'NATIVE_EXECUTION_TURN_FAILED', usageEvidence }) },
    fetchFn: async (url, opts) => {
      if (url.pathname.endsWith('/resume')) return response(url, { phase: 'RESULT_UNKNOWN', allowedWork: ['QUERY_EFFECT'], resultManifest: null,
        turnFailureCode: 'NATIVE_EXECUTION_TURN_FAILED', lease: { executionId: f.c.executionId, ...nextFence, expiresAt: Date.now() + 600000 } })
      if (url.pathname.endsWith('/failure')) {
        reports++; const body = JSON.parse(opts.body)
        assert.deepEqual(Object.keys(body).sort(), ['code', 'fence'])
        if (reports === 1) throw new Error('lost transport response')
        assert.deepEqual(body.fence, nextFence)
        return response(url, { executionId: f.c.executionId, taskId: f.c.taskId, runId: f.c.runId, targetAgentId: 'agent', state: 'FAILED', failureCode: 'AGENT_DELIVERY_FAILED' })
      }
      return f.options.fetchFn(url, opts)
    } }
  const checkpoint = resolve(f.options.rootDir, 'skill-runs', skillDigest({ ...scope, apiOrigin: 'https://api.example.test' }), f.c.executionId, 'engine-failure.json')
  await partial(new SkillConversationLane(options).poll(), 'SKILL_TRANSPORT_UNKNOWN')
  assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).usageEvidence, undefined)
  assert.equal((await new SkillConversationLane(options).poll()).status, 'PROGRESSED')
  const saved = JSON.parse(readFileSync(checkpoint, 'utf8'))
  assert.equal(saved.usageEvidence, undefined); assert.deepEqual(saved.fence, nextFence)
  assert.equal(runs, 1); assert.equal(reports, 2)
})

test('completed business receipt does not hide pending cost evidence; lost ack retries only costs after restart', async t => {
  const f = fixture(t)
  await f.lane.poll(); f.emptyInbox()
  const store = new SkillExecutionStore({ rootDirectory: resolve(f.options.rootDir, 'skill-runs'),
    scope: { ...scope, apiOrigin: f.options.apiOrigin }, command: f.c })
  store.write('native-start-attempt', { requestedModel: 'requested-only' })
  store.write('native-final-message', { requestedModel: 'requested-only', usageEvidence: { status: 'UNVERIFIED', tokenUsage: { last: { inputTokens: 5 } } } })
  let calls = 0, now = 1000
  const payloads = []
  const options = { ...f.options, now: () => now, random: () => 1, fetchFn: async (url, opts) => {
    if (!url.pathname.endsWith('/usage')) return f.options.fetchFn(url, opts)
    assert.equal(skillConversationHttpScope(url, opts), true)
    calls++; payloads.push(JSON.parse(opts.body))
    if (calls === 1) throw new Error('cost ack lost after durable server acceptance')
    return response(url, { executionId: f.c.executionId, attemptId: 'b'.repeat(64), revision: JSON.parse(opts.body).phase === 'STARTED' ? '1' : '2', status: 'PENDING_USAGE', costYuan: null })
  } }
  const first = new SkillConversationLane(options)
  const result = await first.poll()
  assert.equal(result.status, 'IDLE'); assert.equal(result.executionErrors.length, 0)
  assert.equal(result.usageErrors[0].code, 'SKILL_TRANSPORT_UNKNOWN')
  assert.equal(store.read('native-usage-receipt'), null)
  assert.equal(first.nextRecoveryAt(), now + 15000)
  await first.poll({ discover: false }); assert.equal(calls, 1)
  const restarted = new SkillConversationLane(options)
  await restarted.poll({ discover: false })
  assert.deepEqual(payloads[0], payloads[1])
  assert.equal(store.read('native-usage-start-receipt').status, 'PENDING_USAGE')
  assert.equal(store.read('native-usage-receipt'), null)
  await restarted.poll({ discover: false })
  assert.equal(store.read('native-usage-receipt').status, 'PENDING_USAGE')
  assert.equal(f.modelCalls(), 1)
  assert.equal(restarted.nextRecoveryAt(), Infinity)
})

test('cost route is native POST-only and rejects query or encoded path aliases', () => {
  const url = new URL('https://api.example.test/internal/agent/tasks/task/runs/run/conversation/usage')
  assert.equal(skillConversationHttpScope(url, { method: 'POST' }), true)
  assert.equal(skillConversationHttpScope(url, { method: 'GET' }), false)
  url.search = '?owner=other'; assert.equal(skillConversationHttpScope(url, { method: 'POST' }), false)
})


test('provider child calls use authenticated cost route and survive ACK loss without another model turn', async t => {
  const f=fixture(t);await f.lane.poll()
  const store=new SkillExecutionStore({rootDirectory:resolve(f.options.rootDir,'skill-runs'),scope:{...scope,apiOrigin:'https://api.example.test'},command:f.c})
  const call=beginProviderUsage({directory:resolve(store.directory,'scratch/.provider-usage'),config:{model:'gpt-image-2.5-flare',usageChannel:'gpt',usageTier:'standard',usagePriceVersion:'v1'},mode:'generate'})
  call.complete({usage:{input_tokens:1,output_tokens:2},responseModel:null,providerRequestId:'request'})
  let calls=0;const payloads=[]
  const options={...f.options,fetchFn:async(url,opts)=>{
    if(!url.pathname.endsWith('/provider-usage')) return f.options.fetchFn(url,opts)
    assert.equal(skillConversationHttpScope(url,opts),true)
    const payload=JSON.parse(opts.body);payloads.push(payload);calls++
    if(calls===1)throw Error('ACK lost')
    return response(url,{executionId:f.c.executionId,attemptId:'c'.repeat(64),revision:payload.observation.phase==='STARTED'?'1':'2',status:'PENDING_USAGE',costYuan:null})
  }}
  const first=new SkillConversationLane(options);await first.poll({discover:false})
  const restarted=new SkillConversationLane(options);await restarted.poll({discover:false});await restarted.poll({discover:false})
  assert.equal(calls,3);assert.deepEqual(payloads[0],payloads[1]);assert.equal(payloads[2].observation.phase,'TERMINAL');assert.equal(f.modelCalls(),1)
  assert.equal(restarted.nextRecoveryAt(),Infinity)
})
for(const path of ['usage','provider-usage']) test(`cost ${path} route permits only native POST without aliases`,()=>{
 const url=new URL(`https://api.example.test/internal/agent/tasks/task/runs/run/conversation/${path}`)
 assert.equal(skillConversationHttpScope(url,{method:'POST'}),true)
 assert.equal(skillConversationHttpScope(url,{method:'GET'}),false)
 url.search='?owner=another';assert.equal(skillConversationHttpScope(url,{method:'POST'}),false)
})

// Handover uses source-only delivery, not a live lane with a fake registry/runner.
for (const terminal of [false, true]) test(`stopped source-only flush preserves original owner and unknown usage (terminal=${terminal})`, async t => {
  const { SkillUsageDelivery } = await import('../skill-usage-delivery.mjs')
  const f = fixture(t), calls = []
  const store = new SkillExecutionStore({ rootDirectory: f.lane.root, scope: { ...scope, apiOrigin: f.lane.origin }, command: f.c })
  store.write('native-start-attempt', { requestedModel: 'requested-only' })
  if (terminal) store.write('native-final-message', { usageEvidence: { tokenUsage: { last: { inputTokens: 123 } } } })
  store.write('receipt', { state: 'RESULT_COMMITTED' })
  const provider = beginProviderUsage({ directory: resolve(store.directory, 'scratch/.provider-usage'), config: { model: 'image-fixture', usageChannel: 'gpt', usageTier: 'standard', usagePriceVersion: 'fixture' }, mode: 'generate' })
  if (terminal) provider.complete({ usage: { output_tokens: 9 } })
  const { registry, runners, runNative, ...options } = f.options
  const delivery = new SkillUsageDelivery({ ...options, fetchFn: async (url, opts) => {
    assert.match(url.pathname, /^\/internal\/agent\/tasks\/task\/runs\/run\/conversation\/(usage|provider-usage)$/)
    assert.equal(opts.method, 'POST')
    const payload = JSON.parse(opts.body); calls.push(payload)
    return response(url, { executionId: f.c.executionId, attemptId: 'b'.repeat(64), revision: (payload.phase || payload.observation.phase) === 'STARTED' ? '1' : '2', status: 'PENDING_USAGE', costYuan: null })
  } })
  assert.equal(delivery.poll, undefined); assert.equal(delivery.process, undefined)
  assert.deepEqual(await delivery.flush(), { confirmed: true, pending: 0, errors: [] })
  assert.equal(calls.length, terminal ? 4 : 2)
  assert.equal(store.read('native-usage-start-receipt').costYuan, null)
  assert.equal(f.modelCalls(), 0)
  if (terminal) assert.equal(calls.find(c => c.phase === 'TERMINAL').usageEvidence.tokenUsage.last.inputTokens, 123)
  const before = calls.length
  assert.equal((await new SkillUsageDelivery({ ...options, fetchFn: delivery.fetch }).flush()).confirmed, true)
  assert.equal(calls.length, before)
  // Another owner's source partition is never traversed or sent under this session.
  const other = new SkillExecutionStore({ rootDirectory: f.lane.root, scope: { ...scope, ownerJiacn: 'other', apiOrigin: f.lane.origin }, command: f.c })
  other.write('native-start-attempt', { requestedModel: 'other-private-model' })
  assert.equal((await delivery.flush()).confirmed, true)
  assert.equal(other.read('native-usage-start-receipt'), null)
  assert.equal(calls.length, before)
})

test('stopped flush lost reply stays pending; reconstruction only replays exact cost source', async t => {
  const { SkillUsageDelivery } = await import('../skill-usage-delivery.mjs')
  const f = fixture(t), calls = []
  const store = new SkillExecutionStore({ rootDirectory: f.lane.root, scope: { ...scope, apiOrigin: f.lane.origin }, command: f.c })
  store.write('native-start-attempt', { requestedModel: 'requested' })
  let lost = true
  const options = { ...f.options, fetchFn: async (url, opts) => {
    assert.ok(url.pathname.endsWith('/usage')); calls.push(JSON.parse(opts.body))
    if (lost) throw new Error('lost ACK')
    return response(url, { executionId: f.c.executionId, attemptId: 'a'.repeat(64), revision: '1', status: 'PENDING_PRICE', costYuan: null })
  } }
  const delivery = new SkillUsageDelivery(options)
  assert.equal((await delivery.flush()).confirmed, false)
  assert.equal((await delivery.flush()).confirmed, false)
  assert.equal(calls.length, 1) // Existing retry timing is not bypassed by flush.
  assert.equal(store.read('native-usage-start-receipt'), null)
  lost = false
  assert.equal((await new SkillUsageDelivery(options).flush()).confirmed, true)
  assert.deepEqual(calls[1], calls[0]); assert.equal(f.modelCalls(), 0)
})

test('stopped flush cannot confirm unreadable historical commands or inconsistent cost evidence', async t => {
  const { SkillUsageDelivery } = await import('../skill-usage-delivery.mjs')
  const f = fixture(t)
  const store = new SkillExecutionStore({ rootDirectory: f.lane.root, scope: { ...scope, apiOrigin: f.lane.origin }, command: f.c })
  const delivery = new SkillUsageDelivery(f.options)
  writeFileSync(store.path('command'), JSON.stringify({ ...f.c, executionProtocolVersion: 4 }))
  for (let i = 0; i < 2; i++) {
    const result = await delivery.flush()
    assert.equal(result.confirmed, false); assert.equal(result.errors[0].code, 'SKILL_COMMAND_INVALID')
  }
  writeFileSync(store.path('command'), JSON.stringify(f.c))
  store.write('native-final-message', { usageEvidence: null })
  const result = await delivery.flush()
  assert.equal(result.confirmed, false); assert.equal(result.errors[0].code, 'NATIVE_USAGE_SOURCE_MISSING')
  assert.equal(f.modelCalls(), 0)
})
