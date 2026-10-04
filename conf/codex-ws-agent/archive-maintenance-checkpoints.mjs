import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/u
const FEATURE_NAMESPACE = 'CYF_ARCHIVE_MAINTENANCE_CHECKPOINT_V1'
const RECORD_FIELDS = ['blockDigest', 'blockKey', 'draftId', 'draftRevision', 'executionEpoch',
  'formatVersion', 'jobId', 'operationKey', 'runId', 'scopeDigest', 'state']

const digest = value => createHash('sha256').update(value).digest('hex')
const exactKeys = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...RECORD_FIELDS].sort().join('\0')
const identity = status => ({ dev: String(status.dev), ino: String(status.ino), size: status.size,
  nlink: status.nlink, uid: status.uid, mode: status.mode,
  kind: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : 'other' })
const privateMode = (status, expected) => process.platform === 'win32' || (status.mode & 0o077) === 0
  && (status.mode & 0o700) === expected
const sameFileIdentity = (left, right) => left.kind === 'file' && right.kind === 'file'
  && left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.nlink === right.nlink && left.uid === right.uid && left.mode === right.mode
const sameDirectoryIdentity = (left, right) => left.kind === 'directory' && right.kind === 'directory'
  && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode
const currentUid = () => typeof process.getuid === 'function' ? process.getuid() : null

export class ArchiveCheckpointError extends Error {
  constructor(code, message = code) { super(message); this.name = 'ArchiveCheckpointError'; this.code = code }
}

const fail = (code, message) => { throw new ArchiveCheckpointError(code, message) }
const fsyncDirectory = directory => {
  let descriptor
  try { descriptor = openSync(directory, constants.O_RDONLY); fsyncSync(descriptor) }
  catch (error) {
    if (process.platform !== 'win32') throw error
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}
const requireDirectory = path => {
  const status = lstatSync(path)
  if (!status.isDirectory() || status.isSymbolicLink()) fail('ARCHIVE_CHECKPOINT_CORRUPT', 'checkpoint directory is not a real directory')
  if (!privateMode(status, 0o700)) fail('ARCHIVE_CHECKPOINT_OWNERSHIP', 'checkpoint directory permissions changed')
  const uid = currentUid(); if (uid !== null && status.uid !== uid) fail('ARCHIVE_CHECKPOINT_OWNERSHIP', 'checkpoint directory ownership changed')
  return identity(status)
}
const ensureDirectory = path => {
  if (!existsSync(path)) { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); fsyncDirectory(dirname(path)) }
  return requireDirectory(path)
}
const scopeText = value => typeof value === 'string' && value.length > 0 && value.length <= 100
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && !/[\ud800-\udfff]/u.test(value)
const safeComponent = value => {
  if (!ID.test(value || '')) fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint scope component is invalid')
  return value
}
const loopback = hostname => {
  const host = String(hostname || '').replace(/^\[|\]$/gu, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127)
}
const canonicalServiceOrigin = value => {
  let url
  try { url = new URL(value) } catch { fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint service origin is invalid') }
  if (url.origin !== value || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || (url.protocol === 'http:' && !loopback(url.hostname))) {
    fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint service origin is invalid')
  }
  return url.origin
}

export const defaultArchiveMaintenanceCheckpointRoot = (commandInboxDir, profile) => {
  if (!isAbsolute(commandInboxDir || '') || !scopeText(String(profile?.profileId || ''))
      || !ID.test(String(profile?.agentId || ''))) {
    fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint root scope is invalid')
  }
  const profileDirectory = Buffer.from(String(profile.agentId), 'utf8').toString('hex')
  return resolve(commandInboxDir, profileDirectory, 'archive-maintenance-checkpoints')
}

export const archiveBlockDigest = block => {
  const normalized = {
    blockType: block?.blockType,
    blockKey: block?.blockKey,
    ordinal: block?.ordinal,
    title: block?.title,
    titleSourceRanges: Array.isArray(block?.titleSourceRanges)
      ? block.titleSourceRanges.map(range => ({ startByte: range?.startByte, endByte: range?.endByte })) : [],
    paragraphs: Array.isArray(block?.paragraphs) ? block.paragraphs.map(paragraph => ({
      ordinal: paragraph?.ordinal,
      text: paragraph?.text,
      sourceRanges: Array.isArray(paragraph?.sourceRanges)
        ? paragraph.sourceRanges.map(range => ({ startByte: range?.startByte, endByte: range?.endByte })) : []
    })) : []
  }
  return digest(Buffer.from(JSON.stringify(normalized), 'utf8'))
}

export class ArchiveMaintenanceCheckpointStore {
  constructor({ root, runtimeScope, profileId, serviceOrigin, createId = randomUUID }) {
    if (!isAbsolute(root || '')) fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint root must be absolute')
    this.root = resolve(root)
    this.createId = createId
    const runtimeInstanceId = String(runtimeScope?.runtimeInstanceId || '')
    this.scope = {
      featureNamespace: FEATURE_NAMESPACE,
      serviceOrigin: canonicalServiceOrigin(serviceOrigin),
      profileId: String(profileId || ''),
      tenantId: String(runtimeScope?.tenantId || ''),
      clientId: String(runtimeScope?.clientId || ''),
      ownerJiacn: String(runtimeScope?.ownerJiacn || ''),
      agentId: String(runtimeScope?.agentId || '')
    }
    if (this.scope.tenantId !== '0' || !scopeText(this.scope.profileId) || !scopeText(this.scope.clientId)
      || !scopeText(this.scope.ownerJiacn) || !ID.test(this.scope.agentId) || !ID.test(runtimeInstanceId)) {
      fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint runtime scope is invalid')
    }
    this.scopeDigest = digest(Buffer.from(JSON.stringify(this.scope), 'utf8'))
    ensureDirectory(this.root)
    this.scopeRoot = resolve(this.root, 'v1', this.scopeDigest)
    this._ensurePath(this.scopeRoot)
  }

  _ensurePath(target) {
    let current = this.root
    const relative = target.slice(this.root.length).split(/[\\/]/u).filter(Boolean)
    requireDirectory(this.root)
    for (const component of relative) { current = resolve(current, component); ensureDirectory(current) }
    if (resolve(current) !== resolve(target) || !resolve(target).startsWith(`${this.root}${process.platform === 'win32' ? '\\' : '/'}`)) {
      fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint path escaped root')
    }
  }

  _path(command, blockKey) {
    const jobId = safeComponent(command.jobId); const runId = safeComponent(command.runId)
    const epoch = String(command.executionEpoch)
    if (!/^[1-9][0-9]{0,18}$/u.test(epoch)) fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint epoch is invalid')
    safeComponent(blockKey)
    const directory = resolve(this.scopeRoot, jobId, runId, epoch)
    this._ensurePath(directory)
    return resolve(directory, `${digest(blockKey)}.json`)
  }

  load(command, blockKey) {
    const path = this._path(command, blockKey)
    if (!existsSync(path)) return null
    const initial = lstatSync(path)
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) fail('ARCHIVE_CHECKPOINT_CORRUPT', 'checkpoint file is not private regular data')
    if (!privateMode(initial, 0o600)) fail('ARCHIVE_CHECKPOINT_OWNERSHIP', 'checkpoint file permissions changed')
    const uid = currentUid(); if (uid !== null && initial.uid !== uid) fail('ARCHIVE_CHECKPOINT_OWNERSHIP', 'checkpoint file ownership changed')
    let descriptor
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const opened = fstatSync(descriptor); const bytes = readFileSync(descriptor); const after = fstatSync(descriptor)
      if (!sameFileIdentity(identity(initial), identity(opened)) || !sameFileIdentity(identity(opened), identity(after))
        || opened.nlink !== 1 || !privateMode(opened, 0o600)
        || bytes.length !== opened.size || bytes.length > 8192) {
        fail('ARCHIVE_CHECKPOINT_CORRUPT', 'checkpoint inode changed while reading')
      }
      let record
      try { record = JSON.parse(bytes.toString('utf8')) } catch { fail('ARCHIVE_CHECKPOINT_CORRUPT', 'checkpoint JSON is corrupt') }
      if (!exactKeys(record) || record.formatVersion !== 1 || record.scopeDigest !== this.scopeDigest
        || record.jobId !== command.jobId || record.runId !== command.runId
        || record.executionEpoch !== String(command.executionEpoch) || record.blockKey !== blockKey
        || !SHA256.test(record.blockDigest || '') || !ID.test(record.draftId || '')
        || !DECIMAL.test(record.draftRevision || '') || !ID.test(record.operationKey || '')
        || !['PENDING', 'COMMITTED'].includes(record.state)) fail('ARCHIVE_CHECKPOINT_CORRUPT', 'checkpoint record is invalid')
      return Object.freeze(record)
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }

  save(command, blockKey, { blockDigest, draftId, draftRevision, operationKey, state }) {
    const path = this._path(command, blockKey)
    const record = { formatVersion: 1, scopeDigest: this.scopeDigest, jobId: command.jobId,
      runId: command.runId, executionEpoch: String(command.executionEpoch), blockKey, blockDigest,
      draftId, draftRevision: String(draftRevision), operationKey, state }
    if (!SHA256.test(blockDigest || '') || !ID.test(draftId || '') || !DECIMAL.test(record.draftRevision)
      || !ID.test(operationKey || '') || !['PENDING', 'COMMITTED'].includes(state)) {
      fail('ARCHIVE_CHECKPOINT_SCOPE', 'checkpoint write record is invalid')
    }
    const directory = dirname(path); const parentBefore = requireDirectory(directory)
    if (existsSync(path)) {
      const current = this.load(command, blockKey)
      if (current.blockDigest !== blockDigest || current.draftId !== draftId
        || current.operationKey !== operationKey || (current.state === 'COMMITTED' && state !== 'COMMITTED')) {
        fail('ARCHIVE_CHECKPOINT_CONFLICT', 'checkpoint record conflicts with existing state')
      }
    }
    const temporary = resolve(directory, `.checkpoint-${this.createId()}.tmp`)
    let descriptor
    try {
      descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8'); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined
      chmodSync(temporary, 0o600)
      if (!sameDirectoryIdentity(parentBefore, requireDirectory(directory))) fail('ARCHIVE_CHECKPOINT_CORRUPT', 'checkpoint parent inode changed')
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('ARCHIVE_CHECKPOINT_CORRUPT', 'checkpoint target became a symlink')
      renameSync(temporary, path)
      const targetDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try { fsyncSync(targetDescriptor) } finally { closeSync(targetDescriptor) }
      fsyncDirectory(directory)
      return this.load(command, blockKey)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    }
  }
}
