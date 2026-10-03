import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ACTION_OUTCOME_SCHEMA, validateActionFacts, validateActionOutcome, resolveActionChatRequest } from '../juyiting-action-outcome.mjs'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/unified-action-outcome-v3.json', import.meta.url), 'utf8'))
const facts = () => structuredClone(fixture.facts)
const action = () => structuredClone(fixture.outcomes[2])

test('v3 supports direct answer, real clarification, mixed-material inspection and non-image execution', () => {
  assert.deepEqual(ACTION_OUTCOME_SCHEMA.properties.schemaVersion.enum, [3])
  for (const outcome of fixture.outcomes) assert.deepEqual(validateActionOutcome(JSON.stringify(outcome), facts()), outcome)
  assert.equal(Object.isFrozen(validateActionFacts(facts()).availableActions[0].inputMediaTypes), true)
})

test('32 selected sources are complete, 33 is invalid; no-source execution needs no reference-image branch', () => {
  const f = facts(); f.availableSources = Array.from({ length: 32 }, (_, i) => ({ sourceRefId: `s${i}`, kind: 'TASK_WORKSPACE_FILE', mediaType: ['text', 'image', 'audio', 'file'][i % 4] }))
  const a = action(); a.action.sourceRefIds = f.availableSources.map(s => s.sourceRefId)
  assert.equal(validateActionOutcome(a, f).action.sourceRefIds.length, 32)
  f.availableSources.push({ ...f.availableSources[0], sourceRefId: 's32' })
  assert.throws(() => validateActionFacts(f), /ACTION_SOURCES_INVALID/)
  const empty = facts(); empty.availableSources = []
  const execute = structuredClone(fixture.outcomes[3]); execute.action.sourceRefIds = []
  assert.doesNotThrow(() => validateActionOutcome(execute, empty))
  a.action.sourceRefIds = []
  assert.throws(() => validateActionOutcome(a, empty), /ACTION_SELECTION_INVALID/)
})

test('rejects unadvertised action, injected grant/path, wrong branch, source, duplicates and old protocol', () => {
  for (const mutate of [
    a => { a.action.actionId = 'unadvertised-paid-tool' }, a => { a.action.grant = true }, a => { a.action.path = '/root/key' },
    a => { a.action.sourceRefIds = ['unknown'] }, a => { a.action.sourceRefIds = ['source-file', 'source-file'] },
    a => { a.kind = 'ANSWER' }, a => { a.schemaVersion = 1 }, a => { a.clarification = { question: 'x', requiredFacts: ['x'] } }
  ]) { const a = action(); mutate(a); assert.throws(() => validateActionOutcome(a, facts())) }
  const f = facts(); f.availableActions = []
  assert.throws(() => validateActionOutcome(action(), f), /ACTION_NOT_ADVERTISED/)
  const imageOnly = facts(); imageOnly.availableActions[0].inputMediaTypes = ['image']
  assert.throws(() => validateActionOutcome(action(), imageOnly), /ACTION_SELECTION_INVALID/)
  assert.throws(() => validateActionOutcome('{"schemaVersion":3,"schemaVersion":3}', facts()), error => error.code === 'TYPED_OUTCOME_DUPLICATE_KEY')
  assert.throws(() => validateActionOutcome(JSON.stringify(action()) + ' trailing', facts()), error => error.code === 'TYPED_OUTCOME_INVALID_JSON')
  const malformed = action(); malformed.action.instruction = '\ud800'
  assert.throws(() => validateActionOutcome(malformed, facts()))
})

test('capability and read facts are exact; previous reading does not add an unsupported rejection gate', () => {
  for (const mutate of [
    f => { f.availableActions.push(f.availableActions[0]) }, f => { f.availableActions[0].maxSources = 33 },
    f => { f.availableActions[0].kind = 'EXECUTE' }, f => { f.availableActions[0].minSources = 0 },
    f => { f.availableActions[0].inputMediaTypes = ['shell'] }, f => { f.inspectedSourceRefIds = ['unknown'] },
    f => { f.availableSources.push(f.availableSources[0]) }, f => { f.grant = 'forged' }
  ]) { const f = facts(); mutate(f); assert.throws(() => validateActionFacts(f)) }
  const f = facts(); f.inspectedSourceRefIds = f.availableSources.map(s => s.sourceRefId)
  assert.doesNotThrow(() => validateActionOutcome(action(), f))
  f.inspectedSourceRefIds.pop()
  assert.doesNotThrow(() => validateActionOutcome(action(), f))
})

test('v3 CHAT dispatch binds exact task/conversation/generation/target; unknown versions never downgrade to v3', () => {
  const profile = { agentId: 'a', typedDeliberationEnabled: true }
  const message = { durable: true, route: 'CHAT', taskId: 'task', conversationId: 'c', conversationGeneration: '1', targetAgentId: 'a',
    contextSnapshot: { facts: { typedDeliberation: facts(), conversation: { id: 'c', generation: '1', scopeType: 'bounty' }, task: { id: 'task' }, targetAgentId: 'a' } } }
  assert.deepEqual(resolveActionChatRequest(profile, message), facts())
  for (const patch of [{ targetAgentId: 'foreign' }, { conversationId: 'foreign' }, { conversationGeneration: '2' }, { taskId: 'other' }, { route: 'INSPECT' }, { durable: false }]) {
    assert.throws(() => resolveActionChatRequest(profile, { ...message, ...patch }), /ACTION_BINDING_INVALID/)
  }
  assert.throws(() => resolveActionChatRequest({ ...profile, typedDeliberationEnabled: false }, message), /DISABLED/)
  message.contextSnapshot.facts.typedInspection = {}
  assert.throws(() => resolveActionChatRequest(profile, message), /ACTION_MARKER_CONFLICT/)
})
