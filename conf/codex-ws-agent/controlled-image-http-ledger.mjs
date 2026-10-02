import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync
} from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

import { CONTROLLED_IMAGE_MAX_PROFILE_ID_LENGTH, isControlledImageProfileIdentity } from './controlled-image-http-config.mjs'

const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const SHA256 = /^[a-f0-9]{64}$/
const LONG_MAX = 9223372036854775807n
const validEpoch = value => {
  if (!/^[1-9][0-9]*$/.test(value || '')) return false
  try { return BigInt(value) <= LONG_MAX } catch { return false }
}
const CLAIM_MAX_BYTES = Buffer.byteLength(`${JSON.stringify({
  schemaVersion: 1, state: 'CLAIMED', profileId: 'x'.repeat(CONTROLLED_IMAGE_MAX_PROFILE_ID_LENGTH), agentId: 'x'.repeat(100),
  commandId: 'x'.repeat(100), requestDigest: 'a'.repeat(64), bindingId: 'x'.repeat(100),
  bindingEpoch: LONG_MAX.toString(), modelId: 'x'.repeat(100)
})}\n`, 'utf8')

export class ControlledImageHttpLedgerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ControlledImageHttpLedgerError'
    this.code = code
  }
}

const fail = (code, message) => { throw new ControlledImageHttpLedgerError(code, message) }
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex')
const effectiveUid = () => typeof process.geteuid === 'function' ? process.geteuid() : null

const assertNoSymlinkComponents = (path, { allowMissing = false } = {}) => {
  const absolute = resolve(path)
  const parts = absolute.split(sep).filter(Boolean)
  let current = sep
  for (const part of parts) {
    current = resolve(current, part)
    if (!existsSync(current)) {
      if (allowMissing) return
      fail('CONTROLLED_IMAGE_LEDGER_UNSAFE', 'controlled image ledger path is missing')
    }
    if (lstatSync(current).isSymbolicLink()) {
      fail('CONTROLLED_IMAGE_LEDGER_UNSAFE', 'controlled image ledger path contains a symbolic link')
    }
  }
}

const verifyPrivateDirectory = path => {
  assertNoSymlinkComponents(path)
  const info = statSync(path)
  if (!info.isDirectory() || realpathSync(path) !== resolve(path)) {
    fail('CONTROLLED_IMAGE_LEDGER_UNSAFE', 'controlled image ledger path is not a real directory')
  }
  const uid = effectiveUid()
  if (uid !== null && info.uid !== uid) fail('CONTROLLED_IMAGE_LEDGER_OWNER_MISMATCH', 'controlled image ledger directory owner does not match the runtime')
  if ((info.mode & 0o077) !== 0) fail('CONTROLLED_IMAGE_LEDGER_PERMISSIONS', 'controlled image ledger directory must not grant group or world access')
}

const fsyncDirectory = path => {
  const descriptor = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const ensurePrivateDirectory = path => {
  const absolute = resolve(path)
  assertNoSymlinkComponents(absolute, { allowMissing: true })
  const missing = []
  let existing = absolute
  while (!existsSync(existing)) {
    missing.unshift(existing)
    const parent = dirname(existing)
    if (parent === existing) fail('CONTROLLED_IMAGE_LEDGER_UNSAFE', 'controlled image ledger path has no existing parent')
    existing = parent
  }
  assertNoSymlinkComponents(existing)
  for (const directory of missing) {
    let created = false
    try {
      mkdirSync(directory, { mode: 0o700 })
      created = true
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('CONTROLLED_IMAGE_LEDGER_UNSAFE', 'controlled image ledger directory could not be created')
    }
    if (created) chmodSync(directory, 0o700)
    verifyPrivateDirectory(directory)
    if (created) {
      fsyncDirectory(directory)
      fsyncDirectory(dirname(directory))
    }
  }
  verifyPrivateDirectory(absolute)
}

const writeAll = (descriptor, bytes) => {
  let offset = 0
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

export class ControlledImageHttpLedger {
  #root
  #profileId
  #agentId
  #claimRoot

  constructor({ rootDir, profileId, agentId } = {}) {
    if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) fail('CONTROLLED_IMAGE_LEDGER_CONFIG_INVALID', 'controlled image ledger root must be absolute')
    if (!isControlledImageProfileIdentity(profileId, agentId) || !SAFE_ID.test(agentId || '')) {
      fail('CONTROLLED_IMAGE_LEDGER_CONFIG_INVALID', 'controlled image ledger profile and Agent identity must be canonical')
    }
    this.#root = resolve(rootDir)
    this.#profileId = profileId
    this.#agentId = agentId
    ensurePrivateDirectory(this.#root)
    const scope = digest(`controlled-image-http-v1\0${profileId}\0${agentId}`)
    const profilesRoot = resolve(this.#root, 'profiles')
    const profileRoot = resolve(profilesRoot, scope)
    this.#claimRoot = resolve(profileRoot, 'claims')
    for (const directory of [profilesRoot, profileRoot, this.#claimRoot]) ensurePrivateDirectory(directory)
    fsyncDirectory(this.#root)
    fsyncDirectory(profilesRoot)
    fsyncDirectory(profileRoot)
  }

  get rootDir() { return this.#root }

  claimPath(commandId) {
    if (!SAFE_ID.test(commandId || '')) fail('CONTROLLED_IMAGE_COMMAND_INVALID', 'controlled image commandId must be canonical')
    const claimId = digest(`${this.#profileId}\0${this.#agentId}\0${commandId}`)
    return resolve(this.#claimRoot, claimId.slice(0, 2), `${claimId}.json`)
  }

  #existingClaim(path, expectedCommandId) {
    let descriptor
    try {
      descriptor = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW)
      const before = fstatSync(descriptor, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(CLAIM_MAX_BYTES)) {
        fail('CONTROLLED_IMAGE_CLAIM_CORRUPT', 'existing controlled image claim is not a bounded regular file')
      }
      const uid = effectiveUid()
      if (uid !== null && Number(before.uid) !== uid) fail('CONTROLLED_IMAGE_CLAIM_CORRUPT', 'existing controlled image claim owner is invalid')
      if ((Number(before.mode) & 0o077) !== 0) fail('CONTROLLED_IMAGE_CLAIM_CORRUPT', 'existing controlled image claim permissions are invalid')
      const bytes = readFileSync(descriptor)
      const after = fstatSync(descriptor, { bigint: true })
      if (!sameIdentity(before, after) || BigInt(bytes.length) !== after.size) {
        fail('CONTROLLED_IMAGE_CLAIM_CORRUPT', 'existing controlled image claim changed while being read')
      }
      let record
      try { record = JSON.parse(bytes.toString('utf8')) } catch { fail('CONTROLLED_IMAGE_CLAIM_CORRUPT', 'existing controlled image claim is not valid JSON') }
      const keys = Object.keys(record || {}).sort().join(',')
      if (keys !== ['agentId', 'bindingEpoch', 'bindingId', 'commandId', 'modelId', 'profileId', 'requestDigest', 'schemaVersion', 'state'].sort().join(',')
          || record.schemaVersion !== 1 || record.state !== 'CLAIMED'
          || record.profileId !== this.#profileId || record.agentId !== this.#agentId
          || !isControlledImageProfileIdentity(record.profileId, record.agentId)
          || record.commandId !== expectedCommandId || !SAFE_ID.test(record.commandId || '')
          || !SHA256.test(record.requestDigest || '') || !SAFE_ID.test(record.bindingId || '')
          || !validEpoch(record.bindingEpoch) || !SAFE_ID.test(record.modelId || '')) {
        fail('CONTROLLED_IMAGE_CLAIM_CORRUPT', 'existing controlled image claim schema or identity is invalid')
      }
      return record
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  createClaim({ commandId, requestDigest, bindingId, bindingEpoch, modelId } = {}) {
    if (!SAFE_ID.test(commandId || '') || !SHA256.test(requestDigest || '')
        || !SAFE_ID.test(bindingId || '') || !validEpoch(bindingEpoch)
        || !SAFE_ID.test(modelId || '')) {
      fail('CONTROLLED_IMAGE_CLAIM_INVALID', 'controlled image claim fields are invalid')
    }
    const path = this.claimPath(commandId)
    const directory = dirname(path)
    ensurePrivateDirectory(directory)
    const record = Object.freeze({
      schemaVersion: 1,
      state: 'CLAIMED',
      profileId: this.#profileId,
      agentId: this.#agentId,
      commandId,
      requestDigest,
      bindingId,
      bindingEpoch,
      modelId
    })
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    let descriptor
    try {
      descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW, 0o600)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        this.#existingClaim(path, commandId)
        fail('CONTROLLED_IMAGE_ALREADY_CLAIMED', 'controlled image command already has a durable pre-call claim')
      }
      fail('CONTROLLED_IMAGE_CLAIM_IO_FAILED', 'controlled image claim could not be exclusively created')
    }
    try {
      writeAll(descriptor, bytes)
      fsyncSync(descriptor)
    } catch {
      fail('CONTROLLED_IMAGE_CLAIM_IO_FAILED', 'controlled image claim could not be durably persisted')
    } finally {
      closeSync(descriptor)
    }
    try { fsyncDirectory(directory) } catch {
      fail('CONTROLLED_IMAGE_CLAIM_IO_FAILED', 'controlled image claim directory could not be durably persisted')
    }
    return Object.freeze({ path, record })
  }
}
