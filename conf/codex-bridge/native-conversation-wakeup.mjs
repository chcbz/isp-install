// Scheduling only. Used by native and file discovery; their existing processors own durable work.
// One timer per lane; notifications during an active pass request a trailing discovery.
export class NativeConversationWakeup {
  constructor({ poll, nextRecoveryAt, hasMore = () => false, current, eventDriven,
    onReport = () => {}, onError = () => {}, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { poll, nextRecoveryAt, hasMore, current, eventDriven, onReport, onError, now, schedule, cancel })
    this.stopped = false; this.active = false; this.discovery = false; this.timer = null
    this.at = Infinity; this.generation = 0; this.discoveryRetryAt = Infinity; this.retryNotBefore = 0
  }
  start() { this.discovery = true; return this.run() }
  wake() {
    if (this.stopped) return
    this.discovery = true
    if (!this.active) this.arm(this.now())
  }
  stop() {
    this.stopped = true; this.generation++
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null; this.at = Infinity
  }
  arm(at) {
    at = Math.max(at, this.retryNotBefore)
    if (this.stopped || !Number.isFinite(at) || at >= this.at) return
    if (this.timer !== null) this.cancel(this.timer)
    this.at = at
    const generation = ++this.generation
    this.timer = this.schedule(() => {
      if (this.stopped || generation !== this.generation) return
      this.timer = null; this.at = Infinity
      void this.run()
    }, Math.max(0, at - this.now()))
  }
  async run() {
    if (this.stopped || this.active || !this.current()) return
    this.active = true
    const discover = this.discovery || !this.eventDriven || this.discoveryRetryAt <= this.now()
    this.discovery = false
    try {
      const report = await this.poll({ discover })
      if (this.stopped) return
      if (report?.status === 'BUSY') {
        this.retryNotBefore = this.now() + 3000
        if (discover) this.discoveryRetryAt = this.now() + 3000
      } else {
        this.retryNotBefore = 0
        if (discover) this.discoveryRetryAt = Infinity
        this.onReport(report)
        if (discover && this.hasMore()) this.discovery = true
      }
    } catch (error) {
      if (!this.stopped) {
        this.retryNotBefore = this.now() + 3000
        if (discover) this.discoveryRetryAt = this.now() + 3000
        this.onError(error)
      }
    } finally {
      this.active = false
      if (!this.stopped && this.current()) {
        let next
        try { next = this.nextRecoveryAt() }
        catch (error) { this.onError(error); next = this.now() + 3000 }
        this.arm(this.discovery ? this.now() : Math.min(next, this.discoveryRetryAt,
          this.eventDriven ? Infinity : this.now() + 3000))
      }
    }
  }
}
