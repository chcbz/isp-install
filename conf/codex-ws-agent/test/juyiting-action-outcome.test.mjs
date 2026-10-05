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

test('explicit text deliverable marker is durable Boolean data, not inferred from ANSWER or permission', () => {
  const answer = structuredClone(fixture.outcomes[0])
  assert.equal(Object.hasOwn(validateActionOutcome(answer, facts()), 'deliverable'), false)
  assert.equal(ACTION_OUTCOME_SCHEMA.properties.deliverable.type, 'boolean')
  assert.ok(ACTION_OUTCOME_SCHEMA.required.includes('deliverable'))
  for (const deliverable of [false, true]) {
    assert.deepEqual(validateActionOutcome({ ...answer, deliverable }, facts()), { ...answer, deliverable })
  }
  for (const deliverable of [null, 1, 'true', { grant: true }]) {
    assert.throws(() => validateActionOutcome({ ...answer, deliverable }, facts()), /ACTION_OUTCOME_INVALID/)
  }
  for (const outcome of fixture.outcomes.filter(item => item.kind !== 'ANSWER')) {
    assert.throws(() => validateActionOutcome({ ...outcome, deliverable: true }, facts()), /ACTION_OUTCOME_UNION_INVALID/)
    assert.equal(validateActionOutcome({ ...outcome, deliverable: false }, facts()).deliverable, false)
  }
  assert.throws(() => validateActionOutcome({ ...answer, deliverable: true, grant: 'fake' }, facts()), /ACTION_OUTCOME_INVALID/)
})


test('explicit text relations require the exact advertised durable parent and never infer from linkage', () => {
  const parent = { outcomeId: 'original-text', finalDigest: `sha256:${'a'.repeat(64)}` }
  for (const mode of ['APPEND', 'REPLACE', 'RESET']) {
    const value = { schemaVersion: 3, kind: 'ANSWER', text: '原文改稿  ', clarification: null, action: null, deliverable: true,
      deliveryRelation: { mode, parentOutcomeId: parent.outcomeId, parentFinalDigest: parent.finalDigest } }
    assert.deepEqual(validateActionOutcome(value, facts(), parent), value)
    assert.equal(Object.isFrozen(validateActionOutcome(value, facts(), parent).deliveryRelation), true)
    assert.throws(() => validateActionOutcome(value, facts()), /ACTION_DELIVERY_PARENT_INVALID/)
    assert.throws(() => validateActionOutcome(value, facts(), { ...parent, finalDigest: `sha256:${'b'.repeat(64)}` }), /ACTION_DELIVERY_PARENT_INVALID/)
    assert.throws(() => validateActionOutcome({ ...value, deliverable: false }, facts(), parent), /ACTION_DELIVERY_PARENT_INVALID/)
  }
  const old = { schemaVersion: 3, kind: 'ANSWER', text: '文字成果', clarification: null, action: null, deliverable: true }
  assert.deepEqual(validateActionOutcome({ ...old, deliveryRelation: null }, facts(), parent), old)
  assert.equal(Object.hasOwn(validateActionOutcome(old, facts(), parent), 'deliveryRelation'), false)
})


test('actual API read fixture preserves identical explicit parent identity across all text relation modes', () => {
  const groups = JSON.parse(readFileSync(new URL('./fixtures/text-delivery-relations-v3.json', import.meta.url), 'utf8'))
  for (const group of groups) {
    const original = group.initial.outcome; const current = group.updated.outcome
    const parent = { outcomeId: original.outcomeId, finalDigest: original.finalDigest }
    const native = { schemaVersion: 3, kind: current.kind, text: current.text, clarification: null, action: null,
      deliverable: current.deliverable, deliveryRelation: current.deliveryRelation }
    const result = validateActionOutcome(native, facts(), parent)
    assert.deepEqual(result, native); assert.equal(result.deliveryRelation.mode, group.mode)
    assert.equal(result.text, '修改原文  ')
  }
})


test('earlier retained replacement requires the exact advertised target while keeping its causal basis', () => {
  const group = JSON.parse(readFileSync(new URL('./fixtures/retained-text-delivery-v3.json', import.meta.url), 'utf8'))
  const ad = group.admissionFacts; const view = group.updated.outcome
  const outcome = { schemaVersion: 3, kind: 'ANSWER', text: view.text, clarification: null, action: null, deliverable: true, deliveryRelation: view.deliveryRelation }
  assert.deepEqual(validateActionOutcome(outcome, facts(), ad.deliveryParent, ad.deliveryTargets), outcome)
  assert.notEqual(outcome.deliveryRelation.targetOutcomeId, outcome.deliveryRelation.parentOutcomeId)
  assert.throws(() => validateActionOutcome(outcome, facts(), ad.deliveryParent), /ACTION_DELIVERY_TARGET_INVALID/)
  for (const patch of [{ targetOutcomeId: 'discarded' }, { targetFinalDigest: `sha256:${'0'.repeat(64)}` }, { mode: 'APPEND' }, { mode: 'RESET' }]) {
    const bad = structuredClone(outcome); Object.assign(bad.deliveryRelation, patch)
    assert.throws(() => validateActionOutcome(bad, facts(), ad.deliveryParent, ad.deliveryTargets), /ACTION_DELIVERY_TARGET_INVALID/)
  }
  const missing = structuredClone(outcome); delete missing.deliveryRelation.targetFinalDigest
  assert.throws(() => validateActionOutcome(missing, facts(), ad.deliveryParent, ad.deliveryTargets), /ACTION_DELIVERY_PARENT_INVALID/)
  for (const targets of [ad.deliveryTargets.concat(ad.deliveryTargets[0]), [{ ...ad.deliveryTargets[0], text: 123 }], [{ ...ad.deliveryTargets[0], outcomeId: 123 }], [{ ...ad.deliveryTargets[0], grant: 'fake' }]]) {
    assert.throws(() => validateActionOutcome(outcome, facts(), ad.deliveryParent, targets), /ACTION_DELIVERY_TARGET_INVALID/)
  }
})
