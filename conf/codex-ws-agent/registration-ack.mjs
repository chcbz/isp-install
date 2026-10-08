const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactValue = (value, expected, max) => typeof value === 'string' && value === expected &&
  Buffer.byteLength(value) <= max && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value)
const exactText = (value, max) => typeof value === 'string' && Buffer.byteLength(value) > 0 &&
  Buffer.byteLength(value) <= max && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value)
const exactKeys = (value, fields) => isObject(value) && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
const framePayload = frame => isObject(frame?.data) ? frame.data : frame
const traceMatches = (payload, messageId, runtimeInstanceId) =>
  exactValue(payload?.messageId, messageId, 128) &&
  exactValue(payload?.runtimeInstanceId, runtimeInstanceId, 128)
const validNativeToken = token => typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)
const validLegacyToken = token => exactText(token, 512)
const RUNTIME_AUTH_FIELDS = ['agentId', 'clientId', 'contextPackEnabled', 'ownerJiacn', 'runtimeInstanceId', 'scheme', 'tenantId']

const runtimeScopeReceipt = (value, agentId, runtimeInstanceId) => {
  if (!exactKeys(value, RUNTIME_AUTH_FIELDS) || value.scheme !== 'native-runtime-v1' || value.tenantId !== '0'
      || !exactText(value.clientId, 50) || value.clientId === '0' || !exactText(value.ownerJiacn, 50) || value.ownerJiacn === '0'
      || !exactValue(value.agentId, agentId, 100) || !exactValue(value.runtimeInstanceId, runtimeInstanceId, 100)
      || typeof value.contextPackEnabled !== 'boolean') return null
  return Object.freeze({ ...value })
}

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
    this.confirmedRuntimeScope = null
    this._generation = 0
    this.timer = null
    this.waiters = new Set()
  }

  get registered() { return this.stage === 'registered' }
  get generation() { return this._generation }

  // Token and server-bound scope remain process-memory only; snapshots and logs never expose either.
  get runtimeAuthHeader() { return validNativeToken(this.runtimeToken) ? `AgentRuntime ${this.runtimeToken}` : '' }
  get nativeRuntimeAuthHeader() {
    return this.confirmedRuntimeScope && validNativeToken(this.runtimeToken) ? `AgentRuntime ${this.runtimeToken}` : ''
  }
  get runtimeScope() { return this.confirmedRuntimeScope ? Object.freeze({ ...this.confirmedRuntimeScope }) : null }

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

  clearAuthority() {
    this.runtimeToken = null
    this.confirmedRuntimeScope = null
  }

  begin(messageId) {
    this.clearTimer()
    this._generation += 1
    this.clearAuthority()
    this.stage = 'pending_ack'
    this.messageId = messageId
    this.log('log', this.stage)
    this.timer = this.schedule(() => {
      if (this.stage !== 'pending_ack' || this.messageId !== messageId) return
      this.timer = null
      // Observation timeout is not authority. The exact current request may still receive a late ACK.
      this.stage = 'ack_timeout'
      this.log('warn', this.stage)
    }, this.timeoutMs)
  }

  sendFailed(messageId) {
    if (this.stage !== 'pending_ack' || this.messageId !== messageId) return
    this.clearTimer()
    this.clearAuthority()
    this.stage = 'send_failed'
    this.messageId = null
    this.settleWaiters(false)
    this.log('warn', this.stage)
  }

  rejectCurrent() {
    this.clearTimer()
    this.clearAuthority()
    this.stage = 'rejected'
    this.messageId = null
    this.settleWaiters(false)
    this.log('warn', this.stage)
    return 'rejected'
  }

  observe(frame) {
    if (!['pending_ack', 'ack_timeout'].includes(this.stage) || !isObject(frame)) return null
    const payload = framePayload(frame)
    if (!isObject(payload) || !traceMatches(payload, this.messageId, this.runtimeInstanceId)) return null
    if (frame.type === 'agent_registered') {
      // Preserve the legacy observer contract for a correlated but invalid ordinary ACK:
      // it remains pending/observable rather than converting old chat paths into a hard rejection.
      if (!exactValue(payload.agentId, this.agentId, 100) || payload.status !== 'online') return null
      const hasRuntimeAuth = Object.prototype.hasOwnProperty.call(payload, 'runtimeAuth')
      const runtimeScope = hasRuntimeAuth ? runtimeScopeReceipt(payload.runtimeAuth, this.agentId, this.runtimeInstanceId) : null
      // Once the server claims native authority, malformed scope or a non-native token is
      // an explicit authority failure. A missing receipt remains a compatible legacy ACK.
      if (hasRuntimeAuth && (!runtimeScope || !validNativeToken(payload.token))) return this.rejectCurrent()
      if (!hasRuntimeAuth && !validLegacyToken(payload.token)) return null
      this.clearTimer()
      // A legacy ACK preserves ordinary chat/command registration but confers no
      // controlled native authority. Only the exact native receipt retains a token.
      this.runtimeToken = payload.token
      this.confirmedRuntimeScope = runtimeScope
      this.stage = 'registered'
      this.messageId = null
      this.settleWaiters(true)
      this.log('log', this.stage)
      return 'registered'
    }
    if (frame.type !== 'error' && frame.type !== 'protocol_error' && frame.messageType !== 'protocol.error') return null
    return this.rejectCurrent()
  }

  disconnect() {
    this.clearTimer()
    this._generation += 1
    this.clearAuthority()
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
