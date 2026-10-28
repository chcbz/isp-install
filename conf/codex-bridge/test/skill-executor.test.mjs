import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSkillCommand, executeSkill } from '../skill-executor.mjs'
const command = () => ({ executionProtocolVersion: 5, executionId: 'execution1', taskId: 'task1', runId: 'run1', conversationId: 'conversation1', conversationGeneration: '1', commandId: 'command1', messageId: 'message1', skills: [], snapshotDigest: 'a'.repeat(64), parameters: {}, instruction: 'read and write', inputRefs: [], outputs: { dataSchema: null, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: false }, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1' })
const fixture = () => {
  const c = command(); const events = []
  const manifest = { schemaVersion: 1, executionId: c.executionId, snapshotDigest: c.snapshotDigest, result: { data: null, artifacts: [], inputReceipts: [], effectDependencies: [] } }
  const ctx = { registry: { requireNativePackage: () => assert.fail('empty skills must not require a synthetic installation') },
    claimOrResume: async () => { events.push('claim'); return {} }, loadResult: async () => null,
    materializeAuthorizedInputs: async () => [], runNative: async () => { events.push('native'); return manifest },
    stageOutputs: async () => { events.push('stage') }, commitResult: async () => { events.push('commit'); return { state: 'RESULT_COMMITTED' } },
    persistReceipt: async () => { events.push('receipt') } }
  return { c, ctx, events, manifest }
}
test('native command accepts empty skills and harmless metadata but not legacy execution or unknown authority', () => {
  assert.deepEqual(parseSkillCommand(command()), command())
  assert.deepEqual(parseSkillCommand({ ...command(), displayHint: 'optional' }), command())
  for (const patch of [{ executionProtocolVersion: 4 }, { toolPolicyRef: 'ALL_TOOLS' }, { skills: null }, { skill: null }, { inputRefs: ['a', 'a'] }]) assert.throws(() => parseSkillCommand({ ...command(), ...patch }), /SKILL_COMMAND_INVALID/)
  assert.throws(() => parseSkillCommand('{"executionProtocolVersion":5,"executionProtocolVersion":5}'), /SKILL_INVALID_JSON/)
})
test('native executor claims, performs real native work, commits and persists receipt without a skill runner', async () => {
  const { c, ctx, events } = fixture(); await executeSkill(c, ctx)
  assert.deepEqual(events, ['claim', 'native', 'commit', 'receipt'])
})
test('local or server committed recovery never starts a model again', async () => {
  const { c, ctx, manifest, events } = fixture(); ctx.loadResult = async () => manifest
  await executeSkill(c, ctx); assert.deepEqual(events, ['claim', 'commit', 'receipt'])
  events.length = 0; ctx.claimOrResume = async () => ({ resultManifest: manifest }); ctx.recoverCommittedResult = async () => ({ state: 'RESULT_COMMITTED' })
  await executeSkill(c, ctx); assert.deepEqual(events, ['receipt'])
})
test('missing native adapter and wrong result binding never commit', async () => {
  const { c, ctx, manifest } = fixture(); delete ctx.runNative
  await assert.rejects(executeSkill(c, ctx), /SKILL_NATIVE_ADAPTER_MISSING/)
  ctx.runNative = async () => ({ ...manifest, executionId: 'foreign' }); await assert.rejects(executeSkill(c, ctx), /SKILL_RESULT_BINDING_INVALID/)
})
test('legacy commands are rejected before registry or execution admission', async () => {
  await assert.rejects(executeSkill({ ...command(), executionProtocolVersion: 4 }, { registry: { requireNativePackage: () => assert.fail('legacy authority') } }), /SKILL_COMMAND_INVALID/)
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


test('API optional dataSchema omission normalizes to null without inventing output data', () => {
  const wire = command(); delete wire.outputs.dataSchema
  assert.deepEqual(parseSkillCommand(wire), command())
})

const addInstruction = f => {
  const skill = { key: 'guide', version: '1.0.0', packageSha256: 'b'.repeat(64), manifestSha256: null }
  const taskSkillBinding = { executionId: f.c.executionId, taskGrantId: 'grant1', taskGrantVersion: '1', agentId: 'agent1', skillKey: skill.key,
    skillInstallationId: 'installation1', productVersionId: 'product1', skillVersion: skill.version, packageSha256: skill.packageSha256,
    manifestSha256: null, approvedPermissionsSha256: 'c'.repeat(64) }
  f.c.skills = [{ skill, taskSkillBinding }]
  return taskSkillBinding
}
test('native execution binds an ordinary instruction package without old runner readiness', async () => {
  const f = fixture(); const binding = addInstruction(f)
  f.ctx.registry.requireNativePackage = async (skill, options) => {
    assert.equal(skill.manifestSha256, null); assert.deepEqual(options.taskBinding, binding)
    f.events.push('package'); return { descriptor: { kind: 'INSTRUCTION', manifest: null } }
  }
  f.ctx.runNative = async ({ entries }) => {
    assert.equal(entries[0].descriptor.kind, 'INSTRUCTION'); f.events.push('native'); return f.manifest
  }
  await executeSkill(f.c, f.ctx)
  assert.deepEqual(f.events, ['claim', 'package', 'native', 'commit', 'receipt'])
  const broken = structuredClone(f.c); broken.skills[0].skill.manifestSha256 = ''
  assert.throws(() => parseSkillCommand(broken), /SKILL_COMMAND_INVALID/)
})
test('native result recovery does not depend on a still-installed package or live old runner', async () => {
  const f = fixture(); addInstruction(f)
  f.ctx.loadResult = async () => f.manifest
  await executeSkill(f.c, f.ctx)
  assert.deepEqual(f.events, ['claim', 'commit', 'receipt'])
  f.events.length = 0
  f.ctx.claimOrResume = async () => ({ resultManifest: f.manifest })
  f.ctx.recoverCommittedResult = async () => ({ state: 'RESULT_COMMITTED' })
  await executeSkill(f.c, f.ctx)
  assert.deepEqual(f.events, ['receipt'])
})

test('script policy requires a real bound skill and preserves the policy in the command', () => {
  const f = fixture(); f.c.toolPolicyRef = 'NATIVE_SKILL_SCRIPT_V1'
  assert.throws(() => parseSkillCommand(f.c), /SKILL_COMMAND_INVALID/)
  addInstruction(f)
  assert.equal(parseSkillCommand(f.c).toolPolicyRef, 'NATIVE_SKILL_SCRIPT_V1')
})
