import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isCanonicalPositiveJavaLong } from './conversation-reference-inputs-v3.mjs'

const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0
const SHA256 = /^[a-f0-9]{64}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const MATERIALIZED_FIELDS = ['inputRef', 'relativePath', 'source', 'contentType', 'byteLength', 'sha256'].sort().join(',')

export const CONTROLLED_IMAGE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const CONTROLLED_IMAGE_MAX_EDIT_IMAGE_URL_LENGTH = 20_971_520

export class ControlledImageV3FileError extends Error {
  constructor (code, message) { super(message); this.name = 'ControlledImageV3FileError'; this.code = code }
}

const fail = (code, message) => { throw new ControlledImageV3FileError(code, message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const effectiveUid = () => typeof process.geteuid === 'function' ? process.geteuid() : null
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

const assertInside = (parent, child, code) => {
  const local = relative(parent, child)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    fail(code, 'controlled image file escaped the private run directory')
  }
}

const assertNoSymlinkPath = (root, path, code) => {
  let current = path
  while (current !== root) {
    const info = lstatSync(current)
    if (info.isSymbolicLink()) fail(code, 'controlled image file path contains a symbolic link')
    current = resolve(current, '..')
  }
  if (realpathSync(root) !== root) fail(code, 'controlled image file root is not canonical')
}

export const canonicalControlledImageRunDirectory = runDirectory => {
  if (typeof runDirectory !== 'string' || !isAbsolute(runDirectory)) {
    fail('CONTROLLED_IMAGE_COMMAND_INVALID', 'controlled image run directory must be absolute')
  }
  const canonical = realpathSync(runDirectory)
  if (canonical !== resolve(runDirectory)) fail('CONTROLLED_IMAGE_COMMAND_INVALID', 'controlled image run directory is not canonical')
  return canonical
}

export const readVerifiedControlledImageV3Input = (runDirectory, input, index) => {
  if (!object(input) || Object.keys(input).sort().join(',') !== MATERIALIZED_FIELDS
      || input.inputRef !== `input_${index + 1}` || !object(input.source)
      || !['image/jpeg', 'image/png'].includes(input.contentType)
      || !isCanonicalPositiveJavaLong(input.byteLength) || !SHA256.test(input.sha256 || '')
      || input.relativePath !== `inputs/${input.inputRef}.${input.contentType === 'image/png' ? 'png' : 'jpg'}`) {
    fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image v3 input metadata is not canonical')
  }
  const inputsRoot = resolve(runDirectory, 'inputs')
  const path = resolve(runDirectory, input.relativePath)
  assertInside(inputsRoot, path, 'CONTROLLED_IMAGE_INPUT_INVALID')
  assertNoSymlinkPath(inputsRoot, path, 'CONTROLLED_IMAGE_INPUT_INVALID')
  const descriptor = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    const uid = effectiveUid()
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(input.byteLength)
        || (uid !== null && Number(before.uid) !== uid)) {
      fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input is not the expected private regular file')
    }
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameIdentity(before, after) || BigInt(bytes.length) !== BigInt(input.byteLength) || hash(bytes) !== input.sha256) {
      fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input bytes do not match the source-aware snapshot')
    }
    const signature = input.contentType === 'image/png' ? PNG_SIGNATURE : JPEG_SIGNATURE
    if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
      fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input bytes do not match their declared MIME')
    }
    return Object.freeze({
      inputRef: input.inputRef,
      source: input.source,
      contentType: input.contentType,
      sha256: input.sha256,
      byteLength: input.byteLength,
      relativePath: input.relativePath,
      path,
      bytes
    })
  } finally { closeSync(descriptor) }
}

export const readVerifiedControlledImageV3PngOutput = (runDirectory, relativePath = 'outputs/output_1.png') => {
  if (relativePath !== 'outputs/output_1.png') fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image output path is not canonical')
  const outputsRoot = resolve(runDirectory, 'outputs')
  const path = resolve(runDirectory, relativePath)
  assertInside(outputsRoot, path, 'CONTROLLED_IMAGE_RESPONSE_INVALID')
  assertNoSymlinkPath(outputsRoot, path, 'CONTROLLED_IMAGE_RESPONSE_INVALID')
  const descriptor = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    const uid = effectiveUid()
    if (!before.isFile() || before.nlink !== 1n || before.size < BigInt(PNG_SIGNATURE.length)
        || before.size > BigInt(CONTROLLED_IMAGE_MAX_OUTPUT_BYTES)
        || (uid !== null && Number(before.uid) !== uid)) {
      fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image output is not one bounded private regular file')
    }
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameIdentity(before, after) || BigInt(bytes.length) !== after.size
        || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image output changed or is not PNG')
    }
    return Object.freeze({ path, bytes, sha256: hash(bytes), byteLength: String(bytes.length) })
  } finally { closeSync(descriptor) }
}
