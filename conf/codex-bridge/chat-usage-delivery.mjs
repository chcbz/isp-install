import { readNativeJson } from './native-json.mjs'

/** Independent evidence delivery. Never admits a turn, changes a wallet, or retries a model. */
export class ChatUsageDelivery {
  constructor({ inbox, apiOrigin, nativeFetch, now = Date.now }) {
    Object.assign(this, { inbox, apiOrigin, nativeFetch, now })
    this.retries = new Map()
  }
  // The caller owns the stopped subject gate; original session/dispatch attribution is unchanged.
  async flush() {
    const errors = []
    for (let phase = 0; phase < 2; phase++) {
      if (!this.inbox.pendingUsage().length) break
      errors.push(...await this.deliver())
      if (errors.length) break
    }
    const pending = this.inbox.pendingUsage().length
    return { confirmed: !errors.length && !pending, pending, errors }
  }
  nextRecoveryAt() {
    return this.inbox.pendingUsage().reduce((next, item) => Math.min(next,
      this.retries.get(item.key)?.at ?? this.now()), Infinity)
  }
  async deliver() {
    const errors = []
    for (const item of this.inbox.pendingUsage()) {
      const retry = this.retries.get(item.key)
      if (retry?.at > this.now()) continue
      try {
        const endpoint = new URL(`/internal/agent/chat/dispatches/${encodeURIComponent(item.dispatchId)}/usage`, this.apiOrigin)
        const response = await this.nativeFetch(endpoint, { method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(item.payload) })
        if (response?.status !== 200 || response.redirected === true || response.url !== endpoint.href)
          throw new Error('CHAT_USAGE_HTTP_UNCONFIRMED')
        this.inbox.acknowledgeUsage(item, await readNativeJson(response))
        this.retries.delete(item.key)
      } catch {
        const attempt = Math.min((retry?.attempt ?? 0) + 1, 6)
        this.retries.set(item.key, { attempt, at: this.now() + Math.min(30000, 1000 * 2 ** attempt) })
        errors.push({ dispatchId: item.dispatchId, code: 'CHAT_USAGE_DELIVERY_PENDING' })
      }
    }
    return errors
  }
}
