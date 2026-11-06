import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { pendingNativeUsage, acknowledgeNativeUsage } from '../native-usage-receipts.mjs'
function setup(t) {
  const rootDirectory = mkdtempSync(resolve(tmpdir(), 'native-cost-receipt-'))
  t.after(() => rmSync(rootDirectory, { force: true, recursive: true }))
  const options = { rootDirectory, scope: { agentId: 'agent' }, command: { executionId: 'exec', snapshotDigest: 'a'.repeat(64), inputRefs: [] } }
  return { options, store: new SkillExecutionStore(options) }
}
const receipt = { executionId: 'exec', attemptId: 'b'.repeat(64), revision: '1', status: 'PENDING_USAGE', costYuan: null }
for (const terminal of ['native-final-message', 'native-usage-failure']) {
  test(`${terminal} remains pending independently of business receipts and after restart`, t => {
    const { store, options } = setup(t)
    store.write(terminal, { requestedModel: 'requested-only', usageEvidence: { status: 'UNVERIFIED', tokenUsage: { last: { inputTokens: 5 }, total: { inputTokens: 50 } } } })
    store.write('receipt', { state: 'RESULT_COMMITTED' }); store.write('failure-receipt', { state: 'FAILED' })
    const pending = pendingNativeUsage(store)
    assert.deepEqual(pendingNativeUsage(new SkillExecutionStore(options)), pending)
    assert.equal(pending.payload.usageEvidence.tokenUsage.total.inputTokens, 50)
    acknowledgeNativeUsage(store, pending, receipt)
    assert.equal(pendingNativeUsage(new SkillExecutionStore(options)), null)
    assert.equal(store.read('native-usage-receipt').status, 'PENDING_USAGE')
    assert.equal(store.read('native-usage-receipt').costYuan, null)
  })
}
test('missing evidence is pending, not zero; mismatched receipt cannot remove pending evidence', t => {
  const { store } = setup(t)
  assert.equal(pendingNativeUsage(store), null)
  store.write('native-final-message', { threadId: 'thread', turnId: 'turn', content: 'done' })
  const pending = pendingNativeUsage(store)
  assert.equal(pending.payload.usageEvidence, null)
  assert.throws(() => acknowledgeNativeUsage(store, pending, { ...receipt, executionId: 'other' }), /UNCONFIRMED/)
  assert.throws(() => acknowledgeNativeUsage(store, pending, { ...receipt, costYuan: '0.000000' }), /UNCONFIRMED/)
  assert.equal(store.read('native-usage-receipt'), null)
})
test('acknowledged terminal evidence cannot be silently changed', t => {
  const { store } = setup(t)
  store.write('native-usage-failure', { usageEvidence: { status: 'UNVERIFIED' } })
  acknowledgeNativeUsage(store, pendingNativeUsage(store), receipt)
  store.write('native-usage-failure', { usageEvidence: { status: 'changed' } })
  assert.throws(() => pendingNativeUsage(store), /CONFLICT/)
})
