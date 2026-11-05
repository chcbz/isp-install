/** Backend-owned context delivery. No history cache, filtering, cursor advancement or extra RPC. */
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identity = value => typeof value === 'string' && value.trim() === value && value.length > 0
const decimal = (value, zero = false) => typeof value === 'string'
  && (zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)
  && BigInt(value) <= 9223372036854775807n

export function contextDeliveryPlan(message) {
  const plan = message?.contextSnapshot?.facts?.contextDelivery
  if (plan === undefined) return null // Existing snapshots never imply an applied-history checkpoint.
  if (!object(plan) || plan.schemaVersion !== 1 || !['BOOTSTRAP', 'DELTA'].includes(plan.mode)
      || !decimal(plan.afterMessageId, true) || !decimal(plan.throughMessageId)
      || BigInt(plan.afterMessageId) > BigInt(plan.throughMessageId))
    fail('CHAT_CONTEXT_DELIVERY_INVALID', 'Invalid backend context delivery plan')
  if (plan.replacesDispatchId !== undefined && (plan.mode !== 'BOOTSTRAP'
      || !identity(plan.replacesDispatchId) || plan.replacesDispatchId === message.dispatchId))
    fail('CHAT_CONTEXT_DELIVERY_INVALID', 'Only bootstrap may replace a different rejected dispatch')
  if (plan.mode === 'BOOTSTRAP') {
    if (plan.baseTurnId !== null || plan.engineThreadId !== null || plan.afterMessageId !== '0')
      fail('CHAT_CONTEXT_DELIVERY_INVALID', 'Bootstrap cannot use a prior native cursor')
  } else if (!identity(plan.baseTurnId) || !identity(plan.engineThreadId)) {
    fail('CHAT_CONTEXT_DELIVERY_INVALID', 'Delta requires its completed predecessor and native thread')
  }
  return plan
}

/** Must run before thread start/resume and again against its actual result, never after turn/start. */
export function requireContextThread(plan, binding) {
  if (plan?.mode === 'DELTA' && binding?.threadId !== plan.engineThreadId)
    fail('CHAT_CONTEXT_BOOTSTRAP_REQUIRED', 'No matching native history; do not start this delta turn')
}

/** Only the native completion/final-preparation path may create this receipt. */
export function completedContextReceipt(message, engineThreadId, engineTurnId) {
  const plan = contextDeliveryPlan(message)
  if (!plan) return null
  // A completion is after execution. Never return the pre-start bootstrap signal
  // here: API may use that signal to prepare a fresh, explicitly unexecuted attempt.
  if (plan.mode === 'DELTA' && engineThreadId !== plan.engineThreadId)
    fail('TURN_ACCEPTANCE_UNKNOWN', 'Completed native thread differs from the context plan; reconcile without replay')
  if (!identity(engineThreadId) || !identity(engineTurnId))
    fail('CHAT_CONTEXT_RECEIPT_INVALID', 'Native completed turn identity required')
  return { schemaVersion: 1, mode: plan.mode, engineThreadId, engineTurnId,
    throughMessageId: plan.throughMessageId }
}

/** Durable proof created only by the inbox before native execution; not inferred from an error string. */
export function contextBootstrapRejection(record) {
  const proof = record?.contextRejection
  if (!['RECOVERY_REQUIRED', 'CANCELLED'].includes(record?.state) || proof?.schemaVersion !== 1
      || proof.code !== 'CHAT_CONTEXT_BOOTSTRAP_REQUIRED' || proof.executionStarted !== false
      || ['preparation', 'preparedAt', 'engine', 'runningAt', 'finalPrepared', 'finalPublication', 'finalConfirmation'].some(key => Object.hasOwn(record, key))) return null
  return { status: 'recovery_required', errorCode: proof.code, executionStarted: false }
}
