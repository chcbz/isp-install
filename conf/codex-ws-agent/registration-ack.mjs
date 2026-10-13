const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactValue = (value, expected, max) => typeof value === 'string' && value === expected &&
  Buffer.byteLength(value) <= max && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value)
const framePayload = frame => isObject(frame?.data) ? frame.data : frame
const traceMatches = (payload, messageId, runtimeInstanceId) =>
  exactValue(payload?.messageId, messageId, 128) &&
  exactValue(payload?.runtimeInstanceId, runtimeInstanceId, 128)
/** Track only request-correlated server registration outcomes without logging identity or payloads. */
export class RegistrationAckObserver {
  constructor({ agentId, runtimeInstanceId, timeoutMs = 10000,
    sessionProof = null, schedule = setTimeout, cancel = clearTimeout, logger = console } = {}) {
    this.sessionProof = sessionProof
    this.agentId = agentId
    this.runtimeInstanceId = runtimeInstanceId
    this.timeoutMs = timeoutMs
    this.schedule = schedule
    this.cancel = cancel
    this.logger = logger
    this.stage = 'idle'
    this.messageId = null
    this.timer = null
    this.waiters = new Set()
  }

  get registered() { return this.stage === 'registered' }

  // Registration timeout is observational: a slow exact ACK can still release
  // native readers. No token is returned, persisted or included in failures.
  waitForRegistration() {
    if (this.registered) return Promise.resolve(this.snapshot())
    if (!['pending_ack', 'ack_timeout'].includes(this.stage))
      return Promise.reject(Object.assign(new Error('NATIVE_RUNTIME_REGISTRATION_REQUIRED'), { code: 'NATIVE_RUNTIME_REGISTRATION_REQUIRED' }))
    return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }))
  }

  settleWaiters(registered) {
    for (const waiter of this.waiters) {
      if (registered) waiter.resolve(this.snapshot())
      else waiter.reject(Object.assign(new Error('NATIVE_RUNTIME_REGISTRATION_UNAVAILABLE'), { code: 'NATIVE_RUNTIME_REGISTRATION_UNAVAILABLE' }))
    }
    this.waiters.clear()
  }

  snapshot() { return { stage: this.stage, registered: this.registered } }

  log(level, stage) {
    this.logger?.[level]?.(`registration stage=${stage}`)
  }

  clearTimer() {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
  }

  begin(messageId) {
    this.clearTimer()
    this.stage = 'pending_ack'
    this.messageId = messageId
    this.log('log', this.stage)
    this.timer = this.schedule(() => {
      if (this.stage !== 'pending_ack' || this.messageId !== messageId) return
      this.timer = null
      // This timer is a slow-registration observation, not an authority deadline.
      // Keep the current request correlation so a late exact ACK can still enable
      // the native file lane. begin/sendFailed/disconnect invalidate old attempts.
      this.stage = 'ack_timeout'
      this.log('warn', this.stage)
    }, this.timeoutMs)
  }

  sendFailed(messageId) {
    if (this.stage !== 'pending_ack' || this.messageId !== messageId) return
    this.clearTimer()
    this.stage = 'send_failed'
    this.messageId = null
    this.settleWaiters(false)
    this.log('warn', this.stage)
  }

  observe(frame) {
    if (!['pending_ack', 'ack_timeout'].includes(this.stage) || !isObject(frame)) return null
    const payload = framePayload(frame)
    if (!isObject(payload) || !traceMatches(payload, this.messageId, this.runtimeInstanceId)) return null
    if (frame.type === 'agent_registered' && exactValue(payload.agentId, this.agentId, 100) &&
        payload.status === 'online' && !Object.hasOwn(payload, 'token') && !Object.hasOwn(payload, 'sessionToken')
        && typeof payload.durableStateHealthy === 'boolean' && Array.isArray(payload.readyCommandTypes)
        && (!this.sessionProof || ['installationId', 'hostId', 'sessionGeneration'].every(key => payload[key] === this.sessionProof[key]))) {
      this.clearTimer()
      this.stage = 'registered'
      this.messageId = null
      this.settleWaiters(true)
      this.log('log', this.stage)
      return 'registered'
    }
    if (frame.type !== 'error' && frame.type !== 'protocol_error' && frame.messageType !== 'protocol.error') return null
    this.clearTimer()
    this.stage = 'rejected'
    this.messageId = null
    this.settleWaiters(false)
    this.log('warn', this.stage)
    return 'rejected'
  }

  disconnect() {
    this.clearTimer()
    this.stage = 'disconnected'
    this.messageId = null
    this.settleWaiters(false)
  }
}

export const sendRegistrationWithAckObservation = ({ observer, envelope, send }) => {
  observer.begin(envelope.messageId)
  try {
    if (send(envelope)) return true
  } catch (error) {
    observer.sendFailed(envelope.messageId)
    throw error
  }
  observer.sendFailed(envelope.messageId)
  return false
}
