import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import yauzl from 'yauzl'
import { isManagementMessage, parseManagementMessage, managementDigest, managementCanonicalJson, preparedDigest, validateManagement } from './skill-management-wire.mjs'
import { parseStrictJson } from './api-envelope.mjs'
import { eventMessage, replyMessage } from './message-envelope.mjs'
import { parseSkillManifest, resolveSkillEntrypoint, skillPackageTreeDigest } from './skill-manifest.mjs'

export const SKILL_INSTALL_FAILURE = Object.freeze({
  COMMAND_INVALID: 'SKILL_INSTALL_COMMAND_INVALID',
  DOWNLOAD_FORBIDDEN: 'SKILL_DOWNLOAD_FORBIDDEN',
  PACKAGE_TOO_LARGE: 'SKILL_PACKAGE_TOO_LARGE',
  PACKAGE_DIGEST_MISMATCH: 'SKILL_PACKAGE_DIGEST_MISMATCH',
  ARCHIVE_INVALID: 'SKILL_ARCHIVE_INVALID',
  IDENTITY_MISMATCH: 'SKILL_IDENTITY_MISMATCH',
  CONFLICT: 'SKILL_INSTALL_CONFLICT',
  IO_FAILED: 'SKILL_INSTALL_IO_FAILED'
})

// Only the frozen public Reason dictionary crosses the wire; diagnostics stay local.
const publicFailure = code => ({
  SKILL_DOWNLOAD_FORBIDDEN: 'DOWNLOAD_FORBIDDEN', SKILL_PACKAGE_DIGEST_MISMATCH: 'PACKAGE_DIGEST_MISMATCH',
  SKILL_ARCHIVE_INVALID: 'ARCHIVE_INVALID', SKILL_IDENTITY_MISMATCH: 'VERSION_MISMATCH',
  SKILL_STATE_CONFLICT: 'STATE_CHANGED', SKILL_INSTALL_CONFLICT: 'STATE_CHANGED', SKILL_DELIVERY_FENCED: 'STATE_CHANGED',
  SKILL_DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_MISSING', DEPENDENCY_MISSING: 'DEPENDENCY_MISSING', PROVIDER_UNBOUND: 'PROVIDER_UNBOUND',
  SKILL_PERMISSIONS_MISMATCH: 'PERMISSION_REQUIRED'
}[code] || 'PREPARATION_FAILED')

export const WORK_RESULT_RECEIPT_TYPE = 'work.result.receipt'
const DOWNLOAD_PREFIX = '/internal/agent/skill-installations/'
const MARKER_NAME = '.cyf-installation.json'
const DEFAULT_MAX_PACKAGE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_MAX_REPLAY_BATCH = 32
const DEFAULT_UNOWNED_LOCK_STALE_MS = 30_000
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

const canonicalApiOrigin = wsUrl => {
  let endpoint
  try { endpoint = new URL(wsUrl) } catch {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'configured WS_URL is not a valid URL')
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'configured WS_URL cannot define a trusted API origin')
  }
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.pathname = '/'
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint.origin
}

const durableScope = (profile, wsUrl) => {
  const apiOrigin = canonicalApiOrigin(wsUrl)
  const payload = {
    schemaVersion: 1,
    profileId: String(profile.profileId),
    agentId: String(profile.agentId),
    apiOrigin
  }
  return Object.freeze({
    ...payload,
    digest: `sha256:${sha256Hex(Buffer.from(`CYF_SKILL_INSTALL_SCOPE_V1\0${JSON.stringify(payload)}`))}`
  })
}

const pathIdentity = path => {
  const status = lstatSync(path, { bigint: true })
  return Object.freeze({
    path: realpathSync(path),
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    kind: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : status.isSymbolicLink() ? 'symlink' : 'other'
  })
}

const samePathIdentity = (left, right) => Boolean(left && right
  && left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.kind === right.kind)

const LINUX_ATOMIC_HELPER = String.raw`
import ctypes, errno, hashlib, json, os, stat, sys
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, 'renameat2', None)
if renameat2 is None:
    print(json.dumps({'ok': False, 'code': 'UNSUPPORTED', 'message': 'renameat2 unavailable'}))
    sys.exit(3)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2
O_DIRECTORY = getattr(os, 'O_DIRECTORY', 0)
O_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)

def emit(ok, code='OK', message='', **extra):
    print(json.dumps(dict(ok=ok, code=code, message=message, **extra), sort_keys=True))

def call_rename(srcfd, src, dstfd, dst, flags):
    if renameat2(srcfd, os.fsencode(src), dstfd, os.fsencode(dst), flags) != 0:
        value = ctypes.get_errno()
        raise OSError(value, os.strerror(value))

def open_parent(expected):
    fd = os.open(expected['path'], os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    actual = os.fstat(fd)
    if str(actual.st_dev) != expected['dev'] or str(actual.st_ino) != expected['ino']:
        os.close(fd)
        raise RuntimeError('parent inode changed')
    if os.path.realpath('/proc/self/fd/%d' % fd) != expected['path']:
        os.close(fd)
        raise RuntimeError('parent realpath changed')
    return fd

def stat_at(fd, name):
    return os.stat(name, dir_fd=fd, follow_symlinks=False)

def matches(value, expected):
    return str(value.st_dev) == expected['dev'] and str(value.st_ino) == expected['ino']

def parent_still_current(fd, expected):
    try:
        current = os.stat(expected['path'], follow_symlinks=False)
        opened = os.fstat(fd)
        return current.st_dev == opened.st_dev and current.st_ino == opened.st_ino and os.path.realpath(expected['path']) == expected['path']
    except OSError:
        return False

def owner_digest(fd, directory_name):
    try:
        owner_fd = os.open(directory_name + '/owner.json', os.O_RDONLY | O_NOFOLLOW, dir_fd=fd)
    except FileNotFoundError:
        return hashlib.sha256(b'').hexdigest()
    try:
        data = b''
        while True:
            chunk = os.read(owner_fd, 65536)
            if not chunk: break
            data += chunk
            if len(data) > 1048576: raise RuntimeError('owner evidence too large')
        return hashlib.sha256(data).hexdigest()
    finally:
        os.close(owner_fd)

def rename_noreplace(payload):
    src_parent = open_parent(payload['sourceParent'])
    dst_parent = open_parent(payload['targetParent'])
    try:
        source = stat_at(src_parent, payload['sourceName'])
        if not matches(source, payload['sourceIdentity']):
            emit(False, 'SOURCE_CHANGED', 'source inode changed'); return
        expected_owner = payload.get('sourceOwnerSha256')
        if expected_owner is not None and owner_digest(src_parent, payload['sourceName']) != expected_owner:
            emit(False, 'SOURCE_CHANGED', 'source owner generation changed'); return
        try:
            stat_at(dst_parent, payload['targetName'])
            emit(False, 'TARGET_EXISTS', 'target already exists'); return
        except FileNotFoundError:
            pass
        call_rename(src_parent, payload['sourceName'], dst_parent, payload['targetName'], RENAME_NOREPLACE)
        moved = stat_at(dst_parent, payload['targetName'])
        if not matches(moved, payload['sourceIdentity']):
            emit(False, 'POSTCONDITION_FAILED', 'published inode mismatch'); return
        if expected_owner is not None and owner_digest(dst_parent, payload['targetName']) != expected_owner:
            emit(False, 'POSTCONDITION_FAILED', 'published owner generation mismatch'); return
        if not parent_still_current(src_parent, payload['sourceParent']) or not parent_still_current(dst_parent, payload['targetParent']):
            try:
                call_rename(dst_parent, payload['targetName'], src_parent, payload['sourceName'], RENAME_NOREPLACE)
                os.fsync(src_parent)
                if src_parent != dst_parent: os.fsync(dst_parent)
                emit(False, 'PARENT_CHANGED_ROLLED_BACK', 'parent changed during commit; publication rolled back')
            except Exception as rollback:
                emit(False, 'PARENT_CHANGED_ROLLBACK_FAILED', 'parent changed and rollback failed: %s' % rollback)
            return
        os.fsync(src_parent)
        if src_parent != dst_parent: os.fsync(dst_parent)
        emit(True)
    except FileExistsError:
        emit(False, 'TARGET_EXISTS', 'target already exists')
    except Exception as error:
        emit(False, 'IO_ERROR', str(error))
    finally:
        os.close(src_parent); os.close(dst_parent)

def exchange_if_match(payload):
    parent = open_parent(payload['parent'])
    replacement_parent = open_parent(payload['replacementParent'])
    try:
        active = stat_at(parent, payload['activeName'])
        replacement = stat_at(replacement_parent, payload['replacementName'])
        if not matches(active, payload['activeIdentity']):
            emit(False, 'ACTIVE_CHANGED', 'active lock inode changed'); return
        if not matches(replacement, payload['replacementIdentity']):
            emit(False, 'REPLACEMENT_CHANGED', 'replacement lock inode changed'); return
        if payload.get('activeOwnerSha256') is not None and owner_digest(parent, payload['activeName']) != payload['activeOwnerSha256']:
            emit(False, 'ACTIVE_CHANGED', 'active lock owner generation changed'); return
        if payload.get('replacementOwnerSha256') is not None and owner_digest(replacement_parent, payload['replacementName']) != payload['replacementOwnerSha256']:
            emit(False, 'REPLACEMENT_CHANGED', 'replacement lock owner generation changed'); return
        call_rename(parent, payload['activeName'], replacement_parent, payload['replacementName'], RENAME_EXCHANGE)
        moved_active = stat_at(parent, payload['activeName'])
        moved_replacement = stat_at(replacement_parent, payload['replacementName'])
        moved_active_digest = owner_digest(parent, payload['activeName']) if payload.get('replacementOwnerSha256') is not None else None
        moved_replacement_digest = owner_digest(replacement_parent, payload['replacementName']) if payload.get('activeOwnerSha256') is not None else None
        if (not matches(moved_active, payload['replacementIdentity'])
                or (payload.get('replacementOwnerSha256') is not None and moved_active_digest != payload['replacementOwnerSha256'])
                or not matches(moved_replacement, payload['activeIdentity'])
                or (payload.get('activeOwnerSha256') is not None and moved_replacement_digest != payload['activeOwnerSha256'])
                or not parent_still_current(parent, payload['parent'])
                or not parent_still_current(replacement_parent, payload['replacementParent'])):
            try:
                call_rename(parent, payload['activeName'], replacement_parent, payload['replacementName'], RENAME_EXCHANGE)
                os.fsync(parent); os.fsync(replacement_parent)
                emit(False, 'ACTIVE_CHANGED_ROLLED_BACK', 'lock generation changed during exchange; exchange rolled back')
            except Exception as rollback:
                emit(False, 'ACTIVE_CHANGED_ROLLBACK_FAILED', 'lock generation changed and rollback failed: %s' % rollback)
            return
        os.fsync(parent); os.fsync(replacement_parent)
        emit(True)
    except Exception as error:
        emit(False, 'IO_ERROR', str(error))
    finally:
        os.close(parent); os.close(replacement_parent)

operation = sys.argv[1]
payload = json.loads(sys.argv[2])
if operation == 'rename-noreplace': rename_noreplace(payload)
elif operation == 'exchange-if-match': exchange_if_match(payload)
else: emit(False, 'INVALID_OPERATION', operation)
`

const runLinuxAtomicHelper = (operation, payload) => {
  if (process.platform !== 'linux') {
    return { ok: false, code: 'UNSUPPORTED', message: 'Linux renameat2 primitives are required' }
  }
  const result = spawnSync(process.env.CYF_PYTHON_BIN || 'python3', ['-c', LINUX_ATOMIC_HELPER, operation, JSON.stringify(payload)], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  })
  if (result.error) return { ok: false, code: 'UNSUPPORTED', message: result.error.message }
  const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  try {
    const parsed = JSON.parse(line)
    if (isObject(parsed) && typeof parsed.ok === 'boolean') return parsed
  } catch {}
  return { ok: false, code: 'HELPER_FAILED', message: String(result.stderr || line || `helper exited ${result.status}`) }
}

export const LINUX_ATOMIC_FS = Object.freeze({
  renameNoReplace(sourcePath, targetPath, expected = {}) {
    const sourceParent = expected.sourceParent || pathIdentity(dirname(sourcePath))
    const targetParent = expected.targetParent || pathIdentity(dirname(targetPath))
    const sourceIdentity = expected.sourceIdentity || pathIdentity(sourcePath)
    return runLinuxAtomicHelper('rename-noreplace', {
      sourceParent,
      targetParent,
      sourceIdentity,
      sourceOwnerSha256: expected.sourceOwnerSha256,
      sourceName: basename(sourcePath),
      targetName: basename(targetPath)
    })
  },
  exchangeIfMatch(activePath, replacementPath, expected) {
    return runLinuxAtomicHelper('exchange-if-match', {
      parent: expected.parent || pathIdentity(dirname(activePath)),
      replacementParent: expected.replacementParent || pathIdentity(dirname(replacementPath)),
      activeIdentity: expected.activeIdentity,
      replacementIdentity: expected.replacementIdentity || pathIdentity(replacementPath),
      activeOwnerSha256: expected.activeOwnerSha256,
      replacementOwnerSha256: expected.replacementOwnerSha256,
      activeName: basename(activePath),
      replacementName: basename(replacementPath)
    })
  }
})

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
  let ancestor = resolve(directory)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== ancestor || lstatSync(ancestor).isSymbolicLink() || !lstatSync(ancestor).isDirectory()) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'private state ancestor must be canonical')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== resolve(directory) || !lstatSync(directory).isDirectory()) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'private state directory must be canonical')
  if (lstatSync(directory).uid !== process.geteuid()) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'private state owner changed')
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

const readJson = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid()) || before.mode & 0o022n) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'unsafe durable evidence')
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true })
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== BigInt(bytes.length)
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'durable evidence changed')
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { integerTokensOnly: true })
  } finally { closeSync(fd) }
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
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'Runtime-authenticated package download requires TLS except for explicit loopback development endpoints')
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
  if (typeof fileName !== 'string' || !fileName || /[\u0000-\u001f\u007f]/u.test(fileName) || fileName.includes('\\')) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry has an unsafe path or control character')
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
  if (segments.some(segment => /[. ]$/u.test(segment))) {
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'archive entry contains a trailing-dot or trailing-space portable alias')
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

// Preview frontmatter is a deliberately restricted YAML subset: block mappings,
// unquoted keys and single-line string scalars. Never ignore unsupported syntax
// or resolve tags/aliases; an ambiguous identity must not reach activation.
const skillFrontmatterString = raw => {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  let parsed
  if (value.startsWith('"')) {
    // JSON string escapes are a safe subset of YAML double-quoted strings.
    const match = /^("(?:[^"\\]|\\.)*")(?: +#.*)?$/.exec(value)
    if (!match) return null
    try { parsed = JSON.parse(match[1]) } catch { return null }
  } else if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?: +#.*)?$/.exec(value)
    if (!match) return null
    parsed = match[1].replace(/''/g, "'")
  } else {
    parsed = value.replace(/ +#.*$/, '').trimEnd()
    if (/^[\[\]{}&*!|>'"%@`#?:,-]/u.test(parsed) || /:($|\s)/u.test(parsed)
        || /^(?:null|true|false|yes|no|on|off|~|[-+]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)(?:[eE][-+]?[0-9]+)?|0[xob][0-9a-f_]+|[-+]?\.(?:inf|nan))$/iu.test(parsed)) return null
  }
  return typeof parsed === 'string' && parsed.trim() && !/[\u0000-\u001f\u007f]/u.test(parsed) ? parsed : null
}

const parseSkillIdentity = text => {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return null
  const fields = new Map()
  const metadata = new Map()
  const allowedFields = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata'])
  let inMetadata = false
  let closed = false
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '---') {
      closed = true
      break
    }
    if (/[\u0000-\u001f\u007f]/u.test(line)) return null
    if (!line.trim() || /^ *#/u.test(line)) continue
    const match = /^( {2})?([A-Za-z][A-Za-z0-9-]*):(?: +(.*))?$/u.exec(line)
    if (!match) return null
    const [, indent, key, raw = ''] = match
    if (indent) {
      if (!inMetadata || metadata.has(key)) return null
      const value = skillFrontmatterString(raw)
      if (value === null) return null
      metadata.set(key, value)
    } else {
      if (!allowedFields.has(key) || fields.has(key)) return null
      inMetadata = key === 'metadata'
      if (inMetadata) {
        if (raw.trim() && !raw.trim().startsWith('#')) return null
        fields.set(key, metadata)
      } else {
        const value = skillFrontmatterString(raw)
        if (value === null) return null
        fields.set(key, value)
      }
    }
  }
  if (!closed || !fields.has('name') || !fields.has('description') || !metadata.has('version')) return null
  return { name: fields.get('name'), description: fields.get('description'), version: metadata.get('version') }
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
  let manifest = null
  const manifestPath = resolve(stagingPath, 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      manifest = parseSkillManifest(readFileSync(manifestPath), command)
      if (manifest.runner === 'local-script') resolveSkillEntrypoint(stagingPath, manifest.entrypoint)
    } catch {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.ARCHIVE_INVALID, 'executable manifest or local entrypoint is invalid')
    }
  }
  fsyncDirectory(stagingPath)
  return manifest
}

const verifyControlledCodexHome = (codexHome, { create = true } = {}) => {
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
  } else if (create) {
    mkdirSync(skills, { mode: 0o700 })
    chmodSync(skills, 0o700)
    fsyncDirectory(canonical)
  }
  return skills
}


// Copy publication is durable before its intent can authorize a switch.
const syncTree = root => {
  for (const name of readdirSync(root)) {
    const path = resolve(root, name), stat = lstatSync(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) syncTree(path)
    else if (stat.isFile() && stat.nlink === 1) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(fd) } finally { closeSync(fd) }
    } else throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'unsafe discovery copy')
  }
  fsyncDirectory(root)
}

export class SkillInstallManager {
  constructor({ profile, stateRoot, wsUrl, apiKey, getRuntimeHeaders = null,
    maxPackageBytes = DEFAULT_MAX_PACKAGE_BYTES, maxExtractedBytes = DEFAULT_MAX_EXTRACTED_BYTES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES, maxEntries = DEFAULT_MAX_ENTRIES,
    fetchFn = globalThis.fetch, sendResultFn = null, now = Date.now, createId = randomUUID,
    runtimeInstanceId = '', processIdentityFn = currentProcessIdentity, lockOwnerAliveFn = lockOwnerIsAlive,
    unownedLockStaleMs = DEFAULT_UNOWNED_LOCK_STALE_MS, maxReplayBatch = DEFAULT_MAX_REPLAY_BATCH,
    atomicFs = LINUX_ATOMIC_FS, checkpoint = () => {} }) {
    if (!profile?.agentId || !profile?.profileId) throw new Error('profileId and agentId required')
    if (profile.apiKey || apiKey) throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'legacy API-key authorization is retired')
    this.scope = durableScope(profile, wsUrl); this.profile = { ...profile }; this.wsUrl = wsUrl
    // Old protocol journals are retained but never replayed into SM-C1.
    this.stateRoot = resolve(stateRoot, 'management-v2')
    this.stagingDir = resolve(this.stateRoot, 'staging'); this.packagesDir = resolve(this.stateRoot, 'packages')
    this.staleLocksDir = resolve(this.stateRoot, 'stale-locks'); this.statePath = resolve(this.stateRoot, 'journal.json')
    this.lockPath = resolve(this.stateRoot, 'installer.lock'); this.lockOwnerPath = resolve(this.lockPath, 'owner.json')
    Object.assign(this, { getRuntimeHeaders, maxPackageBytes, maxExtractedBytes, maxEntryBytes, maxEntries,
      fetchFn, sendResultFn, now, createId, runtimeInstanceId, processIdentityFn, lockOwnerAliveFn,
      unownedLockStaleMs, maxReplayBatch, atomicFs, checkpoint })
    this.lockOwner = null; this.lockOwnerSha256 = ''; this.healthError = null; this.session = null
    this.verifyCandidate = null; this.tail = Promise.resolve(); this.replayToken = null; this.replayed = new Set()
  }

  initialize() {
    for (const dir of [this.stateRoot, this.stagingDir, this.packagesDir, this.staleLocksDir]) ensurePrivateDirectory(dir)
    this._withLockSync('initialize', () => {
      if (!existsSync(this.statePath)) this._save({ formatVersion: 2, scope: this.scope, identity: null,
        commands: {}, messages: {}, installations: {}, skills: {}, fences: {} })
      const state = this._load(); this.boundIdentity = state.identity
      // Recovery observes durable markers, never performs installation or a switch.
      for (const record of Object.values(state.commands)) {
        if (record.result || record.state === 'RECEIVED') continue
        const evidence = this._observe(state, record)
        if (evidence.outcome === 'APPLIED') this._applyObserved(state, record)
        this._finish(state, record, evidence)
      }
    })
    return { healthy: !this.healthError, errorCode: this.healthError?.code || '' }
  }

  _save(state) {
    const { journalSha256, ...facts } = state
    atomicWriteJson(this.statePath, { ...facts, journalSha256: managementDigest('cyf.skill.journal.v2', facts) })
  }
  _load() {
    if (!lstatSync(this.statePath).isFile() || lstatSync(this.statePath).nlink !== 1 || lstatSync(this.statePath).isSymbolicLink() || realpathSync(this.statePath) !== this.statePath) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'unsafe journal')
    const { journalSha256, ...state } = readJson(this.statePath)
    if (journalSha256 !== managementDigest('cyf.skill.journal.v2', state) || state.formatVersion !== 2
        || managementCanonicalJson(state.scope) !== managementCanonicalJson(this.scope)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'journal integrity/scope conflict')
    for (const record of Object.values(state.commands)) {
      parseManagementMessage(record.envelope)
      if (record.result) {
        parseManagementMessage(record.result)
        if (record.resultWire !== JSON.stringify(record.result) || record.result.data.commandId !== record.envelope.data.commandId
            || record.result.data.skillChangeId !== record.envelope.data.skillChangeId || record.result.data.attempt !== record.envelope.data.attempt
            || record.result.data.executionRuntimeInstanceId !== record.executionRuntimeInstanceId
            || ['agentId', 'runtimeInstallationId', 'fencingToken', 'deliveryEpoch', 'skillRevision'].some(key => record.result.data[key] !== record.envelope.data[key])
            || record.result.data.evidence.observedCommandId !== (record.envelope.data.observedCommandId || record.envelope.data.commandId)
            || record.envelope.data.phase !== 'READ' && record.result.data.evidence.phase !== record.envelope.data.phase
            || record.result.data.evidence.outcome === 'APPLIED' && (!this._same(record.result.data.evidence.actual, record.envelope.data.action === 'UNINSTALL' ? null : record.envelope.data.target)
              || record.result.data.evidence.appliedRevision !== record.envelope.data.skillRevision)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'result integrity conflict')
        if (record.receipt) {
          parseManagementMessage(record.receipt)
          if (!this._receiptMatches(record.receipt, record.result)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'receipt integrity conflict')
        }
      } else if (record.receipt) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'receipt without result')
    }
    return state
  }
  _key(value) { return Buffer.from(value, 'utf8').toString('hex') }
  _packagePath(id) { return resolve(this.packagesDir, this._key(id)) }
  _command(state, id) { return state.commands[this._key(id)] }
  _skill(state, key) { return state.skills[this._key(key)] || null }
  _installation(state, id) { return state.installations[this._key(id)] || null }

  bindSession(binding) {
    if (!binding) { this.session = null; return }
    const identity = { ...binding.scope, runtimeInstallationId: binding.fence.installationId }
    if (identity.agentId !== this.profile.agentId || binding.fence.runtimeInstanceId !== this.runtimeInstanceId) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'authenticated subject mismatch')
    if (this.boundIdentity) {
      if (!this._same(this.boundIdentity, identity)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'durable subject cannot be rebound')
      if (!this._same(this.session, binding)) this.session = structuredClone(binding)
      return
    }
    this._withLockSync('bind-authenticated-skill-subject', () => {
      const state = this._load()
      if (state.identity && managementCanonicalJson(state.identity) !== managementCanonicalJson(identity)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'durable subject cannot be rebound')
      state.identity = identity; this._save(state); this.boundIdentity = identity
    })
    // Equal owner/session bindings must not cancel a legitimate in-progress preparation.
    if (managementCanonicalJson(this.session || null) !== managementCanonicalJson(binding)) this.session = structuredClone(binding)
  }
  _assertIdentity(command, session = this.session) {
    if (!session || session !== this.session) throw new SkillInstallError('SKILL_DELIVERY_FENCED', 'authenticated skill session changed')
    const expected = { ...session.scope, runtimeInstallationId: session.fence.installationId }
    if (Object.entries(expected).some(([key, value]) => command[key] !== value)) throw new SkillInstallError('SKILL_DOWNLOAD_FORBIDDEN', 'command differs from authenticated subject')
  }
  _same(left, right) { return managementCanonicalJson(left) === managementCanonicalJson(right) }
  _assertSource(state, command) {
    const current = this._skill(state, command.skillKey)
    if (!this._same((current?.removed ? null : current?.target) || null, command.source)) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'precise source changed')
    if (current && command.action === 'UPGRADE' && command.desiredEnabled !== current.enabled) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'upgrade cannot change enabled policy')
  }
  _fence(state, command) {
    const key = this._key(command.skillKey), previous = state.fences[key]
    const intent = Object.fromEntries(['action', 'source', 'approvedPermissionsSha256', 'desiredEnabled'].map(key => [key, command[key]]))
    if (previous && (BigInt(command.skillRevision) < BigInt(previous.revision)
        || command.skillRevision === previous.revision && (command.skillChangeId !== previous.skillChangeId || command.attempt !== previous.attempt
          || !this._same(command.target, previous.target) || !this._same(intent, previous.intent)))) throw new SkillInstallError('SKILL_DELIVERY_FENCED', 'obsolete management intent')
    state.fences[key] = { revision: command.skillRevision, skillChangeId: command.skillChangeId, attempt: command.attempt, target: command.target, intent }
  }
  _baseEvidence(state, record, outcome, reasonCode = null) {
    const c = record.envelope.data, current = this._skill(state, c.skillKey)
    return { observedCommandId: c.commandId, phase: c.phase, outcome, actual: current?.removed ? null : current?.target || null,
      appliedRevision: current?.revision || '0', preparedSha256: null,
      readiness: (['PREPARED', 'APPLIED'].includes(outcome) ? c.target.kind : current?.target.kind) === 'INSTRUCTION' ? 'NOT_EXECUTABLE' : 'UNKNOWN', reasonCode, observedAt: this.now() }
  }
  _finish(state, record, evidence, executionRuntimeInstanceId = record.executionRuntimeInstanceId) {
    const c = record.envelope.data
    const data = { schemaVersion: 2, resultType: 'SKILL_CHANGE_RESULT', skillChangeId: c.skillChangeId, commandId: c.commandId,
      agentId: c.agentId, runtimeInstallationId: c.runtimeInstallationId, executionRuntimeInstanceId,
      attempt: c.attempt, fencingToken: c.fencingToken, deliveryEpoch: c.deliveryEpoch, skillRevision: c.skillRevision, evidence }
    data.resultSha256 = managementDigest('cyf.skill.result.v2', data)
    const result = eventMessage(record.envelope.requestId, 'work.result', this.createId(), data)
    parseManagementMessage(result)
    record.executionRuntimeInstanceId = executionRuntimeInstanceId
    record.state = evidence.outcome; record.result = result; record.resultWire = JSON.stringify(result); record.receipt = null
    this._save(state)
    this.checkpoint('result-persisted', record)
    return result
  }

  _receive(envelope) {
    const c = envelope.data; this._assertIdentity(c)
    return this._withLockSync(`receive:${c.commandId}`, () => {
      const state = this._load(), key = this._key(c.commandId), messageKey = this._key(envelope.messageId)
      const wire = JSON.stringify(envelope), previousMessage = state.messages[messageKey]
      if (previousMessage && previousMessage.wire !== wire) throw new SkillInstallError('SKILL_RESULT_CONFLICT', 'same messageId changed bytes')
      let record = state.commands[key]
      if (record && record.envelope.data.commandSha256 !== c.commandSha256) throw new SkillInstallError('SKILL_RESULT_CONFLICT', 'command identity conflict')
      if (!record) {
        record = { envelope, state: 'RECEIVED', executionRuntimeInstanceId: this.runtimeInstanceId, maxDeliveryEpoch: c.deliveryEpoch, result: null }
        state.commands[key] = record
      } else if (!previousMessage && BigInt(c.deliveryEpoch) <= BigInt(record.maxDeliveryEpoch)) {
        throw new SkillInstallError('SKILL_DELIVERY_FENCED', 'new delivery requires a newer authorized epoch')
      }
      if (BigInt(c.deliveryEpoch) > BigInt(record.maxDeliveryEpoch)) record.maxDeliveryEpoch = c.deliveryEpoch
      if (!previousMessage) {
        const ack = replyMessage(envelope, 'command.ack', this.createId(), 'E0', 'received', {
          schemaVersion: 2, skillChangeId: c.skillChangeId, commandId: c.commandId, attempt: c.attempt,
          fencingToken: c.fencingToken, deliveryEpoch: c.deliveryEpoch, ackStatus: 'RECEIVED' })
        validateManagement('CommandAck', ack)
        state.messages[messageKey] = { wire, ack }
        this._save(state) // Receiving is durable before ACK, not before work.result.
      }
      this._send(state.messages[messageKey].ack)
      return record
    })
  }
  _send(envelope) { try { return this.sendResultFn?.(envelope) === true } catch { return false } }

  async handle(input) {
    const envelope = parseManagementMessage(input)
    if (!['command.dispatch', 'work.result.receipt'].includes(envelope.messageType)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.COMMAND_INVALID, 'not a management command')
    // Serialize receive, execution and receipts together. The async download/probe
    // holds the cross-process lock: a concurrent local receive must not re-enter
    // that lock, release another operation's ownership, or overwrite its snapshot.
    const run = () => {
      if (envelope.messageType === 'work.result.receipt') return this.acknowledgeResultReceipt(envelope)
      this._receive(envelope)
      return this.execute(envelope)
    }
    const pending = this.tail.then(run, run); this.tail = pending.catch(() => {})
    return pending
  }
  async execute(input) {
    const envelope = parseManagementMessage(input), c = envelope.data, session = this.session
    this._assertIdentity(c, session)
    const result = await this._withLock(`execute:${c.commandId}`, async () => {
      const state = this._load(), record = this._command(state, c.commandId)
      if (!record || record.envelope.data.commandSha256 !== c.commandSha256) throw new SkillInstallError('SKILL_RESULT_CONFLICT', 'command not durably received')
      if (record.result) return record.result
      if (record.state !== 'RECEIVED') {
        const evidence = this._observe(state, record)
        if (evidence.outcome === 'APPLIED') this._applyObserved(state, record)
        return this._finish(state, record, evidence)
      }
      if (c.phase === 'READ') {
        const observed = this._command(state, c.observedCommandId)
        if (observed && !['skillChangeId', 'skillKey', 'attempt', 'fencingToken', 'skillRevision', 'approvedPermissionsSha256'].every(key => observed.envelope.data[key] === c[key])
            || observed && (!this._same(observed.envelope.data.target, c.target) || !this._same(observed.envelope.data.source, c.source))) throw new SkillInstallError('SKILL_RESULT_CONFLICT', 'READ binding mismatch')
        // Absence alone proves nothing; READ never downloads, changes policy, or publishes a view.
        const evidence = observed ? this._observe(state, observed) : {
          ...this._baseEvidence(state, { ...record, envelope: { ...envelope, data: { ...c, phase: ['ENABLE', 'DISABLE', 'UNINSTALL'].includes(c.action) ? 'POLICY' : 'ACTIVATE' } } }, 'UNKNOWN', 'INTEGRITY_UNPROVEN'), observedCommandId: c.observedCommandId }
        if (observed && evidence.outcome === 'APPLIED') this._applyObserved(state, observed)
        return this._finish(state, record, evidence, observed?.executionRuntimeInstanceId || record.executionRuntimeInstanceId)
      }
      try {
        this._fence(state, c); this._assertSource(state, c)
        if ((c.phase === 'POLICY') && (!this._same(c.source, c.target) || !this._installation(state, c.target.skillInstallationId))) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'policy requires precise installed target')
        record.state = 'STARTED'; record.executionRuntimeInstanceId = this.runtimeInstanceId; this._save(state); this.checkpoint('intent-persisted', record)
        if (c.phase === 'PREPARE') return await this._prepare(state, record, session)
        if (c.phase === 'ACTIVATE') return await this._activate(state, record, session)
        const installed = this._verifiedInstallation(state, c.target.skillInstallationId)
        if (installed.approvedPermissionsSha256 !== c.approvedPermissionsSha256) throw new SkillInstallError('SKILL_PERMISSIONS_MISMATCH', 'policy cannot expand installation permissions')
        if (c.action === 'ENABLE') await this._probe(installed)
        this._assertIdentity(c, session)
        this._policyView(state, record)
        this._applyObserved(state, record)
        return this._finish(state, record, { ...this._baseEvidence(state, record, 'APPLIED'), actual: c.action === 'UNINSTALL' ? null : c.target, appliedRevision: c.skillRevision })
      } catch (error) {
        // Once publication may have happened, never turn uncertainty into a refundable failure.
        if (error?.simulatedCrash) throw error
        if (record.intent) {
          const evidence = this._observe(state, record)
          if (evidence.outcome === 'APPLIED') this._applyObserved(state, record)
          return this._finish(state, record, evidence)
        }
        if (record.result) throw error
        return this._finish(state, record, this._baseEvidence(state, record, 'FAILED', publicFailure(error.code)))
      }
    })
    this.replayResults()
    return { status: result.data.evidence.outcome === 'FAILED' ? 'failed' : 'completed', exitCode: 0, resultEnvelope: result }
  }
  async _probe(row) {
    if (!row.manifest) return { readiness: 'NOT_EXECUTABLE' }
    if (typeof this.verifyCandidate !== 'function') throw new SkillInstallError('SKILL_DEPENDENCY_UNAVAILABLE', 'authenticated runner probe unavailable')
    const probe = await this.verifyCandidate(row)
    if (probe?.readiness !== 'READY') throw new SkillInstallError(probe?.reasonCode || 'SKILL_DEPENDENCY_UNAVAILABLE', 'candidate dependency unavailable')
    return probe
  }
  _descriptor(installation, current = null) {
    const c = installation.command, target = c.target
    return { installationId: target.skillInstallationId, skillInstallationId: target.skillInstallationId, productVersionId: target.productVersionId,
      skillKey: c.skillKey, skillVersion: target.skillVersion, kind: target.kind,
      packageRoot: this._packagePath(target.skillInstallationId), packageSha256: target.packageSha256,
      manifestSha256: target.manifestSha256, approvedPermissionsSha256: c.approvedPermissionsSha256,
      packageTreeDigest: installation.packageTreeDigest, manifest: installation.manifest,
      enabled: current?.enabled ?? false, policyRevision: current?.revision || c.skillRevision }
  }
  _verifiedInstallation(state, id) {
    const installation = this._installation(state, id)
    if (!installation) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'exact installation missing')
    const root = this._packagePath(id), markerPath = resolve(root, MARKER_NAME)
    if (!existsSync(markerPath) || !lstatSync(markerPath).isFile() || lstatSync(markerPath).nlink !== 1 || lstatSync(markerPath).uid !== process.geteuid() || (lstatSync(markerPath).mode & 0o022) || lstatSync(markerPath).isSymbolicLink() || !this._same(readJson(markerPath), installation.marker)
        || skillPackageTreeDigest(root) !== installation.packageTreeDigest) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'managed immutable package changed')
    const row = this._descriptor(installation, this._skill(state, installation.command.skillKey))
    if (row.manifest) {
      const actual = parseSkillManifest(readFileSync(resolve(root, 'manifest.json')), { skillKey: row.skillKey, skillVersion: row.skillVersion })
      if (actual.manifestSha256 !== row.manifestSha256) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'manifest changed')
    }
    return row
  }
  async _prepare(state, record, session) {
    const c = record.envelope.data, target = c.target, path = this._packagePath(target.skillInstallationId)
    if (this._installation(state, target.skillInstallationId) || existsSync(path)) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'installation identity already exists')
    if (BigInt(target.byteLength) > BigInt(this.maxPackageBytes)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.PACKAGE_TOO_LARGE, 'declared package exceeds local limit')
    const command = { ...c, installationId: target.skillInstallationId, skillVersion: target.skillVersion,
      packageSize: target.byteLength, packageSizeBytes: Number(target.byteLength), packageDigest: `sha256:${target.packageSha256}` }
    const bytes = await this._download(command)
    this._assertIdentity(c, session)
    const stage = resolve(this.stagingDir, this._key(c.commandId))
    mkdirSync(stage, { mode: 0o700 }); fsyncDirectory(this.stagingDir)
    const manifest = await extractArchive(bytes, stage, command, this)
    if ((manifest?.manifestSha256 ?? null) !== target.manifestSha256 || (manifest === null) !== (target.kind === 'INSTRUCTION')) throw new SkillInstallError(SKILL_INSTALL_FAILURE.IDENTITY_MISMATCH, 'approved manifest/kind mismatch')
    const packageTreeDigest = skillPackageTreeDigest(stage)
    await this._probe({ installationId: target.skillInstallationId, skillInstallationId: target.skillInstallationId,
      productVersionId: target.productVersionId, skillKey: c.skillKey, skillVersion: target.skillVersion, kind: target.kind,
      packageRoot: stage, packageSha256: target.packageSha256, manifestSha256: target.manifestSha256,
      packageTreeDigest, manifest, enabled: c.desiredEnabled, policyRevision: c.skillRevision })
    this._assertIdentity(c, session)
    const marker = { schemaVersion: 2, commandId: c.commandId, preparedSha256: preparedDigest(c),
      target, approvedPermissionsSha256: c.approvedPermissionsSha256, scopeDigest: this.scope.digest, packageTreeDigest }
    atomicWriteJson(resolve(stage, MARKER_NAME), marker, 0o644); fsyncDirectory(stage)
    const move = this.atomicFs.renameNoReplace(stage, path)
    if (!move.ok) throw this._atomicFailure(move, 'immutable package publication')
    state.installations[this._key(target.skillInstallationId)] = { command: c, marker, manifest, packageTreeDigest }
    record.preparedSha256 = marker.preparedSha256; record.state = 'PREPARED'; this._save(state)
    this.checkpoint('prepared-persisted', record)
    return this._finish(state, record, { ...this._baseEvidence(state, record, 'PREPARED'), preparedSha256: marker.preparedSha256 })
  }
  async _activate(state, record, session) {
    const c = record.envelope.data, prepared = this._command(state, c.preparedCommandId)
    if (!prepared || prepared.state !== 'PREPARED' || prepared.preparedSha256 !== c.preparedSha256
        || c.preparedSha256 !== preparedDigest(c) || !['skillChangeId', 'attempt', 'skillRevision', 'skillKey', 'desiredEnabled', 'approvedPermissionsSha256'].every(k => c[k] === prepared.envelope.data[k])) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'activation lacks matching prepared authorization')
    const row = this._verifiedInstallation(state, c.target.skillInstallationId)
    await this._probe(row); this._assertIdentity(c, session)
    if (!c.desiredEnabled) {
      if (existsSync(resolve(verifyControlledCodexHome(this.profile.codexHome), c.skillKey))) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'disabled source must not be discoverable')
      this._applyObserved(state, record)
      return this._finish(state, record, { ...this._baseEvidence(state, record, 'APPLIED'), actual: c.action === 'UNINSTALL' ? null : c.target, appliedRevision: c.skillRevision, preparedSha256: c.preparedSha256 })
    }
    const root = verifyControlledCodexHome(this.profile.codexHome), view = resolve(root, c.skillKey)
    const stageRoot = this._viewStagingRoot(), stage = resolve(stageRoot, this._key(c.commandId))
    if (existsSync(stage)) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'unresolved discovery stage')
    if (c.source) this._assertViewSource(state, c, view)
    else if (existsSync(view)) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'unmanaged discovery target')
    cpSync(row.packageRoot, stage, { recursive: true, errorOnExist: true, force: false, dereference: false })
    atomicWriteJson(resolve(stage, MARKER_NAME), { ...this._installation(state, c.target.skillInstallationId).marker, viewCommandId: c.commandId }, 0o644)
    syncTree(stage); fsyncDirectory(stageRoot); fsyncDirectory(root)
    record.intent = { view, stage, rootIdentity: pathIdentity(root), stageParentIdentity: pathIdentity(stageRoot), stageIdentity: pathIdentity(stage),
      sourceIdentity: existsSync(view) ? pathIdentity(view) : null }
    this._save(state); this.checkpoint('activation-intent-persisted', record)
    this._assertIdentity(c, session)
    const publication = record.intent.sourceIdentity
      ? this.atomicFs.exchangeIfMatch(view, stage, { parent: record.intent.rootIdentity, replacementParent: record.intent.stageParentIdentity,
          activeIdentity: record.intent.sourceIdentity, replacementIdentity: record.intent.stageIdentity })
      : this.atomicFs.renameNoReplace(stage, view, { sourceParent: record.intent.stageParentIdentity, targetParent: record.intent.rootIdentity,
          sourceIdentity: record.intent.stageIdentity })
    if (!publication.ok) throw this._atomicFailure(publication, 'discovery view switch')
    this.checkpoint('view-switched', record)
    if (this._observe(state, record).outcome !== 'APPLIED') throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'switched view evidence differs')
    this._applyObserved(state, record)
    const evidence = { ...this._baseEvidence(state, record, 'APPLIED'), actual: c.action === 'UNINSTALL' ? null : c.target, appliedRevision: c.skillRevision, preparedSha256: c.preparedSha256 }
    return this._finish(state, record, evidence)
  }
  _viewStagingRoot() {
    verifyControlledCodexHome(this.profile.codexHome)
    const root = resolve(this.profile.codexHome, '.cyf-skill-view-staging')
    ensurePrivateDirectory(root)
    return root
  }
  _viewMatches(state, id, path, commandId = null) {
    try {
      const installation = this._installation(state, id)
      if (!installation || !existsSync(path) || lstatSync(path).isSymbolicLink()) return false
      const { viewCommandId, ...marker } = readJson(resolve(path, MARKER_NAME))
      return (!commandId || viewCommandId === commandId) && this._same(marker, installation.marker)
        && skillPackageTreeDigest(path) === installation.packageTreeDigest
    } catch { return false }
  }
  _assertViewSource(state, command, path) {
    if (!this._viewMatches(state, command.source.skillInstallationId, path)) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'source discovery view does not match managed evidence')
  }
  _policyView(state, record) {
    const c = record.envelope.data, current = this._skill(state, c.skillKey)
    const root = verifyControlledCodexHome(this.profile.codexHome), view = resolve(root, c.skillKey)
    if (c.desiredEnabled === current.enabled) {
      if (c.desiredEnabled) this._assertViewSource(state, c, view)
      else if (existsSync(view)) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'disabled view unexpectedly published')
      if (c.action === 'UNINSTALL') {
        // Already disabled: persist the exact absence intent so READ can recover
        // without deleting the immutable package required by admitted tasks.
        record.intent = { view, uninstalledWithoutView: true }
        this._save(state); this.checkpoint('policy-intent-persisted', record)
      }
      return
    }
    if (!c.desiredEnabled) {
      this._assertViewSource(state, c, view)
      const stageRoot = this._viewStagingRoot(), stage = resolve(stageRoot, this._key(c.commandId))
      record.intent = { view, stage, rootIdentity: pathIdentity(root), stageParentIdentity: pathIdentity(stageRoot), sourceIdentity: pathIdentity(view), disabled: true }
      this._save(state); this.checkpoint('policy-intent-persisted', record)
      const move = this.atomicFs.renameNoReplace(view, stage, { sourceParent: record.intent.rootIdentity,
        targetParent: record.intent.stageParentIdentity, sourceIdentity: record.intent.sourceIdentity })
      if (!move.ok) throw this._atomicFailure(move, 'disable discovery view')
    } else {
      if (existsSync(view)) throw new SkillInstallError('SKILL_STATE_CONFLICT', 'enable cannot replace unmanaged view')
      const stageRoot = this._viewStagingRoot(), stage = resolve(stageRoot, this._key(c.commandId))
      cpSync(this._packagePath(c.target.skillInstallationId), stage, { recursive: true, errorOnExist: true, force: false })
      atomicWriteJson(resolve(stage, MARKER_NAME), { ...this._installation(state, c.target.skillInstallationId).marker, viewCommandId: c.commandId }, 0o644)
      syncTree(stage); fsyncDirectory(stageRoot); fsyncDirectory(root)
      record.intent = { view, stage, rootIdentity: pathIdentity(root), stageParentIdentity: pathIdentity(stageRoot), stageIdentity: pathIdentity(stage), disabled: false }
      this._save(state); this.checkpoint('policy-intent-persisted', record)
      const move = this.atomicFs.renameNoReplace(stage, view, { sourceParent: record.intent.stageParentIdentity,
        targetParent: record.intent.rootIdentity, sourceIdentity: record.intent.stageIdentity })
      if (!move.ok) throw this._atomicFailure(move, 'enable discovery view')
    }
    this.checkpoint('view-switched', record)
    if (this._observe(state, record).outcome !== 'APPLIED') throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'policy view evidence differs')
  }
  _applyObserved(state, record) {
    const c = record.envelope.data, current = this._skill(state, c.skillKey)
    if (current && BigInt(current.revision) > BigInt(c.skillRevision)) return
    state.skills[this._key(c.skillKey)] = { target: c.target, enabled: c.desiredEnabled, removed: c.action === 'UNINSTALL', revision: c.skillRevision, commandId: c.commandId }
    const installation = this._installation(state, c.target.skillInstallationId)
    if (installation) installation.activated = true
  }
  _observe(state, record) {
    const c = record.envelope.data
    if (record.result && record.result.data.evidence.outcome !== 'UNKNOWN') return record.result.data.evidence
    if (c.action === 'UNINSTALL' && c.phase === 'POLICY' && record.intent?.uninstalledWithoutView) {
      try {
        this._verifiedInstallation(state, c.target.skillInstallationId)
        const current = this._skill(state, c.skillKey)
        if (record.intent.view === resolve(verifyControlledCodexHome(this.profile.codexHome, { create: false }), c.skillKey)
            && !existsSync(record.intent.view) && current && !current.enabled && this._same(current.target, c.source)
            && BigInt(current.revision) <= BigInt(c.skillRevision))
          return { ...this._baseEvidence(state, record, 'APPLIED'), actual: null, appliedRevision: c.skillRevision }
      } catch { /* Missing or changed retained source does not prove uninstall. */ }
    }
    if (c.phase === 'POLICY' && record.intent?.disabled) {
      try {
        if (!existsSync(record.intent.view) && this._viewMatches(state, c.target.skillInstallationId, record.intent.stage)
            && samePathIdentity(pathIdentity(record.intent.stage), { ...record.intent.sourceIdentity, path: realpathSync(record.intent.stage) })) {
          return { ...this._baseEvidence(state, record, 'APPLIED'), actual: c.action === 'UNINSTALL' ? null : c.target, appliedRevision: c.skillRevision }
        }
      } catch {}
    }
    if ((c.phase === 'ACTIVATE' || c.phase === 'POLICY' && !record.intent?.disabled) && record.intent) {
      try {
        const row = this._verifiedInstallation(state, c.target.skillInstallationId), view = record.intent.view
        if (view !== resolve(verifyControlledCodexHome(this.profile.codexHome, { create: false }), c.skillKey) || lstatSync(view).isSymbolicLink()
            || !this._viewMatches(state, c.target.skillInstallationId, view, c.commandId) || skillPackageTreeDigest(view) !== row.packageTreeDigest) throw new Error('marker')
        return { ...this._baseEvidence(state, record, 'APPLIED'), actual: c.action === 'UNINSTALL' ? null : c.target, appliedRevision: c.skillRevision, preparedSha256: c.preparedSha256 || null }
      } catch { /* Unknown is not a reason to switch or roll back. */ }
    }
    if (c.phase === 'PREPARE' && record.preparedSha256) {
      try { this._verifiedInstallation(state, c.target.skillInstallationId)
        return { ...this._baseEvidence(state, record, 'PREPARED'), preparedSha256: record.preparedSha256 }
      } catch { /* missing package is not proof of no execution */ }
    }
    return this._baseEvidence(state, record, record.state === 'RECEIVED' ? 'NOT_STARTED' : 'UNKNOWN', 'INTEGRITY_UNPROVEN')
  }

  listInstalledSkills({ includeRetained = false, skillInstallationId = null } = {}) {
    // Atomic journal read + immutable package verification must not block old tasks during PREPARE.
    const state = this._load(), ids = includeRetained ? Object.values(state.installations).filter(row => row.activated).map(row => row.command.target.skillInstallationId)
      : Object.values(state.skills).filter(row => !row.removed).map(row => row.target.skillInstallationId)
    return ids.filter(id => skillInstallationId === null || id === skillInstallationId).map(id => {
      const row = this._verifiedInstallation(state, id), current = this._skill(state, row.skillKey)
      if (!includeRetained) {
        const view = resolve(verifyControlledCodexHome(this.profile.codexHome, { create: false }), row.skillKey)
        if (current.enabled ? !this._viewMatches(state, id, view) : existsSync(view)) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'current discovery view differs')
      }
      return { ...row, active: !current?.removed && current?.target.skillInstallationId === id }
    })
  }

  matchesDurableAckEnvelope(envelope) {
    try { return envelope?.messageType === 'command.ack' && Object.values(this._load().messages).some(row => this._same(row.ack, envelope)) }
    catch { return false }
  }
  isHealthy() { try { return !this.healthError && !!this._load() } catch { return false } }
  pendingResults() { return Object.values(this._load().commands).filter(row => row.result && !row.receipt).map(row => ({ envelope: row.result })) }
  acknowledgedResults() { return Object.values(this._load().commands).filter(row => row.result && row.receipt).map(row => ({ envelope: row.result })) }
  sentResults() { return this.acknowledgedResults() }
  replayResults(sendFn = this.sendResultFn, { limit = this.maxReplayBatch, replayToken = null } = {}) {
    if (typeof sendFn !== 'function' || this.healthError) return 0
    if (replayToken !== this.replayToken) { this.replayToken = replayToken; this.replayed.clear() }
    let sent = 0
    for (const { envelope } of this.pendingResults()) {
      if (replayToken && this.replayed.has(envelope.messageId)) continue
      if (sent >= limit || sendFn(envelope) !== true) break
      if (replayToken) this.replayed.add(envelope.messageId)
      sent++
    }
    return sent
  }
  matchesDurableResultEnvelope(envelope) {
    try { return isManagementMessage(envelope) && this.pendingResults().some(row => this._same(row.envelope, envelope)) } catch { return false }
  }
  matchesDurableResultReceipt(receipt) {
    try {
      parseManagementMessage(receipt)
      return [...this.pendingResults(), ...this.acknowledgedResults()].some(({ envelope }) => this._receiptMatches(receipt, envelope))
    } catch { return false }
  }
  _receiptMatches(receipt, envelope) {
    return receipt.correlationId === envelope.messageId && receipt.requestId === envelope.requestId
      && ['skillChangeId', 'commandId', 'attempt'].every(key => receipt.data[key] === envelope.data[key])
  }
  replayAcks(sendFn = this.sendResultFn) {
    if (!this.session || typeof sendFn !== 'function') return 0
    let sent = 0
    for (const { ack } of Object.values(this._load().messages)) {
      if (sendFn(ack) !== true) break
      sent++
    }
    return sent
  }
  async resumePendingCommands() {
    // Only proven not-started durable receives may run. STARTED/UNKNOWN are observation-only.
    for (const record of Object.values(this._load().commands)) {
      if (!this.session) break
      if (record.state === 'RECEIVED' && !record.result) await this.handle(record.envelope)
    }
  }
  acknowledgeResultReceipt(input) {
    const receipt = parseManagementMessage(input)
    if (receipt.messageType !== WORK_RESULT_RECEIPT_TYPE) throw new SkillInstallError('SKILL_RESULT_CONFLICT', 'not a result receipt')
    return this._withLockSync('commit-result-receipt', () => {
      if (!this.matchesDurableResultReceipt(receipt)) throw new SkillInstallError('SKILL_RESULT_CONFLICT', 'uncorrelated result receipt')
      const state = this._load(), record = this._command(state, receipt.data.commandId)
      if (!record.receipt) { record.receipt = receipt; this._save(state); this.checkpoint('receipt-persisted', record) }
      return { status: 'acknowledged' }
    })
  }
  reconcileCommandOutcome(message) {
    if (!isManagementMessage(message)) return null
    const state = this._load(), record = this._command(state, message.data.commandId)
    return record?.result ? { status: 'completed', authoritative: true, resultEnvelope: record.result } : null
  }
  getInstallation(id) { return this._installation(this._load(), id) }
  _validLockOwner(evidence) {
    if (!isObject(evidence) || evidence.formatVersion !== 2 || typeof evidence.ownerToken !== 'string'
        || !Number.isSafeInteger(evidence.pid) || evidence.pid <= 0
        || typeof evidence.processStartToken !== 'string' || !evidence.processStartToken
        || typeof evidence.bootId !== 'string' || !evidence.bootId) return null
    return evidence
  }

  _inspectLockGeneration() {
    if (!existsSync(this.lockPath)) return null
    let identity
    try { identity = pathIdentity(this.lockPath) } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `installer lock identity cannot be read: ${error.message}`)
    }
    if (identity.kind !== 'directory') {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'installer lock is not a directory')
    }
    let ownerBytes
    try {
      ownerBytes = readFileSync(this.lockOwnerPath)
    } catch (error) {
      if (error?.code === 'ENOENT') ownerBytes = Buffer.alloc(0)
      else throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `installer lock owner evidence cannot be read: ${error.message}`)
    }
    let evidence = null
    try { evidence = JSON.parse(ownerBytes.toString('utf8')) } catch {}
    evidence = isObject(evidence) ? evidence : null
    return {
      identity,
      evidence,
      owner: this._validLockOwner(evidence),
      ownerSha256: sha256Hex(ownerBytes)
    }
  }

  _atomicFailure(result, action) {
    const conflictCodes = new Set([
      'TARGET_EXISTS', 'SOURCE_CHANGED', 'ACTIVE_CHANGED', 'REPLACEMENT_CHANGED',
      'ACTIVE_CHANGED_ROLLED_BACK', 'PARENT_CHANGED_ROLLED_BACK'
    ])
    const code = conflictCodes.has(result?.code) ? SKILL_INSTALL_FAILURE.CONFLICT : SKILL_INSTALL_FAILURE.IO_FAILED
    return new SkillInstallError(code, `${action} failed closed (${result?.code || 'UNKNOWN'}): ${result?.message || 'atomic helper failed'}`)
  }

  _createLockCandidate(owner, suffix) {
    const candidatePath = resolve(this.stateRoot, `.installer-lock-${owner.ownerToken}-${suffix}`)
    mkdirSync(candidatePath, { mode: 0o700 })
    chmodSync(candidatePath, 0o700)
    atomicWriteJson(resolve(candidatePath, 'owner.json'), owner)
    fsyncDirectory(this.stateRoot)
    return candidatePath
  }

  _assertReclaimableGeneration(inspected) {
    const { owner, evidence } = inspected
    if (owner && this.lockOwnerAliveFn(owner)) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'another live process owns the profile-local installer lock')
    }
    if (!owner && evidence?.formatVersion === 1 && Number.isSafeInteger(evidence.pid) && evidence.pid > 0
        && readProcessStartToken(evidence.pid)) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'a live legacy process may own the profile-local installer lock')
    }
    if (!owner && !(evidence?.formatVersion === 1 && Number.isSafeInteger(evidence.pid)
        && evidence.pid > 0 && !readProcessStartToken(evidence.pid))) {
      let current
      try { current = lstatSync(this.lockPath, { bigint: true }) } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
      }
      if (current.dev.toString() !== inspected.identity.dev || current.ino.toString() !== inspected.identity.ino) return false
      const age = Math.max(0, this.now() - Number(current.mtimeMs))
      if (age < this.unownedLockStaleMs) {
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'installer lock ownership is incomplete and not yet stale')
      }
    }
    return true
  }

  _archiveExchangedStaleLock(candidatePath, operation, previousOwner, previousOwnerSha256) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stalePath = resolve(this.staleLocksDir, `installer-${this.now()}-${this.createId()}`)
      const result = this.atomicFs.renameNoReplace(candidatePath, stalePath, {
        sourceParent: pathIdentity(this.stateRoot),
        targetParent: pathIdentity(this.staleLocksDir),
        sourceIdentity: pathIdentity(candidatePath),
        sourceOwnerSha256: previousOwnerSha256
      })
      if (result.ok) {
        atomicWriteJson(resolve(stalePath, 'reclaimed.json'), {
          formatVersion: 2,
          reclaimedAt: this.now(),
          reclaimedByRuntimeInstanceId: this.runtimeInstanceId,
          operation,
          previousOwner
        })
        return stalePath
      }
      if (result.code !== 'TARGET_EXISTS') throw this._atomicFailure(result, 'stale installer lock archival')
    }
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'stale installer lock archival exhausted unique targets')
  }

  _acquireLock(operation) {
    if (this.lockOwner) throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'another operation owns this manager installer lock')
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
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let candidatePath = ''
      try {
        const inspected = this._inspectLockGeneration()
        if (!inspected) {
          candidatePath = this._createLockCandidate(owner, attempt)
          const candidateOwnerSha256 = sha256Hex(readFileSync(resolve(candidatePath, 'owner.json')))
          const result = this.atomicFs.renameNoReplace(candidatePath, this.lockPath, {
            sourceParent: pathIdentity(this.stateRoot),
            targetParent: pathIdentity(this.stateRoot),
            sourceIdentity: pathIdentity(candidatePath),
            sourceOwnerSha256: candidateOwnerSha256
          })
          if (result.ok) {
            this.lockOwner = owner
            this.lockOwnerSha256 = candidateOwnerSha256
            return
          }
          if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true })
          candidatePath = ''
          if (result.code === 'TARGET_EXISTS' || result.code === 'SOURCE_CHANGED') continue
          throw this._atomicFailure(result, 'installer lock acquisition')
        }

        if (!this._assertReclaimableGeneration(inspected)) continue
        candidatePath = this._createLockCandidate(owner, attempt)
        const replacementOwnerSha256 = sha256Hex(readFileSync(resolve(candidatePath, 'owner.json')))
        const exchange = this.atomicFs.exchangeIfMatch(this.lockPath, candidatePath, {
          parent: pathIdentity(this.stateRoot),
          activeIdentity: inspected.identity,
          replacementIdentity: pathIdentity(candidatePath),
          activeOwnerSha256: inspected.ownerSha256,
          replacementOwnerSha256
        })
        if (!exchange.ok) {
          if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true })
          candidatePath = ''
          if (['ACTIVE_CHANGED', 'ACTIVE_CHANGED_ROLLED_BACK', 'REPLACEMENT_CHANGED'].includes(exchange.code)) continue
          throw this._atomicFailure(exchange, 'stale installer lock generation exchange')
        }

        this.lockOwner = owner
        this.lockOwnerSha256 = replacementOwnerSha256
        this._archiveExchangedStaleLock(candidatePath, operation, inspected.evidence, inspected.ownerSha256)
        return
      } catch (error) {
        if (candidatePath && existsSync(candidatePath) && !this.lockOwner) {
          try { rmSync(candidatePath, { recursive: true, force: true }) } catch {}
        }
        if (this.lockOwner) {
          try { this._releaseLock() } catch {}
        }
        if (error instanceof SkillInstallError) throw error
        throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `failed to acquire installer lock: ${error.message}`)
      }
    }
    throw new SkillInstallError(SKILL_INSTALL_FAILURE.CONFLICT, 'installer lock ownership changed repeatedly during acquisition')
  }

  _releaseLock() {
    const expected = this.lockOwner
    try {
      const inspected = this._inspectLockGeneration()
      const observed = inspected?.owner
      if (!expected || !observed || !inspected || !this.lockOwnerSha256
          || inspected.ownerSha256 !== this.lockOwnerSha256
          || observed.ownerToken !== expected.ownerToken
          || observed.pid !== expected.pid || observed.processStartToken !== expected.processStartToken
          || observed.bootId !== expected.bootId || observed.operation !== expected.operation
          || observed.runtimeInstanceId !== expected.runtimeInstanceId) {
        throw new Error('installer lock ownership fence mismatch')
      }
      const releasedPath = resolve(this.stateRoot, `.installer-lock-released-${expected.ownerToken}-${this.createId()}`)
      const result = this.atomicFs.renameNoReplace(this.lockPath, releasedPath, {
        sourceParent: pathIdentity(this.stateRoot),
        targetParent: pathIdentity(this.stateRoot),
        sourceIdentity: inspected.identity,
        sourceOwnerSha256: this.lockOwnerSha256
      })
      if (!result.ok) throw this._atomicFailure(result, 'installer lock release')
      rmSync(releasedPath, { recursive: true, force: true })
      fsyncDirectory(this.stateRoot)
      this.lockOwner = null
      this.lockOwnerSha256 = ''
    } catch (error) {
      this.healthError = error instanceof SkillInstallError
        ? error
        : new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `failed to release installer lock: ${error.message}`)
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
    if (typeof this.getRuntimeHeaders !== 'function') throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'installation-derived Runtime session is required')
    const headers = this.getRuntimeHeaders()
    if (!/^AgentRuntime rts1_[0-9a-f]{64}$/.test(headers?.Authorization || '')
        || headers['X-Agent-Id'] !== this.profile.agentId
        || ['X-Agent-Installation-Id', 'X-Agent-Host-Id', 'X-Agent-Runtime-Id', 'X-Agent-Session-Generation'].some(key => typeof headers[key] !== 'string' || !headers[key])) throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'complete Runtime session proof is required')
    if (typeof this.fetchFn !== 'function') throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'fetch implementation is unavailable')
    const endpoint = buildSkillDownloadUrl(this.wsUrl, command.downloadPath)
    let response
    try {
      response = await this.fetchFn(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: { ...headers, Accept: 'application/octet-stream' }
      })
    } catch (error) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, `package download failed: ${error.message}`)
    }
    if (!response || response.status !== 200 || response.redirected === true) {
      throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'package endpoint did not return a direct 200 response')
    }
    if (response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new SkillInstallError(SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN, 'package content type must be application/octet-stream')
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

}

export const defaultSkillInstallStateRoot = (commandInboxDir, profile, wsUrl = '') => {
  const apiOrigin = wsUrl ? canonicalApiOrigin(wsUrl) : ''
  const scopeKey = sha256Hex(Buffer.from(`${String(profile.profileId || '')}\0${apiOrigin}`)).slice(0, 32)
  return resolve(commandInboxDir, profileDirectory(profile), 'skill-install', scopeKey)
}
