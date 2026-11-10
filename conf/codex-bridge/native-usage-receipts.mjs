import { skillDigest } from './skill-executor.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }

/** Source-owned observations. A durable start precedes the engine call; discovery
 * delivers it even after a crash without terminal evidence. Business receipts never
 * acknowledge costs. No inference, pricing, process/lease or model replay occurs here. */
export function pendingNativeUsage(store) {
  const started = store.read('native-start-attempt')
  const terminal = store.read('native-final-message') || store.read('native-usage-failure') || store.read('native-usage-recovered')
  if (!started) {
    if (terminal) fail('NATIVE_USAGE_SOURCE_MISSING')
    return null
  }
  for (const [phase, source, receiptName] of [
    ['STARTED', started, 'native-usage-start-receipt'],
    ['TERMINAL', terminal, 'native-usage-receipt']
  ]) {
    if (!source) return null
    const payload = { executionId: store.command.executionId, phase,
      requestedModel: started.requestedModel ?? null, usageEvidence: phase === 'STARTED' ? null : source.usageEvidence ?? null }
    const evidenceSha256 = skillDigest(payload)
    const receipt = store.read(receiptName)
    if (!receipt) return { payload, evidenceSha256, receiptName }
    if (receipt.evidenceSha256 !== evidenceSha256) fail('NATIVE_USAGE_RECEIPT_CONFLICT')
  }
  return null
}

export function acknowledgeNativeUsage(store, pending, receipt) {
  if (!receipt || receipt.executionId !== store.command.executionId
      || !/^[a-f0-9]{64}$/.test(receipt.attemptId || '')
      || receipt.revision !== ((pending.payload.phase ?? pending.payload.observation?.phase) === 'STARTED' ? '1' : '2')
      || !['PENDING_USAGE', 'PENDING_PRICE', 'PRICED'].includes(receipt.status)
      || (receipt.status === 'PRICED' ? !/^[0-9]+\.[0-9]{6}$/.test(receipt.costYuan || '') : receipt.costYuan !== null))
    fail('NATIVE_USAGE_RECEIPT_UNCONFIRMED')
  // Receipt represents durable evidence acceptance, not a claim of known or zero cost.
  store.write(pending.receiptName, { executionId: receipt.executionId, attemptId: receipt.attemptId, revision: receipt.revision,
    status: receipt.status, costYuan: receipt.costYuan, evidenceSha256: pending.evidenceSha256 })
}
