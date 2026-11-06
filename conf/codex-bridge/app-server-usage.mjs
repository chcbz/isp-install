const counters = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
const scalar = value => value === null || ['number', 'string', 'boolean'].includes(typeof value)

// Evidence only. last/total semantics, actual model, price and cache-write TTL are
// not supplied by this notification. Do not turn snapshots into billable deltas.
export function usageEvidenceFromNotification(params) {
  if (typeof params?.threadId !== 'string' || !params.threadId || typeof params.turnId !== 'string' || !params.turnId) return null
  if (!params.tokenUsage || typeof params.tokenUsage !== 'object' || Array.isArray(params.tokenUsage)) return null
  const tokenUsage = {}
  for (const kind of ['last', 'total']) {
    const source = params.tokenUsage[kind]
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    tokenUsage[kind] = Object.fromEntries(counters.filter(key => Object.hasOwn(source, key) && scalar(source[key])).map(key => [key, source[key]]))
  }
  if (Object.hasOwn(params.tokenUsage, 'modelContextWindow') && scalar(params.tokenUsage.modelContextWindow)) tokenUsage.modelContextWindow = params.tokenUsage.modelContextWindow
  return { source: 'codex-app-server/thread/tokenUsage/updated', status: 'UNVERIFIED', threadId: params.threadId, turnId: params.turnId, tokenUsage }
}
