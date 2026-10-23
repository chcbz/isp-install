import test from 'node:test'
import assert from 'node:assert/strict'
import { executeSkill, parseSkillCommand } from '../skill-executor.mjs'
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }
const command = () => ({ executionProtocolVersion: 4, executionId: 'pwe_1', taskId: 't1', runId: 'r1', conversationId: 'c1', conversationGeneration: '1',
  taskSkillBinding: { executionId: 'pwe_1', taskGrantId: 'grant_1', taskGrantVersion: '1', agentId: 'agent', skillKey: 'text-file', skillInstallationId: 'si_a', productVersionId: 'spv_a', skillVersion: '1.0.0', packageSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), approvedPermissionsSha256: 'd'.repeat(64) },
  skill: { key: 'text-file', version: '1.0.0', packageSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) },
  commandId: 'cmd1', messageId: 'msg1', snapshotDigest: 'c'.repeat(64), parameters: { title: '内容' }, instruction: '生成文本', inputRefs: [], outputs: { dataSchema: null, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: false } })
const fixture = () => {
  const events = []; const c = command()
  const manifest = { schemaVersion: 1, executionId: c.executionId, snapshotDigest: c.snapshotDigest, result: { data: '真实结果', artifacts: [], inputReceipts: [] } }
  const descriptor = { manifest: { parametersSchema: schema, runner: 'native-model', inputs: { minItems: 0, maxItems: 32, acceptedMimeTypes: ['text/plain'] }, outputs: { dataSchema: null, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: false } } }
  const ctx = { registry: { requireExact: async skill => { assert.equal(skill.skillKey, 'text-file'); return { descriptor, binding: null } } },
    runners: new Map([['native-model', { run: async () => { events.push('run'); return manifest.result } }]]),
    claimOrResume: async () => { events.push('claim'); return {} }, loadResult: async () => null,
    materializeAuthorizedInputs: async () => [], validateAndPersistResult: async () => { events.push('persist'); return manifest },
    stageOutputs: async () => { events.push('stage') }, commitResult: async () => { events.push('commit'); return { state: 'RESULT_COMMITTED' } },
    persistReceipt: async () => { events.push('receipt') } }
  return { c, ctx, events, manifest }
}
test('strict protocol4 command rejects URLs, old protocols, malformed selectors/outputs and duplicate keys', () => {
  assert.deepEqual(parseSkillCommand(command()), command())
  for (const patch of [{ executionProtocolVersion: 3 }, { endpoint: 'https://evil.test' }, { inputRefs: ['a', 'a'] }, { outputs: [{ outputId: '../x', contentMimeType: 'text/plain' }] }])
    assert.throws(() => parseSkillCommand({ ...command(), ...patch }), /SKILL_COMMAND_INVALID/)
  assert.throws(() => parseSkillCommand('{"executionProtocolVersion":4,"executionProtocolVersion":4}'), /SKILL_INVALID_JSON/)
})
test('one executor persists result before stage/commit; data-only still has real commit', async () => {
  const { c, ctx, events } = fixture(); assert.equal((await executeSkill(c, ctx)).state, 'RESULT_COMMITTED')
  assert.deepEqual(events, ['claim', 'run', 'persist', 'commit', 'receipt'])
})
test('recovered persistent result never runs a model/provider again', async () => {
  const { c, ctx, manifest, events } = fixture(); ctx.loadResult = async () => manifest
  await executeSkill(c, ctx); assert.deepEqual(events, ['claim', 'commit', 'receipt'])
})
test('invalid parameters, missing runner, wrong result identity and required empty output fail closed', async () => {
  const { c, ctx, manifest } = fixture(); c.parameters.title = 1; await assert.rejects(executeSkill(c, ctx), /SKILL_PARAMETERS_INVALID/)
  c.parameters.title = 'x'; ctx.runners.clear(); await assert.rejects(executeSkill(c, ctx), /SKILL_RUNNER_MISSING/)
  ctx.runners.set('native-model', { run() {} }); ctx.loadResult = async () => ({ ...manifest, executionId: 'foreign' }); await assert.rejects(executeSkill(c, ctx), /SKILL_RESULT_BINDING_INVALID/)
})

import { readFileSync } from 'node:fs'
import { skillCanonicalJson, skillDigest, skillHash } from '../skill-executor.mjs'
import { canonicalSha256 } from '../chat-runtime.mjs'
const canonicalNumbers = JSON.parse(readFileSync(new URL('./fixtures/canonical-numbers-v4.json', import.meta.url)))
test('portable IEEE754 shortest canonical JSON matches shared Java fixture, including subnormal and negative zero', () => {
  for (const vector of canonicalNumbers.cases) {
    const value = vector.value
    assert.equal(skillCanonicalJson(value), vector.canonical, vector.name)
    assert.equal(skillDigest(value), vector.sha256); assert.equal(`sha256:${skillDigest(value)}`, canonicalSha256(value))
  }
})
test('canonical object keys are UTF16 lexical, never JS integer-property enumeration order', () => {
  const value = { 2: -0, 10: 5e-324, z: { 2: 1e21, 10: 0.000001 }, a: [1.5, 1e-7] }
  const expected = '{"10":5e-324,"2":0,"a":[1.5,1e-7],"z":{"10":0.000001,"2":1e+21}}'
  assert.equal(skillCanonicalJson(value), expected); assert.equal(skillDigest(value), skillHash(expected))
  for (const value of [NaN, Infinity, undefined, 1n]) assert.throws(() => skillCanonicalJson(value), /SKILL_CANONICAL_JSON_INVALID/)
})

test('protocol4 requires the exact shared task binding and rejects substituted execution/package references before claim', async () => {
  const original = command()
  for (const key of ['executionId', 'skillKey', 'skillVersion', 'packageSha256', 'manifestSha256']) {
    const changed = structuredClone(original)
    changed.taskSkillBinding[key] = key.endsWith('Sha256') ? 'e'.repeat(64) : 'substituted'
    assert.throws(() => parseSkillCommand(changed), /SKILL_COMMAND_INVALID/)
  }
  for (const taskSkillBinding of [null, { ...original.taskSkillBinding, taskGrantVersion: '01' },
    { ...original.taskSkillBinding, approvedPermissionsSha256: null }, { ...original.taskSkillBinding, extra: true }]) {
    await assert.rejects(executeSkill({ ...original, taskSkillBinding }, {
      registry: { requireExact() { assert.fail('invalid binding must not reach registry/claim') } }
    }))
  }
  const { taskSkillBinding, ...missing } = original
  assert.throws(() => parseSkillCommand(missing), /SKILL_COMMAND_INVALID/)
})
