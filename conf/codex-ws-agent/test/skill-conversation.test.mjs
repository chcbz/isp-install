import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SkillConversationLane, parseSkillInputSnapshot, validateCommittedSkillResult, skillCommandFromWire } from '../skill-conversation.mjs'
import { skillDigest, skillHash, skillCanonicalJson } from '../skill-executor.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { skillConversationHttpScope } from '../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
const scope = { tenantId: 'tenant', clientId: 'client', ownerJiacn: 'owner', agentId: 'agent' }
const command = () => ({ executionProtocolVersion: 4, executionId: 'pwe_1', taskId: 'task', runId: 'run', conversationId: 'conversation', conversationGeneration: '1', commandId: 'cmd', messageId: 'msg',
  skill: { key: 'analysis', version: '1.0.0', packageSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) },
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
  const runner = { run: async ({ effects }) => {
    const result = await effects.invoke('native-model', { instruction: c.instruction }, async () => { modelCalls++; return { data: { summary: '由模型实际返回' } } })
    return { data: result.data, artifacts: c.outputs.artifactsRequired ? [{ outputId: 'output_1', contentMimeType: 'text/plain', bytes: Buffer.from('真实正文') }] : [], inputReceipts: [] }
  } }
  const fetchFn = async (url, opts) => {
    assert.equal(opts.redirect, 'error'); assert.equal(opts.headers['X-Agent-Id'], 'agent'); assert.equal(Object.hasOwn(opts.headers, 'x-api-key'), false)
    calls.push(url.pathname); const body = opts.body instanceof FormData ? opts.body : opts.body ? JSON.parse(opts.body) : null
    if (url.pathname.endsWith('/commands')) return response(url, { items: inboxEmpty ? [] : [wireCommand(c)] })
    if (url.pathname.endsWith('/lease') || url.pathname.endsWith('/lease/renew')) return response(url, lease())
    if (url.pathname.endsWith('/resume')) return response(url, { lease: lease(), resultManifest: serverManifest, phase: serverManifest ? 'ARCHIVING' : 'RUNNING', allowedWork: serverManifest ? ['STAGE_OUTPUTS', 'COMMIT_RESULT', 'PROJECT_RESULT'] : ['EXECUTE'] })
    if (url.pathname.endsWith('/inputs')) return response(url, { schemaVersion: 4, executionId: c.executionId, leaseVersion: '9007199254740993', snapshotSha256: c.snapshotDigest, noReferencedMaterials: true, inputs: [] })
    if (url.pathname.endsWith('/start')) {
      assert.ok(body.fence.version === '9007199254740993' && body.fence.token); assert.equal(body.snapshotSha256, c.snapshotDigest)
      const key = url.pathname.split('/').at(-2), prior = effects.get(key)
      if (!prior) effects.set(key, { status: 'START_RECORDED', effectDigest: body.effectSha256 })
      return response(url, { schemaVersion: 1, disposition: prior ? 'RECORDED' : 'NEW', status: prior?.status || 'START_RECORDED', providerRequestId: null, resultSha256: null })
    }
    if (url.pathname.endsWith('/result')) { effects.set(url.pathname.split('/').at(-2), body); return response(url, { schemaVersion: 1, disposition: 'KNOWN', status: body.status, providerRequestId: body.providerRequestId, resultSha256: body.resultSha256 }) }
    if (/\/outputs\/[^/]+\/content$/.test(url.pathname)) {
      const bytes = Buffer.from(await body.get('file').arrayBuffer()); assert.equal(body.get('sha256'), skillHash(bytes)); assert.equal(body.get('byteLength'), String(bytes.length)); assert.equal(body.has('length'), false)
      if (loseStage) { loseStage = false; throw Object.assign(new Error('stage reply lost'), { code: 'ECONNRESET' }) }
      return response(url, { outputId: 'output_1', sha256: skillHash(bytes), byteLength: String(bytes.length), state: 'STAGED' }, 201)
    }
    if (url.pathname.includes('/result-commits/')) {
      assert.deepEqual(Object.keys(body).sort(), ['artifacts', 'data', 'fence', 'inputReceipts', 'snapshotSha256'])
      for (const artifact of body.artifacts) { assert.deepEqual(Object.keys(artifact).sort(), ['byteLength', 'outputId', 'sha256']); assert.equal(typeof artifact.byteLength, 'string') }
      const preimage = { schemaVersion: 1, data: body.data, artifacts: body.artifacts.map(item => ({ ...item, byteLength: Number(item.byteLength) })), inputReceipts: body.inputReceipts }
      serverManifest = { ...preimage, resultDigest: skillDigest(preimage), manifestId: url.pathname.split('/').at(-1) }
      if (loseCommit) { loseCommit = false; throw Object.assign(new Error('commit response lost'), { code: 'ECONNRESET' }) }
      return response(url, { manifestId: url.pathname.split('/').at(-1), state: 'RESULT_COMMITTED', phase: 'ARCHIVING', resultSha256: corruptDigest ? '0'.repeat(64) : serverManifest.resultDigest })
    }
    throw new Error(`unexpected path: ${url.pathname}`)
  }
  const options = { apiOrigin: 'https://api.example.test', rootDir: root, scope, agentId: 'agent', runtimeInstanceId: 'runtime', getRuntimeHeaders: headers, fetchFn,
    registry: { requireExact: async () => ({ descriptor, binding: null }) }, runners: new Map([['native-model', runner]]) }
  return { c, calls, effects, options, lane: new SkillConversationLane(options), descriptor, modelCalls: () => modelCalls,
    loseCommit: () => { loseCommit = true }, loseStage: () => { loseStage = true }, emptyInbox: () => { inboxEmpty = true }, corruptDigest: () => { corruptDigest = true },
    serverManifest: () => serverManifest }
}
test('one protocol4 inbox gives genuine data-only commit, authenticated effects and no consent/output-commit', async t => {
  const f = fixture(t); assert.deepEqual(await f.lane.poll(), { processed: 1 }); assert.equal(f.modelCalls(), 1)
  assert.ok(f.calls.some(path => path.includes('/result-commits/'))); assert.ok(!f.calls.some(path => /consent|provider-start|output-commits/.test(path)))
  assert.equal(f.effects.get('native-model').status, 'SUCCEEDED')
})
test('lost final response reads back the identical committed result without a second write or model call', async t => {
  const f = fixture(t); f.loseCommit(); await f.lane.poll(); assert.equal(f.modelCalls(), 1)
  assert.equal(f.calls.filter(path => path.endsWith('/resume')).length, 1)
  assert.equal(f.calls.filter(path => path.includes('/result-commits/')).length, 1)
})
test('stage uncertainty resumes from saved manifest after reconstruction, same output/hash and no model repeat', async t => {
  const f = fixture(t); f.c.outputs.artifactsRequired = true; f.loseStage()
  await assert.rejects(f.lane.poll(), /SKILL_TRANSPORT_UNKNOWN/); assert.equal(f.modelCalls(), 1)
  await new SkillConversationLane(f.options).poll(); assert.equal(f.modelCalls(), 1)
  assert.equal(f.calls.filter(path => path.endsWith('/outputs/output_1/content')).length, 2)
})
test('a recorded/unknown effect can never be issued by a successor claimant', async t => {
  const f = fixture(t); f.effects.set('native-model', { status: 'START_RECORDED' })
  await assert.rejects(f.lane.poll(), /SKILL_RESULT_UNKNOWN/); assert.equal(f.modelCalls(), 0)
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
  await assert.rejects(f.lane.poll(), /SKILL_TRANSPORT_UNKNOWN/)
  f.emptyInbox(); await new SkillConversationLane(f.options).poll()
  assert.equal(f.modelCalls(), 1)
  assert.equal(f.calls.filter(path => path.endsWith('/outputs/output_1/content')).length, 2)
})
test('syntactically valid but incorrect result digest is not a commit receipt', async t => {
  const f = fixture(t); f.corruptDigest()
  await assert.rejects(f.lane.poll(), /SKILL_COMMIT_UNCONFIRMED/)
})
test('frozen §6 source kinds/identities and safe Java lengths preserve MIME/hash; absence is explicit', () => {
  const c = command(); c.inputRefs = ['input_1']
  const input = { inputRef: 'input_1', sourceKind: 'TASK_LINKED_WORKSPACE_VERSION', sourceIdentity: { fileId: 'f', version: 1, purpose: 'INPUT' }, contentMimeType: 'text/plain', byteLength: '4', sha256: 'a'.repeat(64) }
  const envelope = { schemaVersion: 4, executionId: c.executionId, leaseVersion: '9007199254740993', snapshotSha256: c.snapshotDigest, noReferencedMaterials: false, inputs: [input] }
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
  await assert.rejects(new SkillConversationLane(missing.options).poll(), /SKILL_COMMIT_UNCONFIRMED/)
  assert.equal(unsafeRelease, 0)
})

test('a pending UNKNOWN retains its error but does not starve unrelated next inbox execution', async t => {
  const first = fixture(t), second = fixture(t)
  first.effects.set('native-model', { status: 'START_RECORDED' })
  await assert.rejects(first.lane.poll(), /SKILL_RESULT_UNKNOWN/)
  second.c.executionId = 'pwe_2'; second.c.runId = 'run_2'; second.c.commandId = 'cmd_2'; second.c.messageId = 'msg_2'
  const options = { ...first.options, runners: second.options.runners, fetchFn: async (url, opts) => {
    if (url.pathname.endsWith('/commands')) return response(url, { items: [wireCommand(second.c)] })
    return (url.pathname.includes('/runs/run_2/') ? second.options : first.options).fetchFn(url, opts)
  } }
  const lane = new SkillConversationLane(options)
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(lane.poll(), error => {
      assert.equal(error.code, 'SKILL_RESULT_UNKNOWN'); assert.equal(error.processed, 1)
      assert.deepEqual(error.executionErrors, [{ executionId: first.c.executionId, code: 'SKILL_RESULT_UNKNOWN' }])
      return true
    })
  }
  assert.equal(first.modelCalls(), 0); assert.equal(second.modelCalls(), 1)
  assert.equal(second.calls.filter(path => path.includes('/result-commits/')).length, 1)
})

test('shared store or session failures immediately halt poll instead of crossing the security boundary', async t => {
  for (const code of ['SKILL_SESSION_CHANGED', 'SKILL_STORE_UNSAFE', 'SKILL_STORE_IDENTITY_CONFLICT']) {
    const f = fixture(t), calls = [], original = Object.assign(new Error(code), { code, cause: new Error('actual cause') })
    const second = { ...command(), executionId: 'pwe_2', runId: 'run_2' }
    f.lane.fetch = async url => response(url, { items: [wireCommand(f.c), wireCommand(second)] })
    f.lane.process = async command => { calls.push(command.executionId); throw original }
    await assert.rejects(f.lane.poll(), error => error === original)
    assert.deepEqual(calls, ['pwe_1']); assert.equal(f.lane.active, false)
  }
})

test('isolated poll failures preserve first original transport cause without leaking provider response data', async t => {
  const f = fixture(t), cause = Object.assign(new Error('private provider response'), { code: 'ECONNRESET' })
  const original = Object.assign(new Error('SKILL_TRANSPORT_UNKNOWN'), { code: 'SKILL_TRANSPORT_UNKNOWN', cause })
  f.lane.process = async () => { throw original }
  await assert.rejects(f.lane.poll(), error => {
    assert.equal(error, original); assert.equal(error.cause, cause); assert.equal(error.processed, 0)
    assert.deepEqual(error.executionErrors, [{ executionId: f.c.executionId, code: 'SKILL_TRANSPORT_UNKNOWN' }])
    return true
  })
})


test('server committed local-file result replays only under its frozen local-script descriptor', () => {
  const c = command(); c.inputRefs = ['input_1']
  const descriptor = { manifest: { runner: 'local-script', outputs: c.outputs } }
  const preimage = { schemaVersion: 1, data: { summary: '实际持久脚本结果' }, artifacts: [], inputReceipts: [{ inputRef: 'input_1', sha256: 'd'.repeat(64), carrier: 'local-file', delivery: 'DELIVERED' }] }
  const digest = skillDigest(preimage), manifest = { ...preimage, resultDigest: digest, manifestId: `manifest_${digest}` }
  assert.equal(validateCommittedSkillResult(manifest, c, descriptor, 'ARCHIVING').state, 'RESULT_COMMITTED')
  for (const runner of ['native-model', 'provider-operation', undefined])
    assert.throws(() => validateCommittedSkillResult(manifest, c, { manifest: { ...descriptor.manifest, runner } }, 'ARCHIVING'), /SKILL_RESULT_INPUT_RECEIPT_INVALID/)
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
    await assert.rejects(new SkillConversationLane({ ...f.options, fetchFn }).poll(), /SKILL_LEASE_UNCERTAIN/)
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
