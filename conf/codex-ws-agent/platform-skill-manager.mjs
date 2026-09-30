import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, parse, resolve } from 'node:path'

import {
  LINUX_ATOMIC_FS,
  SKILL_INSTALL_FAILURE,
  SkillInstallError,
  extractSkillArchive
} from './skill-install-manager.mjs'
import {
  PlatformSkillNativeError,
  downloadPlatformSkillPackage,
  platformSkillApiOrigin,
  sendPlatformSkillResult,
  validatePlatformSkillCommand,
  validatePlatformSkillReceipt
} from './platform-skill-native.mjs'

export const PLATFORM_SKILL_ORIGIN = 'PLATFORM_PROVISIONED'
export const PLATFORM_SKILL_FAILURE = Object.freeze({
  DISABLED: 'PLATFORM_SKILL_INSTALL_DISABLED',
  PACKAGE_INVALID: 'PLATFORM_SKILL_PACKAGE_INVALID',
  DIGEST_MISMATCH: 'PLATFORM_SKILL_DIGEST_MISMATCH',
  CONFLICT: 'PLATFORM_SKILL_INSTALL_CONFLICT',
  IO_FAILED: 'PLATFORM_SKILL_INSTALL_IO_FAILED'
})

const MARKER_NAME = '.cyf-platform-installation.json'
const DEFAULT_MAX_PACKAGE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_MAX_REPLAY_BATCH = 32
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const SHA256 = /^[0-9a-f]{64}$/
const FAILURE_CODES = new Set(Object.values(PLATFORM_SKILL_FAILURE))
const COMMAND_FIELDS = ['attempt', 'bindingVersion', 'challengeId', 'clientId', 'commandId', 'commandType', 'deliveryEpoch', 'executionEpoch',
  'fencingToken', 'installationId', 'messageId', 'origin', 'ownerJiacn', 'packageRef', 'packageSha256', 'runtimeInstanceId', 'schemaVersion',
  'skillKey', 'skillVersion', 'targetAgentId', 'tenantId']
const RESULT_FIELDS = ['attempt', 'challengeId', 'commandId', 'errorCode', 'executionEpoch', 'installationId', 'outcome', 'packageSha256', 'schemaVersion']
const RECEIPT_RECORD_FIELDS = ['acknowledgedAt', 'formatVersion', 'origin', 'receipt', 'resultSha256', 'scopeDigest']
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, fields) => isObject(value) && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export class PlatformSkillManagerError extends Error {
  constructor(code, message) { super(message); this.name = 'PlatformSkillManagerError'; this.code = code }
}

const fsyncDirectory = directory => {
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const assertRealDirectory = (directory, label = 'directory') => {
  const canonical = resolve(directory)
  let status
  try { status = lstatSync(canonical) } catch (error) {
    throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, `${label} is unavailable: ${error.message}`)
  }
  if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(canonical) !== canonical) {
    throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, `${label} is not a canonical non-symlink directory: ${canonical}`)
  }
  return canonical
}

/** Creates one path component at a time and verifies every existing ancestor before descending. */
const ensureRealDirectory = (directory, mode = 0o700) => {
  const canonical = resolve(directory)
  const root = parse(canonical).root
  assertRealDirectory(root, 'filesystem root')
  let current = root
  const parts = canonical.slice(root.length).split(/[\\/]+/u).filter(Boolean)
  for (const part of parts) {
    const next = resolve(current, part)
    if (existsSync(next)) {
      assertRealDirectory(next)
    } else {
      assertRealDirectory(current, 'directory parent')
      try { mkdirSync(next, { mode }) } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      assertRealDirectory(next)
      chmodSync(next, mode)
      fsyncDirectory(current)
    }
    current = next
  }
  chmodSync(canonical, mode)
  fsyncDirectory(canonical)
  return canonical
}

const pathIdentity = path => {
  const canonical = resolve(path)
  const status = lstatSync(canonical, { bigint: true })
  return Object.freeze({
    path: status.isSymbolicLink() ? canonical : realpathSync(canonical),
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    kind: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : status.isSymbolicLink() ? 'symlink' : 'other'
  })
}
const validIdentity = (value, kind, expectedPath = null) => exactKeys(value, ['dev', 'ino', 'kind', 'path'])
  && typeof value.dev === 'string' && /^[0-9]+$/u.test(value.dev)
  && typeof value.ino === 'string' && /^[0-9]+$/u.test(value.ino)
  && value.kind === kind && typeof value.path === 'string'
  && (expectedPath === null || value.path === resolve(expectedPath))
const sameNodeIdentity = (left, right) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.kind === right.kind)
const samePathIdentity = (left, right) => sameNodeIdentity(left, right) && left.path === right.path

const safeReadBytes = (path, label, maxBytes = 1024 * 1024) => {
  const canonical = resolve(path)
  let status
  try { status = lstatSync(canonical) } catch (error) {
    throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, `${label} is unavailable: ${error.message}`)
  }
  if (!status.isFile() || status.isSymbolicLink() || realpathSync(canonical) !== canonical || status.size > maxBytes) {
    throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, `${label} is not a bounded canonical regular file`)
  }
  return readFileSync(canonical)
}
const readJson = (path, label = 'JSON record') => {
  try { return JSON.parse(safeReadBytes(path, label).toString('utf8')) } catch (error) {
    if (error instanceof PlatformSkillManagerError) throw error
    throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, `${label} is unreadable: ${error.message}`)
  }
}

const atomicFailure = result => {
  const code = ['TARGET_EXISTS', 'SOURCE_CHANGED', 'PARENT_CHANGED_ROLLED_BACK', 'PARENT_CHANGED_ROLLBACK_FAILED', 'POSTCONDITION_FAILED'].includes(result?.code)
    ? PLATFORM_SKILL_FAILURE.CONFLICT : PLATFORM_SKILL_FAILURE.IO_FAILED
  return new PlatformSkillManagerError(code, `atomic no-replace write failed closed (${result?.code || 'UNKNOWN'}): ${result?.message || 'atomic helper failed'}`)
}

/** Writes and fsyncs a temporary regular file, then publishes it with atomic no-replace. */
const createJsonOnce = (targetPath, value, { mode = 0o600, atomicFs, createId }) => {
  const directory = assertRealDirectory(dirname(targetPath), 'journal parent')
  const parentIdentity = pathIdentity(directory)
  const temporaryPath = resolve(directory, `.${basename(targetPath)}.tmp-${process.pid}-${createId()}`)
  let descriptor
  let temporaryIdentity
  try {
    descriptor = openSync(temporaryPath, 'wx', mode)
    writeFileSync(descriptor, Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporaryPath, mode)
    temporaryIdentity = pathIdentity(temporaryPath)
    if (!validIdentity(temporaryIdentity, 'file', temporaryPath)) throw new Error('journal temporary file identity is invalid')
    const result = atomicFs.renameNoReplace(temporaryPath, targetPath, {
      sourceParent: parentIdentity,
      targetParent: parentIdentity,
      sourceIdentity: temporaryIdentity
    })
    if (!result?.ok) {
      if (existsSync(temporaryPath)) {
        const current = pathIdentity(temporaryPath)
        if (samePathIdentity(current, temporaryIdentity) && current.kind === 'file') unlinkSync(temporaryPath)
      }
      fsyncDirectory(directory)
      if (result?.code === 'TARGET_EXISTS') return false
      throw atomicFailure(result)
    }
    const published = pathIdentity(targetPath)
    if (!sameNodeIdentity(published, temporaryIdentity) || published.kind !== 'file') {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, 'journal publication inode postcondition failed')
    }
    fsyncDirectory(directory)
    return true
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    try {
      if (existsSync(temporaryPath)) {
        const current = pathIdentity(temporaryPath)
        if (!temporaryIdentity || samePathIdentity(current, temporaryIdentity)) unlinkSync(temporaryPath)
      }
    } catch {}
    if (error instanceof PlatformSkillManagerError) throw error
    throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, `journal write failed: ${error.message}`)
  }
}

const assertSafeId = (value, label) => {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, `${label} is not a safe identifier`)
  }
  return value
}
const scopeDigest = scope => sha256(Buffer.from(`CYF_PLATFORM_SKILL_SCOPE_V1\0${JSON.stringify(scope)}`))
const businessCommand = command => Object.freeze({
  schemaVersion: command.schemaVersion,
  origin: command.origin,
  commandType: command.commandType,
  commandId: command.commandId,
  fencingToken: command.fencingToken,
  deliveryEpoch: command.deliveryEpoch,
  executionEpoch: command.executionEpoch,
  tenantId: command.tenantId,
  clientId: command.clientId,
  ownerJiacn: command.ownerJiacn,
  targetAgentId: command.targetAgentId,
  runtimeInstanceId: command.runtimeInstanceId,
  installationId: command.installationId,
  bindingVersion: command.bindingVersion,
  skillKey: command.skillKey,
  skillVersion: command.skillVersion,
  packageSha256: command.packageSha256,
  challengeId: command.challengeId,
  packageRef: command.packageRef
})
const commandFingerprint = command => sha256(Buffer.from(`CYF_PLATFORM_SKILL_BUSINESS_V2\0${JSON.stringify(businessCommand(command))}`))
const profileDirectory = profile => Buffer.from(String(profile.agentId), 'utf8').toString('hex')

const mapFailure = error => {
  if (error instanceof PlatformSkillManagerError) return error
  if (error instanceof PlatformSkillNativeError) {
    if (error.code === PLATFORM_SKILL_FAILURE.DIGEST_MISMATCH) return new PlatformSkillManagerError(error.code, error.message)
    if (error.code === 'PLATFORM_SKILL_NATIVE_RESPONSE_INVALID') return new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.PACKAGE_INVALID, error.message)
    if (error.code === 'PLATFORM_SKILL_COMMAND_INVALID') return new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, error.message)
    return new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, error.message)
  }
  if (error instanceof SkillInstallError) {
    if ([SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, SKILL_INSTALL_FAILURE.IDENTITY_MISMATCH].includes(error.code)) {
      return new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.PACKAGE_INVALID, error.message)
    }
    if (error.code === SKILL_INSTALL_FAILURE.CONFLICT) return new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, error.message)
  }
  return new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, error?.message || 'platform skill installation failed')
}

const resultBody = (command, outcome, errorCode) => Object.freeze({
  schemaVersion: 1,
  installationId: command.installationId,
  commandId: command.commandId,
  attempt: command.attempt,
  executionEpoch: command.executionEpoch,
  challengeId: command.challengeId,
  packageSha256: command.packageSha256,
  outcome,
  errorCode
})
const validResultBody = (value, command) => exactKeys(value, RESULT_FIELDS)
  && value.schemaVersion === 1 && value.installationId === command.installationId && value.commandId === command.commandId
  && value.attempt === command.attempt && value.executionEpoch === command.executionEpoch && value.challengeId === command.challengeId
  && value.packageSha256 === command.packageSha256
  && (value.outcome === 'SUCCEEDED' && value.errorCode === null
    || value.outcome === 'FAILED' && FAILURE_CODES.has(value.errorCode))

export const defaultPlatformSkillStateRoot = (commandInboxDir, profile, runtimeScope, wsUrl) => {
  const scope = {
    origin: PLATFORM_SKILL_ORIGIN,
    apiOrigin: platformSkillApiOrigin(wsUrl),
    profileId: String(profile?.profileId || ''),
    tenantId: String(runtimeScope?.tenantId || ''),
    clientId: String(runtimeScope?.clientId || ''),
    ownerJiacn: String(runtimeScope?.ownerJiacn || ''),
    agentId: String(runtimeScope?.agentId || ''),
    runtimeInstanceId: String(runtimeScope?.runtimeInstanceId || '')
  }
  return resolve(commandInboxDir, profileDirectory(profile || {}), 'platform-skill', scopeDigest(scope).slice(0, 32))
}

export class PlatformSkillManager {
  constructor({
    profile,
    runtimeScope,
    stateRoot,
    wsUrl,
    enabled = false,
    authorizationProvider = () => '',
    fetchFn = globalThis.fetch,
    downloadFn = downloadPlatformSkillPackage,
    sendResultFn = sendPlatformSkillResult,
    atomicFs = LINUX_ATOMIC_FS,
    now = () => Date.now(),
    createId = () => randomUUID(),
    maxPackageBytes = DEFAULT_MAX_PACKAGE_BYTES,
    maxExtractedBytes = DEFAULT_MAX_EXTRACTED_BYTES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxReplayBatch = DEFAULT_MAX_REPLAY_BATCH
  }) {
    if (!profile?.profileId || !profile?.agentId || !profile?.codexHome) throw new Error('profileId, agentId and codexHome are required')
    if (!runtimeScope || profile.agentId !== runtimeScope.agentId) throw new Error('profile agentId must match native runtime scope')
    if (!Number.isSafeInteger(maxReplayBatch) || maxReplayBatch < 1 || maxReplayBatch > 256) throw new Error('maxReplayBatch must be between 1 and 256')
    this.profile = { profileId: String(profile.profileId), agentId: String(profile.agentId), codexHome: resolve(profile.codexHome) }
    this.runtimeScope = Object.freeze({ ...runtimeScope })
    this.stateRoot = resolve(stateRoot)
    this.wsUrl = wsUrl
    this.enabled = enabled === true
    this.authorizationProvider = authorizationProvider
    this.fetchFn = fetchFn
    this.downloadFn = downloadFn
    this.sendResultFn = sendResultFn
    this.atomicFs = atomicFs
    this.now = now
    this.createId = createId
    this.maxPackageBytes = maxPackageBytes
    this.extractLimits = { maxExtractedBytes, maxEntryBytes, maxEntries }
    this.maxReplayBatch = maxReplayBatch
    this.apiOrigin = platformSkillApiOrigin(wsUrl)
    this.scope = Object.freeze({
      formatVersion: 1,
      origin: PLATFORM_SKILL_ORIGIN,
      apiOrigin: this.apiOrigin,
      profileId: this.profile.profileId,
      tenantId: runtimeScope.tenantId,
      clientId: runtimeScope.clientId,
      ownerJiacn: runtimeScope.ownerJiacn,
      agentId: runtimeScope.agentId,
      runtimeInstanceId: runtimeScope.runtimeInstanceId
    })
    this.scopeRecord = Object.freeze({ ...this.scope, digest: scopeDigest(this.scope) })
    this.installationsDir = resolve(this.stateRoot, 'installations')
    this.initialized = false
    this.inFlight = new Map()
    this.replayCursor = null
  }

  _writeOnce(path, value, mode = 0o600) {
    return createJsonOnce(path, value, { mode, atomicFs: this.atomicFs, createId: this.createId })
  }

  initialize() {
    ensureRealDirectory(this.stateRoot)
    ensureRealDirectory(this.installationsDir)
    const scopePath = resolve(this.stateRoot, 'scope.json')
    if (!this._writeOnce(scopePath, this.scopeRecord)) {
      const actual = readJson(scopePath, 'platform skill scope')
      if (!sameJson(actual, this.scopeRecord)) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform skill scope conflicts with durable state')
    }
    this.initialized = true
    return { healthy: true, enabled: this.enabled }
  }

  _requireInitialized() {
    if (!this.initialized) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, 'platform skill manager is not initialized')
  }

  _installationDirectory(installationId) {
    return resolve(this.installationsDir, assertSafeId(installationId, 'installationId'))
  }

  _validateCommand(command) {
    const seed = [command?.tenantId, command?.clientId, command?.ownerJiacn, command?.installationId,
      command?.targetAgentId, 'PLATFORM_SKILL_INSTALL'].join('\0')
    const expectedCommandId = `cmd_controlled_${sha256(Buffer.from(seed))}`
    if (!exactKeys(command, COMMAND_FIELDS) || command.schemaVersion !== 1 || command.origin !== PLATFORM_SKILL_ORIGIN
        || command.commandType !== 'PLATFORM_SKILL_INSTALL' || !SAFE_ID.test(command.messageId) || !SAFE_ID.test(command.commandId)
        || command.commandId !== expectedCommandId || !Number.isSafeInteger(command.attempt) || command.attempt < 1
        || command.fencingToken !== '1' || command.deliveryEpoch !== '1' || command.executionEpoch !== '1'
        || command.tenantId !== this.runtimeScope.tenantId || command.clientId !== this.runtimeScope.clientId
        || command.ownerJiacn !== this.runtimeScope.ownerJiacn || command.targetAgentId !== this.runtimeScope.agentId
        || command.runtimeInstanceId !== this.runtimeScope.runtimeInstanceId || !SAFE_ID.test(command.installationId)
        || !SAFE_ID.test(command.challengeId) || typeof command.bindingVersion !== 'string'
        || !/^[1-9][0-9]{0,18}$/u.test(command.bindingVersion) || command.skillKey !== 'archive-maintainer'
        || command.skillVersion !== '1.0.0' || !SHA256.test(command.packageSha256)
        || command.packageRef !== `/internal/agent/platform-skills/installations/${command.installationId}/package`) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'durable platform command shape or scope is invalid')
    }
    return command
  }

  _commandRecord(command) {
    this._validateCommand(command)
    return Object.freeze({
      formatVersion: 2,
      origin: PLATFORM_SKILL_ORIGIN,
      scopeDigest: this.scopeRecord.digest,
      businessFingerprint: commandFingerprint(command),
      receivedAt: this.now(),
      command: Object.freeze({ ...command })
    })
  }

  _loadCommandRecord(directory) {
    const record = readJson(resolve(directory, 'command.json'), 'platform installation command')
    if (!exactKeys(record, ['businessFingerprint', 'command', 'formatVersion', 'origin', 'receivedAt', 'scopeDigest'])
        || record.formatVersion !== 2 || record.origin !== PLATFORM_SKILL_ORIGIN || record.scopeDigest !== this.scopeRecord.digest
        || !Number.isSafeInteger(record.receivedAt) || record.receivedAt < 0) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform installation command registry is invalid')
    }
    this._validateCommand(record.command)
    if (record.businessFingerprint !== commandFingerprint(record.command)) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform installation command fingerprint is invalid')
    }
    return record
  }

  _recoverCommandlessDirectory(directory) {
    const entries = readdirSync(directory)
    for (const name of entries) {
      if (!name.startsWith('.command.json.tmp-')) return false
      const path = resolve(directory, name)
      const status = lstatSync(path)
      if (!status.isFile() || status.isSymbolicLink()) return false
      unlinkSync(path)
    }
    if (entries.length) fsyncDirectory(directory)
    return true
  }

  _ensureInstallation(command) {
    const directory = this._installationDirectory(command.installationId)
    const expected = this._commandRecord(command)
    let created = false
    try {
      const parentBefore = pathIdentity(this.installationsDir)
      mkdirSync(directory, { mode: 0o700 })
      const actual = pathIdentity(directory)
      if (!validIdentity(actual, 'directory', directory) || !samePathIdentity(pathIdentity(this.installationsDir), parentBefore)) {
        throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'installation registry parent changed during creation')
      }
      chmodSync(directory, 0o700)
      fsyncDirectory(this.installationsDir)
      created = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const status = lstatSync(directory)
    if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(directory) !== directory) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'installation registry path is not a canonical directory')
    }
    const commandPath = resolve(directory, 'command.json')
    if (!existsSync(commandPath)) {
      if (!created && !this._recoverCommandlessDirectory(directory)) {
        throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'installation registry exists without recoverable command evidence')
      }
      if (!this._writeOnce(commandPath, expected)) {
        const raced = this._loadCommandRecord(directory)
        if (raced.businessFingerprint !== expected.businessFingerprint) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'installation command creation raced with different business content')
        return { directory, commandRecord: raced, created: false }
      }
      return { directory, commandRecord: expected, created: true }
    }
    const actual = this._loadCommandRecord(directory)
    if (actual.businessFingerprint !== expected.businessFingerprint) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'installationId is already bound to different platform skill content')
    }
    return { directory, commandRecord: actual, created: false }
  }

  _namespacePaths() {
    const skills = resolve(this.profile.codexHome, 'skills')
    const origin = resolve(skills, 'platform-provisioned')
    const scope = resolve(origin, this.scopeRecord.digest)
    const skill = resolve(scope, 'archive-maintainer')
    const stagingRoot = resolve(skills, '.platform-provisioned-staging')
    const staging = resolve(stagingRoot, this.scopeRecord.digest)
    return { skills, origin, scope, skill, stagingRoot, staging, targetPath: resolve(skill, '1.0.0') }
  }

  _skillsNamespace() {
    assertRealDirectory(this.profile.codexHome, 'profile CODEX_HOME')
    const paths = this._namespacePaths()
    ensureRealDirectory(paths.skills)
    ensureRealDirectory(paths.origin)
    ensureRealDirectory(paths.scope)
    ensureRealDirectory(paths.skill)
    ensureRealDirectory(paths.stagingRoot)
    ensureRealDirectory(paths.staging)
    return {
      ...paths,
      sourceParentIdentity: pathIdentity(paths.staging),
      targetParentIdentity: pathIdentity(paths.skill)
    }
  }

  _marker(command) {
    return Object.freeze({
      schemaVersion: 1,
      origin: PLATFORM_SKILL_ORIGIN,
      scopeDigest: this.scopeRecord.digest,
      businessFingerprint: commandFingerprint(command),
      installationId: command.installationId,
      commandId: command.commandId,
      attempt: command.attempt,
      executionEpoch: command.executionEpoch,
      challengeId: command.challengeId,
      bindingVersion: command.bindingVersion,
      agentId: command.targetAgentId,
      runtimeInstanceId: command.runtimeInstanceId,
      skillKey: command.skillKey,
      skillVersion: command.skillVersion,
      packageSha256: command.packageSha256
    })
  }

  _manifestProof(directory) {
    const manifestPath = resolve(directory, 'SKILL.md')
    const bytes = safeReadBytes(manifestPath, 'platform SKILL.md', this.extractLimits.maxEntryBytes)
    const identity = pathIdentity(manifestPath)
    if (!validIdentity(identity, 'file', manifestPath)) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform SKILL.md identity is invalid')
    }
    return { manifestIdentity: identity, manifestSha256: sha256(bytes) }
  }

  _validActivation(path, command, prepared) {
    try {
      const status = lstatSync(path)
      if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(path) !== resolve(path)) return false
      const directoryIdentity = pathIdentity(path)
      if (!sameNodeIdentity(directoryIdentity, prepared.stagingIdentity)) return false
      const names = readdirSync(path).sort()
      if (names.join('\0') !== [MARKER_NAME, 'SKILL.md'].sort().join('\0')) return false
      const marker = readJson(resolve(path, MARKER_NAME), 'platform activation marker')
      if (!sameJson(marker, this._marker(command))) return false
      const manifest = this._manifestProof(path)
      return manifest.manifestSha256 === prepared.manifestSha256
        && sameNodeIdentity(manifest.manifestIdentity, prepared.manifestIdentity)
    } catch { return false }
  }

  _preparedRecord(command, stagingPath, namespace) {
    const proof = this._manifestProof(stagingPath)
    return Object.freeze({
      formatVersion: 2,
      origin: PLATFORM_SKILL_ORIGIN,
      scopeDigest: this.scopeRecord.digest,
      businessFingerprint: commandFingerprint(command),
      stagingPath,
      targetPath: namespace.targetPath,
      sourceParentIdentity: namespace.sourceParentIdentity,
      targetParentIdentity: namespace.targetParentIdentity,
      stagingIdentity: pathIdentity(stagingPath),
      manifestIdentity: proof.manifestIdentity,
      manifestSha256: proof.manifestSha256,
      preparedAt: this.now()
    })
  }

  _validatePrepared(record, command) {
    const paths = this._namespacePaths()
    const fields = ['businessFingerprint', 'formatVersion', 'manifestIdentity', 'manifestSha256', 'origin', 'preparedAt', 'scopeDigest',
      'sourceParentIdentity', 'stagingIdentity', 'stagingPath', 'targetParentIdentity', 'targetPath']
    const valid = exactKeys(record, fields) && record.formatVersion === 2 && record.origin === PLATFORM_SKILL_ORIGIN
      && record.scopeDigest === this.scopeRecord.digest && record.businessFingerprint === commandFingerprint(command)
      && record.targetPath === paths.targetPath && dirname(record.stagingPath) === paths.staging
      && basename(record.stagingPath).startsWith(`${command.installationId}-`)
      && validIdentity(record.sourceParentIdentity, 'directory', paths.staging)
      && validIdentity(record.targetParentIdentity, 'directory', paths.skill)
      && validIdentity(record.stagingIdentity, 'directory', record.stagingPath)
      && validIdentity(record.manifestIdentity, 'file', resolve(record.stagingPath, 'SKILL.md'))
      && typeof record.manifestSha256 === 'string' && SHA256.test(record.manifestSha256)
      && Number.isSafeInteger(record.preparedAt) && record.preparedAt >= 0
    if (!valid) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'prepared platform installation record conflicts with scope or namespace')
    return record
  }

  _loadPrepared(directory, command) {
    const path = resolve(directory, 'prepared.json')
    if (!existsSync(path)) return null
    return this._validatePrepared(readJson(path, 'prepared platform installation record'), command)
  }

  _persistResult(directory, command, outcome, errorCode) {
    const body = resultBody(command, outcome, errorCode)
    if (!validResultBody(body, command)) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform result body is invalid')
    const record = Object.freeze({
      formatVersion: 2,
      origin: PLATFORM_SKILL_ORIGIN,
      scopeDigest: this.scopeRecord.digest,
      businessFingerprint: commandFingerprint(command),
      createdAt: this.now(),
      result: body
    })
    const path = resolve(directory, 'result.json')
    if (!this._writeOnce(path, record)) {
      const actual = this._loadResult(directory, command)
      if (!sameJson(actual.result, body)) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'durable platform installation result conflicts')
      return actual
    }
    return record
  }

  _loadResult(directory, command) {
    const path = resolve(directory, 'result.json')
    if (!existsSync(path)) return null
    const record = readJson(path, 'durable platform installation result')
    if (!exactKeys(record, ['businessFingerprint', 'createdAt', 'formatVersion', 'origin', 'result', 'scopeDigest'])
        || record.formatVersion !== 2 || record.origin !== PLATFORM_SKILL_ORIGIN || record.scopeDigest !== this.scopeRecord.digest
        || record.businessFingerprint !== commandFingerprint(command) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || !validResultBody(record.result, command)) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'durable platform installation result is invalid')
    }
    return record
  }

  _loadReceipt(directory, command, resultRecord) {
    const path = resolve(directory, 'receipt.json')
    if (!existsSync(path)) return null
    const record = readJson(path, 'platform installation receipt')
    const resultSha256 = sha256(Buffer.from(JSON.stringify(resultRecord.result)))
    if (!exactKeys(record, RECEIPT_RECORD_FIELDS) || record.formatVersion !== 1 || record.origin !== PLATFORM_SKILL_ORIGIN
        || record.scopeDigest !== this.scopeRecord.digest || record.resultSha256 !== resultSha256
        || !Number.isSafeInteger(record.acknowledgedAt) || record.acknowledgedAt < 0) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform installation receipt conflicts with persisted result')
    }
    try {
      return validatePlatformSkillReceipt(record.receipt, command, this.runtimeScope, resultRecord.result.outcome, resultRecord.result.errorCode)
    } catch (error) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, `platform installation receipt body is invalid: ${error.message}`)
    }
  }

  _recovery(error, result = null, activationCommitted = false, status = 'recovery_required') {
    const mapped = mapFailure(error)
    return {
      status,
      outcome: result?.outcome ?? null,
      failureCode: mapped.code,
      errorMessage: mapped.message,
      result,
      activationCommitted
    }
  }

  async _postPersisted(directory, command, resultRecord) {
    if (resultRecord.result.outcome === 'SUCCEEDED') {
      const prepared = this._loadPrepared(directory, command)
      if (!prepared || !existsSync(prepared.targetPath) || existsSync(prepared.stagingPath)
          || !this._validActivation(prepared.targetPath, command, prepared)) {
        return this._recovery(new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT,
          'persisted platform success no longer matches the activated SKILL.md proof'), resultRecord.result, false)
      }
    }
    const existingReceipt = this._loadReceipt(directory, command, resultRecord)
    if (existingReceipt) return this._terminal(resultRecord.result, existingReceipt, true)
    let authorization
    try { authorization = await this.authorizationProvider() } catch { authorization = '' }
    try {
      const receipt = await this.sendResultFn({
        wsUrl: this.wsUrl,
        command,
        runtimeScope: this.runtimeScope,
        authorization,
        outcome: resultRecord.result.outcome,
        errorCode: resultRecord.result.errorCode,
        fetchFn: this.fetchFn
      })
      const validated = validatePlatformSkillReceipt(receipt, command, this.runtimeScope, resultRecord.result.outcome, resultRecord.result.errorCode)
      const receiptRecord = {
        formatVersion: 1,
        origin: PLATFORM_SKILL_ORIGIN,
        scopeDigest: this.scopeRecord.digest,
        resultSha256: sha256(Buffer.from(JSON.stringify(resultRecord.result))),
        acknowledgedAt: this.now(),
        receipt: validated
      }
      const receiptPath = resolve(directory, 'receipt.json')
      if (!this._writeOnce(receiptPath, receiptRecord)) {
        const existing = this._loadReceipt(directory, command, resultRecord)
        if (!sameJson(existing, validated)) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform installation receipt creation raced with different content')
        return this._terminal(resultRecord.result, existing, true)
      }
      return this._terminal(resultRecord.result, validated, false)
    } catch (error) {
      return {
        status: 'recovery_required',
        outcome: resultRecord.result.outcome,
        failureCode: resultRecord.result.errorCode,
        errorMessage: `PLATFORM_SKILL_RECEIPT_PENDING: ${error?.code || error?.message || 'unknown response'}`,
        result: resultRecord.result,
        activationCommitted: resultRecord.result.outcome === 'SUCCEEDED'
      }
    }
  }

  _terminal(result, receipt, idempotent) {
    return {
      status: result.outcome === 'SUCCEEDED' ? 'completed' : 'failed',
      outcome: result.outcome,
      failureCode: result.errorCode,
      errorMessage: result.errorCode || '',
      result,
      receipt,
      idempotent,
      activationCommitted: result.outcome === 'SUCCEEDED'
    }
  }

  _activatePrepared(record, command) {
    this._validatePrepared(record, command)
    const sourceParent = pathIdentity(dirname(record.stagingPath))
    const targetParent = pathIdentity(dirname(record.targetPath))
    if (!samePathIdentity(sourceParent, record.sourceParentIdentity)
        || !samePathIdentity(targetParent, record.targetParentIdentity)) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'prepared platform installation parent inode changed')
    }
    const targetExists = existsSync(record.targetPath)
    const stagingExists = existsSync(record.stagingPath)
    if (targetExists) {
      if (stagingExists || !this._validActivation(record.targetPath, command, record)) {
        throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform skill target conflicts with prepared installation')
      }
      return
    }
    if (!stagingExists || !samePathIdentity(pathIdentity(record.stagingPath), record.stagingIdentity)
        || !this._validActivation(record.stagingPath, command, record)) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'prepared platform skill staging is unavailable or invalid')
    }
    const result = this.atomicFs.renameNoReplace(record.stagingPath, record.targetPath, {
      sourceParent: record.sourceParentIdentity,
      targetParent: record.targetParentIdentity,
      sourceIdentity: record.stagingIdentity
    })
    if (!result?.ok) throw atomicFailure(result)
    if (!this._validActivation(record.targetPath, command, record)) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, 'activated platform skill failed immediate proof validation')
    }
  }

  _verifyPackage(bytes, command) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > this.maxPackageBytes) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.PACKAGE_INVALID, 'platform package is not a bounded byte buffer')
    }
    if (sha256(bytes) !== command.packageSha256) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.DIGEST_MISMATCH, 'platform package digest does not match command')
    }
    return bytes
  }

  _safeRemoveStaging(path, identity) {
    try {
      if (!existsSync(path)) return
      const current = pathIdentity(path)
      if (!samePathIdentity(current, identity) || current.kind !== 'directory') return
      rmSync(path, { recursive: true, force: true })
      fsyncDirectory(dirname(path))
    } catch { /* fail closed by leaving uncertain staging evidence */ }
  }

  async _install(directory, command, created) {
    const existingResult = this._loadResult(directory, command)
    if (existingResult) return this._postPersisted(directory, command, existingResult)
    const existingPrepared = this._loadPrepared(directory, command)
    if (existingPrepared) {
      try {
        this._activatePrepared(existingPrepared, command)
        const result = this._persistResult(directory, command, 'SUCCEEDED', null)
        return this._postPersisted(directory, command, result)
      } catch (error) {
        return this._recovery(error, null, existsSync(existingPrepared.targetPath)
          && this._validActivation(existingPrepared.targetPath, command, existingPrepared))
      }
    }
    if (!created) {
      return this._recovery(new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED,
        'installation registry has no durable result or prepared activation'), null, false, 'unknown')
    }
    if (!this.enabled) {
      const result = this._persistResult(directory, command, 'FAILED', PLATFORM_SKILL_FAILURE.DISABLED)
      return this._postPersisted(directory, command, result)
    }

    let stagingPath = ''
    let stagingIdentity = null
    try {
      const namespace = this._skillsNamespace()
      if (existsSync(namespace.targetPath)) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform skill namespace target already exists')
      const authorization = await this.authorizationProvider()
      const bytes = this._verifyPackage(await this.downloadFn({
        wsUrl: this.wsUrl,
        command,
        runtimeScope: this.runtimeScope,
        authorization,
        fetchFn: this.fetchFn,
        maxPackageBytes: this.maxPackageBytes
      }), command)
      stagingPath = resolve(namespace.staging, `${command.installationId}-${this.createId()}`)
      const parentBefore = pathIdentity(namespace.staging)
      mkdirSync(stagingPath, { mode: 0o700 })
      stagingIdentity = pathIdentity(stagingPath)
      if (!validIdentity(stagingIdentity, 'directory', stagingPath) || !samePathIdentity(pathIdentity(namespace.staging), parentBefore)) {
        throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform staging parent changed during creation')
      }
      chmodSync(stagingPath, 0o700)
      fsyncDirectory(namespace.staging)
      await extractSkillArchive(bytes, stagingPath, command, this.extractLimits)
      if (readdirSync(stagingPath).join('\0') !== 'SKILL.md') {
        throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.PACKAGE_INVALID, 'approved platform package must contain only root SKILL.md')
      }
      this._manifestProof(stagingPath)
      if (!this._writeOnce(resolve(stagingPath, MARKER_NAME), this._marker(command), 0o644)) {
        throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform staging marker already exists')
      }
      fsyncDirectory(stagingPath)
      const prepared = this._preparedRecord(command, stagingPath, namespace)
      const preparedPath = resolve(directory, 'prepared.json')
      if (!this._writeOnce(preparedPath, prepared)) {
        const existing = this._loadPrepared(directory, command)
        if (!sameJson(existing, prepared)) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'prepared platform installation creation raced')
      }
      this._activatePrepared(prepared, command)
      const result = this._persistResult(directory, command, 'SUCCEEDED', null)
      return this._postPersisted(directory, command, result)
    } catch (rawError) {
      const error = mapFailure(rawError)
      const preparedExists = existsSync(resolve(directory, 'prepared.json'))
      if (stagingPath && !preparedExists && stagingIdentity) this._safeRemoveStaging(stagingPath, stagingIdentity)
      if (preparedExists) return this._recovery(error)
      const result = this._persistResult(directory, command, 'FAILED', error.code)
      return this._postPersisted(directory, command, result)
    }
  }

  async execute(message) {
    this._requireInitialized()
    let command
    try { command = validatePlatformSkillCommand(message, this.runtimeScope, this.now()) } catch (error) {
      const mapped = mapFailure(error)
      return { status: 'failed', outcome: null, failureCode: mapped.code, errorMessage: mapped.message, result: null, activationCommitted: false }
    }
    const fingerprint = commandFingerprint(command)
    const active = this.inFlight.get(command.installationId)
    if (active) {
      if (active.businessFingerprint !== fingerprint) {
        return this._recovery(new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT,
          'in-flight installationId is bound to different platform skill content'), null, false, 'failed')
      }
      return active.promise
    }
    const operation = (async () => {
      try {
        const installation = this._ensureInstallation(command)
        return await this._install(installation.directory, installation.commandRecord.command, installation.created)
      } catch (error) {
        return this._recovery(error, null, false, 'failed')
      }
    })()
    this.inFlight.set(command.installationId, { businessFingerprint: fingerprint, promise: operation })
    try { return await operation } finally {
      if (this.inFlight.get(command.installationId)?.promise === operation) this.inFlight.delete(command.installationId)
    }
  }

  async replayPending(limit = this.maxReplayBatch) {
    this._requireInitialized()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxReplayBatch) {
      throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.CONFLICT, 'platform replay batch is outside the configured bound')
    }
    const names = readdirSync(this.installationsDir).sort()
    for (const name of names) {
      if (!SAFE_ID.test(name)) throw new PlatformSkillManagerError(PLATFORM_SKILL_FAILURE.IO_FAILED, 'unexpected platform installation registry entry')
    }
    const page = names.filter(name => this.replayCursor === null || name > this.replayCursor).slice(0, limit)
    if (page.length === 0) { this.replayCursor = null; return [] }
    const results = []
    for (const name of page) {
      this.replayCursor = name
      const directory = resolve(this.installationsDir, name)
      try {
        assertRealDirectory(directory, 'platform installation registry')
        if (!existsSync(resolve(directory, 'command.json'))) {
          results.push({ status: 'unknown', installationId: name, outcome: null, failureCode: PLATFORM_SKILL_FAILURE.IO_FAILED,
            errorMessage: 'platform installation has no durable command record', result: null, activationCommitted: false })
          continue
        }
        const commandRecord = this._loadCommandRecord(directory)
        results.push(await this._install(directory, commandRecord.command, false))
      } catch (error) {
        results.push({ ...this._recovery(error, null, false, 'unknown'), installationId: name })
      }
    }
    if (page.length < limit) this.replayCursor = null
    return results
  }

  getInstallation(installationId) {
    this._requireInitialized()
    const directory = this._installationDirectory(installationId)
    if (!existsSync(directory)) return null
    assertRealDirectory(directory, 'platform installation registry')
    if (!existsSync(resolve(directory, 'command.json'))) return { status: 'unknown', installationId }
    const command = this._loadCommandRecord(directory)
    const result = this._loadResult(directory, command.command)
    const receipt = result ? this._loadReceipt(directory, command.command, result) : null
    return { command, result, receipt }
  }
}
