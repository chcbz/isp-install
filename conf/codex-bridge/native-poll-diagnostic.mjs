// Never serialize exception messages, stacks, stderr, request bodies or commands.
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'])
const safeCode = code => typeof code === 'string' && (networkCodes.has(code) || /^(?:SKILL|MATERIALS)_[A-Z_]{1,80}$/.test(code)) ? code : 'REDACTED'
export function nativePollDiagnostic(error) {
  const cause = error?.cause
  const diagnostic = { stage: error?.stage === 'skill-effect-invoke' ? 'skill-effect-invoke' : 'native-conversation-poll', cause: cause == null ? 'ABSENT' : safeCode(cause.code) }
  if (cause?.code === 'SKILL_LOCAL_PROCESS_FAILED') {
    if (Number.isInteger(cause.exitCode) && cause.exitCode >= 0 && cause.exitCode <= 255) diagnostic.exitCode = cause.exitCode
    if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGPIPE', 'SIGHUP', 'SIGQUIT', 'SIGBUS', 'SIGILL', 'SIGFPE'].includes(cause.signal)) diagnostic.signal = cause.signal
  }
  if (Array.isArray(error?.executionErrors)) diagnostic.executions = error.executionErrors.map(item => ({
    executionId: typeof item?.executionId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(item.executionId) ? item.executionId : 'REDACTED',
    code: safeCode(item?.code)
  }))
  return diagnostic
}
