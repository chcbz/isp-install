import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TYPED_DELIBERATION_OUTPUT_SCHEMA,
  buildTypedDeliberationDeclaration,
  parseStrictTypedOutcomeJson,
  resolveTypedDeliberationRequest,
  validateTypedDeliberationFacts,
  validateTypedInteractionOutcome
} from '../juyiting-typed-outcome.mjs'

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', 'typed-deliberation-client-result-v1.json'), 'utf8'))
const facts = () => structuredClone(fixture.dispatchFacts)
const profile = { profileId: 'p', agentId: 'agent-1', typedDeliberationEnabled: true, fastChatEnabled: true, appServerEnabled: true, chatEngine: 'app-server', chatSandbox: 'read-only', chatToolPolicy: 'read-only-constrained' }
const readyAdapter = () => ({ closed: false, readback: { initialize: { capabilities: {} }, schema: { measured: true, schemaContractId: 'codex-cli-0.153.4', cliVersion: '0.153.4', bundleSha256: 'b06f77062369d481a59cc70720c12b89cb9dd49c385863923262102d3ad6c978' } } })
const message = typed => ({
  durable: true, route: 'CHAT', taskId: 'task-1', conversationId: 'conversation-1', conversationGeneration: '7', targetAgentId: 'agent-1',
  contextSnapshot: { facts: { targetAgentId: 'agent-1', task: { id: 'task-1' }, conversation: { id: 'conversation-1', generation: '7', scopeType: 'bounty' }, ...(typed === undefined ? {} : { typedDeliberation: typed }) } }
})

test('frozen output schema and all three valid union samples are exact', () => {
  assert.deepEqual(TYPED_DELIBERATION_OUTPUT_SCHEMA, fixture.outputSchema)
  const dispatch = validateTypedDeliberationFacts(facts())
  assert.deepEqual(fixture.outcomes.map(outcome => validateTypedInteractionOutcome(JSON.stringify(outcome), dispatch)), fixture.outcomes)
})

test('strict parser rejects duplicates, trailing prose, malformed Unicode, non-object and unknown union fields', () => {
  const dispatch = validateTypedDeliberationFacts(facts())
  const invalid = [
    '{"schemaVersion":1,"kind":"ANSWER","kind":"CLARIFY","text":"x","clarification":null,"proposal":null}',
    `${JSON.stringify(fixture.outcomes[0])}\napproved`,
    '{"schemaVersion":1,"kind":"ANSWER","text":"\\ud800","clarification":null,"proposal":null}',
    '[]',
    JSON.stringify({ ...fixture.outcomes[0], grant: true }),
    JSON.stringify({ ...fixture.outcomes[0], clarification: { question: 'x', requiredFacts: ['SOURCE_SELECTION'] } })
  ]
  for (const raw of invalid) assert.throws(() => validateTypedInteractionOutcome(raw, dispatch))
  assert.throws(() => parseStrictTypedOutcomeJson('{"a":{"x":1,"x":2}}'), error => error.code === 'TYPED_OUTCOME_DUPLICATE_KEY')
  const forged = Object.create({ grant: true }); Object.assign(forged, fixture.outcomes[0])
  assert.throws(() => validateTypedInteractionOutcome(forged, dispatch), /TYPED_OUTCOME_SHAPE_INVALID/)
})

test('proposal semantics bind operation and exact trusted source catalog without granting authority', () => {
  const dispatch = validateTypedDeliberationFacts(facts())
  const proposal = structuredClone(fixture.outcomes[2])
  assert.equal(validateTypedInteractionOutcome(JSON.stringify(proposal), dispatch).proposal.sourceRefIds[0], 'source_1')
  for (const mutate of [
    value => { value.proposal.operation = 'EDIT_AUDIO' },
    value => { value.proposal.sourceRefIds = ['forged'] },
    value => { value.proposal.sourceRefIds = ['source_1', 'source_1'] },
    value => { value.proposal.instruction = 'red\nblue' },
    value => { value.proposal.instruction = '\ud800' }
  ]) {
    const value = structuredClone(proposal); mutate(value); assert.throws(() => validateTypedInteractionOutcome(value, dispatch))
  }
  const workspace = facts(); workspace.availableSources[0].kind = 'TASK_WORKSPACE_FILE'
  assert.throws(() => validateTypedInteractionOutcome(proposal, validateTypedDeliberationFacts(workspace)), error => error.code === 'TYPED_OUTCOME_EDIT_SOURCE_INVALID')
  const generate = structuredClone(proposal); generate.proposal.operation = 'GENERATE_IMAGE'; generate.proposal.sourceRefIds = []
  assert.doesNotThrow(() => validateTypedInteractionOutcome(generate, dispatch))
})

test('trusted typed dispatch is exact, bounded and bound to CHAT bounty task/conversation/agent', () => {
  assert.deepEqual(resolveTypedDeliberationRequest(profile, message(facts())), fixture.dispatchFacts)
  assert.equal(resolveTypedDeliberationRequest(profile, message(undefined)), null)
  assert.throws(() => resolveTypedDeliberationRequest({ ...profile, typedDeliberationEnabled: false }, message(facts())), error => error.code === 'TYPED_DELIBERATION_DISABLED')
  for (const changed of [
    { route: 'INSPECT' }, { taskId: 'other' }, { conversationId: 'other' }, { conversationGeneration: '8' }, { targetAgentId: 'other' }
  ]) assert.throws(() => resolveTypedDeliberationRequest(profile, { ...message(facts()), ...changed }), error => error.code === 'TYPED_DELIBERATION_BINDING_INVALID')
  const none = facts(); none.referenceMode = 'NONE'; assert.throws(() => validateTypedDeliberationFacts(none), error => error.code === 'TYPED_DELIBERATION_REFERENCE_MODE_INVALID')
  const duplicate = facts(); duplicate.availableSources.push({ ...duplicate.availableSources[0] }); assert.throws(() => validateTypedDeliberationFacts(duplicate))
  const malformed = facts(); malformed.availableSources[0].sourceRefId = `source_${String.fromCharCode(0xd800)}`
  assert.throws(() => validateTypedDeliberationFacts(malformed), error => error.code === 'TYPED_DELIBERATION_SOURCES_INVALID')
  const missingTask = message(facts()); delete missingTask.taskId; delete missingTask.contextSnapshot.facts.task.id
  assert.throws(() => resolveTypedDeliberationRequest(profile, missingTask), error => error.code === 'TYPED_DELIBERATION_BINDING_INVALID')
  const numericScope = message(facts()); numericScope.contextSnapshot.facts.conversation.id = 1
  assert.throws(() => resolveTypedDeliberationRequest(profile, numericScope), error => error.code === 'TYPED_DELIBERATION_BINDING_INVALID')
  const unknown = facts(); unknown.extra = true; assert.throws(() => validateTypedDeliberationFacts(unknown))
})

test('typed declaration is default-off, unavailable until exact measured live adapter, then READY', () => {
  assert.equal(buildTypedDeliberationDeclaration({ ...profile, typedDeliberationEnabled: false }, readyAdapter()), null)
  assert.equal(buildTypedDeliberationDeclaration(profile, null).state, 'UNAVAILABLE')
  assert.equal(buildTypedDeliberationDeclaration(profile, { ...readyAdapter(), closed: true }).state, 'UNAVAILABLE')
  assert.equal(buildTypedDeliberationDeclaration(profile, { ...readyAdapter(), readback: { initialize: {}, schema: { measured: false } } }).state, 'UNAVAILABLE')
  assert.deepEqual(buildTypedDeliberationDeclaration(profile, readyAdapter()), {
    schemaVersion: 1, state: 'READY', carrier: 'CHAT_MESSAGE_FINAL_SIDECAR_V1', referenceModes: ['NONE', 'AVAILABLE'],
    outcomeKinds: ['ANSWER', 'CLARIFY', 'EXECUTION_PROPOSAL'], engine: 'CODEX_APP_SERVER_NATIVE_OUTPUT_SCHEMA', strictNoToolsVerified: false, toolPolicy: 'read-only-constrained'
  })
})
