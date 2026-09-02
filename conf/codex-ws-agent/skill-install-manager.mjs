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
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import yauzl from 'yauzl'

export const SKILL_INSTALL_FAILURE = Object.freeze({
  DISABLED: 'SKILL_INSTALL_DISABLED',
  COMMAND_INVALID: 'SKILL_INSTALL_COMMAND_INVALID',
  DOWNLOAD_FORBIDDEN: 'SKILL_DOWNLOAD_FORBIDDEN',
  PACKAGE_TOO_LARGE: 'SKILL_PACKAGE_TOO_LARGE',
  PACKAGE_DIGEST_MISMATCH: 'SKILL_PACKAGE_DIGEST_MISMATCH',
  ARCHIVE_INVALID: 'SKILL_ARCHIVE_INVALID',
  IDENTITY_MISMATCH: 'SKILL_IDENTITY_MISMATCH',
  CONFLICT: 'SKILL_INSTALL_CONFLICT',
  IO_FAILED: 'SKILL_INSTALL_IO_FAILED'
})

const RESULT_TYPE = 'SKILL_INSTALL_RESULT'
export const WORK_RESULT_RECEIPT_TYPE = 'work.result.receipt'
const RESULT_RECEIPT_STATUS = 'ACCEPTED'
const COMMAND_TYPE = 'SKILL_INSTALL'
const DOWNLOAD_PREFIX = '/internal/agent/skill-installations/'
const MARKER_NAME = '.cyf-installation.json'
const DEFAULT_MAX_PACKAGE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_MAX_REPLAY_BATCH = 32
const DEFAULT_UNOWNED_LOCK_STALE_MS = 30_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_SKILL_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_SKILL_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const readBootId = () => {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return '' }
}

const readProcessStartToken = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return ''
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closing = stat.lastIndexOf(')')
    if (closing < 0) return ''
    const fields = stat.slice(closing + 2).trim().split(/\s+/)
    return fields[19] || ''
  } catch {
    return ''
  }
}

const currentProcessIdentity = () => {
  const processStartToken = readProcessStartToken(process.pid)
  const bootId = readBootId()
  if (!processStartToken || !bootId) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'cannot establish PID/start identity for installer lock ownership')
  }
  return { pid: process.pid, processStartToken, bootId }
}

const lockOwnerIsAlive = owner => (
  isObject(owner)
  && Number.isSafeInteger(owner.pid)
  && owner.pid > 0
  && typeof owner.processStartToken === 'string'
  && owner.processStartToken.length > 0
  && typeof owner.bootId === 'string'
  && owner.bootId.length > 0
  && readBootId() === owner.bootId
  && readProcessStartToken(owner.pid) === owner.processStartToken
)

const collisionKey = path => path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')

export class SkillInstallError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'SkillInstallError'
    this.code = code
    this.activationCommitted = options.activationCommitted === true
  }
}

const sha256Hex = value => createHash('sha256').update(value).digest('hex')
const profileDirectory = profile => Buffer.from(String(profile.agentId), 'utf8').toString('hex')

const fsyncDirectory = directory => {
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const ensurePrivateDirectory = directory => {
  const existed = existsSync(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  fsyncDirectory(directory)
  if (!existed) fsyncDirectory(dirname(directory))
}

const atomicWriteText = (targetPath, text, mode = 0o600) => {
  const directory = dirname(targetPath)
  ensurePrivateDirectory(directory)
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  let descriptor
  try {
    descriptor = openSync(temporaryPath, 'wx', mode)
    writeFileSync(descriptor, text, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, targetPath)
    chmodSync(targetPath, mode)
    const targetDescriptor = openSync(targetPath, 'r')
    try { fsyncSync(targetDescriptor) } finally { closeSync(targetDescriptor) }
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath) } catch {}
    throw error
  }
}

const atomicWriteJson = (targetPath, value, mode = 0o600) => (
  atomicWriteText(targetPath, `${JSON.stringify(value, null, 2)}\n`, mode)
)

const durableRename = (sourcePath, targetPath, mode = null) => {
  const sourceDirectory = dirname(sourcePath)
  const targetDirectory = dirname(targetPath)
  renameSync(sourcePath, targetPath)
  if (mode !== null) chmodSync(targetPath, mode)
  fsyncDirectory(sourceDirectory)
  if (sourceDirectory !== targetDirectory) fsyncDirectory(targetDirectory)
}

const durableUnlink = targetPath => {
  const directory = dirname(targetPath)
  unlinkSync(targetPath)
  fsyncDirectory(directory)
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const exactField = (message, field) => {
  const raw = isObject(message?.rawPayload) ? message.rawPayload : message
  const nested = isObject(raw?.payload) ? raw.payload : {}
  const outerPresent = isObject(raw) && hasOwn(raw, field)
  const nestedPresent = hasOwn(nested, field)
  if (outerPresent && nestedPresent && JSON.stringify(raw[field]) !== JSON.stringify(nested[field])) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, `${field} conflicts across command layers`)
  }
  if (outerPresent) return raw[field]
  if (nestedPresent) return nested[field]
  return message?.[field]
}

const requireSafeId = (value, field) => {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, `${field} must be a safe non-blank identifier`)
  }
  return value
}

const requirePositiveDecimal = (value, field) => {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, `${field} must be a canonical positive decimal string`)
  }
  return value
}

const commandFingerprint = command => `sha256:${sha256Hex(Buffer.from(JSON.stringify({
  commandType: command.commandType,
  commandId: command.commandId,
  attempt: command.attempt,
  fencingToken: command.fencingToken,
  deliveryEpoch: command.deliveryEpoch,
  targetAgentId: command.targetAgentId,
  orderId: command.orderId,
  installationId: command.installationId,
  productVersionId: command.productVersionId,
  skillKey: command.skillKey,
  skillVersion: command.skillVersion,
  packageSize: command.packageSize,
  packageDigest: command.packageDigest,
  downloadPath: command.downloadPath
})))}`

export const validateSkillInstallCommand = (message, profile, maxPackageBytes = DEFAULT_MAX_PACKAGE_BYTES) => {
  if (!isObject(message)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'SKILL_INSTALL command must be an object')
  }
  const commandType = exactField(message, 'commandType')
  if (commandType !== COMMAND_TYPE) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, `commandType must be exactly ${COMMAND_TYPE}`)
  }
  const targetAgentId = requireSafeId(exactField(message, 'targetAgentId'), 'targetAgentId')
  if (!profile?.agentId || targetAgentId !== profile.agentId) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'targetAgentId does not match this profile')
  }
  const attempt = exactField(message, 'attempt')
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'attempt must be a positive safe JSON integer')
  }
  const command = {
    messageId: requireSafeId(exactField(message, 'messageId'), 'messageId'),
    commandType,
    commandId: requireSafeId(exactField(message, 'commandId'), 'commandId'),
    attempt,
    fencingToken: requirePositiveDecimal(exactField(message, 'fencingToken'), 'fencingToken'),
    deliveryEpoch: requirePositiveDecimal(exactField(message, 'deliveryEpoch'), 'deliveryEpoch'),
    targetAgentId,
    orderId: requireSafeId(exactField(message, 'orderId'), 'orderId'),
    installationId: requireSafeId(exactField(message, 'installationId'), 'installationId'),
    productVersionId: requireSafeId(exactField(message, 'productVersionId'), 'productVersionId'),
    skillKey: exactField(message, 'skillKey'),
    skillVersion: exactField(message, 'skillVersion'),
    packageSize: exactField(message, 'packageSize'),
    packageDigest: exactField(message, 'packageDigest'),
    downloadPath: exactField(message, 'downloadPath')
  }
  if (typeof command.skillKey !== 'string' || !SAFE_SKILL_KEY.test(command.skillKey)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'skillKey must use lowercase portable skill syntax')
  }
  if (typeof command.skillVersion !== 'string' || !SAFE_SKILL_VERSION.test(command.skillVersion)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'skillVersion must use portable version syntax')
  }
  requirePositiveDecimal(command.packageSize, 'packageSize')
  const packageSizeBigInt = BigInt(command.packageSize)
  if (packageSizeBigInt > BigInt(maxPackageBytes)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.PACKAGE_TOO_LARGE, 'declared packageSize exceeds the local installation limit')
  }
  command.packageSizeBytes = Number(packageSizeBigInt)
  if (typeof command.packageDigest !== 'string' || !SHA256_DIGEST.test(command.packageDigest)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'packageDigest must be canonical lowercase sha256')
  }
  const exactDownloadPath = `${DOWNLOAD_PREFIX}${command.installationId}/package`
  if (typeof command.downloadPath !== 'string' || command.downloadPath !== exactDownloadPath) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'downloadPath must be the exact installation-scoped API path')
  }
  command.fingerprint = commandFingerprint(command)
  return Object.freeze(command)
}

const isExplicitLoopbackHost = hostname => {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127)
}

export const buildSkillDownloadUrl = (wsUrl, downloadPath) => {
  let endpoint
  try { endpoint = new URL(wsUrl) } catch {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'configured WS_URL is not a valid URL')
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'configured WS_URL cannot define a trusted API origin')
  }
  if (endpoint.protocol === 'ws:' && !isExplicitLoopbackHost(endpoint.hostname)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'API-key package download requires TLS except for explicit loopback development endpoints')
  }
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.pathname = '/'
  endpoint.search = ''
  endpoint.hash = ''
  let download
  try { download = new URL(downloadPath, endpoint) } catch {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'downloadPath is invalid')
  }
  if (download.origin !== endpoint.origin || download.username || download.password
      || download.search || download.hash || !download.pathname.startsWith(DOWNLOAD_PREFIX)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'downloadPath must remain on the configured API origin')
  }
  return download
}

const readResponseBytes = async (response, expectedSize, maxPackageBytes) => {
  const chunks = []
  let total = 0
  if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk)
      total += chunk.length
      if (total > maxPackageBytes || total > expectedSize) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.PACKAGE_TOO_LARGE, 'downloaded package exceeded its declared or configured size')
      }
      chunks.push(chunk)
    }
  } else if (typeof response?.arrayBuffer === 'function') {
    const chunk = Buffer.from(await response.arrayBuffer())
    total = chunk.length
    if (total > maxPackageBytes || total > expectedSize) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.PACKAGE_TOO_LARGE, 'downloaded package exceeded its declared or configured size')
    }
    chunks.push(chunk)
  } else {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'package response has no readable body')
  }
  if (total !== expectedSize) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.PACKAGE_TOO_LARGE, 'downloaded package length does not match packageSize')
  }
  return Buffer.concat(chunks, total)
}

const safeArchivePath = fileName => {
  if (typeof fileName !== 'string' || !fileName || fileName.includes('\0') || fileName.includes('\\')) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry has an unsafe path')
  }
  if (fileName.startsWith('/') || /^[A-Za-z]:/.test(fileName)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry uses an absolute path')
  }
  const directory = fileName.endsWith('/')
  const trimmed = directory ? fileName.slice(0, -1) : fileName
  const segments = trimmed.split('/')
  if (!trimmed || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry contains traversal or empty path segments')
  }
  const normalized = segments.join('/')
  if (normalized === MARKER_NAME || normalized.startsWith(`${MARKER_NAME}/`)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry uses the reserved installation marker namespace')
  }
  return { normalized, directory }
}

const archiveMode = entry => (entry.externalFileAttributes >>> 16) & 0xffff
const archiveType = entry => archiveMode(entry) & 0o170000

const openZip = buffer => new Promise((resolvePromise, rejectPromise) => {
  yauzl.fromBuffer(buffer, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true
  }, (error, zipFile) => error ? rejectPromise(error) : resolvePromise(zipFile))
})

const readZipEntry = (zipFile, entry, maxEntryBytes) => new Promise((resolvePromise, rejectPromise) => {
  zipFile.openReadStream(entry, (error, stream) => {
    if (error) return rejectPromise(error)
    const chunks = []
    let total = 0
    stream.on('data', raw => {
      const chunk = Buffer.from(raw)
      total += chunk.length
      if (total > maxEntryBytes || total > entry.uncompressedSize) {
        stream.destroy(new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry exceeded its declared or configured size'))
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', rejectPromise)
    stream.once('end', () => {
      if (total !== entry.uncompressedSize) {
        rejectPromise(new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry size mismatch'))
        return
      }
      resolvePromise(Buffer.concat(chunks, total))
    })
  })
})

const createDirectoryTree = (root, relativePath) => {
  if (!relativePath) return
  let current = root
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment)
    if (existsSync(current)) {
      const status = lstatSync(current)
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive path collides with a non-directory')
      }
      continue
    }
    mkdirSync(current, { mode: 0o700 })
    chmodSync(current, 0o700)
    fsyncDirectory(dirname(current))
  }
}

const writeExtractedFile = (root, relativePath, bytes, mode) => {
  const parent = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
  createDirectoryTree(root, parent)
  const targetPath = resolve(root, relativePath)
  const descriptor = openSync(targetPath, 'wx', 0o600)
  try {
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  chmodSync(targetPath, mode === 0o755 ? 0o755 : 0o644)
  fsyncDirectory(dirname(targetPath))
}

const parseSkillIdentity = text => {
  if (!text.startsWith('---')) return null
  const lines = text.split(/\r?\n/)
  if (lines[0].trim() !== '---') return null
  const identity = {}
  let closed = false
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '---') {
      closed = true
      break
    }
    const match = /^(name|version):\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    identity[match[1]] = value
  }
  return closed ? identity : null
}

const validateNoFilePrefixConflict = entries => {
  const paths = [...entries.entries()]
  for (const [path, kind] of paths) {
    if (kind !== 'file') continue
    const portablePath = collisionKey(path)
    for (const [other] of paths) {
      if (path !== other && collisionKey(other).startsWith(`${portablePath}/`)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive file paths are not prefix-safe')
      }
    }
  }
}

const extractArchive = async (buffer, stagingPath, command, limits) => {
  let zipFile
  try {
    zipFile = await openZip(buffer)
  } catch (error) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, `package is not a valid ZIP archive: ${error.message}`)
  }
  const entries = new Map()
  const portableEntries = new Map()
  let entryCount = 0
  let extractedBytes = 0
  let skillManifestBytes = null
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      let finished = false
      const fail = error => {
        if (finished) return
        finished = true
        try { zipFile.close() } catch {}
        rejectPromise(error)
      }
      zipFile.once('error', error => fail(new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, error.message)))
      zipFile.once('end', () => {
        if (finished) return
        finished = true
        resolvePromise()
      })
      zipFile.on('entry', entry => {
        void (async () => {
          entryCount += 1
          if (entryCount > limits.maxEntries) {
            throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive contains too many entries')
          }
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'encrypted archive entries are not allowed')
          }
          const { normalized, directory } = safeArchivePath(entry.fileName)
          if (entries.has(normalized)) {
            throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, `duplicate archive entry: ${normalized}`)
          }
          const segments = normalized.split('/')
          for (let depth = 1; depth <= segments.length; depth += 1) {
            const portablePath = segments.slice(0, depth).join('/')
            const portableKey = collisionKey(portablePath)
            const portableConflict = portableEntries.get(portableKey)
            if (portableConflict && portableConflict !== portablePath) {
              throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive paths collide after Unicode normalization or case folding')
            }
            portableEntries.set(portableKey, portablePath)
          }
          const type = archiveType(entry)
          if (type === 0o120000) {
            throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'symbolic links are not allowed in skill archives')
          }
          if (type && ![0o040000, 0o100000].includes(type)) {
            throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'special files are not allowed in skill archives')
          }
          if (directory) {
            if (type === 0o100000) throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive directory has regular-file metadata')
            entries.set(normalized, 'directory')
            validateNoFilePrefixConflict(entries)
            createDirectoryTree(stagingPath, normalized)
            zipFile.readEntry()
            return
          }
          if (type === 0o040000) throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive file has directory metadata')
          if (entry.uncompressedSize > limits.maxEntryBytes) {
            throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry exceeds the per-file limit')
          }
          extractedBytes += entry.uncompressedSize
          if (extractedBytes > limits.maxExtractedBytes) {
            throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive exceeds the expanded-size limit')
          }
          entries.set(normalized, 'file')
          validateNoFilePrefixConflict(entries)
          const bytes = await readZipEntry(zipFile, entry, limits.maxEntryBytes)
          const mode = (archiveMode(entry) & 0o111) ? 0o755 : 0o644
          writeExtractedFile(stagingPath, normalized, bytes, mode)
          if (normalized === 'SKILL.md') skillManifestBytes = bytes
          zipFile.readEntry()
        })().catch(fail)
      })
      zipFile.readEntry()
    })
  } catch (error) {
    if (error instanceof SkillInstallError) throw error
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, `archive extraction failed: ${error.message}`)
  }
  if (!skillManifestBytes) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive must contain a root SKILL.md')
  }
  const identity = parseSkillIdentity(skillManifestBytes.toString('utf8'))
  if (!identity || identity.name !== command.skillKey || identity.version !== command.skillVersion) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.IDENTITY_MISMATCH, 'SKILL.md name/version does not match the command identity')
  }
  fsyncDirectory(stagingPath)
}

const verifyControlledCodexHome = codexHome => {
  if (typeof codexHome !== 'string' || !codexHome.trim()) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'profile codexHome is required for skill installation')
  }
  const canonical = resolve(codexHome)
  if (!existsSync(canonical)) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'profile codexHome does not exist')
  }
  const status = lstatSync(canonical)
  if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(canonical) !== canonical) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'profile codexHome must be a real non-symlink directory')
  }
  const skills = resolve(canonical, 'skills')
  if (existsSync(skills)) {
    const skillsStatus = lstatSync(skills)
    if (!skillsStatus.isDirectory() || skillsStatus.isSymbolicLink() || realpathSync(skills) !== skills) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'CODEX_HOME/skills must be a real non-symlink directory')
    }
  } else {
    mkdirSync(skills, { mode: 0o700 })
    chmodSync(skills, 0o700)
    fsyncDirectory(canonical)
  }
  return skills
}

const validateMarker = (targetPath, command, fingerprint) => {
  const markerPath = resolve(targetPath, MARKER_NAME)
  if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink() || !statSync(markerPath).isFile()) return false
  let marker
  try { marker = readJson(markerPath) } catch { return false }
  return marker?.schemaVersion === 1
    && marker.installationId === command.installationId
    && marker.commandId === command.commandId
    && marker.attempt === command.attempt
    && marker.fencingToken === command.fencingToken
    && marker.deliveryEpoch === command.deliveryEpoch
    && marker.productVersionId === command.productVersionId
    && marker.packageDigest === command.packageDigest
    && marker.skillKey === command.skillKey
    && marker.skillVersion === command.skillVersion
    && marker.commandFingerprint === fingerprint
}

export const buildSkillInstallResultEnvelope = ({ profile, command, status, failureCode = null, installedAt = null, messageId = randomUUID(), runtimeInstanceId }) => ({
  schemaVersion: 1,
  messageType: 'work.result',
  messageId,
  resultType: RESULT_TYPE,
  commandId: command?.commandId || '',
  attempt: command?.attempt ?? 0,
  fencingToken: command?.fencingToken || '',
  deliveryEpoch: command?.deliveryEpoch || '',
  orderId: command?.orderId || '',
  installationId: command?.installationId || '',
  targetAgentId: command?.targetAgentId || profile.agentId,
  sourceAgentId: profile.agentId,
  agentId: profile.agentId,
  runtimeInstanceId,
  productVersionId: command?.productVersionId || '',
  status,
  packageDigest: command?.packageDigest || '',
  skillKey: command?.skillKey || '',
  skillVersion: command?.skillVersion || '',
  installedAt,
  failureCode
})

export class SkillInstallManager {
  constructor({
    profile,
    stateRoot,
    wsUrl,
    apiKey,
    enabled = false,
    maxPackageBytes = DEFAULT_MAX_PACKAGE_BYTES,
    maxExtractedBytes = DEFAULT_MAX_EXTRACTED_BYTES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    fetchFn = globalThis.fetch,
    sendResultFn = null,
    now = () => Date.now(),
    createId = () => randomUUID(),
    runtimeInstanceId = '',
    processIdentityFn = currentProcessIdentity,
    lockOwnerAliveFn = lockOwnerIsAlive,
    unownedLockStaleMs = DEFAULT_UNOWNED_LOCK_STALE_MS,
    maxReplayBatch = DEFAULT_MAX_REPLAY_BATCH
  }) {
    if (!profile?.agentId || !profile?.profileId) throw new Error('profileId and agentId are required for skill installation')
    this.profile = profile
    this.stateRoot = resolve(stateRoot)
    this.wsUrl = wsUrl
    this.apiKey = profile.apiKey || apiKey || ''
    this.enabled = enabled === true
    this.maxPackageBytes = maxPackageBytes
    this.maxExtractedBytes = maxExtractedBytes
    this.maxEntryBytes = maxEntryBytes
    this.maxEntries = maxEntries
    this.fetchFn = fetchFn
    this.sendResultFn = sendResultFn
    this.now = now
    this.createId = createId
    this.runtimeInstanceId = runtimeInstanceId
    this.processIdentityFn = processIdentityFn
    this.lockOwnerAliveFn = lockOwnerAliveFn
    this.unownedLockStaleMs = unownedLockStaleMs
    this.maxReplayBatch = maxReplayBatch
    this.stagingDir = resolve(this.stateRoot, 'staging')
    this.registryDir = resolve(this.stateRoot, 'installed-registry')
    this.resultsPendingDir = resolve(this.stateRoot, 'work-results', 'pending')
    this.resultsAcknowledgedDir = resolve(this.stateRoot, 'work-results', 'acknowledged')
    this.resultsSentDir = resolve(this.stateRoot, 'work-results', 'sent')
    this.resultsQuarantineDir = resolve(this.stateRoot, 'work-results', 'quarantine')
    this.staleLocksDir = resolve(this.stateRoot, 'stale-locks')
    this.lockPath = resolve(this.stateRoot, 'installer.lock')
    this.lockOwnerPath = resolve(this.lockPath, 'owner.json')
    this.lockOwner = null
    this.healthError = null
  }

  initialize() {
    for (const directory of [
      this.stateRoot, this.stagingDir, this.registryDir,
      this.resultsPendingDir, this.resultsAcknowledgedDir, this.resultsSentDir,
      this.resultsQuarantineDir, this.staleLocksDir
    ]) ensurePrivateDirectory(directory)
    this._withLockSync('initialize', () => {
      this._scanResultRecords()
      this._recoverRegistry()
    })
    return { healthy: !this.healthError, errorCode: this.healthError?.code || '' }
  }

  _registryPath(installationId) {
    return resolve(this.registryDir, `${Buffer.from(installationId, 'utf8').toString('hex')}.json`)
  }

  _readRegistry(installationId) {
    const path = this._registryPath(installationId)
    if (!existsSync(path)) return null
    const record = readJson(path)
    this._validateRegistryRecord(record, installationId)
    return record
  }

  _validateRegistryRecord(record, expectedInstallationId = '') {
    if (!isObject(record) || record.formatVersion !== 1 || !['PREPARED', 'ACTIVE'].includes(record.state)
        || typeof record.installationId !== 'string' || typeof record.commandFingerprint !== 'string'
        || !isObject(record.command) || !isObject(record.resultEnvelope)) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'installed-skill registry is corrupt')
    }
    if (expectedInstallationId && record.installationId !== expectedInstallationId) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'installed-skill registry identity mismatch')
    }
    if (record.agentId !== this.profile.agentId || record.profileId !== this.profile.profileId
        || record.command.installationId !== record.installationId) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'installed-skill registry profile mismatch')
    }
    const skillsRoot = verifyControlledCodexHome(this.profile.codexHome)
    const expectedTargetPath = resolve(skillsRoot, record.command.skillKey)
    if (record.targetPath !== expectedTargetPath || dirname(record.stagingPath) !== this.stagingDir
        || !basename(record.stagingPath).startsWith(`${record.installationId}-`)) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'installed-skill registry path binding is invalid')
    }
    if (record.commandFingerprint !== record.command.fingerprint
        || record.resultEnvelope.messageType !== 'work.result'
        || record.resultEnvelope.resultType !== RESULT_TYPE
        || record.resultEnvelope.status !== 'SUCCEEDED'
        || record.resultEnvelope.commandId !== record.command.commandId
        || record.resultEnvelope.installationId !== record.installationId) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'installed-skill registry command/result binding is invalid')
    }
    return record
  }

  _listRegistry() {
    const records = []
    for (const fileName of readdirSync(this.registryDir).filter(name => name.endsWith('.json')).sort()) {
      const path = resolve(this.registryDir, fileName)
      try { records.push(this._validateRegistryRecord(readJson(path))) } catch (error) {
        this.healthError = error instanceof SkillInstallError
          ? error
          : new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, error.message)
        throw this.healthError
      }
    }
    return records
  }

  _writeRegistry(record) {
    atomicWriteJson(this._registryPath(record.installationId), record)
  }

  _resultPath(directory, recordId) {
    return resolve(directory, `${recordId}.json`)
  }

  _validateResultRecord(record, expectedRecordId = '') {
    if (!isObject(record) || ![1, 2].includes(record.formatVersion) || typeof record.recordId !== 'string'
        || !isObject(record.envelope) || record.envelope.messageType !== 'work.result'
        || record.envelope.resultType !== RESULT_TYPE || record.envelope.sourceAgentId !== this.profile.agentId) {
      throw new Error('invalid skill work.result outbox record')
    }
    if (expectedRecordId && record.recordId !== expectedRecordId) throw new Error('skill result record/file mismatch')
    if (record.profileId !== this.profile.profileId || record.agentId !== this.profile.agentId) {
      throw new Error('skill result record profile mismatch')
    }
    if (record.sendAttempts !== undefined && (!Number.isSafeInteger(record.sendAttempts) || record.sendAttempts < 0)) {
      throw new Error('invalid skill result sendAttempts')
    }
    return record
  }

  _sameResultRecord(left, right) {
    return left.recordId === right.recordId && JSON.stringify(left.envelope) === JSON.stringify(right.envelope)
  }

  _validateAcknowledgedResultRecord(record, expectedRecordId = '') {
    const validated = this._validateResultRecord(record, expectedRecordId)
    if (!Number.isSafeInteger(validated.acknowledgedAt) || !isObject(validated.receipt)) {
      throw new Error('acknowledged skill result requires durable application receipt evidence')
    }
    const receipt = this._receiptFields(validated.receipt)
    if (!this._receiptMatchesEnvelope(receipt, validated.envelope)) {
      throw new Error('acknowledged skill result receipt does not match its envelope')
    }
    return validated
  }

  _quarantineResult(sourcePath, recordId, error) {
    const targetPath = resolve(this.resultsQuarantineDir, `${recordId}-${this.createId()}.json`)
    durableRename(sourcePath, targetPath, 0o600)
    atomicWriteText(`${targetPath}.reason.txt`, `${new Date(this.now()).toISOString()} ${error.message}\n`)
    this.healthError = new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'skill work.result outbox requires reconciliation')
  }

  _scanResultRecords() {
    for (const directory of [this.resultsPendingDir, this.resultsAcknowledgedDir]) {
      for (const fileName of readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const sourcePath = resolve(directory, fileName)
        try {
          const validator = directory === this.resultsAcknowledgedDir
            ? this._validateAcknowledgedResultRecord.bind(this)
            : this._validateResultRecord.bind(this)
          validator(readJson(sourcePath), fileName.slice(0, -5))
          chmodSync(sourcePath, 0o600)
        } catch (error) {
          this._quarantineResult(sourcePath, fileName.slice(0, -5), error)
        }
      }
    }
    for (const fileName of readdirSync(this.resultsPendingDir).filter(name => name.endsWith('.json'))) {
      const recordId = fileName.slice(0, -5)
      const pendingPath = resolve(this.resultsPendingDir, fileName)
      const acknowledgedPath = this._resultPath(this.resultsAcknowledgedDir, recordId)
      if (!existsSync(pendingPath) || !existsSync(acknowledgedPath)) continue
      try {
        const pending = this._validateResultRecord(readJson(pendingPath), recordId)
        const acknowledged = this._validateAcknowledgedResultRecord(readJson(acknowledgedPath), recordId)
        if (!this._sameResultRecord(pending, acknowledged)) {
          throw new Error('pending result conflicts with acknowledged receipt evidence')
        }
        durableUnlink(pendingPath)
      } catch (error) {
        if (existsSync(pendingPath)) this._quarantineResult(pendingPath, recordId, error)
      }
    }
    for (const fileName of readdirSync(this.resultsSentDir).filter(name => name.endsWith('.json'))) {
      const sourcePath = resolve(this.resultsSentDir, fileName)
      const recordId = fileName.slice(0, -5)
      try {
        const legacy = this._validateResultRecord(readJson(sourcePath), recordId)
        const pendingPath = this._resultPath(this.resultsPendingDir, recordId)
        const acknowledgedPath = this._resultPath(this.resultsAcknowledgedDir, recordId)
        if (existsSync(acknowledgedPath)) {
          const acknowledged = this._validateAcknowledgedResultRecord(readJson(acknowledgedPath), recordId)
          if (!this._sameResultRecord(legacy, acknowledged)) throw new Error('legacy-sent result conflicts with acknowledged result')
          durableUnlink(sourcePath)
        } else if (existsSync(pendingPath)) {
          const pending = this._validateResultRecord(readJson(pendingPath), recordId)
          if (!this._sameResultRecord(legacy, pending)) throw new Error('legacy-sent result conflicts with pending result')
          durableUnlink(sourcePath)
        } else {
          durableRename(sourcePath, pendingPath, 0o600)
        }
      } catch (error) {
        if (existsSync(sourcePath)) this._quarantineResult(sourcePath, recordId, error)
      }
    }
    if (readdirSync(this.resultsQuarantineDir).some(name => name.endsWith('.json'))) {
      this.healthError ||= new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'skill work.result outbox requires reconciliation')
    }
  }

  _ensureResultRecord(recordId, envelope) {
    const pending = this._resultPath(this.resultsPendingDir, recordId)
    const acknowledged = this._resultPath(this.resultsAcknowledgedDir, recordId)
    if (existsSync(pending)) {
      const record = this._validateResultRecord(readJson(pending), recordId)
      if (JSON.stringify(record.envelope) !== JSON.stringify(envelope)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'durable work.result record conflicts with registry evidence')
      }
      return { recordId, state: 'pending' }
    }
    if (existsSync(acknowledged)) {
      const record = this._validateAcknowledgedResultRecord(readJson(acknowledged), recordId)
      if (JSON.stringify(record.envelope) !== JSON.stringify(envelope)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'acknowledged work.result record conflicts with registry evidence')
      }
      return { recordId, state: 'acknowledged' }
    }
    atomicWriteJson(pending, {
      formatVersion: 2,
      recordId,
      profileId: this.profile.profileId,
      agentId: this.profile.agentId,
      createdAt: this.now(),
      sendAttempts: 0,
      lastSentAt: null,
      lastReplayToken: '',
      envelope
    })
    return { recordId, state: 'pending' }
  }

  _reconcilePreparedRecord(record, cause = null) {
    const current = this._readRegistry(record.installationId)
    if (!current || current.commandFingerprint !== record.commandFingerprint) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'prepared activation cannot be reconciled with its durable registry')
    }
    const targetExists = existsSync(current.targetPath)
    const stagingExists = existsSync(current.stagingPath)
    if (current.state === 'ACTIVE') {
      if (!targetExists || stagingExists
          || !validateMarker(current.targetPath, current.command, current.commandFingerprint)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'active installed-skill registry does not match CODEX_HOME')
      }
    } else if (targetExists) {
      if (stagingExists || !validateMarker(current.targetPath, current.command, current.commandFingerprint)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'prepared installation has conflicting activation state')
      }
    } else if (stagingExists) {
      const stagingStatus = lstatSync(current.stagingPath)
      if (!stagingStatus.isDirectory() || stagingStatus.isSymbolicLink()
          || !validateMarker(current.stagingPath, current.command, current.commandFingerprint)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'prepared staging does not match its durable registry')
      }
      if (existsSync(current.targetPath)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'activation target appeared during prepared recovery')
      }
      durableRename(current.stagingPath, current.targetPath)
    } else {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'prepared installation lost both staging and activation target')
    }
    const active = current.state === 'ACTIVE'
      ? current
      : { ...current, state: 'ACTIVE', activatedAt: current.activatedAt || this.now() }
    if (current.state !== 'ACTIVE') this._writeRegistry(active)
    this._ensureResultRecord(active.resultRecordId, active.resultEnvelope)
    return {
      status: 'completed',
      exitCode: 0,
      errorMessage: cause ? `prepared activation reconciled after: ${cause.message}` : '',
      resultEnvelope: active.resultEnvelope,
      idempotent: false,
      activationCommitted: true
    }
  }

  _recoverRegistry() {
    for (const record of this._listRegistry()) this._reconcilePreparedRecord(record)
  }

  _readLockOwnerEvidence() {
    if (!existsSync(this.lockOwnerPath)) return null
    try {
      const owner = readJson(this.lockOwnerPath)
      return isObject(owner) ? owner : null
    } catch {
      return null
    }
  }

  _readLockOwner() {
    const owner = this._readLockOwnerEvidence()
    if (!owner || owner.formatVersion !== 2 || typeof owner.ownerToken !== 'string'
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.processStartToken !== 'string' || !owner.processStartToken
        || typeof owner.bootId !== 'string' || !owner.bootId) return null
    return owner
  }

  _reclaimStaleLock(operation) {
    if (!existsSync(this.lockPath)) return false
    const evidence = this._readLockOwnerEvidence()
    const owner = this._readLockOwner()
    if (owner && this.lockOwnerAliveFn(owner)) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'another live process owns the profile-local installer lock')
    }
    if (!owner && evidence?.formatVersion === 1 && Number.isSafeInteger(evidence.pid) && evidence.pid > 0
        && readProcessStartToken(evidence.pid)) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'a live legacy process may own the profile-local installer lock')
    }
    if (!owner && !(evidence?.formatVersion === 1 && Number.isSafeInteger(evidence.pid)
        && evidence.pid > 0 && !readProcessStartToken(evidence.pid))) {
      const age = Math.max(0, this.now() - statSync(this.lockPath).mtimeMs)
      if (age < this.unownedLockStaleMs) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'installer lock ownership is incomplete and not yet stale')
      }
    }
    const stalePath = resolve(this.staleLocksDir, `installer-${this.now()}-${this.createId()}`)
    try {
      durableRename(this.lockPath, stalePath)
      atomicWriteJson(resolve(stalePath, 'reclaimed.json'), {
        formatVersion: 1,
        reclaimedAt: this.now(),
        reclaimedByRuntimeInstanceId: this.runtimeInstanceId,
        operation,
        previousOwner: evidence
      })
      return true
    } catch (error) {
      if (!existsSync(this.lockPath)) return true
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `failed to reclaim stale installer lock: ${error.message}`)
    }
  }

  _acquireLock(operation) {
    const identity = this.processIdentityFn()
    const owner = {
      formatVersion: 2,
      ownerToken: this.createId(),
      pid: identity.pid,
      processStartToken: identity.processStartToken,
      bootId: identity.bootId,
      operation,
      runtimeInstanceId: this.runtimeInstanceId,
      acquiredAt: this.now()
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (existsSync(this.lockPath)) {
        this._reclaimStaleLock(operation)
        continue
      }
      const candidatePath = resolve(this.stateRoot, `.installer-lock-${owner.ownerToken}-${attempt}`)
      try {
        mkdirSync(candidatePath, { mode: 0o700 })
        chmodSync(candidatePath, 0o700)
        atomicWriteJson(resolve(candidatePath, 'owner.json'), owner)
        renameSync(candidatePath, this.lockPath)
        fsyncDirectory(this.stateRoot)
        this.lockOwner = owner
        return
      } catch (error) {
        try { if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true }) } catch {}
        if (existsSync(this.lockPath) && ['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(error?.code)) continue
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `failed to acquire installer lock: ${error.message}`)
      }
    }
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'installer lock ownership changed repeatedly during acquisition')
  }

  _releaseLock() {
    const expected = this.lockOwner
    try {
      const observed = this._readLockOwner()
      if (!expected || !observed || observed.ownerToken !== expected.ownerToken
          || observed.pid !== expected.pid || observed.processStartToken !== expected.processStartToken
          || observed.bootId !== expected.bootId) {
        throw new Error('installer lock ownership fence mismatch')
      }
      const releasedPath = resolve(this.stateRoot, `.installer-lock-released-${expected.ownerToken}`)
      renameSync(this.lockPath, releasedPath)
      fsyncDirectory(this.stateRoot)
      rmSync(releasedPath, { recursive: true, force: true })
      fsyncDirectory(this.stateRoot)
      this.lockOwner = null
    } catch (error) {
      this.healthError = new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `failed to release installer lock: ${error.message}`)
      throw this.healthError
    }
  }

  _withLockSync(operation, callback) {
    this._acquireLock(operation)
    let callbackError = null
    try { return callback() } catch (error) { callbackError = error; throw error } finally {
      try { this._releaseLock() } catch (error) { if (!callbackError) throw error }
    }
  }

  async _withLock(operation, callback) {
    this._acquireLock(operation)
    let callbackError = null
    try { return await callback() } catch (error) { callbackError = error; throw error } finally {
      try { this._releaseLock() } catch (error) { if (!callbackError) throw error }
    }
  }

  async _download(command) {
    if (!this.apiKey) throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'managed Agent API credential is unavailable')
    if (typeof this.fetchFn !== 'function') throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'fetch implementation is unavailable')
    const endpoint = buildSkillDownloadUrl(this.wsUrl, command.downloadPath)
    let response
    try {
      response = await this.fetchFn(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/zip' }
      })
    } catch (error) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `package download failed: ${error.message}`)
    }
    if (!response || response.status !== 200 || response.redirected === true) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'package endpoint did not return a direct 200 response')
    }
    if (response.url) {
      let observed
      try { observed = new URL(response.url) } catch {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'package response URL is invalid')
      }
      if (observed.origin !== endpoint.origin || observed.pathname !== endpoint.pathname || observed.search || observed.hash) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'package response escaped the configured same-origin path')
      }
    }
    const contentLength = response.headers?.get?.('content-length')
    if (contentLength !== null && contentLength !== undefined && contentLength !== '') {
      if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || BigInt(contentLength) !== BigInt(command.packageSize)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.PACKAGE_TOO_LARGE, 'Content-Length does not match packageSize')
      }
    }
    const bytes = await readResponseBytes(response, command.packageSizeBytes, this.maxPackageBytes)
    const digest = `sha256:${sha256Hex(bytes)}`
    if (digest !== command.packageDigest) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.PACKAGE_DIGEST_MISMATCH, 'downloaded package SHA-256 does not match packageDigest')
    }
    return bytes
  }

  _assertNoRegistryConflict(command, targetPath) {
    const existing = this._readRegistry(command.installationId)
    if (existing) {
      if (existing.commandFingerprint !== command.fingerprint) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'installationId was reused with a different command fingerprint')
      }
      if (existing.state === 'ACTIVE') {
        if (!validateMarker(existing.targetPath, command, command.fingerprint)) {
          throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'installed target no longer matches its durable registry')
        }
        this._ensureResultRecord(existing.resultRecordId, existing.resultEnvelope)
        return existing
      }
      if (existsSync(existing.targetPath) && validateMarker(existing.targetPath, command, command.fingerprint)) {
        const active = { ...existing, state: 'ACTIVE', activatedAt: existing.activatedAt || this.now() }
        this._writeRegistry(active)
        this._ensureResultRecord(active.resultRecordId, active.resultEnvelope)
        return active
      }
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'installationId has an unresolved prepared registry record')
    }
    for (const record of this._listRegistry()) {
      if (record.command.skillKey === command.skillKey) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'skillKey is already owned by another installationId')
      }
    }
    if (existsSync(targetPath)) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'CODEX_HOME skill target already exists without a matching registry')
    }
    return null
  }

  _persistFailureResult(command, error) {
    const envelope = buildSkillInstallResultEnvelope({
      profile: this.profile,
      command,
      status: 'FAILED',
      failureCode: error.code,
      installedAt: null,
      runtimeInstanceId: this.runtimeInstanceId
    })
    const recordId = this.createId()
    this._ensureResultRecord(recordId, envelope)
    return envelope
  }

  _reconcileActivatedRecord(prepared, cause = null) {
    try {
      return this._withLockSync(`reconcile-activation:${prepared.installationId}`, () => (
        this._reconcilePreparedRecord(prepared, cause)
      ))
    } catch (error) {
      this.healthError = error instanceof SkillInstallError
        ? error
        : new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, error.message)
      return {
        status: 'recovery_required',
        exitCode: null,
        errorMessage: `prepared activation requires startup reconciliation: ${cause?.message || error.message}`,
        failureCode: this.healthError.code,
        resultEnvelope: prepared.resultEnvelope,
        activationCommitted: existsSync(prepared.targetPath) && !existsSync(prepared.stagingPath)
      }
    }
  }

  async execute(message) {
    let command
    let preparedRecord = null
    try {
      command = validateSkillInstallCommand(message, this.profile, this.maxPackageBytes)
      if (!this.enabled) throw new SkillInstallError(SKILL_INSTALL_FAILURE.DISABLED, 'managed skill installation is disabled')
      if (this.healthError) throw this.healthError
      const result = await this._withLock(`install:${command.installationId}`, async () => {
        const skillsRoot = verifyControlledCodexHome(this.profile.codexHome)
        const targetPath = resolve(skillsRoot, command.skillKey)
        const existing = this._assertNoRegistryConflict(command, targetPath)
        if (existing) {
          return { status: 'completed', exitCode: 0, errorMessage: '', resultEnvelope: existing.resultEnvelope, idempotent: true }
        }
        const packageBytes = await this._download(command)
        const stagingPath = resolve(this.stagingDir, `${command.installationId}-${this.createId()}`)
        mkdirSync(stagingPath, { mode: 0o700 })
        chmodSync(stagingPath, 0o700)
        fsyncDirectory(this.stagingDir)
        try {
          await extractArchive(packageBytes, stagingPath, command, {
            maxEntries: this.maxEntries,
            maxEntryBytes: this.maxEntryBytes,
            maxExtractedBytes: this.maxExtractedBytes
          })
          const installedAt = String(this.now())
          const resultEnvelope = buildSkillInstallResultEnvelope({
            profile: this.profile,
            command,
            status: 'SUCCEEDED',
            failureCode: null,
            installedAt,
            runtimeInstanceId: this.runtimeInstanceId
          })
          const resultRecordId = this.createId()
          const marker = {
            schemaVersion: 1,
            installationId: command.installationId,
            commandId: command.commandId,
            attempt: command.attempt,
            fencingToken: command.fencingToken,
            deliveryEpoch: command.deliveryEpoch,
            productVersionId: command.productVersionId,
            packageDigest: command.packageDigest,
            skillKey: command.skillKey,
            skillVersion: command.skillVersion,
            commandFingerprint: command.fingerprint,
            installedAt
          }
          atomicWriteJson(resolve(stagingPath, MARKER_NAME), marker, 0o644)
          fsyncDirectory(stagingPath)
          const prepared = {
            formatVersion: 1,
            state: 'PREPARED',
            profileId: this.profile.profileId,
            agentId: this.profile.agentId,
            installationId: command.installationId,
            commandFingerprint: command.fingerprint,
            command: { ...command },
            targetPath,
            stagingPath,
            preparedAt: this.now(),
            activatedAt: null,
            resultRecordId,
            resultEnvelope
          }
          preparedRecord = prepared
          this._writeRegistry(prepared)
          if (existsSync(targetPath)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'skill target appeared during activation')
          durableRename(stagingPath, targetPath)
          const active = { ...prepared, state: 'ACTIVE', activatedAt: this.now() }
          this._writeRegistry(active)
          this._ensureResultRecord(resultRecordId, resultEnvelope)
          return { status: 'completed', exitCode: 0, errorMessage: '', resultEnvelope, idempotent: false, activationCommitted: true }
        } catch (error) {
          if (!preparedRecord && existsSync(stagingPath)) rmSync(stagingPath, { recursive: true, force: true })
          throw error
        }
      })
      this.replayResults(this.sendResultFn, { replayToken: `command:${command.commandId}:${this.now()}` })
      return result
    } catch (rawError) {
      if (preparedRecord) {
        const reconciled = this._reconcileActivatedRecord(preparedRecord, rawError)
        if (reconciled.status === 'completed') {
          this.replayResults(this.sendResultFn, { replayToken: `command:${command.commandId}:${this.now()}` })
        }
        return reconciled
      }
      const error = rawError instanceof SkillInstallError
        ? rawError
        : new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, rawError.message || 'skill installation failed')
      let resultEnvelope = null
      try {
        resultEnvelope = this._withLockSync(`persist-failure:${command?.commandId || 'invalid'}`, () => (
          this._persistFailureResult(command || {}, error)
        ))
        this.replayResults(this.sendResultFn, { replayToken: `failure:${command?.commandId || 'invalid'}:${this.now()}` })
      } catch (resultError) {
        this.healthError = new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `failed to persist skill failure result: ${resultError.message}`)
        return {
          status: 'recovery_required',
          exitCode: null,
          errorMessage: this.healthError.message,
          failureCode: this.healthError.code,
          resultEnvelope: null,
          activationCommitted: false
        }
      }
      return {
        status: 'failed',
        exitCode: null,
        errorMessage: `${error.code}: ${error.message}`,
        failureCode: error.code,
        resultEnvelope
      }
    }
  }

  reconcileCommandOutcome(message) {
    if (message?.commandType !== COMMAND_TYPE) return null
    return this._withLockSync(`reconcile-command:${message.installationId || ''}`, () => {
      const command = validateSkillInstallCommand(message, this.profile, this.maxPackageBytes)
      const record = this._readRegistry(command.installationId)
      if (!record || record.commandFingerprint !== command.fingerprint || record.state !== 'ACTIVE'
          || !validateMarker(record.targetPath, command, command.fingerprint)) return null
      this._ensureResultRecord(record.resultRecordId, record.resultEnvelope)
      return { status: 'completed', exitCode: 0, errorMessage: '', activationCommitted: true }
    })
  }

  _replayResultsLocked(sendFn, options = {}) {
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, this.maxReplayBatch)
      : this.maxReplayBatch
    const replayToken = String(options.replayToken || '')
    let replayed = 0
    for (const fileName of readdirSync(this.resultsPendingDir).filter(name => name.endsWith('.json')).sort()) {
      if (replayed >= limit) break
      const sourcePath = resolve(this.resultsPendingDir, fileName)
      let record
      try { record = this._validateResultRecord(readJson(sourcePath), fileName.slice(0, -5)) } catch (error) {
        this._quarantineResult(sourcePath, fileName.slice(0, -5), error)
        break
      }
      if (replayToken && record.lastReplayToken === replayToken) continue
      let sent = false
      try { sent = sendFn(record.envelope) === true } catch { break }
      if (!sent) break
      try {
        atomicWriteJson(sourcePath, {
          ...record,
          formatVersion: 2,
          sendAttempts: Number(record.sendAttempts || 0) + 1,
          lastSentAt: this.now(),
          lastReplayToken: replayToken
        })
      } catch (error) {
        this.healthError = new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `failed to persist work.result send attempt: ${error.message}`)
        break
      }
      replayed += 1
    }
    return replayed
  }

  replayResults(sendFn = this.sendResultFn, options = {}) {
    if (this.healthError || typeof sendFn !== 'function') return 0
    try {
      return this._withLockSync('replay-work-results', () => this._replayResultsLocked(sendFn, options))
    } catch (error) {
      if (error?.code === SKILL_INSTALL_FAILURE.IO_FAILED) this.healthError = error
      return 0
    }
  }

  _receiptFields(message) {
    const receipt = {
      messageType: exactField(message, 'messageType'),
      messageId: exactField(message, 'messageId'),
      correlationId: exactField(message, 'correlationId'),
      resultType: exactField(message, 'resultType'),
      receiptStatus: exactField(message, 'receiptStatus'),
      commandId: exactField(message, 'commandId'),
      attempt: exactField(message, 'attempt'),
      fencingToken: exactField(message, 'fencingToken'),
      deliveryEpoch: exactField(message, 'deliveryEpoch'),
      installationId: exactField(message, 'installationId'),
      targetAgentId: exactField(message, 'targetAgentId')
    }
    if (receipt.messageType !== WORK_RESULT_RECEIPT_TYPE || receipt.resultType !== RESULT_TYPE
        || receipt.receiptStatus !== RESULT_RECEIPT_STATUS) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'work.result receipt type/status is invalid')
    }
    requireSafeId(receipt.messageId, 'messageId')
    requireSafeId(receipt.correlationId, 'correlationId')
    requireSafeId(receipt.commandId, 'commandId')
    requireSafeId(receipt.installationId, 'installationId')
    if (!Number.isSafeInteger(receipt.attempt) || receipt.attempt <= 0
        || requirePositiveDecimal(receipt.fencingToken, 'fencingToken') !== receipt.fencingToken
        || requirePositiveDecimal(receipt.deliveryEpoch, 'deliveryEpoch') !== receipt.deliveryEpoch
        || receipt.targetAgentId !== this.profile.agentId) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'work.result receipt correlation fields are invalid')
    }
    return receipt
  }

  _receiptMatchesEnvelope(receipt, envelope) {
    return receipt.correlationId === envelope.messageId
      && receipt.commandId === envelope.commandId
      && receipt.attempt === envelope.attempt
      && receipt.fencingToken === envelope.fencingToken
      && receipt.deliveryEpoch === envelope.deliveryEpoch
      && receipt.installationId === envelope.installationId
      && receipt.targetAgentId === envelope.targetAgentId
  }

  acknowledgeResultReceipt(message) {
    const receipt = this._receiptFields(message)
    return this._withLockSync(`work-result-receipt:${receipt.correlationId}`, () => (
      this._acknowledgeResultReceiptLocked(receipt)
    ))
  }

  _acknowledgeResultReceiptLocked(receipt) {
    for (const fileName of readdirSync(this.resultsAcknowledgedDir).filter(name => name.endsWith('.json')).sort()) {
      const path = resolve(this.resultsAcknowledgedDir, fileName)
      const record = this._validateAcknowledgedResultRecord(readJson(path), fileName.slice(0, -5))
      if (record.envelope.messageId !== receipt.correlationId) continue
      if (!this._receiptMatchesEnvelope(receipt, record.envelope)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'work.result receipt conflicts with acknowledged result')
      }
      return { status: 'acknowledged', idempotent: true, recordId: record.recordId }
    }
    for (const fileName of readdirSync(this.resultsPendingDir).filter(name => name.endsWith('.json')).sort()) {
      const sourcePath = resolve(this.resultsPendingDir, fileName)
      const record = this._validateResultRecord(readJson(sourcePath), fileName.slice(0, -5))
      if (record.envelope.messageId !== receipt.correlationId) continue
      if (!this._receiptMatchesEnvelope(receipt, record.envelope)) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'work.result receipt conflicts with pending result')
      }
      const acknowledged = {
        ...record,
        formatVersion: 2,
        acknowledgedAt: this.now(),
        receipt: { ...receipt }
      }
      const targetPath = this._resultPath(this.resultsAcknowledgedDir, record.recordId)
      atomicWriteJson(targetPath, acknowledged)
      try {
        durableUnlink(sourcePath)
      } catch (error) {
        this.healthError = new SkillInstallError(
          SKILL_INSTALL_FAILURE.IO_FAILED,
          `work.result receipt was persisted but pending retirement requires startup reconciliation: ${error.message}`
        )
        throw this.healthError
      }
      return { status: 'acknowledged', idempotent: false, recordId: record.recordId }
    }
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'work.result receipt has no matching durable pending result')
  }

  getInstallation(installationId) {
    return this._readRegistry(installationId)
  }

  pendingResults() {
    return readdirSync(this.resultsPendingDir).filter(name => name.endsWith('.json')).sort().map(fileName => (
      this._validateResultRecord(readJson(resolve(this.resultsPendingDir, fileName)), fileName.slice(0, -5))
    ))
  }

  acknowledgedResults() {
    return readdirSync(this.resultsAcknowledgedDir).filter(name => name.endsWith('.json')).sort().map(fileName => (
      this._validateAcknowledgedResultRecord(readJson(resolve(this.resultsAcknowledgedDir, fileName)), fileName.slice(0, -5))
    ))
  }

  sentResults() {
    return this.acknowledgedResults()
  }

}

export const defaultSkillInstallStateRoot = (commandInboxDir, profile) => resolve(
  commandInboxDir,
  profileDirectory(profile),
  'skill-install'
)
