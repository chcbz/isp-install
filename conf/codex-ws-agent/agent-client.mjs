import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  unwatchFile,
  watchFile,
  writeFileSync
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

export const PROCESS_RUNTIME_INSTANCE_ID = randomUUID()
export const PROTOCOL_VERSION = 1
export const MESSAGE_TYPES = Object.freeze({
  PROTOCOL_HELLO: 'protocol.hello',
  PROTOCOL_ERROR: 'protocol.error',
  AGENT_REGISTER: 'agent.register',
  AGENT_PRESENCE: 'agent.presence',
  CHAT_MESSAGE: 'chat.message',
  CHAT_MESSAGE_DELTA: 'chat.message.delta',
  COMMAND_DISPATCH: 'command.dispatch',
  COMMAND_ACK: 'command.ack',
  WORK_PROGRESS: 'work.progress',
  WORK_HEARTBEAT: 'work.heartbeat',
  WORK_RESULT: 'work.result',
  HELP_REQUEST: 'help.request',
  ARTIFACT_PUBLISH: 'artifact.publish',
  TASK_EVENT: 'task.event'
})

const CANONICAL_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES))
const MESSAGE_ID_REQUIRED_TYPES = new Set([
  MESSAGE_TYPES.CHAT_MESSAGE,
  MESSAGE_TYPES.CHAT_MESSAGE_DELTA,
  MESSAGE_TYPES.COMMAND_DISPATCH,
  MESSAGE_TYPES.COMMAND_ACK,
  MESSAGE_TYPES.WORK_PROGRESS,
  MESSAGE_TYPES.WORK_HEARTBEAT,
  MESSAGE_TYPES.WORK_RESULT,
  MESSAGE_TYPES.HELP_REQUEST,
  MESSAGE_TYPES.ARTIFACT_PUBLISH,
  MESSAGE_TYPES.TASK_EVENT
])
const RESERVED_FIELDS = [
  'schemaVersion', 'tenantId', 'clientId', 'agentId', 'sourceAgentId', 'targetAgentId',
  'receiverAgentId', 'runtimeInstanceId', 'messageId', 'requestId', 'commandId', 'commandType',
  'correlationId', 'causationId', 'conversationId', 'taskId', 'workItemId',
  'issuedAt', 'sentAt', 'timestamp', 'expiresAt', 'attempt'
]
const INBOUND_CONTROL_TYPES = new Set([
  'connected', 'ping', 'pong', 'agent_registered', 'agent_status_updated',
  'agent_capability_index', 'protocol_error', 'error', 'task_reported'
])
const DISABLED_PROFILE_STATUSES = new Set(['disabled', 'inactive', 'unavailable'])

export class AgentProtocolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentProtocolError'
    this.code = code
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const sameEnvelopeValue = (left, right) => {
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isFinite(left) && Number.isFinite(right) && Object.is(left, right)
  }
  return JSON.stringify(left) === JSON.stringify(right)
}

const envelopeConflict = field => new AgentProtocolError(
  'ENVELOPE_FIELD_CONFLICT',
  `Conflicting values for reserved Envelope field or alias: ${field}`
)

const firstPresent = (layer, aliases) => {
  for (const alias of aliases) {
    if (hasOwn(layer, alias)) return { alias, value: layer[alias] }
  }
  return null
}

const validateAliasGroupWithinLayer = (layer, logicalField, aliases) => {
  const first = firstPresent(layer, aliases)
  if (!first) return
  for (const alias of aliases) {
    if (hasOwn(layer, alias) && !sameEnvelopeValue(first.value, layer[alias])) {
      throw envelopeConflict(logicalField)
    }
  }
}

const validateAliasGroupAcrossLayers = (outer, nested, logicalField, aliases) => {
  const left = firstPresent(outer, aliases)
  const right = firstPresent(nested, aliases)
  if (left && right && !sameEnvelopeValue(left.value, right.value)) {
    throw envelopeConflict(logicalField)
  }
}

const validateSchemaVersion = layer => {
  if (!hasOwn(layer, 'schemaVersion')) return
  const version = layer.schemaVersion
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version !== PROTOCOL_VERSION) {
    throw new AgentProtocolError('INVALID_SCHEMA_VERSION', 'schemaVersion must be the JSON integer 1')
  }
}

const validateRawSchemaVersionTokens = text => {
  let index = 0
  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1
  }
  const readStringToken = () => {
    const start = index
    index += 1
    let escaped = false
    while (index < text.length) {
      const character = text[index]
      index += 1
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') return text.slice(start, index)
    }
    return null
  }
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1
      continue
    }
    const token = readStringToken()
    if (!token) return
    let key
    try { key = JSON.parse(token) } catch { continue }
    const afterKey = index
    skipWhitespace()
    if (text[index] !== ':') {
      index = afterKey
      continue
    }
    index += 1
    skipWhitespace()
    if (key !== 'schemaVersion') continue
    if (text[index] !== '1') {
      throw new AgentProtocolError('INVALID_SCHEMA_VERSION', 'schemaVersion must be the JSON integer 1')
    }
    const following = text[index + 1]
    if (following && !/[\s,}]/.test(following)) {
      throw new AgentProtocolError('INVALID_SCHEMA_VERSION', 'schemaVersion must be the JSON integer 1')
    }
    index += 1
  }
}

const canonicalTypeAlias = type => {
  if (CANONICAL_MESSAGE_TYPES.has(type)) return type
  switch (type) {
    case 'agent.action': return MESSAGE_TYPES.COMMAND_DISPATCH
    case 'task_event':
    case 'task_assigned': return MESSAGE_TYPES.TASK_EVENT
    case 'agent.message':
    case 'agent.reply':
    case 'agent_message': return MESSAGE_TYPES.CHAT_MESSAGE
    case 'agent.message.delta':
    case 'agent_message_delta': return MESSAGE_TYPES.CHAT_MESSAGE_DELTA
    case 'protocol_error': return MESSAGE_TYPES.PROTOCOL_ERROR
    default: return null
  }
}

const typeDeclarations = (layer, layerName) => {
  const declarations = []
  for (const field of ['type', 'messageType']) {
    if (!hasOwn(layer, field)) continue
    const value = layer[field]
    if (typeof value !== 'string' || !value.trim()) {
      throw new AgentProtocolError('INVALID_MESSAGE_TYPE', `${layerName}.${field} must be a non-blank string`)
    }
    declarations.push({ field, value: value.trim(), layerName })
  }
  return declarations
}

const getEnvelopeValue = (outer, nested, aliases) => {
  const outerValue = firstPresent(outer, aliases)
  if (outerValue) return outerValue.value
  return firstPresent(nested, aliases)?.value
}

export const normalizeInboundMessage = raw => {
  let outer = raw
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    const rawText = raw.toString()
    validateRawSchemaVersionTokens(rawText)
    try {
      outer = JSON.parse(rawText)
    } catch (error) {
      throw new AgentProtocolError('INVALID_JSON', `Invalid JSON message: ${error.message}`)
    }
  }
  if (!isObject(outer)) {
    throw new AgentProtocolError('INVALID_ENVELOPE', 'Agent message must be a JSON object')
  }
  if (hasOwn(outer, 'payload') && !isObject(outer.payload)) {
    throw new AgentProtocolError('INVALID_PAYLOAD', 'payload must be a JSON object when present')
  }
  const nested = isObject(outer.payload) ? outer.payload : {}

  validateSchemaVersion(outer)
  validateSchemaVersion(nested)
  for (const field of RESERVED_FIELDS) {
    if (hasOwn(outer, field) && hasOwn(nested, field) && !sameEnvelopeValue(outer[field], nested[field])) {
      throw envelopeConflict(field)
    }
  }
  validateAliasGroupWithinLayer(outer, 'messageId', ['messageId', 'requestId'])
  validateAliasGroupWithinLayer(nested, 'messageId', ['messageId', 'requestId'])
  validateAliasGroupWithinLayer(outer, 'sourceAgentId', ['agentId', 'sourceAgentId'])
  validateAliasGroupWithinLayer(nested, 'sourceAgentId', ['agentId', 'sourceAgentId'])
  validateAliasGroupWithinLayer(outer, 'targetAgentId', ['targetAgentId', 'receiverAgentId'])
  validateAliasGroupWithinLayer(nested, 'targetAgentId', ['targetAgentId', 'receiverAgentId'])
  validateAliasGroupWithinLayer(outer, 'sentAt', ['sentAt', 'timestamp'])
  validateAliasGroupWithinLayer(nested, 'sentAt', ['sentAt', 'timestamp'])
  validateAliasGroupAcrossLayers(outer, nested, 'messageId', ['messageId', 'requestId'])
  validateAliasGroupAcrossLayers(outer, nested, 'sourceAgentId', ['agentId', 'sourceAgentId'])
  validateAliasGroupAcrossLayers(outer, nested, 'targetAgentId', ['targetAgentId', 'receiverAgentId'])
  validateAliasGroupAcrossLayers(outer, nested, 'sentAt', ['sentAt', 'timestamp'])

  const declarations = [...typeDeclarations(outer, 'outer'), ...typeDeclarations(nested, 'payload')]
  const messageTypeDeclarations = declarations.filter(({ field }) => field === 'messageType')
  if (!messageTypeDeclarations.length) {
    throw new AgentProtocolError('MESSAGE_TYPE_REQUIRED', 'An explicit messageType is required')
  }
  for (const declaration of messageTypeDeclarations) {
    if (!CANONICAL_MESSAGE_TYPES.has(declaration.value)) {
      throw new AgentProtocolError(
        'INVALID_MESSAGE_TYPE',
        `${declaration.layerName}.messageType must use a canonical Protocol v1 value`
      )
    }
  }

  let canonicalType = null
  let directWrapper = false
  for (const declaration of declarations) {
    if (declaration.field === 'type' && declaration.value === 'agent_direct_message') {
      directWrapper = true
      continue
    }
    const resolved = canonicalTypeAlias(declaration.value)
    if (!resolved) {
      throw new AgentProtocolError('UNSUPPORTED_MESSAGE_TYPE', `Unsupported Agent Protocol message type: ${declaration.value}`)
    }
    if (canonicalType && canonicalType !== resolved) {
      throw new AgentProtocolError('MESSAGE_TYPE_CONFLICT', 'type and messageType resolve to different Agent Protocol semantics')
    }
    canonicalType = resolved
  }
  if (!canonicalType || !CANONICAL_MESSAGE_TYPES.has(canonicalType)) {
    throw new AgentProtocolError('UNSUPPORTED_MESSAGE_TYPE', 'No supported canonical messageType was declared')
  }
  if (directWrapper && canonicalType !== MESSAGE_TYPES.CHAT_MESSAGE && canonicalType !== MESSAGE_TYPES.COMMAND_DISPATCH) {
    throw new AgentProtocolError(
      'MESSAGE_TYPE_CONFLICT',
      'agent_direct_message compatibility wrapper is limited to chat.message or command.dispatch'
    )
  }
  if (!hasOwn(outer, 'schemaVersion') && !hasOwn(nested, 'schemaVersion')) {
    throw new AgentProtocolError('SCHEMA_VERSION_REQUIRED', 'schemaVersion=1 is required for Protocol v1 messages')
  }

  const messageId = getEnvelopeValue(outer, nested, ['messageId', 'requestId'])
  if (MESSAGE_ID_REQUIRED_TYPES.has(canonicalType) && (typeof messageId !== 'string' || !messageId.trim())) {
    throw new AgentProtocolError('MESSAGE_ID_REQUIRED', `messageId is required for ${canonicalType}`)
  }

  const normalized = { ...nested, ...outer, payload: nested, schemaVersion: PROTOCOL_VERSION, messageType: canonicalType }
  normalized.messageId = messageId
  normalized.commandId = getEnvelopeValue(outer, nested, ['commandId'])
  normalized.commandType = getEnvelopeValue(outer, nested, ['commandType'])
  normalized.targetAgentId = getEnvelopeValue(outer, nested, ['targetAgentId', 'receiverAgentId'])
  normalized.sourceAgentId = getEnvelopeValue(outer, nested, ['sourceAgentId', 'agentId'])
  normalized.runtimeInstanceId = getEnvelopeValue(outer, nested, ['runtimeInstanceId'])
  normalized.taskId = getEnvelopeValue(outer, nested, ['taskId'])
  normalized.workItemId = getEnvelopeValue(outer, nested, ['workItemId'])
  normalized.attempt = getEnvelopeValue(outer, nested, ['attempt'])
  normalized.issuedAt = getEnvelopeValue(outer, nested, ['issuedAt'])
  normalized.expiresAt = getEnvelopeValue(outer, nested, ['expiresAt'])
  normalized.correlationId = getEnvelopeValue(outer, nested, ['correlationId'])
  normalized.causationId = getEnvelopeValue(outer, nested, ['causationId'])
  normalized.rawPayload = outer

  if (canonicalType === MESSAGE_TYPES.COMMAND_DISPATCH) {
    for (const [field, value] of [
      ['commandId', normalized.commandId],
      ['commandType', normalized.commandType],
      ['targetAgentId', normalized.targetAgentId]
    ]) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new AgentProtocolError(`${field.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}_REQUIRED`, `${field} is required for command.dispatch`)
      }
    }
  }

  return normalized
}

const parseNonNegativeMs = (value, fallback) => {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const hasFlag = flag => process.argv.slice(2).includes(flag)

const canExecute = targetPath => {
  try {
    accessSync(targetPath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

const resolveExecutable = command => {
  const value = String(command || '').trim()
  if (!value) return ''
  if (value.includes('/')) return canExecute(value) ? value : ''
  for (const dir of String(process.env.PATH || '').split(':').filter(Boolean)) {
    const candidate = resolve(dir, value)
    if (canExecute(candidate)) return candidate
  }
  return ''
}

const parseScalarValue = rawValue => {
  const value = String(rawValue || '').trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

const configError = (message, exitOnError = true) => {
  if (exitOnError) {
    console.error(message)
    process.exit(1)
  }
  throw new Error(message)
}

const parseSectionProfiles = (raw, fallbackProfile, options = {}) => {
  const exitOnError = options.exitOnError !== false
  const profiles = []
  let current = null
  let defaults = {}
  for (const originalLine of String(raw).split(/\r?\n/)) {
    const line = originalLine.trim()
    if (!line || line.startsWith('#')) continue
    if (/^\[(default|profile\.default|agent\.default)\]$/.test(line)) {
      if (current) profiles.push(current)
      current = { __section: 'default' }
      continue
    }
    const sectionMatch = line.match(/^\[(agent|profile)\.([^\]]+)\]$/)
    if (sectionMatch) {
      if (current) profiles.push(current)
      current = { profileId: sectionMatch[2] }
      continue
    }
    if (!current) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    current[line.slice(0, index).trim()] = parseScalarValue(line.slice(index + 1).trim())
  }
  if (current) profiles.push(current)
  const defaultIndex = profiles.findIndex(profile => profile.__section === 'default')
  if (defaultIndex >= 0) {
    defaults = { ...profiles[defaultIndex] }
    delete defaults.__section
    profiles.splice(defaultIndex, 1)
  }
  if (!profiles.length) configError('CODEX_PROFILES_FILE section format is empty or invalid', exitOnError)
  return profiles.map((profile, index) => normalizeProfile({ ...defaults, ...profile }, fallbackProfile, index))
}

const normalizeProfile = (profile, fallback = {}, index = 0) => {
  const agentId = profile.agentId || fallback.agentId || `local-codex-${index + 1}`
  const status = String(profile.status || fallback.status || '').trim().toLowerCase()
  return {
    profileId: profile.profileId || agentId,
    agentId,
    agentName: profile.agentName || fallback.agentName || `本地 Codex ${index + 1}`,
    personaName: profile.personaName || fallback.personaName || profile.agentName || fallback.agentName || `Codex ${index + 1}`,
    apiKey: profile.apiKey || fallback.apiKey || '',
    codexBin: profile.codexBin || fallback.codexBin || 'codex',
    codexHome: profile.codexHome || fallback.codexHome || '',
    codexWorkdir: profile.codexWorkdir || fallback.codexWorkdir || process.cwd(),
    codexSandbox: profile.codexSandbox || fallback.codexSandbox || 'workspace-write',
    codexApproval: profile.codexApproval || fallback.codexApproval || 'never',
    codexSessionMode: profile.codexSessionMode || fallback.codexSessionMode || 'new',
    codexTimeoutMs: parseNonNegativeMs(profile.codexTimeoutMs, fallback.codexTimeoutMs || 900000),
    enabled: profile.enabled !== false && profile.active !== false && !DISABLED_PROFILE_STATUSES.has(status),
    status,
    isDefault: profile.isDefault === true
  }
}

const legacyProfile = () => normalizeProfile({
  profileId: process.env.CODEX_PROFILE_ID || process.env.AGENT_ID || 'default',
  agentId: process.env.AGENT_ID || 'local-codex',
  agentName: process.env.AGENT_NAME || '本地 Codex',
  personaName: process.env.AGENT_PERSONA || '吴用',
  codexBin: process.env.CODEX_BIN || 'codex',
  codexHome: process.env.CODEX_HOME || '',
  codexWorkdir: process.env.CODEX_WORKDIR || process.cwd(),
  codexSandbox: process.env.CODEX_SANDBOX || 'workspace-write',
  codexApproval: process.env.CODEX_APPROVAL || 'never',
  codexSessionMode: process.env.CODEX_SESSION_MODE || 'new',
  codexTimeoutMs: parseNonNegativeMs(process.env.CODEX_TIMEOUT_MS, 900000),
  isDefault: true
})

const loadProfilesRaw = (options = {}) => {
  const profilesFile = process.env.CODEX_PROFILES_FILE?.trim()
  if (profilesFile) {
    try {
      return readFileSync(resolve(profilesFile), 'utf8')
    } catch (error) {
      configError(`failed to read CODEX_PROFILES_FILE ${profilesFile}: ${error.message}`, options.exitOnError !== false)
    }
  }
  return process.env.CODEX_PROFILES || ''
}

const parseProfiles = (raw, fallbackProfile, options = {}) => {
  const exitOnError = options.exitOnError !== false
  if (!raw || !String(raw).trim()) return [fallbackProfile]
  const text = String(raw).trim()
  if (/^\[(agent|profile)\./m.test(text)) return parseSectionProfiles(text, fallbackProfile, { exitOnError })
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    configError(`CODEX_PROFILES must be valid JSON: ${error.message}`, exitOnError)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) configError('CODEX_PROFILES must be a non-empty JSON array', exitOnError)
  return parsed.map((profile, index) => normalizeProfile(profile || {}, fallbackProfile, index))
}

const loadRuntimeConfig = (options = {}) => {
  const loadedProfiles = parseProfiles(loadProfilesRaw(options), legacyProfile(), options).filter(profile => profile.enabled)
  if (!loadedProfiles.length) configError('CODEX_PROFILES has no enabled profiles', options.exitOnError !== false)
  const configuredDefaultProfile = process.env.DEFAULT_CODEX_PROFILE
  const selected = configuredDefaultProfile && loadedProfiles.find(
    profile => profile.profileId === configuredDefaultProfile || profile.agentId === configuredDefaultProfile
  )
  return {
    profiles: loadedProfiles,
    defaultProfileId: selected?.profileId || loadedProfiles.find(profile => profile.isDefault)?.profileId || loadedProfiles[0].profileId
  }
}

let config = null
let defaultProfile = null
let shuttingDown = false
let shutdownStarted = false
let profileReloadTimer = null
let profileReloadInFlight = false
let lastProfileSignature = ''
let codexSessionMapPath = ''
let codexSessionMap = {}
const currentRuns = new Map()
const profileStates = new Map()
let WebSocketClient = globalThis.WebSocket || null

const DEFAULT_FS_OPERATIONS = Object.freeze({
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
})

const fsyncDirectory = (fs, directory) => {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

const ensureSecureDirectory = (fs, directory) => {
  const existed = fs.existsSync(directory)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  fsyncDirectory(fs, directory)
  if (!existed) fsyncDirectory(fs, dirname(directory))
}

const forceSecureFileMode = (fs, filePath) => {
  fs.chmodSync(filePath, 0o600)
  const descriptor = fs.openSync(filePath, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

const atomicWriteText = (fs, targetPath, text) => {
  const directory = dirname(targetPath)
  const directoryExisted = fs.existsSync(directory)
  fs.mkdirSync(directory, { recursive: true })
  if (!directoryExisted) {
    fsyncDirectory(fs, directory)
    fsyncDirectory(fs, dirname(directory))
  }
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, text, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, targetPath)
    forceSecureFileMode(fs, targetPath)
    fsyncDirectory(fs, directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    throw error
  }
}

const atomicWriteJson = (fs, targetPath, value) => atomicWriteText(fs, targetPath, `${JSON.stringify(value, null, 2)}\n`)

const durableRename = (fs, sourcePath, targetPath, mode = 0o600) => {
  const sourceDirectory = dirname(sourcePath)
  const targetDirectory = dirname(targetPath)
  fs.renameSync(sourcePath, targetPath)
  if (mode === 0o600) forceSecureFileMode(fs, targetPath)
  else fs.chmodSync(targetPath, mode)
  fsyncDirectory(fs, sourceDirectory)
  if (targetDirectory !== sourceDirectory) fsyncDirectory(fs, targetDirectory)
}

const durableUnlink = (fs, targetPath) => {
  const directory = dirname(targetPath)
  fs.unlinkSync(targetPath)
  fsyncDirectory(fs, directory)
}

const safeProfileDirectory = profile => Buffer.from(String(profile.agentId), 'utf8').toString('hex')
const equalRecordField = (left, right) => sameEnvelopeValue(left ?? '', right ?? '')

export class PersistentCommandInbox {
  constructor({
    rootDir,
    profile,
    successPolicy = 'archive',
    now = () => Date.now(),
    createId = () => randomUUID(),
    fs = DEFAULT_FS_OPERATIONS
  }) {
    if (!profile?.agentId || !profile?.profileId) throw new Error('profileId and agentId are required for the command inbox')
    if (!['archive', 'delete'].includes(successPolicy)) throw new Error('successPolicy must be archive or delete')
    this.rootDir = resolve(rootDir)
    this.profile = profile
    this.successPolicy = successPolicy
    this.now = now
    this.createId = createId
    this.fs = { ...DEFAULT_FS_OPERATIONS, ...fs }
    this.profileDir = resolve(this.rootDir, safeProfileDirectory(profile))
    this.pendingDir = resolve(this.profileDir, 'pending')
    this.processingDir = resolve(this.profileDir, 'processing')
    this.archiveDir = resolve(this.profileDir, 'archive')
    this.recoveryDir = resolve(this.profileDir, 'recovery-required')
    this.quarantineDir = resolve(this.profileDir, 'quarantine')
    this.sequencePath = resolve(this.profileDir, 'sequence.json')
    this.lastSequence = 0
  }

  initialize() {
    ensureSecureDirectory(this.fs, this.rootDir)
    ensureSecureDirectory(this.fs, this.profileDir)
    for (const directory of [this.pendingDir, this.processingDir, this.archiveDir, this.recoveryDir, this.quarantineDir]) {
      ensureSecureDirectory(this.fs, directory)
    }
    this.secureExistingQueueFiles()
    this.loadSequence()
    return this.recover()
  }

  secureExistingQueueFiles() {
    for (const directory of [this.pendingDir, this.processingDir, this.archiveDir, this.recoveryDir, this.quarantineDir]) {
      for (const fileName of this.fs.readdirSync(directory)) {
        if (!fileName.endsWith('.json') && !fileName.endsWith('.reason.txt')) continue
        const filePath = resolve(directory, fileName)
        if (this.fs.statSync(filePath).isFile()) forceSecureFileMode(this.fs, filePath)
      }
    }
  }

  loadSequence() {
    let persisted = 0
    if (this.fs.existsSync(this.sequencePath)) {
      forceSecureFileMode(this.fs, this.sequencePath)
      const sequence = JSON.parse(this.fs.readFileSync(this.sequencePath, 'utf8'))
      if (!isObject(sequence) || sequence.formatVersion !== 1
          || !Number.isSafeInteger(sequence.lastSequence) || sequence.lastSequence < 0) {
        throw new Error('invalid persistent queue sequence state')
      }
      persisted = sequence.lastSequence
    }
    let observed = 0
    for (const directory of [this.pendingDir, this.processingDir, this.archiveDir, this.recoveryDir, this.quarantineDir]) {
      for (const fileName of this.listJsonFiles(directory)) {
        const filePath = resolve(directory, fileName)
        forceSecureFileMode(this.fs, filePath)
        try {
          const record = JSON.parse(this.fs.readFileSync(filePath, 'utf8'))
          if (Number.isSafeInteger(record?.queueSequence) && record.queueSequence > observed) observed = record.queueSequence
        } catch {}
      }
    }
    this.lastSequence = Math.max(persisted, observed)
    if (!this.fs.existsSync(this.sequencePath) || this.lastSequence !== persisted) this.persistSequence()
  }

  persistSequence() {
    atomicWriteJson(this.fs, this.sequencePath, { formatVersion: 1, lastSequence: this.lastSequence })
  }

  nextSequence() {
    if (this.lastSequence >= Number.MAX_SAFE_INTEGER) throw new Error('persistent queue sequence exhausted')
    this.lastSequence += 1
    this.persistSequence()
    return this.lastSequence
  }

  enqueue(message) {
    const normalized = normalizeInboundMessage(message?.rawPayload || message)
    if (normalized.messageType !== MESSAGE_TYPES.COMMAND_DISPATCH) {
      throw new AgentProtocolError('COMMAND_MESSAGE_TYPE_REQUIRED', 'Only command.dispatch may enter the persistent inbox')
    }
    if (normalized.targetAgentId !== this.profile.agentId) {
      throw new AgentProtocolError('TARGET_AGENT_ID_MISMATCH', 'targetAgentId does not match this Agent profile')
    }
    const queueSequence = this.nextSequence()
    const now = this.now()
    const queueId = this.createId()
    const record = {
      formatVersion: 1,
      queueId,
      queueSequence,
      profileId: this.profile.profileId,
      agentId: this.profile.agentId,
      state: 'pending',
      receivedAt: now,
      enqueuedAt: now,
      messageId: normalized.messageId || '',
      commandId: normalized.commandId || '',
      commandType: normalized.commandType || '',
      targetAgentId: normalized.targetAgentId || '',
      taskId: normalized.taskId || '',
      workItemId: normalized.workItemId || '',
      attempt: Number.isSafeInteger(normalized.attempt) ? normalized.attempt : 0,
      issuedAt: Number.isSafeInteger(normalized.issuedAt) ? normalized.issuedAt : null,
      expiresAt: Number.isSafeInteger(normalized.expiresAt) ? normalized.expiresAt : null,
      correlationId: normalized.correlationId || '',
      causationId: normalized.causationId || '',
      rawPayload: normalized.rawPayload
    }
    const fileName = `${String(queueSequence).padStart(20, '0')}-${queueId}.json`
    const targetPath = resolve(this.pendingDir, fileName)
    atomicWriteJson(this.fs, targetPath, record)
    return { record, normalized, fileName, path: targetPath }
  }

  recover() {
    const result = {
      recovered: 0,
      completed: 0,
      quarantined: 0,
      recoveryRequired: 0,
      recoveryRecords: [],
      completedRecords: []
    }
    for (const fileName of this.listJsonFiles(this.pendingDir)) {
      const filePath = resolve(this.pendingDir, fileName)
      try {
        this.readAndValidate(filePath, new Set(['pending']))
      } catch (error) {
        this.quarantine(filePath, error)
        result.quarantined += 1
      }
    }
    for (const fileName of this.listJsonFiles(this.recoveryDir)) {
      const filePath = resolve(this.recoveryDir, fileName)
      try {
        const validated = this.readAndValidate(filePath, new Set(['recovery_required']))
        result.recoveryRecords.push({ ...validated, fileName, path: filePath })
        result.recoveryRequired += 1
      } catch (error) {
        this.quarantine(filePath, error)
        result.quarantined += 1
      }
    }
    for (const fileName of this.listJsonFiles(this.processingDir)) {
      const sourcePath = resolve(this.processingDir, fileName)
      let validated
      try {
        validated = this.readAndValidate(sourcePath, new Set(['pending', 'processing', 'completed', 'recovery_required']))
      } catch (error) {
        this.quarantine(sourcePath, error)
        result.quarantined += 1
        continue
      }
      if (validated.record.state === 'completed' && validated.record.outcome) {
        result.completedRecords.push(validated)
        this.settleCompletedFile(sourcePath, fileName, validated.record)
        result.completed += 1
        continue
      }
      const record = validated.record.state === 'recovery_required'
        ? validated.record
        : {
            ...validated.record,
            profileId: this.profile.profileId,
            state: 'recovery_required',
            recoveredAt: this.now(),
            recoveryReason: 'PROCESSING_OUTCOME_UNKNOWN: automatic re-execution is forbidden',
            recoveryCount: Number(validated.record.recoveryCount || 0) + 1
          }
      // Persist the non-executable state before moving directories. A crash after
      // this write but before rename is recovered as recovery_required, never rerun.
      if (validated.record.state !== 'recovery_required') atomicWriteJson(this.fs, sourcePath, record)
      const recoveryPath = this.uniquePath(this.recoveryDir, fileName)
      durableRename(this.fs, sourcePath, recoveryPath)
      result.recoveryRecords.push({ record, normalized: validated.normalized, fileName, path: recoveryPath })
      result.recoveryRequired += 1
    }
    return result
  }

  claimNext() {
    const candidates = []
    for (const fileName of this.listJsonFiles(this.pendingDir)) {
      const filePath = resolve(this.pendingDir, fileName)
      try {
        candidates.push({ fileName, filePath, ...this.readAndValidate(filePath, new Set(['pending'])) })
      } catch (error) {
        this.quarantine(filePath, error)
      }
    }
    candidates.sort((left, right) => left.record.queueSequence - right.record.queueSequence || left.record.queueId.localeCompare(right.record.queueId))
    const next = candidates[0]
    if (!next) return null
    const processingPath = resolve(this.processingDir, next.fileName)
    durableRename(this.fs, next.filePath, processingPath)
    const record = { ...next.record, profileId: this.profile.profileId, state: 'processing', startedAt: this.now() }
    atomicWriteJson(this.fs, processingPath, record)
    return { record, normalized: next.normalized, fileName: next.fileName, path: processingPath }
  }

  assertExecutable(item) {
    const validated = this.readAndValidate(item.path, new Set(['processing']))
    if (validated.normalized.messageType !== MESSAGE_TYPES.COMMAND_DISPATCH) {
      throw new AgentProtocolError('COMMAND_MESSAGE_TYPE_REQUIRED', 'Only command.dispatch may execute from the persistent inbox')
    }
    return validated
  }

  markCompleted(item, outcome) {
    const completed = {
      ...item.record,
      state: 'completed',
      completedAt: this.now(),
      outcome: {
        status: outcome?.status || 'completed',
        exitCode: outcome?.exitCode ?? null,
        errorMessage: outcome?.errorMessage || ''
      }
    }
    atomicWriteJson(this.fs, item.path, completed)
    return completed
  }

  complete(item, outcome) {
    const completed = this.markCompleted(item, outcome)
    this.settleCompletedFile(item.path, item.fileName, completed)
    return completed
  }

  restoreProcessing(item, reason = 'interrupted') {
    if (!item?.path || !this.fs.existsSync(item.path)) return null
    const pendingPath = this.uniquePath(this.pendingDir, item.fileName)
    durableRename(this.fs, item.path, pendingPath)
    const restored = {
      ...item.record,
      state: 'pending',
      recoveredAt: this.now(),
      recoveryReason: reason,
      recoveryCount: Number(item.record.recoveryCount || 0) + 1
    }
    atomicWriteJson(this.fs, pendingPath, restored)
    return { record: restored, fileName: pendingPath.split('/').pop(), path: pendingPath }
  }

  markRecoveryRequired(item, reason) {
    if (!item?.path || !this.fs.existsSync(item.path)) throw new Error('claimed command file is missing')
    const validated = this.readAndValidate(item.path, new Set(['pending', 'processing', 'recovery_required']))
    const record = validated.record.state === 'recovery_required'
      ? validated.record
      : {
          ...validated.record,
          profileId: this.profile.profileId,
          state: 'recovery_required',
          recoveredAt: this.now(),
          recoveryReason: reason || 'PROCESSING_OUTCOME_UNKNOWN: automatic re-execution is forbidden',
          recoveryCount: Number(validated.record.recoveryCount || 0) + 1
        }
    if (validated.record.state !== 'recovery_required') atomicWriteJson(this.fs, item.path, record)
    if (dirname(item.path) === this.recoveryDir) {
      return { record, normalized: validated.normalized, fileName: item.fileName, path: item.path }
    }
    const recoveryPath = this.uniquePath(this.recoveryDir, item.fileName)
    durableRename(this.fs, item.path, recoveryPath)
    return {
      record,
      normalized: validated.normalized,
      fileName: recoveryPath.split('/').pop(),
      path: recoveryPath
    }
  }

  commandStateIndex() {
    const index = new Map()
    const errors = []
    const locations = [
      { directory: this.pendingDir, expectedStates: new Set(['pending']) },
      { directory: this.processingDir, expectedStates: new Set(['pending', 'processing', 'completed', 'recovery_required']) },
      { directory: this.archiveDir, expectedStates: new Set(['completed']) },
      { directory: this.recoveryDir, expectedStates: new Set(['recovery_required']) }
    ]
    for (const { directory, expectedStates } of locations) {
      for (const fileName of this.listJsonFiles(directory)) {
        const path = resolve(directory, fileName)
        try {
          const validated = this.readAndValidate(path, expectedStates)
          const item = { ...validated, fileName, path }
          const records = index.get(validated.normalized.commandId) || []
          records.push(item)
          index.set(validated.normalized.commandId, records)
        } catch (error) {
          try { this.quarantine(path, error) } catch {}
          errors.push(`${fileName}: ${error.message}`)
        }
      }
    }
    if (errors.length) {
      throw new AgentProtocolError('COMMAND_INBOX_CORRUPT', `Inbox records quarantined during reconciliation: ${errors.join('; ')}`)
    }
    return index
  }

  count(state = 'pending') {
    const directory = state === 'processing' ? this.processingDir
      : state === 'archive' ? this.archiveDir
      : state === 'recovery' || state === 'recovery_required' ? this.recoveryDir
      : this.pendingDir
    return this.listJsonFiles(directory).length
  }

  list(state = 'pending') {
    const directory = state === 'processing' ? this.processingDir
      : state === 'archive' ? this.archiveDir
      : state === 'recovery' || state === 'recovery_required' ? this.recoveryDir
      : this.pendingDir
    const expectedStates = state === 'archive' ? new Set(['completed'])
      : state === 'recovery' ? new Set(['recovery_required'])
      : new Set([state])
    return this.listJsonFiles(directory).map(fileName => this.readAndValidate(resolve(directory, fileName), expectedStates).record)
  }

  listJsonFiles(directory) {
    try {
      return this.fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  readAndValidate(filePath, expectedStates = null) {
    forceSecureFileMode(this.fs, filePath)
    let record
    try {
      record = JSON.parse(this.fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
      throw new Error(`invalid inbox JSON: ${error.message}`)
    }
    if (!isObject(record) || record.formatVersion !== 1 || typeof record.queueId !== 'string'
        || !Number.isSafeInteger(record.queueSequence) || record.queueSequence <= 0 || !isObject(record.rawPayload)) {
      throw new Error('invalid inbox record shape')
    }
    if (record.agentId !== this.profile.agentId) throw new Error('inbox record canonical agent identity mismatch')
    if (expectedStates && !expectedStates.has(record.state)) throw new Error(`invalid inbox record state: ${record.state}`)
    if (record.state === 'completed') {
      if (!isObject(record.outcome) || !['completed', 'failed'].includes(record.outcome.status)) {
        throw new Error('completed inbox record requires a valid outcome marker')
      }
    } else if (hasOwn(record, 'outcome')) {
      throw new Error('non-completed inbox record must not contain an outcome marker')
    }
    if (record.state === 'recovery_required' && typeof record.recoveryReason !== 'string') {
      throw new Error('recovery-required inbox record requires a recoveryReason')
    }
    let normalized
    try {
      normalized = normalizeInboundMessage(record.rawPayload)
    } catch (error) {
      throw new Error(`invalid persisted command envelope: ${error.code || error.message}`)
    }
    if (normalized.messageType !== MESSAGE_TYPES.COMMAND_DISPATCH) throw new Error('persisted record is not command.dispatch')
    if (normalized.targetAgentId !== this.profile.agentId) throw new Error('persisted command targetAgentId mismatch')
    for (const field of ['messageId', 'commandId', 'commandType', 'targetAgentId']) {
      if (!equalRecordField(record[field], normalized[field])) throw new Error(`persisted command ${field} mismatch`)
    }
    return { record, normalized }
  }

  quarantine(sourcePath, error) {
    if (!this.fs.existsSync(sourcePath)) return
    const baseName = sourcePath.split('/').pop()
    const targetPath = this.uniquePath(this.quarantineDir, baseName)
    durableRename(this.fs, sourcePath, targetPath)
    atomicWriteText(this.fs, `${targetPath}.reason.txt`, `${new Date(this.now()).toISOString()} ${error.message}\n`)
  }

  settleCompletedFile(sourcePath, fileName, record) {
    if (record.outcome?.status === 'completed' && this.successPolicy === 'delete') {
      durableUnlink(this.fs, sourcePath)
      return
    }
    durableRename(this.fs, sourcePath, this.uniquePath(this.archiveDir, fileName))
  }

  uniquePath(directory, fileName) {
    let candidate = resolve(directory, fileName)
    if (!this.fs.existsSync(candidate)) return candidate
    const suffix = fileName.endsWith('.json') ? '.json' : ''
    const stem = suffix ? fileName.slice(0, -suffix.length) : fileName
    candidate = resolve(directory, `${stem}-${this.createId()}${suffix}`)
    return candidate
  }
}

// --- A06: Command Deduplication & Acknowledgement ---

export const ACK_STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  STARTED: 'STARTED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED'
})

export const LEDGER_STATUS = Object.freeze({
  ...ACK_STATUS,
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED'
})

const ACK_STATUS_VALUES = new Set(Object.values(ACK_STATUS))
const LEDGER_STATUS_VALUES = new Set(Object.values(LEDGER_STATUS))
const TERMINAL_LEDGER_STATUSES = new Set([ACK_STATUS.SUCCEEDED, ACK_STATUS.FAILED, ACK_STATUS.REJECTED])
const FINGERPRINT_TRANSPORT_FIELDS = new Set([
  'schemaVersion', 'type', 'messageType', 'messageId', 'message_id', 'requestId', 'request_id', 'commandId',
  'runtimeInstanceId', 'runtime_instance_id', 'runtimeId', 'runtime_id', 'runtime',
  'tenantId', 'clientId', 'profileId',
  'agentId', 'sourceAgentId', 'senderAgentId', 'senderId', 'senderType', 'senderName',
  'receiverAgentId', 'correlationId', 'correlation_id', 'causationId', 'causation_id',
  'conversationId', 'conversation_id', 'traceId', 'trace_id', 'spanId', 'span_id',
  'timestamp', 'sentAt', 'sent_at', 'issuedAt', 'issued_at', 'expiresAt', 'expires_at', 'attempt',
  'sessionId', 'session_id', 'session', 'runtimeSessionId', 'codexSessionId'
])
const FINGERPRINT_SEMANTIC_ENVELOPE_FIELDS = Object.freeze([
  'commandType', 'targetAgentId', 'taskId', 'workItemId'
])
const FINGERPRINT_COMPAT_BUSINESS_FIELDS = Object.freeze([
  'prompt', 'content', 'instruction', 'description', 'title', 'currentTaskTitle'
])
const FINGERPRINT_PAYLOAD_ROOT_CONTROL_FIELDS = new Set([
  ...FINGERPRINT_TRANSPORT_FIELDS,
  ...FINGERPRINT_SEMANTIC_ENVELOPE_FIELDS
])

const computeSha256 = text => {
  const hash = createHash('sha256')
  hash.update(text, 'utf8')
  return hash.digest('hex')
}

const canonicalizeFingerprintValue = (value, path = '$') => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentProtocolError('INVALID_COMMAND_PAYLOAD', `${path} must contain finite JSON numbers`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalizeFingerprintValue(entry, `${path}[${index}]`))
  }
  if (!isObject(value)) {
    throw new AgentProtocolError('INVALID_COMMAND_PAYLOAD', `${path} contains a non-JSON value`)
  }
  const canonical = {}
  for (const key of Object.keys(value).sort()) {
    if (FINGERPRINT_TRANSPORT_FIELDS.has(key) || value[key] === undefined) continue
    canonical[key] = canonicalizeFingerprintValue(value[key], `${path}.${key}`)
  }
  return canonical
}

const buildFingerprintSource = normalized => {
  const businessPayload = {}
  if (isObject(normalized?.payload)) {
    for (const key of Object.keys(normalized.payload).sort()) {
      if (FINGERPRINT_PAYLOAD_ROOT_CONTROL_FIELDS.has(key) || normalized.payload[key] === undefined) continue
      businessPayload[key] = normalized.payload[key]
    }
  }
  for (const field of FINGERPRINT_COMPAT_BUSINESS_FIELDS) {
    if (hasOwn(normalized || {}, field) && normalized[field] !== undefined) businessPayload[field] = normalized[field]
  }
  return {
    commandType: String(normalized?.commandType || ''),
    targetAgentId: String(normalized?.targetAgentId || ''),
    taskId: String(normalized?.taskId || ''),
    workItemId: String(normalized?.workItemId || ''),
    businessPayload: canonicalizeFingerprintValue(businessPayload)
  }
}

export class CommandFingerprint {
  static compute(normalized) {
    return computeSha256(JSON.stringify(canonicalizeFingerprintValue(buildFingerprintSource(normalized))))
  }
}

export class DurableDedupeLedger {
  constructor({ rootDir, profile, now = () => Date.now(), createId = () => randomUUID(), fs = DEFAULT_FS_OPERATIONS }) {
    if (!profile?.agentId) throw new Error('profile.agentId is required for the dedupe ledger')
    this.rootDir = resolve(rootDir)
    this.profile = profile
    this.now = now
    this.createId = createId
    this.fs = { ...DEFAULT_FS_OPERATIONS, ...fs }
    this.ledgerDir = resolve(this.rootDir, 'ledger')
    this.conflictsDir = resolve(this.rootDir, 'ledger-conflicts')
    this.quarantineDir = resolve(this.rootDir, 'ledger-quarantine')
    this.blockedDir = resolve(this.rootDir, 'ledger-blocked')
    this.corruptions = []
  }

  initialize() {
    for (const directory of [this.ledgerDir, this.conflictsDir, this.quarantineDir, this.blockedDir]) {
      ensureSecureDirectory(this.fs, directory)
    }
    this.corruptions = []
    for (const fileName of this.fs.readdirSync(this.blockedDir)) {
      if (!fileName.endsWith('.json')) continue
      const path = resolve(this.blockedDir, fileName)
      forceSecureFileMode(this.fs, path)
      try {
        const marker = JSON.parse(this.fs.readFileSync(path, 'utf8'))
        this.corruptions.push(isObject(marker) ? marker : { reason: 'invalid ledger blocked marker', fileName })
      } catch (error) {
        this.corruptions.push({ reason: `invalid ledger blocked marker: ${error.message}`, fileName })
      }
    }
    for (const fileName of this.fs.readdirSync(this.ledgerDir)) {
      if (!fileName.endsWith('.json')) continue
      const path = resolve(this.ledgerDir, fileName)
      forceSecureFileMode(this.fs, path)
      const commandId = this._decodeCommandId(fileName)
      try {
        const entry = JSON.parse(this.fs.readFileSync(path, 'utf8'))
        this._validateEntry(entry, commandId || undefined)
      } catch (error) {
        this._quarantineLedgerFile(path, commandId, error)
      }
    }
    for (const fileName of this.fs.readdirSync(this.conflictsDir)) {
      if (!fileName.endsWith('.json')) continue
      const path = resolve(this.conflictsDir, fileName)
      forceSecureFileMode(this.fs, path)
      try {
        this._validateConflict(JSON.parse(this.fs.readFileSync(path, 'utf8')), fileName.slice(0, -5))
      } catch (error) {
        this._quarantineLedgerFile(path, '', error)
      }
    }
    for (const directory of [this.quarantineDir, this.blockedDir]) {
      for (const fileName of this.fs.readdirSync(directory)) {
        if (fileName.endsWith('.json') || fileName.endsWith('.reason.txt')) {
          forceSecureFileMode(this.fs, resolve(directory, fileName))
        }
      }
    }
    return { corruptions: this.corruptions.length }
  }

  hasCorruption() {
    return this.corruptions.length > 0
  }

  corruptionSummary() {
    return this.corruptions.map(entry => entry.reason || entry.message || 'corrupt durable ledger').join('; ')
  }

  _entryPath(commandId) {
    return resolve(this.ledgerDir, `${Buffer.from(String(commandId), 'utf8').toString('hex')}.json`)
  }

  _blockedPath(commandId) {
    const name = commandId
      ? `${Buffer.from(String(commandId), 'utf8').toString('hex')}.json`
      : `unknown-${this.createId()}.json`
    return resolve(this.blockedDir, name)
  }

  _conflictPath(recordId) {
    return resolve(this.conflictsDir, `${recordId}.json`)
  }

  _decodeCommandId(fileName) {
    const encoded = fileName.replace(/\.json$/, '')
    if (!encoded || !/^[0-9a-f]+$/i.test(encoded) || encoded.length % 2) return ''
    try {
      const decoded = Buffer.from(encoded, 'hex').toString('utf8')
      return Buffer.from(decoded, 'utf8').toString('hex') === encoded.toLowerCase() ? decoded : ''
    } catch { return '' }
  }

  _validateEntry(entry, expectedCommandId) {
    if (!isObject(entry) || entry.formatVersion !== 1 || typeof entry.commandId !== 'string' || !entry.commandId.trim()) {
      throw new Error('invalid dedupe ledger entry shape')
    }
    if (expectedCommandId && entry.commandId !== expectedCommandId) throw new Error('dedupe ledger commandId/file mismatch')
    if (typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
      throw new Error('invalid dedupe ledger fingerprint')
    }
    if (!LEDGER_STATUS_VALUES.has(entry.status)) throw new Error(`invalid dedupe ledger status: ${entry.status}`)
    if (entry.agentId && entry.agentId !== this.profile.agentId) throw new Error('dedupe ledger agent identity mismatch')
    if ([ACK_STATUS.SUCCEEDED, ACK_STATUS.FAILED].includes(entry.status) && !isObject(entry.outcome)) {
      throw new Error('terminal dedupe ledger entry requires outcome')
    }
    if (entry.status === LEDGER_STATUS.RECOVERY_REQUIRED && typeof entry.rejectReason !== 'string') {
      throw new Error('recovery-required ledger entry requires rejectReason')
    }
    return entry
  }

  _validateConflict(conflict, expectedRecordId) {
    if (!isObject(conflict) || conflict.formatVersion !== 1
        || typeof conflict.recordId !== 'string' || !conflict.recordId
        || typeof conflict.commandId !== 'string' || !conflict.commandId) {
      throw new Error('invalid dedupe conflict record shape')
    }
    if (expectedRecordId && conflict.recordId !== expectedRecordId) throw new Error('dedupe conflict record/file mismatch')
    if (!/^[0-9a-f]{64}$/.test(conflict.existingFingerprint || '')
        || !/^[0-9a-f]{64}$/.test(conflict.conflictingFingerprint || '')) {
      throw new Error('invalid dedupe conflict fingerprint')
    }
    if (!LEDGER_STATUS_VALUES.has(conflict.existingStatus)) throw new Error('invalid dedupe conflict existingStatus')
    if (conflict.agentId && conflict.agentId !== this.profile.agentId) throw new Error('dedupe conflict agent identity mismatch')
    return conflict
  }

  _uniquePath(directory, fileName) {
    const target = resolve(directory, fileName)
    if (!this.fs.existsSync(target)) return target
    const stem = fileName.endsWith('.json') ? fileName.slice(0, -5) : fileName
    return resolve(directory, `${stem}-${this.createId()}.json`)
  }

  _quarantineLedgerFile(sourcePath, commandId, error) {
    if (!this.fs.existsSync(sourcePath)) return
    const fileName = sourcePath.split('/').pop()
    const targetPath = this._uniquePath(this.quarantineDir, fileName)
    durableRename(this.fs, sourcePath, targetPath)
    atomicWriteText(this.fs, `${targetPath}.reason.txt`, `${new Date(this.now()).toISOString()} ${error.message}\n`)
    const marker = {
      formatVersion: 1,
      commandId: commandId || '',
      profileId: this.profile.profileId,
      agentId: this.profile.agentId,
      quarantinedAt: this.now(),
      quarantinedFile: targetPath.split('/').pop(),
      reason: `CORRUPT_LEDGER: ${error.message}`
    }
    atomicWriteJson(this.fs, this._blockedPath(commandId), marker)
    this.corruptions.push(marker)
  }

  _assertHealthy() {
    if (this.hasCorruption()) {
      throw new AgentProtocolError('DEDUPE_LEDGER_CORRUPT', this.corruptionSummary() || 'durable dedupe ledger requires reconciliation')
    }
  }

  getEntry(commandId) {
    this._assertHealthy()
    const path = this._entryPath(commandId)
    if (!this.fs.existsSync(path)) return null
    forceSecureFileMode(this.fs, path)
    try {
      return this._validateEntry(JSON.parse(this.fs.readFileSync(path, 'utf8')), commandId)
    } catch (error) {
      this._quarantineLedgerFile(path, commandId, error)
      throw new AgentProtocolError('DEDUPE_LEDGER_CORRUPT', `Corrupt ledger entry for ${commandId}: ${error.message}`)
    }
  }

  listEntries() {
    this._assertHealthy()
    const entries = []
    for (const fileName of this.fs.readdirSync(this.ledgerDir).sort()) {
      if (!fileName.endsWith('.json')) continue
      const path = resolve(this.ledgerDir, fileName)
      const commandId = this._decodeCommandId(fileName)
      forceSecureFileMode(this.fs, path)
      try {
        entries.push(this._validateEntry(JSON.parse(this.fs.readFileSync(path, 'utf8')), commandId || undefined))
      } catch (error) {
        this._quarantineLedgerFile(path, commandId, error)
        throw new AgentProtocolError('DEDUPE_LEDGER_CORRUPT', `Corrupt ledger entry ${fileName}: ${error.message}`)
      }
    }
    return entries
  }

  _writeEntry(commandId, entry) {
    this._assertHealthy()
    atomicWriteJson(this.fs, this._entryPath(commandId), entry)
  }

  _newEntry(commandId, fingerprint, meta, status = ACK_STATUS.RECEIVED) {
    const now = this.now()
    return {
      formatVersion: 1,
      profileId: this.profile.profileId,
      agentId: this.profile.agentId,
      commandId,
      fingerprint,
      status,
      queueSequence: 0,
      messageId: meta.messageId || '',
      commandType: meta.commandType || '',
      targetAgentId: meta.targetAgentId || '',
      taskId: meta.taskId || '',
      workItemId: meta.workItemId || '',
      receivedAt: now,
      startedAt: null,
      completedAt: null,
      rejectedAt: status === ACK_STATUS.REJECTED ? now : null,
      recoveryRequiredAt: status === LEDGER_STATUS.RECOVERY_REQUIRED ? now : null,
      rejectReason: meta.rejectReason || null,
      outcome: null,
      ackReceivedEmitted: false,
      ackStartedEmitted: false,
      ackCompletedEmitted: false,
      ackRejectedEmitted: false
    }
  }

  _recordConflict(commandId, existing, fingerprint, meta) {
    const recordId = this.createId()
    const conflict = {
      formatVersion: 1,
      recordId,
      profileId: this.profile.profileId,
      agentId: this.profile.agentId,
      commandId,
      existingFingerprint: existing.fingerprint,
      conflictingFingerprint: fingerprint,
      existingStatus: existing.status,
      messageId: meta.messageId || '',
      commandType: meta.commandType || '',
      targetAgentId: meta.targetAgentId || '',
      taskId: meta.taskId || '',
      workItemId: meta.workItemId || '',
      detectedAt: this.now(),
      rejectReason: 'FINGERPRINT_CONFLICT: same commandId with different payload',
      ackRejectedEmitted: false
    }
    atomicWriteJson(this.fs, this._conflictPath(recordId), conflict)
    return conflict
  }

  checkOrRecord(commandId, fingerprint, meta) {
    this._assertHealthy()
    const existing = this.getEntry(commandId)
    const now = this.now()
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const conflict = this._recordConflict(commandId, existing, fingerprint, meta)
        return { action: 'conflict', entry: existing, conflict }
      }
      return { action: 'duplicate', entry: existing }
    }
    if (Number.isSafeInteger(meta.expiresAt) && meta.expiresAt > 0 && now > meta.expiresAt) {
      const entry = this._newEntry(commandId, fingerprint, {
        ...meta,
        rejectReason: 'EXPIRED: command expired before execution'
      }, ACK_STATUS.REJECTED)
      this._writeEntry(commandId, entry)
      return { action: 'expired', entry }
    }
    const entry = this._newEntry(commandId, fingerprint, meta)
    this._writeEntry(commandId, entry)
    return { action: 'accept', entry }
  }

  recordQueueSequence(commandId, queueSequence) {
    const existing = this.getEntry(commandId)
    if (!existing) throw new Error(`dedupe ledger entry missing for ${commandId}`)
    this._writeEntry(commandId, { ...existing, queueSequence })
  }

  markStarted(commandId) {
    const existing = this.getEntry(commandId)
    if (!existing) throw new Error(`dedupe ledger entry missing for ${commandId}`)
    if (existing.status === ACK_STATUS.STARTED) return existing
    if (existing.status !== ACK_STATUS.RECEIVED) throw new Error(`cannot start command from ledger status ${existing.status}`)
    const entry = { ...existing, status: ACK_STATUS.STARTED, startedAt: this.now() }
    this._writeEntry(commandId, entry)
    return entry
  }

  markCompleted(commandId, outcome) {
    const existing = this.getEntry(commandId)
    if (!existing) throw new Error(`dedupe ledger entry missing for ${commandId}`)
    if ([ACK_STATUS.SUCCEEDED, ACK_STATUS.FAILED].includes(existing.status)) return existing
    if (![ACK_STATUS.RECEIVED, ACK_STATUS.STARTED].includes(existing.status)) {
      throw new Error(`cannot complete command from ledger status ${existing.status}`)
    }
    const status = outcome?.status === 'failed' ? ACK_STATUS.FAILED : ACK_STATUS.SUCCEEDED
    const entry = {
      ...existing,
      status,
      completedAt: this.now(),
      outcome: {
        status: outcome?.status || 'completed',
        exitCode: outcome?.exitCode ?? null,
        errorMessage: outcome?.errorMessage || ''
      }
    }
    this._writeEntry(commandId, entry)
    return entry
  }

  markRejected(commandId, reason) {
    const existing = this.getEntry(commandId)
    if (!existing) return null
    if (TERMINAL_LEDGER_STATUSES.has(existing.status)) return existing
    const entry = {
      ...existing,
      status: ACK_STATUS.REJECTED,
      rejectedAt: this.now(),
      rejectReason: reason || 'REJECTED'
    }
    this._writeEntry(commandId, entry)
    return entry
  }

  markRecoveryRequired(commandId, fingerprint, meta, reason) {
    const existing = this.getEntry(commandId)
    if (existing && TERMINAL_LEDGER_STATUSES.has(existing.status)) return { entry: existing, conflict: null }
    const entry = existing || this._newEntry(commandId, fingerprint, meta)
    if (entry.fingerprint !== fingerprint) {
      const conflict = this._recordConflict(commandId, entry, fingerprint, meta)
      return { entry, conflict }
    }
    const recoveryEntry = {
      ...entry,
      status: LEDGER_STATUS.RECOVERY_REQUIRED,
      recoveryRequiredAt: this.now(),
      rejectReason: reason
    }
    this._writeEntry(commandId, recoveryEntry)
    return { entry: recoveryEntry, conflict: null }
  }

  markAckEmitted(commandId, ackStatus, marker = {}) {
    const field = ackStatus === ACK_STATUS.RECEIVED ? 'ackReceivedEmitted'
      : ackStatus === ACK_STATUS.STARTED ? 'ackStartedEmitted'
      : ackStatus === ACK_STATUS.SUCCEEDED || ackStatus === ACK_STATUS.FAILED ? 'ackCompletedEmitted'
      : ackStatus === ACK_STATUS.REJECTED ? 'ackRejectedEmitted'
      : null
    if (!field) throw new Error(`unsupported ACK marker status: ${ackStatus}`)
    if (marker.kind === 'none') return
    if (marker.kind === 'conflict') {
      const path = this._conflictPath(marker.recordId)
      if (!this.fs.existsSync(path)) throw new Error(`conflict record missing: ${marker.recordId}`)
      forceSecureFileMode(this.fs, path)
      let conflict
      try {
        conflict = this._validateConflict(JSON.parse(this.fs.readFileSync(path, 'utf8')), marker.recordId)
        if (conflict.commandId !== commandId) throw new Error(`conflict commandId mismatch: ${marker.recordId}`)
      } catch (error) {
        this._quarantineLedgerFile(path, commandId, error)
        throw new AgentProtocolError('DEDUPE_LEDGER_CORRUPT', `Corrupt conflict record ${marker.recordId}: ${error.message}`)
      }
      atomicWriteJson(this.fs, path, { ...conflict, [field]: true, ackEmittedAt: this.now() })
      return
    }
    const existing = this.getEntry(commandId)
    if (!existing) throw new Error(`dedupe ledger entry missing for ACK marker ${commandId}`)
    this._writeEntry(commandId, { ...existing, [field]: true })
  }

  getConflicts(commandId) {
    const conflicts = []
    for (const fileName of this.fs.readdirSync(this.conflictsDir).sort()) {
      if (!fileName.endsWith('.json')) continue
      const path = resolve(this.conflictsDir, fileName)
      forceSecureFileMode(this.fs, path)
      try {
        const conflict = this._validateConflict(JSON.parse(this.fs.readFileSync(path, 'utf8')), fileName.slice(0, -5))
        if (conflict.commandId === commandId) conflicts.push(conflict)
      } catch (error) {
        this._quarantineLedgerFile(path, commandId, error)
        throw new AgentProtocolError('DEDUPE_LEDGER_CORRUPT', `Corrupt conflict record ${fileName}: ${error.message}`)
      }
    }
    return conflicts
  }
}

export class AckOutbox {
  constructor({ rootDir, profile, now = () => Date.now(), createId = () => randomUUID(), fs = DEFAULT_FS_OPERATIONS }) {
    if (!profile?.agentId) throw new Error('profile.agentId is required for the ACK outbox')
    this.rootDir = resolve(rootDir)
    this.profile = profile
    this.now = now
    this.createId = createId
    this.fs = { ...DEFAULT_FS_OPERATIONS, ...fs }
    this.acksDir = resolve(this.rootDir, 'acks')
    this.quarantineDir = resolve(this.rootDir, 'acks-quarantine')
    this.sequencePath = resolve(this.rootDir, 'ack-sequence.json')
    this.lastSequence = 0
    this.corruptions = []
  }

  initialize() {
    ensureSecureDirectory(this.fs, this.acksDir)
    ensureSecureDirectory(this.fs, this.quarantineDir)
    this.corruptions = []
    for (const fileName of this.fs.readdirSync(this.quarantineDir)) {
      if (fileName.endsWith('.json')) this.corruptions.push({ fileName, reason: 'previously quarantined ACK requires reconciliation' })
      if (fileName.endsWith('.json') || fileName.endsWith('.reason.txt')) {
        forceSecureFileMode(this.fs, resolve(this.quarantineDir, fileName))
      }
    }
    const validRecords = []
    for (const fileName of this.fs.readdirSync(this.acksDir)) {
      if (!fileName.endsWith('.json')) continue
      const path = resolve(this.acksDir, fileName)
      forceSecureFileMode(this.fs, path)
      try {
        validRecords.push({ fileName, path, record: this._readAndValidate(path) })
      } catch (error) {
        this._quarantine(path, error)
      }
    }
    this._loadSequence(validRecords)
    return { corruptions: this.corruptions.length }
  }

  _loadSequence(records) {
    let persisted = 0
    if (this.fs.existsSync(this.sequencePath)) {
      forceSecureFileMode(this.fs, this.sequencePath)
      try {
        const sequence = JSON.parse(this.fs.readFileSync(this.sequencePath, 'utf8'))
        if (!isObject(sequence) || sequence.formatVersion !== 1
            || !Number.isSafeInteger(sequence.lastSequence) || sequence.lastSequence < 0) {
          throw new Error('invalid ACK outbox sequence state')
        }
        persisted = sequence.lastSequence
      } catch (error) {
        this._quarantine(this.sequencePath, error)
      }
    }
    const observed = records.reduce((maximum, item) => (
      Number.isSafeInteger(item.record.queueSequence)
        ? Math.max(maximum, item.record.queueSequence)
        : maximum
    ), 0)
    this.lastSequence = Math.max(persisted, observed)
    if (!this.fs.existsSync(this.sequencePath) || this.lastSequence !== persisted) this._persistSequence()

    // Legacy timestamp-named records have no reliable same-millisecond order.
    // Preserve their prior lexical order once, then use the durable sequence forever.
    for (const item of records.filter(entry => !Number.isSafeInteger(entry.record.queueSequence)).sort((left, right) => left.fileName.localeCompare(right.fileName))) {
      const queueSequence = this._nextSequence()
      item.record = { ...item.record, queueSequence }
      atomicWriteJson(this.fs, item.path, item.record)
    }
  }

  _persistSequence() {
    atomicWriteJson(this.fs, this.sequencePath, { formatVersion: 1, lastSequence: this.lastSequence })
  }

  _nextSequence() {
    if (this.lastSequence >= Number.MAX_SAFE_INTEGER) throw new Error('ACK outbox sequence exhausted')
    this.lastSequence += 1
    this._persistSequence()
    return this.lastSequence
  }

  hasCorruption() {
    return this.corruptions.length > 0
  }

  corruptionSummary() {
    return this.corruptions.map(entry => entry.reason || 'corrupt ACK outbox record').join('; ')
  }

  _uniquePath(fileName) {
    const target = resolve(this.quarantineDir, fileName)
    if (!this.fs.existsSync(target)) return target
    const stem = fileName.endsWith('.json') ? fileName.slice(0, -5) : fileName
    return resolve(this.quarantineDir, `${stem}-${this.createId()}.json`)
  }

  _quarantine(sourcePath, error) {
    if (!this.fs.existsSync(sourcePath)) return
    const targetPath = this._uniquePath(sourcePath.split('/').pop())
    durableRename(this.fs, sourcePath, targetPath)
    atomicWriteText(this.fs, `${targetPath}.reason.txt`, `${new Date(this.now()).toISOString()} ${error.message}\n`)
    this.corruptions.push({ fileName: targetPath.split('/').pop(), reason: `CORRUPT_ACK: ${error.message}` })
  }

  _readAndValidate(path) {
    let record
    try {
      record = JSON.parse(this.fs.readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`invalid ACK outbox JSON: ${error.message}`)
    }
    if (!isObject(record) || record.formatVersion !== 1 || !isObject(record.envelope)) {
      throw new Error('invalid ACK outbox record shape')
    }
    if (hasOwn(record, 'queueSequence')
        && (!Number.isSafeInteger(record.queueSequence) || record.queueSequence <= 0)) {
      throw new Error('ACK outbox record has invalid queueSequence')
    }
    let normalized
    try {
      normalized = normalizeInboundMessage(record.envelope)
    } catch (error) {
      throw new Error(`invalid ACK envelope: ${error.code || error.message}`)
    }
    if (normalized.messageType !== MESSAGE_TYPES.COMMAND_ACK) throw new Error('ACK outbox envelope is not command.ack')
    if (!ACK_STATUS_VALUES.has(record.envelope.ackStatus)) throw new Error('ACK outbox envelope has invalid ackStatus')
    if (typeof record.envelope.commandId !== 'string' || !record.envelope.commandId.trim()) {
      throw new Error('ACK outbox envelope requires commandId')
    }
    if (normalized.sourceAgentId !== this.profile.agentId) throw new Error('ACK outbox agent identity mismatch')
    if (hasOwn(record, 'marker')) {
      if (!isObject(record.marker)) throw new Error('ACK outbox marker must be an object')
      if (!['entry', 'conflict', 'none'].includes(record.marker.kind)) throw new Error('ACK outbox marker has invalid kind')
      if (record.marker.kind === 'conflict' && (typeof record.marker.recordId !== 'string' || !record.marker.recordId)) {
        throw new Error('ACK outbox conflict marker requires recordId')
      }
    }
    return record
  }

  enqueue(ackEnvelope, marker = { kind: 'entry' }) {
    const now = this.now()
    const queueSequence = this._nextSequence()
    const fileName = `${String(queueSequence).padStart(20, '0')}-${this.createId()}.json`
    const record = {
      formatVersion: 1,
      queueSequence,
      envelope: ackEnvelope,
      marker,
      createdAt: now,
      attempts: 0
    }
    atomicWriteJson(this.fs, resolve(this.acksDir, fileName), record)
    return { fileName, record }
  }

  dequeue(fileName) {
    const path = resolve(this.acksDir, fileName)
    if (!this.fs.existsSync(path)) return
    durableUnlink(this.fs, path)
  }

  pendingEnvelopes() {
    const envelopes = []
    for (const fileName of this.fs.readdirSync(this.acksDir)) {
      if (!fileName.endsWith('.json')) continue
      const path = resolve(this.acksDir, fileName)
      forceSecureFileMode(this.fs, path)
      try {
        const record = this._readAndValidate(path)
        envelopes.push({ fileName, envelope: record.envelope, marker: record.marker || { kind: 'entry' }, record })
      } catch (error) {
        this._quarantine(path, error)
        throw new AgentProtocolError('ACK_OUTBOX_CORRUPT', `ACK outbox record ${fileName} quarantined: ${error.message}`)
      }
    }
    return envelopes.sort((left, right) => (
      left.record.queueSequence - right.record.queueSequence || left.fileName.localeCompare(right.fileName)
    ))
  }
}

export const buildAckEnvelope = (profile, ackStatus, meta, runtimeInstanceId = PROCESS_RUNTIME_INSTANCE_ID) => {
  const envelope = {
    schemaVersion: PROTOCOL_VERSION,
    messageType: MESSAGE_TYPES.COMMAND_ACK,
    messageId: randomUUID(),
    commandId: meta.commandId || '',
    sourceAgentId: profile.agentId,
    agentId: profile.agentId,
    runtimeInstanceId,
    ackStatus,
    ackAt: Date.now()
  }
  if (meta.messageId) envelope.correlationId = meta.messageId
  if (meta.taskId) envelope.taskId = meta.taskId
  if (meta.workItemId) envelope.workItemId = meta.workItemId
  if (meta.rejectReason) envelope.rejectReason = meta.rejectReason
  if (meta.outcome) envelope.outcome = meta.outcome
  return envelope
}


export class AgentMessageProcessor {
  constructor({ profile, inbox, runCommand, runChat, onTaskEvent = () => {}, onReject = () => {}, sendChatBusy = () => {}, ledger = null, ackOutbox = null, sendFn = null }) {
    this.profile = profile
    this.inbox = inbox
    this.runCommand = runCommand
    this.runChat = runChat
    this.onTaskEvent = onTaskEvent
    this.onReject = onReject
    this.sendChatBusy = sendChatBusy
    this.ledger = ledger
    this.ackOutbox = ackOutbox
    this.sendFn = sendFn
    this.drainPromise = null
    this.chatActive = false
    this.commandActive = false
    this.paused = false
    this.stopped = false
    this.failClosedError = null
  }

  start({ drain = true } = {}) {
    const recovery = this.inbox.initialize()
    try {
      if (this.ledger) this._reconcileLedgerWithInbox()
      else for (const recovered of recovery.recoveryRecords || []) this._recordRecoveryRequired(recovered)
    } catch (error) {
      const protocolError = error instanceof AgentProtocolError
        ? error
        : new AgentProtocolError('COMMAND_RECOVERY_ERROR', `Failed to persist recovery state: ${error.message}`)
      this._failClosed(protocolError, {})
    }
    if (this.ledger?.hasCorruption()) {
      this._failClosed(new AgentProtocolError(
        'DEDUPE_LEDGER_CORRUPT',
        this.ledger.corruptionSummary() || 'Durable dedupe ledger requires reconciliation'
      ), {})
    }
    if (this.ackOutbox?.hasCorruption()) {
      this._failClosed(new AgentProtocolError(
        'ACK_OUTBOX_CORRUPT',
        this.ackOutbox.corruptionSummary() || 'Durable ACK outbox requires reconciliation'
      ), {})
    }
    this.paused = !drain || Boolean(this.failClosedError)
    if (drain && !this.failClosedError) void this.drain()
    return { ...recovery, paused: this.paused, failClosedCode: this.failClosedError?.code || '' }
  }

  _commandMeta(message) {
    return {
      messageId: message.messageId || '',
      commandType: message.commandType || '',
      targetAgentId: message.targetAgentId || '',
      taskId: message.taskId || '',
      workItemId: message.workItemId || '',
      expiresAt: message.expiresAt
    }
  }

  _reconcileCompletedRecord(completed) {
    if (!this.ledger) return
    const message = completed.normalized
    const meta = this._commandMeta(message)
    const fingerprint = CommandFingerprint.compute(message)
    const check = this.ledger.checkOrRecord(message.commandId, fingerprint, { ...meta, expiresAt: null })
    if (check.action === 'conflict') {
      throw new Error(`completed inbox record conflicts with ledger for ${message.commandId}`)
    }
    const entry = this.ledger.markCompleted(message.commandId, completed.record.outcome)
    this._emitAck(entry.status, {
      ...meta,
      commandId: message.commandId,
      outcome: entry.outcome
    })
  }

  _reconcileLedgerWithInbox() {
    if (!this.ledger) return
    const inboxIndex = this.inbox.commandStateIndex()
    const ledgerEntries = this.ledger.listEntries()
    const ledgerIndex = new Map(ledgerEntries.map(entry => [entry.commandId, entry]))
    const commandIds = new Set([...inboxIndex.keys(), ...ledgerIndex.keys()])

    for (const commandId of [...commandIds].sort()) {
      const records = inboxIndex.get(commandId) || []
      const entry = ledgerIndex.get(commandId) || null
      if (records.length > 1) {
        throw new AgentProtocolError(
          'COMMAND_STATE_CONFLICT',
          `Multiple durable inbox records exist for commandId ${commandId}; manual reconciliation is required`
        )
      }

      if (!entry && records.length) {
        const item = records[0]
        if (item.record.state === 'completed') {
          this._reconcileCompletedRecord(item)
          continue
        }
        if (item.record.state === 'recovery_required') {
          this._recordRecoveryRequired(item)
          continue
        }
        if (item.record.state === 'pending') {
          const fingerprint = CommandFingerprint.compute(item.normalized)
          const check = this.ledger.checkOrRecord(
            commandId,
            fingerprint,
            { ...this._commandMeta(item.normalized), expiresAt: null }
          )
          if (check.action !== 'accept') throw new Error(`failed to reconstruct missing RECEIVED ledger for ${commandId}`)
          this.ledger.recordQueueSequence(commandId, item.record.queueSequence)
          this._emitAck(ACK_STATUS.RECEIVED, { ...this._commandMeta(item.normalized), commandId })
          continue
        }
        const reason = 'PROCESSING_OUTCOME_UNKNOWN: durable inbox processing state requires reconciliation'
        const recovered = this.inbox.markRecoveryRequired(item, reason)
        this._recordRecoveryRequired(recovered)
        continue
      }

      if (!entry) continue
      if (!records.length) {
        if ([ACK_STATUS.RECEIVED, ACK_STATUS.STARTED].includes(entry.status)) {
          const reason = `ORPHAN_LEDGER_NO_INBOX: ${entry.status} ledger was persisted but no inbox record exists; execution outcome is unknown; reconcile or dispatch a new commandId`
          const result = this.ledger.markRecoveryRequired(
            commandId,
            entry.fingerprint,
            entry,
            reason
          )
          if (result.conflict) throw new Error(`orphan ledger fingerprint conflict for ${commandId}`)
          this._emitAck(ACK_STATUS.REJECTED, {
            ...this._commandMeta(entry),
            commandId,
            rejectReason: reason
          })
          this._failClosed(new AgentProtocolError('COMMAND_RECOVERY_REQUIRED', reason), entry)
        } else if (entry.status === LEDGER_STATUS.RECOVERY_REQUIRED) {
          const reason = entry.rejectReason || 'RECOVERY_REQUIRED: manual reconciliation is required'
          this._emitAck(ACK_STATUS.REJECTED, {
            ...this._commandMeta(entry),
            commandId,
            rejectReason: reason
          })
          this._failClosed(new AgentProtocolError('COMMAND_RECOVERY_REQUIRED', reason), entry)
        }
        continue
      }

      const item = records[0]
      const fingerprint = CommandFingerprint.compute(item.normalized)
      if (entry.fingerprint !== fingerprint) {
        throw new AgentProtocolError(
          'COMMAND_STATE_CONFLICT',
          `Ledger/inbox fingerprint mismatch for commandId ${commandId}; manual reconciliation is required`
        )
      }

      if (item.record.state === 'completed') {
        if ([ACK_STATUS.RECEIVED, ACK_STATUS.STARTED].includes(entry.status)) this._reconcileCompletedRecord(item)
        else if (![ACK_STATUS.SUCCEEDED, ACK_STATUS.FAILED].includes(entry.status)) {
          throw new AgentProtocolError('COMMAND_STATE_CONFLICT', `Completed inbox record conflicts with ledger status ${entry.status} for ${commandId}`)
        }
        continue
      }

      if (item.record.state === 'recovery_required') {
        if ([ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, LEDGER_STATUS.RECOVERY_REQUIRED].includes(entry.status)) {
          this._recordRecoveryRequired(item)
        } else {
          throw new AgentProtocolError('COMMAND_STATE_CONFLICT', `Recovery inbox record conflicts with ledger status ${entry.status} for ${commandId}`)
        }
        continue
      }

      if (item.record.state === 'pending' && entry.status === ACK_STATUS.RECEIVED) continue
      if (['pending', 'processing'].includes(item.record.state)
          && [ACK_STATUS.STARTED, LEDGER_STATUS.RECOVERY_REQUIRED].includes(entry.status)) {
        const reason = entry.rejectReason
          || 'PROCESSING_OUTCOME_UNKNOWN: STARTED ledger state cannot be automatically re-executed after restart'
        const recovered = this.inbox.markRecoveryRequired(item, reason)
        if (entry.status === LEDGER_STATUS.RECOVERY_REQUIRED) {
          this._emitAck(ACK_STATUS.REJECTED, {
            ...this._commandMeta(item.normalized),
            commandId,
            rejectReason: reason
          })
          this._failClosed(new AgentProtocolError('COMMAND_RECOVERY_REQUIRED', reason), recovered.record.rawPayload)
        } else {
          this._recordRecoveryRequired(recovered)
        }
        continue
      }

      throw new AgentProtocolError(
        'COMMAND_STATE_CONFLICT',
        `Inbox state ${item.record.state} conflicts with ledger status ${entry.status} for ${commandId}`
      )
    }
  }

  _recordRecoveryRequired(recovered) {
    const message = recovered.normalized
    const meta = this._commandMeta(message)
    const reason = recovered.record.recoveryReason
      || 'PROCESSING_OUTCOME_UNKNOWN: automatic re-execution is forbidden; reconcile or dispatch a new commandId'
    let marker = { kind: 'none' }
    if (this.ledger) {
      const fingerprint = CommandFingerprint.compute(message)
      const result = this.ledger.markRecoveryRequired(message.commandId, fingerprint, meta, reason)
      if (result.conflict) marker = { kind: 'conflict', recordId: result.conflict.recordId }
      else marker = { kind: 'entry' }
    }
    this._emitAck(ACK_STATUS.REJECTED, {
      ...meta,
      commandId: message.commandId,
      rejectReason: reason
    }, marker)
    this._failClosed(new AgentProtocolError('COMMAND_RECOVERY_REQUIRED', reason), recovered.record.rawPayload)
  }

  _failClosed(error, raw) {
    if (!this.failClosedError) this.failClosedError = error
    this.paused = true
    this.onReject(error, raw)
  }

  pause() {
    this.paused = true
  }

  resume() {
    if (this.stopped || this.failClosedError) return
    this.paused = false
    void this.drain()
  }

  stop() {
    this.stopped = true
    this.paused = true
  }

  isBusy() {
    return this.chatActive || this.commandActive
  }

  _ackForLedgerEntry(entry) {
    if (entry.status === LEDGER_STATUS.RECOVERY_REQUIRED) {
      return { ackStatus: ACK_STATUS.REJECTED, rejectReason: entry.rejectReason || 'RECOVERY_REQUIRED' }
    }
    if (ACK_STATUS_VALUES.has(entry.status)) {
      return { ackStatus: entry.status, rejectReason: entry.rejectReason || '', outcome: entry.outcome || undefined }
    }
    return { ackStatus: ACK_STATUS.REJECTED, rejectReason: `UNSUPPORTED_LEDGER_STATUS: ${entry.status}` }
  }

  _replayLedgerEntry(entry, meta) {
    const replay = this._ackForLedgerEntry(entry)
    this._emitAck(replay.ackStatus, {
      ...meta,
      commandId: entry.commandId,
      rejectReason: replay.rejectReason,
      outcome: replay.outcome
    })
    return replay
  }

  _rejectWhileFailClosed(message, fingerprint, meta) {
    if (!this.ledger || this.ledger.hasCorruption()) {
      const reason = this.failClosedError?.message || 'processor is fail-closed pending durable reconciliation'
      this._emitAck(ACK_STATUS.REJECTED, { ...meta, commandId: message.commandId, rejectReason: reason }, { kind: 'none' })
      return { kind: 'rejected', error: this.failClosedError || new AgentProtocolError('PROCESSOR_FAIL_CLOSED', reason) }
    }
    try {
      const existing = this.ledger.getEntry(message.commandId)
      if (!existing) {
        const reason = this.failClosedError?.message || 'processor is fail-closed pending durable reconciliation'
        this._emitAck(ACK_STATUS.REJECTED, { ...meta, commandId: message.commandId, rejectReason: reason }, { kind: 'none' })
        return { kind: 'rejected', error: this.failClosedError || new AgentProtocolError('PROCESSOR_FAIL_CLOSED', reason) }
      }
      if (existing.fingerprint !== fingerprint) {
        const check = this.ledger.checkOrRecord(message.commandId, fingerprint, meta)
        this._emitAck(ACK_STATUS.REJECTED, {
          ...meta,
          commandId: message.commandId,
          rejectReason: check.conflict.rejectReason
        }, { kind: 'conflict', recordId: check.conflict.recordId })
        return { kind: 'rejected', error: new AgentProtocolError('COMMAND_FINGERPRINT_CONFLICT', check.conflict.rejectReason) }
      }
      this._replayLedgerEntry(existing, meta)
      return { kind: 'command-duplicate', commandId: message.commandId }
    } catch (error) {
      const protocolError = error instanceof AgentProtocolError
        ? error
        : new AgentProtocolError('PROCESSOR_FAIL_CLOSED', error.message)
      this._failClosed(protocolError, message.rawPayload)
      return { kind: 'rejected', error: protocolError }
    }
  }

  async handle(raw) {
    let message
    try {
      message = normalizeInboundMessage(raw)
    } catch (error) {
      const protocolError = error instanceof AgentProtocolError
        ? error
        : new AgentProtocolError('INVALID_MESSAGE', error.message)
      this.onReject(protocolError, raw)
      return { kind: 'rejected', error: protocolError }
    }

    if (message.targetAgentId && message.targetAgentId !== this.profile.agentId) {
      const error = new AgentProtocolError('TARGET_AGENT_ID_MISMATCH', 'targetAgentId does not match this Agent profile')
      this.onReject(error, raw)
      return { kind: 'rejected', error }
    }

    switch (message.messageType) {
      case MESSAGE_TYPES.COMMAND_DISPATCH: {
        const commandId = message.commandId
        const meta = this._commandMeta(message)
        let fingerprint
        try {
          fingerprint = CommandFingerprint.compute(message)
        } catch (error) {
          const protocolError = error instanceof AgentProtocolError
            ? error
            : new AgentProtocolError('INVALID_COMMAND_PAYLOAD', error.message)
          this.onReject(protocolError, raw)
          this._emitAck(ACK_STATUS.REJECTED, { ...meta, commandId, rejectReason: protocolError.message }, { kind: 'none' })
          return { kind: 'rejected', error: protocolError }
        }

        if (this.failClosedError || this.ledger?.hasCorruption() || this.ackOutbox?.hasCorruption()) {
          if (!this.failClosedError) {
            const code = this.ledger?.hasCorruption() ? 'DEDUPE_LEDGER_CORRUPT' : 'ACK_OUTBOX_CORRUPT'
            const detail = this.ledger?.hasCorruption()
              ? this.ledger.corruptionSummary()
              : this.ackOutbox.corruptionSummary()
            this._failClosed(new AgentProtocolError(code, detail), raw)
          }
          return this._rejectWhileFailClosed(message, fingerprint, meta)
        }

        if (this.ledger) {
          let check
          try {
            check = this.ledger.checkOrRecord(commandId, fingerprint, meta)
          } catch (error) {
            const protocolError = error instanceof AgentProtocolError
              ? error
              : new AgentProtocolError('DEDUPE_LEDGER_ERROR', error.message)
            this._failClosed(protocolError, raw)
            this._emitAck(ACK_STATUS.REJECTED, { ...meta, commandId, rejectReason: protocolError.message }, { kind: 'none' })
            return { kind: 'rejected', error: protocolError }
          }

          if (check.action === 'conflict') {
            this._emitAck(ACK_STATUS.REJECTED, {
              ...meta,
              commandId,
              rejectReason: check.conflict.rejectReason
            }, { kind: 'conflict', recordId: check.conflict.recordId })
            return { kind: 'rejected', error: new AgentProtocolError('COMMAND_FINGERPRINT_CONFLICT', check.conflict.rejectReason) }
          }
          if (check.action === 'expired') {
            this._emitAck(ACK_STATUS.REJECTED, { ...meta, commandId, rejectReason: check.entry.rejectReason })
            return { kind: 'rejected', error: new AgentProtocolError('COMMAND_EXPIRED', check.entry.rejectReason) }
          }
          if (check.action === 'duplicate') {
            this._replayLedgerEntry(check.entry, meta)
            if ([ACK_STATUS.RECEIVED, ACK_STATUS.STARTED].includes(check.entry.status)) void this.drain()
            return { kind: 'command-duplicate', commandId }
          }
        }

        try {
          const item = this.inbox.enqueue(message)
          if (this.ledger) {
            this.ledger.recordQueueSequence(commandId, item.record.queueSequence)
            this._emitAck(ACK_STATUS.RECEIVED, { ...meta, commandId })
          }
          void this.drain()
          return { kind: 'command', item }
        } catch (error) {
          const protocolError = new AgentProtocolError('COMMAND_INBOX_ERROR', `Failed to persist command: ${error.message}`)
          try {
            this.ledger?.markRejected(commandId, protocolError.message)
            this._emitAck(ACK_STATUS.REJECTED, { ...meta, commandId, rejectReason: protocolError.message })
          } catch {}
          this._failClosed(protocolError, raw)
          return { kind: 'rejected', error: protocolError }
        }
      }
      case MESSAGE_TYPES.CHAT_MESSAGE:
        if (this.isBusy()) {
          await this.sendChatBusy(message)
          return { kind: 'chat-busy' }
        }
        this.chatActive = true
        try {
          await this.runChat(message)
        } finally {
          this.chatActive = false
          void this.drain()
        }
        return { kind: 'chat' }
      case MESSAGE_TYPES.TASK_EVENT:
        await this.onTaskEvent(message)
        return { kind: 'task-event' }
      default:
        return { kind: 'ignored', messageType: message.messageType }
    }
  }

  drain() {
    if (this.paused || this.stopped || this.chatActive || this.failClosedError) return this.drainPromise || Promise.resolve()
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = Promise.resolve()
      .then(() => this.runDrain())
      .finally(() => {
        this.drainPromise = null
        if (!this.paused && !this.stopped && !this.chatActive && !this.failClosedError && this.inbox.count('pending')) {
          queueMicrotask(() => { void this.drain() })
        }
      })
    return this.drainPromise
  }

  async runDrain() {
    while (!this.paused && !this.stopped && !this.chatActive && !this.failClosedError) {
      let item
      try {
        item = this.inbox.claimNext()
      } catch (error) {
        this._failClosed(new AgentProtocolError('COMMAND_INBOX_ERROR', `Failed to claim durable command: ${error.message}`), {})
        return
      }
      if (!item) return
      let validated
      try {
        validated = this.inbox.assertExecutable(item)
        item.record = validated.record
      } catch (error) {
        try {
          this.inbox.quarantine(item.path, error)
        } catch (quarantineError) {
          this._failClosed(new AgentProtocolError('COMMAND_INBOX_ERROR', `Failed to quarantine invalid command: ${quarantineError.message}`), item.record.rawPayload)
          return
        }
        this.onReject(new AgentProtocolError('INVALID_PERSISTED_COMMAND', error.message), item.record.rawPayload)
        continue
      }

      if (this.ledger && validated.normalized.commandId) {
        let fingerprint
        try {
          fingerprint = CommandFingerprint.compute(validated.normalized)
          let entry = this.ledger.getEntry(validated.normalized.commandId)
          if (!entry) {
            const check = this.ledger.checkOrRecord(
              validated.normalized.commandId,
              fingerprint,
              this._commandMeta(validated.normalized)
            )
            entry = check.entry
            this.ledger.recordQueueSequence(validated.normalized.commandId, validated.record.queueSequence)
          }
          if (entry.fingerprint !== fingerprint || entry.status !== ACK_STATUS.RECEIVED) {
            throw new Error(`queued command ledger mismatch/status ${entry.status}`)
          }
          this.ledger.markStarted(validated.normalized.commandId)
          const startedAck = this._emitAck(ACK_STATUS.STARTED, {
            ...this._commandMeta(validated.normalized),
            commandId: validated.normalized.commandId
          })
          if (!startedAck.persisted || this.failClosedError) {
            const reason = !startedAck.persisted
              ? 'STARTED_ACK_NOT_DURABLE: command was not executed because its STARTED ACK could not be persisted'
              : `PRE_EXECUTION_DURABILITY_FAILURE: command was not executed after STARTED ACK persistence (${this.failClosedError.message})`
            this._transitionClaimedToRecovery(item, validated.normalized, fingerprint, reason)
            return
          }
        } catch (error) {
          const reason = `PRE_EXECUTION_DURABILITY_FAILURE: command was not executed because durable preparation failed (${error.message})`
          this._transitionClaimedToRecovery(item, validated.normalized, fingerprint, reason)
          return
        }
      }

      this.commandActive = true
      let outcome
      try {
        outcome = await this.runCommand(validated.normalized, validated.record)
      } catch (error) {
        outcome = { status: 'failed', errorMessage: error.message }
      }
      const durableOutcome = {
        status: outcome?.status === 'failed' ? 'failed' : 'completed',
        exitCode: outcome?.exitCode,
        errorMessage: outcome?.errorMessage || ''
      }
      try {
        const completed = this.inbox.markCompleted(item, durableOutcome)
        let entry = null
        if (this.ledger && validated.normalized.commandId) {
          entry = this.ledger.markCompleted(validated.normalized.commandId, durableOutcome)
          this._emitAck(entry.status, {
            ...this._commandMeta(validated.normalized),
            commandId: validated.normalized.commandId,
            outcome: entry.outcome
          })
        }
        this.inbox.settleCompletedFile(item.path, item.fileName, completed)
      } catch (error) {
        this._failClosed(new AgentProtocolError(
          'COMMAND_COMPLETION_PERSIST_ERROR',
          `Command outcome may have side effects and requires reconciliation: ${error.message}`
        ), item.record.rawPayload)
      } finally {
        this.commandActive = false
      }
    }
  }

  _transitionClaimedToRecovery(item, message, fingerprint, reason) {
    let recovered
    try {
      recovered = this.inbox.markRecoveryRequired(item, reason)
    } catch (error) {
      this._failClosed(new AgentProtocolError(
        'COMMAND_INBOX_ERROR',
        `Command was not executed, but recovery-required inbox persistence failed: ${error.message}`
      ), item.record.rawPayload)
      return false
    }

    try {
      const durableFingerprint = fingerprint || CommandFingerprint.compute(message)
      const result = this.ledger.markRecoveryRequired(
        message.commandId,
        durableFingerprint,
        this._commandMeta(message),
        reason
      )
      if (result.conflict) throw new Error(`recovery fingerprint conflict for ${message.commandId}`)
      this._emitAck(ACK_STATUS.REJECTED, {
        ...this._commandMeta(message),
        commandId: message.commandId,
        rejectReason: reason
      })
    } catch (error) {
      this._failClosed(new AgentProtocolError(
        'DEDUPE_LEDGER_ERROR',
        `Command was not executed; recovery-required inbox is durable but ledger/ACK persistence failed: ${error.message}`
      ), recovered.record.rawPayload)
      return false
    }
    this._failClosed(new AgentProtocolError('COMMAND_RECOVERY_REQUIRED', reason), recovered.record.rawPayload)
    return true
  }

  _emitAck(ackStatus, meta, marker = { kind: 'entry' }) {
    const delivery = {
      persisted: false,
      sent: false,
      markerPersisted: false,
      dequeued: false
    }
    if (!this.ackOutbox) return delivery
    const envelope = buildAckEnvelope(this.profile, ackStatus, meta)
    let queued
    try {
      queued = this.ackOutbox.enqueue(envelope, marker)
      delivery.persisted = true
    } catch (error) {
      this._failClosed(new AgentProtocolError('ACK_OUTBOX_PERSIST_ERROR', `Failed to persist ACK before send: ${error.message}`), meta)
      return delivery
    }
    if (!this.sendFn) return delivery
    let sent = false
    try {
      sent = this.sendFn(envelope) === true
    } catch {
      return delivery
    }
    if (!sent) return delivery
    delivery.sent = true
    try {
      if (this.ledger && marker.kind !== 'none') this.ledger.markAckEmitted(meta.commandId, ackStatus, marker)
      delivery.markerPersisted = true
    } catch (error) {
      this._failClosed(new AgentProtocolError(
        'ACK_MARKER_PERSIST_ERROR',
        `ACK was sent but durable emitted marker failed; replay remains enabled for at-least-once delivery: ${error.message}`
      ), meta)
      return delivery
    }
    try {
      this.ackOutbox.dequeue(queued.fileName)
      delivery.dequeued = true
      return delivery
    } catch (error) {
      this._failClosed(new AgentProtocolError(
        'ACK_OUTBOX_DEQUEUE_ERROR',
        `ACK was sent but outbox dequeue failed; delivery remains at-least-once: ${error.message}`
      ), meta)
      return delivery
    }
  }

  replayAcks() {
    if (!this.ackOutbox || !this.sendFn) return 0
    let pending
    try {
      pending = this.ackOutbox.pendingEnvelopes()
    } catch (error) {
      const protocolError = error instanceof AgentProtocolError
        ? error
        : new AgentProtocolError('ACK_OUTBOX_CORRUPT', error.message)
      this._failClosed(protocolError, {})
      return 0
    }
    let replayed = 0
    for (const item of pending) {
      let sent = false
      try {
        sent = this.sendFn(item.envelope) === true
      } catch {
        break
      }
      if (!sent) break
      try {
        if (this.ledger && item.marker.kind !== 'none') {
          this.ledger.markAckEmitted(item.envelope.commandId, item.envelope.ackStatus, item.marker)
        }
      } catch (error) {
        this._failClosed(new AgentProtocolError(
          'ACK_MARKER_PERSIST_ERROR',
          `Replayed ACK was sent but marker persistence failed; outbox retained: ${error.message}`
        ), item.envelope)
        break
      }
      try {
        this.ackOutbox.dequeue(item.fileName)
        replayed += 1
      } catch (error) {
        this._failClosed(new AgentProtocolError(
          'ACK_OUTBOX_DEQUEUE_ERROR',
          `Replayed ACK was sent but dequeue failed; outbox retained: ${error.message}`
        ), item.envelope)
        break
      }
    }
    return replayed
  }

  async waitForIdle(timeoutMs = 5000) {
    const startedAt = Date.now()
    while (this.isBusy() || this.drainPromise
      || (!this.paused && !this.failClosedError && (this.inbox.count('pending') || this.inbox.count('processing')))) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for AgentMessageProcessor to become idle')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    }
  }
}


const loadCodexSessionMap = () => {
  try {
    if (!codexSessionMapPath || !existsSync(codexSessionMapPath)) return {}
    const parsed = JSON.parse(readFileSync(codexSessionMapPath, 'utf8'))
    return isObject(parsed) ? parsed : {}
  } catch (error) {
    console.warn(`failed to load codex session map | path=${codexSessionMapPath} | ${error.message}`)
    return {}
  }
}

const saveCodexSessionMap = () => {
  try {
    atomicWriteJson(DEFAULT_FS_OPERATIONS, codexSessionMapPath, codexSessionMap)
  } catch (error) {
    console.warn(`failed to save codex session map | path=${codexSessionMapPath} | ${error.message}`)
  }
}

export const buildWebSocketUrl = (url, apiKey, profile, runtimeInstanceId = PROCESS_RUNTIME_INSTANCE_ID) => {
  const parsed = new URL(url)
  parsed.searchParams.set('api_key', profile?.apiKey || apiKey)
  if (profile?.agentId) {
    parsed.searchParams.set('agent_id', profile.agentId)
    parsed.searchParams.set('agentId', profile.agentId)
  }
  parsed.searchParams.set('runtime_instance_id', runtimeInstanceId)
  parsed.searchParams.set('runtimeInstanceId', runtimeInstanceId)
  return parsed.toString()
}

export const buildProtocolEnvelope = (messageType, payload, profile, runtimeInstanceId = PROCESS_RUNTIME_INSTANCE_ID) => ({
  ...payload,
  type: messageType,
  schemaVersion: PROTOCOL_VERSION,
  messageType,
  messageId: randomUUID(),
  agentId: profile.agentId,
  sourceAgentId: profile.agentId,
  runtimeInstanceId,
  senderType: 'agent',
  senderName: payload?.senderName || payload?.personaName || profile.personaName || profile.agentName,
  sentAt: Date.now()
})

const getProfileById = profileId => config?.profiles.find(profile => profile.profileId === profileId || profile.agentId === profileId)
const getProfileState = profile => profileStates.get(profile.agentId)

const sendRaw = (event, profile = defaultProfile) => {
  const state = getProfileState(profile)
  if (!state?.ws || state.ws.readyState !== WebSocketClient.OPEN) return false
  state.ws.send(JSON.stringify(event))
  return true
}

const sendProtocol = (messageType, payload = {}, profile = defaultProfile) => sendRaw(
  buildProtocolEnvelope(messageType, payload, profile),
  profile
)

const sendLegacy = (type, payload = {}, profile = defaultProfile) => sendRaw({
  ...payload,
  type,
  requestId: `${type}-${Date.now()}-${randomUUID()}`,
  agentId: profile.agentId,
  runtimeInstanceId: PROCESS_RUNTIME_INSTANCE_ID,
  senderType: 'agent',
  senderName: profile.agentName
}, profile)

const sendStatus = (profile, status, extra = {}) => sendProtocol(MESSAGE_TYPES.AGENT_PRESENCE, {
  status,
  currentTaskId: extra.taskId || '',
  currentTaskTitle: extra.title || '',
  errorMessage: extra.errorMessage || ''
}, profile)

const registerAgent = profile => sendProtocol(MESSAGE_TYPES.AGENT_REGISTER, {
  name: profile.agentName,
  personaName: profile.personaName,
  endpoint: config.wsUrl,
  abilities: ['codex', 'shell', 'code-edit', 'debug', 'deploy-assist']
}, profile)

const resolvePrompt = message => {
  if (message.prompt) return String(message.prompt)
  if (message.content) return String(message.content)
  if (message.instruction) return String(message.instruction)
  if (message.description) return String(message.description)
  if (message.currentTaskTitle) return String(message.currentTaskTitle)
  if (message.title) return `处理任务：${message.title}`
  return ''
}

const trimReply = (value, limit = 12000) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}\n\n[输出已截断]` : text
}
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const buildReplyChunks = (content, chunkSize = 72) => {
  const text = String(content || '')
  const chunks = []
  for (let index = 0; index < text.length; index += chunkSize) chunks.push(text.slice(index, index + chunkSize))
  return chunks
}

const chatTrace = message => ({
  correlationId: message.correlationId || message.messageId,
  causationId: message.messageId,
  conversationId: message.conversationId,
  conversationType: message.conversationType || 'juyiting'
})

const sendChatDelta = (profile, message, content, extra = {}, sendProtocolFn = sendProtocol) => {
  if (!content) return
  sendProtocolFn(MESSAGE_TYPES.CHAT_MESSAGE_DELTA, {
    ...chatTrace(message),
    content,
    senderName: profile.personaName || profile.agentName,
    ...extra
  }, profile)
}

const sendChatFinal = (profile, message, content, extra = {}, sendProtocolFn = sendProtocol) => sendProtocolFn(
  MESSAGE_TYPES.CHAT_MESSAGE,
  {
    ...chatTrace(message),
    content,
    senderName: profile.personaName || profile.agentName,
    ...extra
  },
  profile
)

const extractCodexAgentText = event => {
  if (!isObject(event)) return ''
  const item = isObject(event.item) ? event.item : null
  if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text
  if (event.type === 'agent_message_delta' && typeof event.delta === 'string') return event.delta
  if (event.type === 'agent_message_delta' && typeof event.text === 'string') return event.text
  if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') return event.delta
  return ''
}

const extractCodexSessionId = event => {
  if (!isObject(event)) return ''
  if (typeof event.session_id === 'string') return event.session_id
  if (typeof event.sessionId === 'string') return event.sessionId
  if (event.type === 'session_meta' && typeof event.payload?.id === 'string') return event.payload.id
  if (typeof event.payload?.session_id === 'string') return event.payload.session_id
  if (typeof event.payload?.sessionId === 'string') return event.payload.sessionId
  if (typeof event.item?.session_id === 'string') return event.item.session_id
  return ''
}

const findCodexSessionFiles = dir => {
  const files = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return files }
  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...findCodexSessionFiles(entryPath))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath)
  }
  return files
}

const readCodexSessionMeta = filePath => {
  try {
    const firstLine = readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]
    if (!firstLine) return null
    const event = JSON.parse(firstLine)
    if (event?.type !== 'session_meta' || !event.payload?.id) return null
    const stats = statSync(filePath)
    return { id: String(event.payload.id), path: filePath, mtimeMs: stats.mtimeMs }
  } catch { return null }
}

const findLatestCodexSession = (profile, sinceMs = 0) => {
  if (!profile.codexHome) return null
  return findCodexSessionFiles(resolve(profile.codexHome, 'sessions'))
    .map(readCodexSessionMeta)
    .filter(meta => meta && meta.mtimeMs >= sinceMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null
}

const hasCodexSession = profile => {
  if (!profile.codexHome) return false
  const indexPath = resolve(profile.codexHome, 'session_index.jsonl')
  try {
    if (existsSync(indexPath) && readFileSync(indexPath, 'utf8').trim()) return true
    return Boolean(findLatestCodexSession(profile))
  } catch { return false }
}

const codexSessionMapKey = (profile, message) => message?.conversationId ? `${profile.agentId}:${message.conversationId}` : ''
const getMappedCodexSessionId = (profile, message) => {
  const value = codexSessionMap[codexSessionMapKey(profile, message)]
  return typeof value === 'string' ? value.trim() : ''
}
const rememberCodexSession = (profile, message, sessionId) => {
  const key = codexSessionMapKey(profile, message)
  const value = String(sessionId || '').trim()
  if (!key || !value || codexSessionMap[key] === value) return
  codexSessionMap[key] = value
  saveCodexSessionMap()
}

const buildCodexArgs = (profile, message, prompt) => {
  const mappedSessionId = getMappedCodexSessionId(profile, message)
  if (profile.codexSessionMode === 'resume' && (mappedSessionId || hasCodexSession(profile))) {
    return [
      '--ask-for-approval', profile.codexApproval,
      'exec', 'resume', '--json', '--skip-git-repo-check',
      ...(mappedSessionId ? [mappedSessionId] : ['--last', '--all']),
      prompt
    ]
  }
  return [
    '--ask-for-approval', profile.codexApproval,
    'exec', '--json', '--cd', profile.codexWorkdir,
    '--sandbox', profile.codexSandbox, '--skip-git-repo-check', prompt
  ]
}

export const runCodex = (profile, message, mode = 'command', overrides = {}) => new Promise(resolveRun => {
  const spawnFn = overrides.spawnFn || spawn
  const sendProtocolFn = overrides.sendProtocolFn || sendProtocol
  const sendLegacyFn = overrides.sendLegacyFn || sendLegacy
  const sendStatusFn = overrides.sendStatusFn || sendStatus
  const prompt = resolvePrompt(message)
  const taskId = message.taskId || message.workItemId || message.commandId || message.messageId || `codex-${Date.now()}`
  const title = message.title || message.currentTaskTitle || (mode === 'chat' ? 'Agent 聊天' : 'Codex 执行任务')

  if (!prompt) {
    const errorMessage = 'No prompt/content/instruction/title found in inbound event'
    if (mode === 'chat') sendChatFinal(profile, message, `无法处理：${errorMessage}`, { status: 'failed' }, sendProtocolFn)
    else sendLegacyFn('codex.result', { taskId, status: 'failed', errorMessage }, profile)
    resolveRun({ status: 'failed', errorMessage })
    return
  }

  if (mode === 'command') sendStatusFn(profile, 'busy', { taskId, title })
  if (mode === 'chat') sendChatDelta(profile, message, '收到，正在整理回复。\n\n', { phase: 'intro' }, sendProtocolFn)

  const args = buildCodexArgs(profile, message, prompt)
  const startedAt = Date.now()
  let child
  try {
    child = spawnFn(profile.codexBin, args, {
      cwd: profile.codexWorkdir,
      env: { ...process.env, ...(profile.codexHome ? { CODEX_HOME: profile.codexHome } : {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    if (mode === 'chat') sendChatFinal(profile, message, `执行失败：${error.message}`, { status: 'failed' }, sendProtocolFn)
    else {
      const payload = { taskId, agentId: profile.agentId, status: 'failed', currentTaskTitle: title, errorMessage: error.message }
      sendLegacyFn('task.report', payload, profile)
      sendLegacyFn('codex.result', payload, profile)
    }
    if (mode === 'command') sendStatusFn(profile, 'online')
    resolveRun({ status: 'failed', errorMessage: error.message })
    return
  }

  currentRuns.set(profile.agentId, child)
  let stdout = ''
  let stderr = ''
  let agentReplyText = ''
  let streamedAgentReply = ''
  let jsonLineBuffer = ''
  let runSessionId = ''
  let streamQueue = Promise.resolve()
  let settled = false
  const timeout = setTimeout(() => child.kill('SIGTERM'), profile.codexTimeoutMs)

  const streamAgentReplyText = async (content, extra = {}) => {
    if (mode !== 'chat' || !content) return
    const chunks = buildReplyChunks(content)
    for (const [index, chunk] of chunks.entries()) {
      sendChatDelta(profile, message, chunk, {
        phase: extra.phase || 'reply',
        chunkIndex: extra.chunkIndex ?? index,
        chunkCount: extra.chunkCount ?? chunks.length
      }, sendProtocolFn)
      streamedAgentReply += chunk
      await sleep(index === 0 ? 1 : 2)
    }
  }
  const queueAgentReplyText = (content, extra = {}) => {
    if (content) streamQueue = streamQueue.then(() => streamAgentReplyText(content, extra))
    return streamQueue
  }
  const handleJsonLine = line => {
    const trimmed = line.trim()
    if (!trimmed) return
    let event
    try { event = JSON.parse(trimmed) } catch {
      agentReplyText += `${trimmed}\n`
      return
    }
    const sessionId = extractCodexSessionId(event)
    if (sessionId) {
      runSessionId = sessionId
      rememberCodexSession(profile, message, sessionId)
    }
    const agentText = extractCodexAgentText(event)
    if (!agentText) return
    if (event.type === 'item.completed') {
      agentReplyText = agentText
      queueAgentReplyText(agentText.startsWith(streamedAgentReply) ? agentText.slice(streamedAgentReply.length) : agentText)
    } else {
      agentReplyText += agentText
      queueAgentReplyText(agentText)
    }
  }

  child.stdout.on('data', chunk => {
    const raw = chunk.toString()
    stdout = (stdout + raw).slice(-120000)
    jsonLineBuffer += raw
    let newline
    while ((newline = jsonLineBuffer.indexOf('\n')) !== -1) {
      handleJsonLine(jsonLineBuffer.slice(0, newline))
      jsonLineBuffer = jsonLineBuffer.slice(newline + 1)
    }
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-60000) })

  const finish = async (code, spawnError = null) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    if (jsonLineBuffer.trim()) handleJsonLine(jsonLineBuffer)
    currentRuns.delete(profile.agentId)
    if (!runSessionId) {
      const latestSession = findLatestCodexSession(profile, startedAt - 5000)
      if (latestSession?.id) rememberCodexSession(profile, message, latestSession.id)
    }
    const status = !spawnError && code === 0 ? 'completed' : 'failed'
    const replyContent = trimReply(agentReplyText) || trimReply(stdout) || trimReply(stderr)
      || (status === 'completed' ? '已处理，但无可返回内容。' : '执行失败，暂无详细输出。')
    const errorMessage = spawnError?.message || stderr.trim()
    const payload = {
      taskId,
      workItemId: message.workItemId || '',
      commandId: message.commandId || '',
      agentId: profile.agentId,
      status,
      currentTaskTitle: title,
      durationMs: Date.now() - startedAt,
      output: replyContent,
      errorMessage
    }
    if (mode === 'chat') {
      if (replyContent && streamedAgentReply !== replyContent) {
        await queueAgentReplyText(replyContent.startsWith(streamedAgentReply)
          ? replyContent.slice(streamedAgentReply.length)
          : replyContent)
      }
      await streamQueue
      sendChatFinal(profile, message, replyContent, { status }, sendProtocolFn)
    } else {
      sendLegacyFn('task.report', payload, profile)
      sendLegacyFn('codex.result', payload, profile)
    }
    if (mode === 'command') sendStatusFn(profile, 'online')
    resolveRun({ ...payload, exitCode: code })
  }

  child.on('close', code => { void finish(code) })
  child.on('error', error => { void finish(null, error) })
})

const ensureProfiles = (profiles, defaultProfileId, exitOnError = true) => {
  const profileIds = new Set()
  const agentIds = new Set()
  for (const profile of profiles) {
    if (profileIds.has(profile.profileId)) configError(`duplicate CODEX_PROFILES profileId: ${profile.profileId}`, exitOnError)
    if (agentIds.has(profile.agentId)) configError(`duplicate CODEX_PROFILES agentId: ${profile.agentId}`, exitOnError)
    profileIds.add(profile.profileId)
    agentIds.add(profile.agentId)
    const resolvedCodexBin = resolveExecutable(profile.codexBin)
    if (!resolvedCodexBin) configError(`codex binary not found or not executable for profile ${profile.profileId}: ${profile.codexBin}`, exitOnError)
    profile.codexBin = resolvedCodexBin
    if (!existsSync(profile.codexWorkdir)) configError(`codex workdir not found for profile ${profile.profileId}: ${profile.codexWorkdir}`, exitOnError)
  }
  if (!profiles.find(profile => profile.profileId === defaultProfileId || profile.agentId === defaultProfileId)) {
    configError(`DEFAULT_CODEX_PROFILE not found: ${defaultProfileId}`, exitOnError)
  }
}

const profileSignature = (profiles, defaultProfileId) => JSON.stringify({ defaultProfileId, profiles })
const sameProfileConfig = (left, right) => profileSignature([left], left.profileId) === profileSignature([right], right.profileId)

const clearReconnectState = state => {
  if (!state) return
  clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
  state.reconnectScheduled = false
}

const terminateChild = (profile, child, signal = 'SIGTERM') => {
  if (!child || child.exitCode !== null || child.killed) return
  try { child.kill(signal) } catch (error) {
    console.error(`failed to send ${signal} to codex child | profile=${profile.profileId} | ${error.message}`)
  }
}

const terminateAllRuns = () => {
  for (const profile of config.profiles) {
    const child = currentRuns.get(profile.agentId)
    if (child) {
      terminateChild(profile, child, 'SIGTERM')
      setTimeout(() => terminateChild(profile, child, 'SIGKILL'), 5000)
    }
  }
}

const createProfileState = profile => {
  const inbox = new PersistentCommandInbox({
    rootDir: config.commandInboxDir,
    profile,
    successPolicy: config.commandInboxSuccessPolicy
  })
  const ledger = new DurableDedupeLedger({
    rootDir: resolve(config.commandInboxDir, safeProfileDirectory(profile)),
    profile
  })
  const ackOutbox = new AckOutbox({
    rootDir: resolve(config.commandInboxDir, safeProfileDirectory(profile)),
    profile
  })
  ledger.initialize()
  ackOutbox.initialize()

  const sendAckFn = envelope => sendRaw(envelope, profile)

  const taskEvents = new Map()
  const state = {
    profile,
    ws: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    reconnectStartedAt: 0,
    reconnectScheduled: false,
    taskEvents,
    inbox,
    ledger,
    ackOutbox,
    processor: null
  }
  state.processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: message => runCodex(profile, message, 'command'),
    runChat: message => runCodex(profile, message, 'chat'),
    onTaskEvent: message => {
      const key = message.workItemId || message.taskId || message.messageId
      taskEvents.set(key, { ...message, observedAt: Date.now() })
      console.log(`task event observed | profile=${profile.profileId} | event=${message.eventType || ''} | taskId=${message.taskId || ''}`)
    },
    onReject: (error, raw) => {
      console.warn(`protocol message rejected | profile=${profile.profileId} | code=${error.code} | ${error.message}`)
      sendProtocol(MESSAGE_TYPES.PROTOCOL_ERROR, {
        code: error.code,
        message: error.message,
        causationId: isObject(raw) ? raw.messageId || raw.requestId : undefined
      }, profile)
    },
    sendChatBusy: message => sendChatFinal(profile, message, '当前正在处理其他请求，请稍后再试。', { status: 'busy' }),
    ledger,
    ackOutbox,
    sendFn: sendAckFn
  })
  const recovery = state.processor.start({ drain: false })
  if (recovery.recovered || recovery.completed || recovery.quarantined || recovery.recoveryRequired || recovery.failClosedCode) {
    const summary = {
      recovered: recovery.recovered,
      completed: recovery.completed,
      quarantined: recovery.quarantined,
      recoveryRequired: recovery.recoveryRequired,
      paused: recovery.paused,
      failClosedCode: recovery.failClosedCode
    }
    console.warn(`command inbox recovered | profile=${profile.profileId} | ${JSON.stringify(summary)}`)
  }
  return state
}

const isProfileBusy = profile => getProfileState(profile)?.processor?.isBusy() || currentRuns.has(profile.agentId)

const handleMessage = async (profile, raw) => {
  let parsed
  try { parsed = JSON.parse(raw.toString()) } catch (error) {
    getProfileState(profile)?.processor?.onReject(new AgentProtocolError('INVALID_JSON', `Invalid JSON message: ${error.message}`), raw.toString())
    return
  }
  if (!isObject(parsed)) {
    getProfileState(profile)?.processor?.onReject(new AgentProtocolError('INVALID_ENVELOPE', 'Agent message must be a JSON object'), parsed)
    return
  }
  if (INBOUND_CONTROL_TYPES.has(parsed.type) && !hasOwn(parsed, 'messageType')) {
    if (parsed.type === 'connected') {
      registerAgent(profile)
      sendStatus(profile, isProfileBusy(profile) ? 'busy' : 'online')
    } else if (parsed.type === 'ping') {
      sendLegacy('pong', {}, profile)
    }
    return
  }
  await getProfileState(profile)?.processor?.handle(raw.toString())
}

const doReconnect = profile => {
  const state = getProfileState(profile)
  if (!state || shuttingDown || state.reconnectScheduled) return
  const now = Date.now()
  if (!state.reconnectStartedAt) state.reconnectStartedAt = now
  const elapsed = now - state.reconnectStartedAt
  if (elapsed >= config.reconnectMaxMs) {
    shutdown(1, `reconnect timeout for profile ${profile.profileId}`)
    return
  }
  const delay = Math.min(30000, 1000 * 2 ** state.reconnectAttempt, config.reconnectMaxMs - elapsed)
  state.reconnectAttempt += 1
  state.reconnectScheduled = true
  state.reconnectTimer = setTimeout(() => {
    state.reconnectScheduled = false
    state.reconnectTimer = null
    connectProfile(profile)
  }, delay)
}

const connectProfile = profile => {
  const state = getProfileState(profile)
  if (!state) return
  clearReconnectState(state)
  clearInterval(state.heartbeatTimer)
  if (state.ws && state.ws.readyState !== WebSocketClient.CLOSED) {
    try { state.ws.close() } catch {}
  }
  let closeFired = false
  state.ws = new WebSocketClient(buildWebSocketUrl(config.wsUrl, config.apiKey, profile))
  state.ws.addEventListener('open', () => {
    clearReconnectState(state)
    state.reconnectAttempt = 0
    state.reconnectStartedAt = 0
    registerAgent(profile)
    sendStatus(profile, isProfileBusy(profile) ? 'busy' : 'online')
    const replayed = state.processor.replayAcks()
    if (replayed) console.warn(`ack replay | profile=${profile.profileId} | replayed=${replayed}`)
    state.processor.resume()
    state.heartbeatTimer = setInterval(() => sendStatus(profile, isProfileBusy(profile) ? 'busy' : 'online'), config.heartbeatMs)
  })
  state.ws.addEventListener('message', event => { void handleMessage(profile, event.data) })
  state.ws.addEventListener('close', () => {
    closeFired = true
    clearInterval(state.heartbeatTimer)
    state.processor.pause()
    if (!shuttingDown) doReconnect(profile)
  })
  state.ws.addEventListener('error', error => {
    console.error(`websocket error | profile=${profile.profileId}:`, error.message || error)
    setTimeout(() => {
      if (!closeFired && !shuttingDown && !state.reconnectScheduled) {
        try { state.ws?.close() } catch {}
        doReconnect(profile)
      }
    }, 1000)
  })
}

const disconnectProfile = (profile, reason = 'profile removed') => {
  const state = getProfileState(profile)
  if (!state) return
  state.processor.pause()
  clearReconnectState(state)
  clearInterval(state.heartbeatTimer)
  sendStatus(profile, 'offline', { errorMessage: reason })
  try { state.ws?.close() } catch {}
  const child = currentRuns.get(profile.agentId)
  if (child) {
    terminateChild(profile, child, 'SIGTERM')
    setTimeout(() => terminateChild(profile, child, 'SIGKILL'), 5000)
  }
  state.processor.stop()
  profileStates.delete(profile.agentId)
}

const applyProfileConfig = (nextProfiles, nextDefaultProfileId, reason = 'config reload') => {
  const previousProfiles = config.profiles
  const previousByAgentId = new Map(previousProfiles.map(profile => [profile.agentId, profile]))
  const nextByAgentId = new Map(nextProfiles.map(profile => [profile.agentId, profile]))
  for (const previousProfile of previousProfiles) {
    const next = nextByAgentId.get(previousProfile.agentId)
    const state = profileStates.get(previousProfile.agentId)
    if ((!next || !sameProfileConfig(previousProfile, next)) && state?.processor?.isBusy()) {
      shutdown(1, `${reason}: defer active profile replacement to process restart`)
      return
    }
  }
  for (const previousProfile of previousProfiles) {
    const next = nextByAgentId.get(previousProfile.agentId)
    if (!next || !sameProfileConfig(previousProfile, next)) disconnectProfile(previousProfile, reason)
  }
  config.profiles = nextProfiles
  config.defaultProfileId = nextDefaultProfileId
  defaultProfile = getProfileById(nextDefaultProfileId) || nextProfiles[0]
  for (const nextProfile of nextProfiles) {
    const previous = previousByAgentId.get(nextProfile.agentId)
    const state = profileStates.get(nextProfile.agentId)
    if (state && previous && sameProfileConfig(previous, nextProfile)) {
      state.profile = nextProfile
      continue
    }
    profileStates.set(nextProfile.agentId, createProfileState(nextProfile))
    connectProfile(nextProfile)
  }
  lastProfileSignature = profileSignature(config.profiles, config.defaultProfileId)
}

const reloadProfiles = (reason = 'config reload') => {
  if (shuttingDown || shutdownStarted || profileReloadInFlight) return
  profileReloadInFlight = true
  try {
    const next = loadRuntimeConfig({ exitOnError: false })
    ensureProfiles(next.profiles, next.defaultProfileId, false)
    if (profileSignature(next.profiles, next.defaultProfileId) !== lastProfileSignature) {
      applyProfileConfig(next.profiles, next.defaultProfileId, reason)
    }
  } catch (error) {
    console.warn(`profile config reload skipped | reason=${reason} | ${error.message}`)
  } finally {
    profileReloadInFlight = false
  }
}

const startProfileWatcher = () => {
  lastProfileSignature = profileSignature(config.profiles, config.defaultProfileId)
  if (config.profileReloadMs <= 0) return
  const profilesFile = process.env.CODEX_PROFILES_FILE?.trim()
  if (profilesFile) {
    const resolvedProfilesFile = resolve(profilesFile)
    watchFile(resolvedProfilesFile, { interval: config.profileReloadMs }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) reloadProfiles(`file changed: ${resolvedProfilesFile}`)
    })
  } else {
    profileReloadTimer = setInterval(() => reloadProfiles('periodic CODEX_PROFILES check'), config.profileReloadMs)
  }
}

const shutdown = (exitCode = 0, reason = '') => {
  if (shutdownStarted) return
  shutdownStarted = true
  shuttingDown = true
  if (reason) console.warn(`shutting down codex-ws-agent | reason=${reason}`)
  terminateAllRuns()
  if (profileReloadTimer) clearInterval(profileReloadTimer)
  const profilesFile = process.env.CODEX_PROFILES_FILE?.trim()
  if (profilesFile) unwatchFile(resolve(profilesFile))
  for (const profile of config.profiles) {
    const state = getProfileState(profile)
    state?.processor.pause()
    clearReconnectState(state)
    clearInterval(state?.heartbeatTimer)
    sendStatus(profile, 'offline')
    try { state?.ws?.close() } catch {}
  }
  setTimeout(() => process.exit(exitCode), 100)
}

export const loadWebSocketClient = async () => {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  const module = await import('ws')
  const implementation = module.WebSocket || module.default
  if (typeof implementation !== 'function') throw new Error('No WebSocket implementation is available')
  return implementation
}

export const main = async () => {
  WebSocketClient = await loadWebSocketClient()
  const runtimeConfig = loadRuntimeConfig()
  config = {
    wsUrl: process.env.WS_URL || 'wss://api.chaoyoufan.cn/ws/agent/channel',
    apiKey: process.env.OPENCLAW_API_KEY || '',
    profiles: runtimeConfig.profiles,
    defaultProfileId: runtimeConfig.defaultProfileId,
    heartbeatMs: parseNonNegativeMs(process.env.HEARTBEAT_MS, 30000),
    reconnectMaxMs: parseNonNegativeMs(process.env.RECONNECT_MAX_MS, 30 * 60 * 1000),
    profileReloadMs: parseNonNegativeMs(process.env.CODEX_PROFILE_RELOAD_MS, 5000),
    commandInboxDir: resolve(process.env.COMMAND_INBOX_DIR || '/home/isp/apps/codex-ws-agent/data/inbox'),
    commandInboxSuccessPolicy: process.env.COMMAND_INBOX_SUCCESS_POLICY || 'archive'
  }
  if (!config.apiKey && !config.profiles.every(profile => profile.apiKey)) {
    configError('OPENCLAW_API_KEY is required unless every profile defines apiKey')
  }
  if (!['archive', 'delete'].includes(config.commandInboxSuccessPolicy)) {
    configError('COMMAND_INBOX_SUCCESS_POLICY must be archive or delete')
  }
  ensureProfiles(config.profiles, config.defaultProfileId)
  defaultProfile = getProfileById(config.defaultProfileId) || config.profiles[0]
  codexSessionMapPath = resolve(process.env.CODEX_SESSION_MAP_FILE || resolve(process.cwd(), 'codex-session-map.json'))
  codexSessionMap = loadCodexSessionMap()

  if (hasFlag('--validate')) {
    console.log(`configuration valid | profiles=${config.profiles.length} | defaultProfile=${defaultProfile.profileId} | runtimeInstanceId=${PROCESS_RUNTIME_INSTANCE_ID}`)
    return
  }

  for (const profile of config.profiles) profileStates.set(profile.agentId, createProfileState(profile))
  process.on('SIGINT', () => shutdown(0, 'SIGINT'))
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
  for (const profile of config.profiles) connectProfile(profile)
  startProfileWatcher()
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch(error => {
    console.error(error.message || error)
    process.exit(1)
  })
}
