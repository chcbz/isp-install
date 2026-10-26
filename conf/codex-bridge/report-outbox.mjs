import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, resolve } from 'node:path'

export const EXECUTION_REPORT_RESULT_TYPE = 'CODEX_EXECUTION_RESULT'
export const WORK_RESULT_RECEIPT_TYPE = 'work.result.receipt'
export const EXECUTION_REPORT_RECEIPT_STATUS = 'ACCEPTED'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const safeString = value => typeof value === 'string' && value.trim() ? value : ''

export class ExecutionReportOutboxError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ExecutionReportOutboxError'
    this.code = code
  }
}

const fsyncDirectory = directory => {
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const ensurePrivateDirectory = directory => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  fsyncDirectory(directory)
}

const atomicWriteJson = (path, value) => {
  const directory = dirname(path)
  const temporary = resolve(directory, `.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    throw error
  }
}

const durableUnlink = path => {
  if (!existsSync(path)) return
  unlinkSync(path)
  fsyncDirectory(dirname(path))
}

const fingerprint = message => createHash('sha256').update(JSON.stringify({
  commandId: message.commandId,
  messageId: message.messageId,
  targetAgentId: message.targetAgentId
})).digest('hex')

const recordIdFor = message => createHash('sha256').update(`CYF_EXECUTION_REPORT_V1\0${fingerprint(message)}`).digest('hex')

export const buildExecutionReportEnvelope = ({ profile, command, outcome, runtimeInstanceId, messageId = randomUUID() }) => {
  if (!profile?.agentId) throw new ExecutionReportOutboxError('EXECUTION_REPORT_PROFILE_INVALID', 'registered profile agentId is required')
  for (const field of ['commandId', 'messageId', 'targetAgentId']) {
    if (!safeString(command?.[field])) {
      throw new ExecutionReportOutboxError('EXECUTION_REPORT_COMMAND_INVALID', `inbound ${field} is required for execution reporting`)
    }
  }
  if (command.targetAgentId !== profile.agentId) {
    throw new ExecutionReportOutboxError('EXECUTION_REPORT_TARGET_CONFLICT', 'inbound targetAgentId does not match the registered profile')
  }
  return {
    schemaVersion: 1,
    messageType: 'work.result',
    messageId,
    resultType: EXECUTION_REPORT_RESULT_TYPE,
    sourceAgentId: profile.agentId,
    agentId: profile.agentId,
    runtimeInstanceId: safeString(runtimeInstanceId),
    targetAgentId: command.targetAgentId,
    commandId: command.commandId,
    correlationId: command.messageId,
    status: outcome?.status === 'failed' ? 'FAILED' : 'SUCCEEDED',
    exitCode: Number.isSafeInteger(outcome?.exitCode) ? outcome.exitCode : null
  }
}

export class ExecutionReportOutbox {
  constructor({ profile, rootDir, runtimeInstanceId = '', now = () => Date.now(), createId = () => randomUUID() }) {
    if (!profile?.profileId || !profile?.agentId) throw new Error('profileId and agentId are required for execution reporting')
    this.profile = profile
    this.rootDir = resolve(rootDir)
    this.pendingDir = resolve(this.rootDir, 'pending')
    this.acknowledgedDir = resolve(this.rootDir, 'acknowledged')
    this.quarantineDir = resolve(this.rootDir, 'quarantine')
    this.scopePath = resolve(this.rootDir, 'scope.json')
    this.runtimeInstanceId = runtimeInstanceId
    this.now = now
    this.createId = createId
  }

  initialize() {
    for (const directory of [this.rootDir, this.pendingDir, this.acknowledgedDir, this.quarantineDir]) ensurePrivateDirectory(directory)
    const scope = { formatVersion: 1, profileId: this.profile.profileId, agentId: this.profile.agentId }
    if (existsSync(this.scopePath)) {
      let existing
      try { existing = JSON.parse(readFileSync(this.scopePath, 'utf8')) } catch {
        throw new ExecutionReportOutboxError('EXECUTION_REPORT_OUTBOX_CORRUPT', 'execution report scope is unreadable')
      }
      if (!isObject(existing) || existing.formatVersion !== 1 || existing.profileId !== scope.profileId || existing.agentId !== scope.agentId) {
        throw new ExecutionReportOutboxError('EXECUTION_REPORT_SCOPE_CONFLICT', 'execution report durable state belongs to another registered profile')
      }
      chmodSync(this.scopePath, 0o600)
    } else {
      atomicWriteJson(this.scopePath, scope)
    }
    this._reconcileAcknowledged()
  }

  _path(directory, recordId) { return resolve(directory, `${recordId}.json`) }

  _read(path, recordId, acknowledged = false) {
    let record
    try { record = JSON.parse(readFileSync(path, 'utf8')) } catch {
      throw new ExecutionReportOutboxError('EXECUTION_REPORT_OUTBOX_CORRUPT', `execution report ${recordId} is unreadable`)
    }
    if (!isObject(record) || record.formatVersion !== 1 || record.recordId !== recordId || !isObject(record.envelope)
        || typeof record.wire !== 'string' || record.wire !== JSON.stringify(record.envelope)
        || record.profileId !== this.profile.profileId || record.agentId !== this.profile.agentId) {
      throw new ExecutionReportOutboxError('EXECUTION_REPORT_OUTBOX_CORRUPT', `execution report ${recordId} is invalid`)
    }
    const envelope = record.envelope
    if (envelope.schemaVersion !== 1 || envelope.messageType !== 'work.result' || envelope.resultType !== EXECUTION_REPORT_RESULT_TYPE
        || envelope.sourceAgentId !== this.profile.agentId || envelope.agentId !== this.profile.agentId
        || !safeString(envelope.messageId) || !safeString(envelope.commandId) || !safeString(envelope.correlationId)
        || envelope.targetAgentId !== this.profile.agentId || !['SUCCEEDED', 'FAILED'].includes(envelope.status)) {
      throw new ExecutionReportOutboxError('EXECUTION_REPORT_OUTBOX_CORRUPT', `execution report ${recordId} has invalid identity or correlation`)
    }
    if (acknowledged && (!Number.isSafeInteger(record.acknowledgedAt) || !isObject(record.receipt))) {
      throw new ExecutionReportOutboxError('EXECUTION_REPORT_OUTBOX_CORRUPT', `acknowledged execution report ${recordId} is invalid`)
    }
    return record
  }

  _reconcileAcknowledged() {
    for (const fileName of readdirSync(this.acknowledgedDir).filter(name => name.endsWith('.json')).sort()) {
      const recordId = fileName.slice(0, -5)
      const acknowledged = this._read(this._path(this.acknowledgedDir, recordId), recordId, true)
      this._validateReceipt(acknowledged.receipt, acknowledged.envelope)
      const pending = this._path(this.pendingDir, recordId)
      if (existsSync(pending)) {
        const pendingRecord = this._read(pending, recordId)
        if (pendingRecord.wire !== acknowledged.wire) {
          throw new ExecutionReportOutboxError('EXECUTION_REPORT_OUTBOX_CORRUPT', 'pending execution report conflicts with receipt evidence')
        }
        durableUnlink(pending)
      }
    }
  }

  _validateReceipt(receipt, envelope) {
    if (!isObject(receipt) || receipt.messageType !== WORK_RESULT_RECEIPT_TYPE
        || receipt.resultType !== EXECUTION_REPORT_RESULT_TYPE || receipt.receiptStatus !== EXECUTION_REPORT_RECEIPT_STATUS
        || !safeString(receipt.messageId) || receipt.correlationId !== envelope.messageId
        || receipt.commandId !== envelope.commandId || receipt.targetAgentId !== envelope.targetAgentId) {
      throw new ExecutionReportOutboxError('EXECUTION_REPORT_RECEIPT_CONFLICT', 'work.result receipt does not match its durable execution report')
    }
  }

  isExecutionReceipt(message) {
    return isObject(message) && message.messageType === WORK_RESULT_RECEIPT_TYPE && message.resultType === EXECUTION_REPORT_RESULT_TYPE
  }

  enqueue(command, outcome) {
    const recordId = recordIdFor(command)
    const envelope = buildExecutionReportEnvelope({
      profile: this.profile, command, outcome, runtimeInstanceId: this.runtimeInstanceId, messageId: this.createId()
    })
    const pendingPath = this._path(this.pendingDir, recordId)
    const acknowledgedPath = this._path(this.acknowledgedDir, recordId)
    for (const [path, acknowledged] of [[pendingPath, false], [acknowledgedPath, true]]) {
      if (!existsSync(path)) continue
      const existing = this._read(path, recordId, acknowledged)
      if (existing.envelope.commandId !== envelope.commandId || existing.envelope.correlationId !== envelope.correlationId
          || existing.envelope.targetAgentId !== envelope.targetAgentId) {
        throw new ExecutionReportOutboxError('EXECUTION_REPORT_CORRELATION_CONFLICT', 'execution report record conflicts with inbound command correlation')
      }
      return { recordId, record: existing, state: acknowledged ? 'acknowledged' : 'pending' }
    }
    const record = {
      formatVersion: 1, recordId, profileId: this.profile.profileId, agentId: this.profile.agentId,
      createdAt: this.now(), sendAttempts: 0, lastSentAt: null, envelope, wire: JSON.stringify(envelope)
    }
    atomicWriteJson(pendingPath, record)
    return { recordId, record, state: 'pending' }
  }

  sendPending(sendFn) {
    if (typeof sendFn !== 'function') return 0
    let sent = 0
    for (const fileName of readdirSync(this.pendingDir).filter(name => name.endsWith('.json')).sort()) {
      const recordId = fileName.slice(0, -5)
      const path = this._path(this.pendingDir, recordId)
      const record = this._read(path, recordId)
      if (sendFn(record.wire) !== true) break
      atomicWriteJson(path, { ...record, sendAttempts: record.sendAttempts + 1, lastSentAt: this.now() })
      sent += 1
    }
    return sent
  }

  enqueueAndSend(command, outcome, sendFn) {
    const queued = this.enqueue(command, outcome)
    return { ...queued, sent: queued.state === 'pending' ? this.sendPending(sendFn) : 0 }
  }

  acknowledgeReceipt(message) {
    if (!this.isExecutionReceipt(message)) {
      throw new ExecutionReportOutboxError('EXECUTION_REPORT_RECEIPT_INVALID', 'not an execution report receipt')
    }
    for (const directory of [this.acknowledgedDir, this.pendingDir]) {
      for (const fileName of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
        const recordId = fileName.slice(0, -5)
        const path = this._path(directory, recordId)
        const record = this._read(path, recordId, directory === this.acknowledgedDir)
        if (record.envelope.messageId !== message.correlationId) continue
        this._validateReceipt(message, record.envelope)
        if (directory === this.acknowledgedDir) return { status: 'acknowledged', idempotent: true, recordId }
        atomicWriteJson(this._path(this.acknowledgedDir, recordId), {
          ...record, acknowledgedAt: this.now(), receipt: { ...message }
        })
        durableUnlink(path)
        return { status: 'acknowledged', idempotent: false, recordId }
      }
    }
    throw new ExecutionReportOutboxError('EXECUTION_REPORT_RECEIPT_CONFLICT', 'work.result receipt has no matching pending execution report')
  }

  pendingReports() {
    return readdirSync(this.pendingDir).filter(name => name.endsWith('.json')).sort().map(fileName =>
      this._read(this._path(this.pendingDir, fileName.slice(0, -5)), fileName.slice(0, -5)))
  }
}
