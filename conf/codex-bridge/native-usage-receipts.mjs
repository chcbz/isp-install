import { skillDigest } from './skill-executor.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }

/** Source-owned terminal evidence only. Business receipts/leases never acknowledge costs.
 * No token aggregation, actual-model inference, pricing or model invocation occurs here. */
export function pendingNativeUsage(store) {
  const terminal = store.read('native-final-message') || store.read('native-usage-failure')
  if (!terminal) return null
  const payload = { executionId: store.command.executionId,
    requestedModel: terminal.requestedModel ?? null, usageEvidence: terminal.usageEvidence ?? null }
  const evidenceSha256 = skillDigest(payload)
  const receipt = store.read('native-usage-receipt')
  if (receipt) {
    if (receipt.evidenceSha256 !== evidenceSha256) fail('NATIVE_USAGE_RECEIPT_CONFLICT')
    return null
  }
  return { payload, evidenceSha256 }
}

export function acknowledgeNativeUsage(store, pending, receipt) {
  if (!receipt || receipt.executionId !== store.command.executionId
      || !/^[a-f0-9]{64}$/.test(receipt.attemptId || '')
      || !/^[1-9][0-9]*$/.test(receipt.revision || '')
      || !['PENDING_USAGE', 'PENDING_PRICE', 'PRICED'].includes(receipt.status)
      || (receipt.status === 'PRICED' ? !/^[0-9]+\.[0-9]{6}$/.test(receipt.costYuan || '') : receipt.costYuan !== null))
    fail('NATIVE_USAGE_RECEIPT_UNCONFIRMED')
  // Receipt represents durable evidence acceptance, not a claim of known or zero cost.
  store.write('native-usage-receipt', { executionId: receipt.executionId, attemptId: receipt.attemptId, revision: receipt.revision,
    status: receipt.status, costYuan: receipt.costYuan, evidenceSha256: pending.evidenceSha256 })
}
