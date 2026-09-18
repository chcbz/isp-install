const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactValue = (value, expected, max) => typeof value === 'string' && value === expected &&
  Buffer.byteLength(value) <= max && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value)
const framePayload = frame => isObject(frame?.data) ? frame.data : frame
const traceMatches = (payload, messageId, runtimeInstanceId) =>
  exactValue(payload?.messageId, messageId, 128) &&
  exactValue(payload?.runtimeInstanceId, runtimeInstanceId, 128)
const validToken = token => typeof token === 'string' && Buffer.byteLength(token) > 0 &&
  Buffer.byteLength(token) <= 512 && token.trim() === token && !/[\x00-\x1f\x7f]/u.test(token)

/** Track only request-correlated server registration outcomes without logging identity or payloads. */
export class RegistrationAckObserver {
  constructor({ agentId, runtimeInstanceId, timeoutMs = 10000,
    schedule = setTimeout, cancel = clearTimeout, logger = console } = {}) {
    this.agentId = agentId
    this.runtimeInstanceId = runtimeInstanceId
    this.timeoutMs = timeoutMs
    this.schedule = schedule
    this.cancel = cancel
    this.logger = logger
    this.stage = 'idle'
    this.messageId = null
    this.runtimeToken = null
    this.timer = null
  }

  get registered() { return this.stage === 'registered' }

  // Token remains process-memory only; snapshots and logs must never expose it.
  get runtimeAuthHeader() { return /^[0-9a-f]{32}$/.test(this.runtimeToken || '') ? `AgentRuntime ${this.runtimeToken}` : '' }

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
    this.runtimeToken = null
    this.log('log', this.stage)
    this.timer = this.schedule(() => {
      if (this.stage !== 'pending_ack' || this.messageId !== messageId) return
      this.timer = null
      this.stage = 'ack_timeout'
      this.messageId = null
      this.log('warn', this.stage)
    }, this.timeoutMs)
  }

  sendFailed(messageId) {
    if (this.stage !== 'pending_ack' || this.messageId !== messageId) return
    this.clearTimer()
    this.stage = 'send_failed'
    this.messageId = null
    this.log('warn', this.stage)
  }

  observe(frame) {
    if (this.stage !== 'pending_ack' || !isObject(frame)) return null
    const payload = framePayload(frame)
    if (!isObject(payload) || !traceMatches(payload, this.messageId, this.runtimeInstanceId)) return null
    if (frame.type === 'agent_registered' && exactValue(payload.agentId, this.agentId, 100) &&
        payload.status === 'online' && validToken(payload.token)) {
      this.clearTimer()
      this.runtimeToken = payload.token
      this.stage = 'registered'
      this.messageId = null
      this.log('log', this.stage)
      return 'registered'
    }
    if (frame.type !== 'error' && frame.type !== 'protocol_error' && frame.messageType !== 'protocol.error') return null
    this.clearTimer()
    this.stage = 'rejected'
    this.messageId = null
    this.log('warn', this.stage)
    return 'rejected'
  }

  disconnect() {
    this.clearTimer()
    this.stage = 'disconnected'
    this.messageId = null
    this.runtimeToken = null
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
