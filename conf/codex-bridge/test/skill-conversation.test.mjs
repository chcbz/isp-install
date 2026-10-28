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
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'skill-lane-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const c = command(), calls = [], effects = new Map(); let modelCalls = 0, serverManifest = null, loseCommit = false, loseStage = false, inboxEmpty = false, corruptDigest = false
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
      artifacts.push({ outputId: 'output_1', contentMimeType: 'text/plain', sha256: skillHash(bytes), byteLength: String(bytes.length) })
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
  return { c, calls, effects, options, lane: new SkillConversationLane(options), descriptor, modelCalls: () => modelCalls,
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
test('a different recovery error clears UNKNOWN backoff and is not silently swallowed', async t => {
  const f = fixture(t); let now = 0, code = 'SKILL_RESULT_UNKNOWN'
  const lane = new SkillConversationLane({ ...f.options, now: () => now, random: () => 1 })
  lane.process = async () => { throw Object.assign(new Error(code), { code }) }
  await partial(lane.poll(), 'SKILL_RESULT_UNKNOWN')
  now = 15000; code = 'SKILL_TRANSPORT_UNKNOWN'
  await partial(lane.poll(), 'SKILL_TRANSPORT_UNKNOWN')
  assert.equal(lane.unknownRetries.size, 0)
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
