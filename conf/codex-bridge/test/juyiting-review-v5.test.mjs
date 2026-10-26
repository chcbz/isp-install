import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { buildActionOutcomeContract, validateActionOutcome } from '../juyiting-action-outcome.mjs'
import { validateReviewBasis, messageRevisionDigest } from '../juyiting-review-basis.mjs'
const f = JSON.parse(readFileSync(new URL('./fixtures/message-review-v5.json', import.meta.url)))
test('shared exact v5 fixture passes actual model schema, parser and frozen digest', () => {
  const contract = buildActionOutcomeContract(f.facts, f.basis)
  assert.equal(new Ajv2020().compile(contract.outputSchema)(f.outcome), true)
  assert.deepEqual(validateActionOutcome(f.outcome, f.facts, null, [], f.basis), f.outcome)
  assert.equal(messageRevisionDigest(f.basis, f.parentOutcomeId, f.parentFinalDigest, f.outcome.revision), f.expectedRevisionDigest)
  assert.throws(() => validateActionOutcome(f.outcome, f.facts))
  for (const ids of [['artifact_manifest'], ['invented'], [], ['artifact_text', 'artifact_text']]) {
    const bad = structuredClone(f.outcome); bad.revision.targetArtifactIds = ids
    // Native schema constrains advertised IDs; cardinality/uniqueness remain strict parser checks.
    if (ids.some(id => id !== 'artifact_text')) assert.equal(new Ajv2020().compile(contract.outputSchema)(bad), false)
    assert.throws(() => validateActionOutcome(bad, f.facts, null, [], f.basis))
  }
})
test('ordinary question preserves review and malformed basis cannot silently become null', () => {
  const answer = { ...f.outcome, kind: 'ANSWER', text: '解释当前结果', revision: null }
  assert.deepEqual(validateActionOutcome(answer, f.facts, null, [], f.basis), answer)
  assert.throws(() => validateActionOutcome({ ...answer, deliverable: true }, f.facts, null, [], f.basis))
  assert.throws(() => validateReviewBasis(undefined))
  assert.throws(() => validateReviewBasis({ ...f.basis, sourceMessageId: '01' }))
})
test('server-frozen formal source is consumable without a public artifact selector', () => {
  const facts = { ...f.facts, availableSources: [{ sourceRefId: 'formal_source', kind: 'FORMAL_ARTIFACT', mediaType: 'image', contentMimeType: 'image/png' }] }
  const answer = { ...f.outcome, kind: 'ANSWER', text: '读取固定正式成果', revision: null }
  assert.deepEqual(validateActionOutcome(answer, facts), answer)
  assert.ok(buildActionOutcomeContract(facts).outputSchema)
})
