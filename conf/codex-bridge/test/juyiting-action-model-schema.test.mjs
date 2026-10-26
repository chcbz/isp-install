import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { buildActionOutcomeContract, validateActionOutcome } from '../juyiting-action-outcome.mjs'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/unified-action-outcome-v5.json', import.meta.url)))
const facts = () => {
  const f = structuredClone(fixture.facts)
  for (const a of f.availableActions) a.parametersSchema.properties = {}
  return f
}
const strictObjects = schema => {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort())
  }
  for (const value of Object.values(schema)) strictObjects(value)
}
test('no capability has no action branch and retains actual answer validation', () => {
  const f = facts(); f.availableActions = []
  const c = buildActionOutcomeContract(f)
  assert.deepEqual(c.outputSchema.properties.kind.enum, ['ANSWER', 'CLARIFY'])
  assert.deepEqual(c.outputSchema.properties.action, { type: 'null' })
  strictObjects(c.outputSchema)
  const check = new Ajv2020().compile(c.outputSchema)
  assert.equal(check(fixture.outcomes[0]), true)
  assert.equal(check(fixture.outcomes[2]), false)
  assert.deepEqual(validateActionOutcome(fixture.outcomes[0], f), fixture.outcomes[0])
})
test('schema binds exact action identity and exact recursive parameter schema without mutating facts', () => {
  const f = facts(); const before = JSON.stringify(f)
  const c = buildActionOutcomeContract(f); strictObjects(c.outputSchema)
  const check = new Ajv2020().compile(c.outputSchema)
  assert.equal(check(fixture.outcomes[2]), true)
  const wrong = structuredClone(fixture.outcomes[2]); wrong.action.actionId = 'not-advertised'
  assert.equal(check(wrong), false)
  wrong.action.actionId = f.availableActions[0].actionId; wrong.action.parameters.extra = true
  assert.equal(check(wrong), false)
  assert.equal(JSON.stringify(f), before)
  assert.equal(c.contractDigest, `sha256:${createHash('sha256').update(JSON.stringify({ instructions: c.instructions, outputSchema: c.outputSchema })).digest('hex')}`)
  f.availableActions[0].actionId = 'changed'
  assert.notEqual(buildActionOutcomeContract(f).contractDigest, c.contractDigest)
  f.availableActions[0].parametersSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    properties: { caption: { type: 'string' }, flags: { type: 'array', items: { type: 'boolean' } } }, required: ['caption', 'flags'] }
  strictObjects(buildActionOutcomeContract(f).outputSchema)
})
test('published optional image size adapts to strict model without changing execution contract', () => {
  const f = facts(); const manifest = JSON.parse(readFileSync(new URL('../toolchain/skill-packages-se2/image-generate/manifest.json', import.meta.url)))
  f.availableActions[0].parametersSchema = manifest.parametersSchema
  const before = JSON.stringify(f); const contract = buildActionOutcomeContract(f); strictObjects(contract.outputSchema)
  const check = new Ajv2020().compile(contract.outputSchema)
  const outcome = structuredClone(fixture.outcomes[2]); outcome.action.parameters = { size: '800x600' }
  assert.equal(check(outcome), true)
  assert.deepEqual(validateActionOutcome(outcome, f).action.parameters, { size: '800x600' })
  outcome.action.parameters = { size: null }; assert.equal(check(outcome), true)
  assert.deepEqual(validateActionOutcome(outcome, f).action.parameters, {})
  outcome.action.parameters = {}; assert.deepEqual(validateActionOutcome(outcome, f).action.parameters, {})
  outcome.action.parameters = { size: 'bad' }; assert.throws(() => validateActionOutcome(outcome, f), { code: 'ACTION_PARAMETERS_INVALID' })
  outcome.action.parameters = { extra: true }; assert.throws(() => validateActionOutcome(outcome, f), { code: 'ACTION_PARAMETERS_INVALID' })
  assert.equal(JSON.stringify(f), before)
  for (const schema of [
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {}, additionalProperties: true },
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {}, additionalProperties: false, allOf: [{ type: 'object' }] }]) {
    const f = facts(); f.availableActions[0].parametersSchema = structuredClone(schema)
    const before = JSON.stringify(f)
    assert.throws(() => buildActionOutcomeContract(f), { code: 'ACTION_MODEL_SCHEMA_UNSUPPORTED' })
    assert.equal(JSON.stringify(f), before)
  }
})


test('production clarification and revision failures are excluded by the model schema', () => {
  const f = { schemaVersion: 5, availableActions: [], availableSources: [], inspectedSourceRefIds: [] }
  const unlinked = buildActionOutcomeContract(f)
  assert.equal(unlinked.outputSchema.properties.text.minLength, 1)
  assert.deepEqual(unlinked.outputSchema.properties.deliveryRelation, { type: 'null' })
  const linked = buildActionOutcomeContract(f, null, { outcomeId: 'outcome-parent', finalDigest: 'sha256:' + 'a'.repeat(64) })
  assert.ok(linked.outputSchema.properties.deliveryRelation.anyOf)
  assert.notEqual(linked.contractDigest, unlinked.contractDigest)
})

test('media replacement uses the same frozen target in model schema and runtime validation', () => {
  const f = facts(); const parent = { outcomeId: 'red', finalDigest: 'sha256:' + 'a'.repeat(64) }
  const targets = [{ ...parent, outputSource: { requestId: 'execute-red', stepId: 'step-red', outputId: 'image', sha256: 'b'.repeat(64) } }]
  const outcome = structuredClone(fixture.outcomes[2])
  outcome.deliveryRelation = { mode: 'REPLACE', parentOutcomeId: parent.outcomeId, parentFinalDigest: parent.finalDigest,
    targetOutcomeId: parent.outcomeId, targetFinalDigest: parent.finalDigest }
  const check = new Ajv2020().compile(buildActionOutcomeContract(f, null, parent, targets).outputSchema)
  assert.equal(check(outcome), true)
  assert.deepEqual(validateActionOutcome(outcome, f, parent, targets), outcome)
  const textTarget = [{ ...parent, text: 'keep this text' }]
  assert.throws(() => validateActionOutcome(outcome, f, parent, textTarget), /ACTION_DELIVERY_TARGET_INVALID/)
  outcome.deliveryRelation.targetFinalDigest = 'sha256:' + 'c'.repeat(64)
  assert.equal(check(outcome), false)
  assert.throws(() => validateActionOutcome(outcome, f, parent, targets), /ACTION_DELIVERY_TARGET_INVALID/)
})
