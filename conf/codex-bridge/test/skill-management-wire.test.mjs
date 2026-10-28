import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { managementCanonicalJson, managementDigest, validateManagement, validateNativeTaskSkillBinding, parseManagementMessage } from '../skill-management-wire.mjs'
import { fromAgentWire, toAgentWire } from '../agent-message-wire.mjs'
import { examples } from './fixtures/skill-management-fixture.mjs'
const root = new URL('./fixtures/skill-management/', import.meta.url)
const lock = JSON.parse(readFileSync(new URL('contract-lock.json', root)))
test('SM-C1 fixtures are original bytes at locked SHA; all shared schema examples and canonical vectors consumed', () => {
  for (const file of ['schema', 'examples', 'behavior']) {
    const path = file === 'schema' ? new URL('../schemas/management-contract-v1.schema.json', import.meta.url)
      : new URL(`management-contract-v1.${file}.json`, root)
    const sha = createHash('sha256').update(readFileSync(path)).digest('hex')
    assert.equal(sha, lock.files[`specs/juyiting-skill-execution/fixtures/management-contract-v1.${file}.json`])
  }
  for (const c of examples.cases) {
    if (c.valid) validateManagement(c.definition, c.value)
    else assert.throws(() => validateManagement(c.definition, c.value), undefined, c.name)
  }
  const position = { ...examples.cases.find(c => c.name === 'accepted-offline-install').value.data,
    price: null, orderId: null, fundingStatus: 'NONE',
    authorizationSource: { type: 'POSITION', grantId: 'grant_1', grantRevision: '1', bindingId: '1' } }
  validateManagement('SkillChange', position)
  delete position.authorizationSource
  assert.throws(() => validateManagement('SkillChange', position))
  for (const v of examples.digestVectors) {
    assert.equal(managementCanonicalJson(v.value), v.canonicalUtf8)
    assert.equal(managementDigest(v.domain, v.value), v.sha256)
  }
})
test('real command/result/ACK/receipt full public serializer → consumer roundtrip, without task IDs or transport injection', () => {
  let count = 0
  for (const c of examples.cases.filter(c => c.valid && ['Command', 'CommandAck', 'Result', 'ResultReceipt'].includes(c.definition))) {
    const wire = JSON.stringify(toAgentWire(c.value, { runtimeInstanceId: 'another-boot' }))
    assert.deepEqual(fromAgentWire(wire), c.value, c.name)
    assert.equal(Object.hasOwn(c.value.data, 'taskId'), false)
    assert.equal(Object.hasOwn(c.value.data, 'orderId'), false)
    if (c.definition === 'Result') assert.equal(Object.hasOwn(JSON.parse(wire), 'code'), false)
    count++
  }
  assert.ok(count >= 10)
})
test('actual management consumer rejects shared malformed command/result/receipt cases and raw duplicate/numeric tokens', () => {
  for (const c of examples.cases.filter(c => !c.valid && ['Command', 'Result', 'ResultReceipt'].includes(c.definition))) {
    assert.throws(() => parseManagementMessage(JSON.stringify(c.value)), undefined, c.name)
  }
  const original = examples.cases.find(c => c.name === 'prepare-command').value
  const wire = JSON.stringify(original)
  for (const bad of [wire.replace('"attempt":1', '"attempt":1e0'), wire.replace('"attempt":1', '"attempt":1.0'),
    wire.replace('"attempt":1', '"attempt":-0'), wire.replace('"attempt":1', '"attempt":1,"attempt":1'),
    wire.replace('"owner_demo"', '"\\ud800"')]) assert.throws(() => fromAgentWire(bad))
  for (const c of examples.rawParserCases) { if (c.definition === 'Command') assert.throws(() => parseManagementMessage(c.raw || c.json)) }
})
test('management domain is UTF8 ordered and rejects nonportable values without changing legacy skill hash contract', () => {
  for (const value of [undefined, NaN, -0, 0.1, 1e21, '\udfff', { '\ud800': 'x' }]) assert.throws(() => managementCanonicalJson(value))
  const command = structuredClone(examples.cases.find(c => c.name === 'prepare-command').value)
  command.data.deliveryEpoch = '9007199254740993'; parseManagementMessage(command)
  command.data.target.productVersionId = 'substituted'; assert.throws(() => parseManagementMessage(command), /SKILL_RESULT_CONFLICT/)
})


test('v5 NativeTaskSkillBinding differs from locked v1 only in explicit nullable manifest hash', () => {
  const oldSchema = JSON.parse(readFileSync(new URL('../schemas/management-contract-v1.schema.json', import.meta.url)))
  const nativeSchema = JSON.parse(readFileSync(new URL('../schemas/native-task-skill-binding-v5.schema.json', import.meta.url)))
  const original = oldSchema.definitions.TaskSkillBinding
  assert.deepEqual(nativeSchema.required, original.required)
  assert.equal(nativeSchema.additionalProperties, original.additionalProperties)
  const nativeProperties = structuredClone(nativeSchema.properties)
  assert.deepEqual(nativeProperties.manifestSha256, { anyOf: [{ $ref: `${oldSchema.$id}#/definitions/Sha256` }, { type: 'null' }] })
  nativeProperties.manifestSha256 = { $ref: `${oldSchema.$id}#/definitions/Sha256` }
  for (const field of Object.values(nativeProperties)) if (field.$ref) field.$ref = field.$ref.replace(oldSchema.$id, '')
  assert.deepEqual(nativeProperties, original.properties)
  const sample = structuredClone(examples.cases.find(item => item.valid && item.definition === 'TaskSkillBinding').value)
  const instruction = { ...sample, manifestSha256: null }
  assert.equal(validateNativeTaskSkillBinding(sample), sample)
  assert.equal(validateNativeTaskSkillBinding(instruction), instruction)
  assert.throws(() => validateManagement('TaskSkillBinding', instruction))
  for (const bad of [{ ...sample, manifestSha256: '' }, { ...sample, manifestSha256: 'a'.repeat(63) },
    { ...sample, manifestSha256: null, packageSha256: null }, { ...sample, manifestSha256: null, approvedPermissionsSha256: null },
    { ...sample, manifestSha256: null, taskGrantId: '' }, { ...instruction, extra: true }]) assert.throws(() => validateNativeTaskSkillBinding(bad))
  const missing = { ...sample }; delete missing.manifestSha256
  assert.throws(() => validateNativeTaskSkillBinding(missing))
})
