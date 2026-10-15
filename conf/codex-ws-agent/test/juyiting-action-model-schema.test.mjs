import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { buildActionOutcomeContract, validateActionOutcome } from '../juyiting-action-outcome.mjs'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/unified-action-outcome-v4.json', import.meta.url)))
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
test('optional/open/unsupported schema fails explicitly, never changes required fields or inserts defaults', () => {
  for (const schema of [fixture.facts.availableActions[0].parametersSchema,
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {}, additionalProperties: true },
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {}, additionalProperties: false, allOf: [{ type: 'object' }] }]) {
    const f = facts(); f.availableActions[0].parametersSchema = structuredClone(schema)
    const before = JSON.stringify(f)
    assert.throws(() => buildActionOutcomeContract(f), { code: 'ACTION_MODEL_SCHEMA_UNSUPPORTED' })
    assert.equal(JSON.stringify(f), before)
  }
})
