import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SkillConversationLane, parseSkillInputSnapshot } from '../skill-conversation.mjs'
import { skillDigest, skillHash } from '../skill-executor.mjs'
import { skillConversationHttpScope } from '../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
const scope = { tenantId: 'tenant', clientId: 'client', ownerJiacn: 'owner', agentId: 'agent' }
const command = () => ({ executionProtocolVersion: 4, executionId: 'pwe_1', taskId: 'task', runId: 'run', conversationId: 'conversation', conversationGeneration: '1', commandId: 'cmd', messageId: 'msg',
  skill: { key: 'analysis', version: '1.0.0', packageSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) },
  snapshotDigest: 'c'.repeat(64), parameters: {}, instruction: '分析资料', inputRefs: [], outputs: { dataSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: false } })
const headers = () => ({ Authorization: `AgentRuntime rts1_${'0'.repeat(64)}`, 'X-Agent-Id': 'agent', 'X-Agent-Installation-Id': 'installation', 'X-Agent-Host-Id': 'host', 'X-Agent-Runtime-Id': 'runtime', 'X-Agent-Session-Generation': '1' })
const response = (url, value, status = 200, headers = {}) => {
  const reply = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }); Object.defineProperty(reply, 'url', { value: url.href }); return reply
}
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'skill-lane-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const c = command(), calls = [], effects = new Map(); let modelCalls = 0, serverManifest = null, loseCommit = false, loseStage = false, inboxEmpty = false, corruptDigest = false
  const descriptor = { manifest: { runner: 'native-model', parametersSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false }, inputs: { minItems: 0, maxItems: 32, acceptedMimeTypes: ['text/plain'] }, outputs: c.outputs } }
  const lease = () => ({ executionId: c.executionId, version: 1, token: '00000000-0000-0000-0000-000000000001', expiresAt: Date.now() + 600000 })
  const runner = { run: async ({ effects }) => {
    const result = await effects.invoke('native-model', { instruction: c.instruction }, async () => { modelCalls++; return { data: { summary: '由模型实际返回' } } })
    return { data: result.data, artifacts: c.outputs.artifactsRequired ? [{ outputId: 'output_1', contentMimeType: 'text/plain', bytes: Buffer.from('真实正文') }] : [], inputReceipts: [] }
  } }
  const fetchFn = async (url, opts) => {
    assert.equal(opts.redirect, 'error'); assert.equal(opts.headers['X-Agent-Id'], 'agent'); assert.equal(Object.hasOwn(opts.headers, 'x-api-key'), false)
    calls.push(url.pathname); const body = opts.body instanceof FormData ? opts.body : opts.body ? JSON.parse(opts.body) : null
    if (url.pathname.endsWith('/commands')) return response(url, { items: inboxEmpty ? [] : [c] })
    if (url.pathname.endsWith('/lease') || url.pathname.endsWith('/lease/renew')) return response(url, lease())
    if (url.pathname.endsWith('/resume')) return response(url, { lease: lease(), resultManifest: serverManifest, phase: serverManifest ? 'ARCHIVING' : 'RUNNING', allowedWork: serverManifest ? ['STAGE_OUTPUTS', 'COMMIT_RESULT', 'PROJECT_RESULT'] : ['EXECUTE'] })
    if (url.pathname.endsWith('/inputs')) return response(url, { schemaVersion: 4, executionId: c.executionId, leaseVersion: 1, snapshotDigest: c.snapshotDigest, noReferencedMaterials: true, inputs: [] })
    if (url.pathname.endsWith('/start')) {
      assert.ok(body.fence.version === 1 && body.fence.token); assert.equal(body.snapshotDigest, c.snapshotDigest)
      const key = url.pathname.split('/').at(-2), prior = effects.get(key)
      if (!prior) effects.set(key, { status: 'START_RECORDED', effectDigest: body.effectDigest })
      return response(url, { schemaVersion: 1, disposition: prior ? 'RECORDED' : 'NEW', status: prior?.status || 'START_RECORDED', providerRequestId: null, resultDigest: null })
    }
    if (url.pathname.endsWith('/result')) { effects.set(url.pathname.split('/').at(-2), body); return response(url, { schemaVersion: 1, disposition: 'KNOWN', status: body.status, providerRequestId: body.providerRequestId, resultDigest: body.resultDigest }) }
    if (/\/outputs\/[^/]+\/content$/.test(url.pathname)) {
      const bytes = Buffer.from(await body.get('file').arrayBuffer()); assert.equal(body.get('sha256'), skillHash(bytes))
      if (loseStage) { loseStage = false; throw Object.assign(new Error('stage reply lost'), { code: 'ECONNRESET' }) }
      return response(url, { outputId: 'output_1', sha256: skillHash(bytes), byteLength: bytes.length, state: 'STAGED' }, 201)
    }
    if (url.pathname.includes('/result-commits/')) {
      assert.deepEqual(Object.keys(body).sort(), ['artifacts', 'data', 'fence', 'inputReceipts', 'snapshotDigest'])
      for (const artifact of body.artifacts) { assert.deepEqual(Object.keys(artifact).sort(), ['byteLength', 'outputId', 'sha256']); assert.equal(typeof artifact.byteLength, 'number') }
      const preimage = { schemaVersion: 1, data: body.data, artifacts: body.artifacts, inputReceipts: body.inputReceipts }
      serverManifest = { ...preimage, resultDigest: skillDigest(preimage), manifestId: url.pathname.split('/').at(-1) }
      if (loseCommit) { loseCommit = false; throw Object.assign(new Error('commit response lost'), { code: 'ECONNRESET' }) }
      return response(url, { manifestId: url.pathname.split('/').at(-1), state: 'RESULT_COMMITTED', phase: 'ARCHIVING', resultDigest: corruptDigest ? '0'.repeat(64) : serverManifest.resultDigest })
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
  const input = { inputRef: 'input_1', sourceKind: 'TASK_LINKED_WORKSPACE_VERSION', sourceIdentity: { fileId: 'f', version: 1, purpose: 'INPUT' }, contentMimeType: 'text/plain', byteLength: 4, sha256: 'a'.repeat(64) }
  const envelope = { schemaVersion: 4, executionId: c.executionId, leaseVersion: 1, snapshotDigest: c.snapshotDigest, noReferencedMaterials: false, inputs: [input] }
  assert.deepEqual(parseSkillInputSnapshot(envelope, c, { version: 1 })[0], { ...input, byteLength: '4' })
  for (const patch of [{ sourceKind: 'URL' }, { byteLength: Number.MAX_SAFE_INTEGER + 1 }, { byteLength: '-1' }, { sourceIdentity: null }])
    assert.throws(() => parseSkillInputSnapshot({ ...envelope, inputs: [{ ...input, ...patch }] }, c, { version: 1 }), /SNAPSHOT_INVALID/)
  assert.throws(() => parseSkillInputSnapshot({ ...envelope, noReferencedMaterials: true }, c, { version: 1 }), /SNAPSHOT_INVALID/)
})
