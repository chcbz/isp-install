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
  #runtimeCredential = null
  #runtimeAbort = null

  runtimeCredential() { return this.#runtimeCredential }

  invalidateRuntime() {
    this.#runtimeAbort?.abort()
    this.#runtimeAbort = null
    this.#runtimeCredential = null
  }

  acceptRuntime(payload) {
    const auth = payload.runtimeAuth
    if (auth === undefined) return true // old server: no F01 capability has been negotiated
    const fields = ['scheme', 'tenantId', 'clientId', 'agentId', 'runtimeInstanceId', 'contextPackEnabled']
    if (!isObject(auth) || Object.keys(auth).length !== fields.length || fields.some(key => !(key in auth))
        || auth.scheme !== 'native-runtime-v1' || auth.agentId !== this.agentId
        || auth.runtimeInstanceId !== this.runtimeInstanceId || !/^agt_[0-9a-f]{32}$/.test(auth.agentId)
        || !exactValue(auth.tenantId, auth.tenantId, 50) || !auth.tenantId
        || !exactValue(auth.clientId, auth.clientId, 50) || !auth.clientId
        || typeof auth.contextPackEnabled !== 'boolean' || !/^[0-9a-f]{32}$/.test(payload.token)) return false
    this.#runtimeAbort = new AbortController()
    const signal = this.#runtimeAbort.signal
    this.#runtimeCredential = Object.freeze({ ...auth, token: payload.token, signal,
      invalidate: () => {
        if (this.#runtimeCredential?.signal !== signal) return
        this.disconnect()
        this.onInvalidated()
      }
    })
    return true
  }

  constructor({ agentId, runtimeInstanceId, timeoutMs = 10000,
    schedule = setTimeout, cancel = clearTimeout, logger = console, onInvalidated = () => {} } = {}) {
    this.agentId = agentId
    this.runtimeInstanceId = runtimeInstanceId
    this.timeoutMs = timeoutMs
    this.schedule = schedule
    this.cancel = cancel
    this.logger = logger
    this.onInvalidated = onInvalidated
    this.stage = 'idle'
    this.messageId = null
    this.timer = null
  }

  get registered() { return this.stage === 'registered' }

  snapshot() { return { stage: this.stage, registered: this.registered } }

  log(level, stage) {
    this.logger?.[level]?.(`registration stage=${stage}`)
  }

  clearTimer() {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
  }

  begin(messageId) {
    this.invalidateRuntime()
    this.clearTimer()
    this.stage = 'pending_ack'
    this.messageId = messageId
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
    if (!isObject(frame)) return null
    if (this.stage === 'registered' && frame.type === 'agent_status_updated') {
      const payload = framePayload(frame)
      if (payload?.agentId === this.agentId && payload?.runtimeInstanceId === this.runtimeInstanceId
          && ['offline', 'error'].includes(payload.status)) {
        this.invalidateRuntime()
        this.stage = 'rejected'
        return 'rejected'
      }
    }
    if (this.stage === 'registered' && ['error', 'protocol_error'].includes(frame.type)) {
      const payload = framePayload(frame)
      if (payload?.runtimeInstanceId === this.runtimeInstanceId
          || /^(?:AGENT_ID_(?:REQUIRED|CONFLICT|MISMATCH)|RUNTIME_INSTANCE_ID_(?:REQUIRED|INVALID|NOT_FIXED|MISMATCH)|AGENT_REGISTRATION_UNAVAILABLE)$/.test(payload?.code)) {
        this.invalidateRuntime()
        this.stage = 'rejected'
        return 'rejected'
      }
    }
    if (this.stage !== 'pending_ack') return null
    const payload = framePayload(frame)
    if (!isObject(payload) || !traceMatches(payload, this.messageId, this.runtimeInstanceId)) return null
    if (frame.type === 'agent_registered' && exactValue(payload.agentId, this.agentId, 100) &&
        payload.status === 'online' && validToken(payload.token)) {
      this.clearTimer()
      this.invalidateRuntime()
      if (!this.acceptRuntime(payload)) {
        this.stage = 'rejected'
        this.messageId = null
        this.log('warn', this.stage)
        return 'rejected'
      }
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
    this.invalidateRuntime()
    this.clearTimer()
    this.stage = 'disconnected'
    this.messageId = null
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
