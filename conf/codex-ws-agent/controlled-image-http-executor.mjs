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

import { CONTROLLED_IMAGE_MAX_INPUT_ITEMS } from './controlled-image-http-config.mjs'

const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
// Match the existing NativeConversationLane wire ceiling; this adapter must not widen it.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_EDIT_IMAGE_URL_LENGTH = 20_971_520

export class ControlledImageHttpError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ControlledImageHttpError'
    this.code = code
  }
}

const fail = (code, message) => { throw new ControlledImageHttpError(code, message) }
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const effectiveUid = () => typeof process.geteuid === 'function' ? process.geteuid() : null

const assertInside = (parent, child) => {
  const local = relative(parent, child)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input escaped the private run directory')
  }
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

const readVerifiedInput = (runDirectory, input, index) => {
  if (!isObject(input) || !['image/jpeg', 'image/png'].includes(input.contentType)
      || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1
      || !SHA256.test(input.sha256 || '')
      || input.relativePath !== `inputs/input_${index + 1}.${input.contentType === 'image/png' ? 'png' : 'jpg'}`) {
    fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input metadata is not canonical')
  }
  const path = resolve(runDirectory, input.relativePath)
  const inputsRoot = resolve(runDirectory, 'inputs')
  assertInside(inputsRoot, path)
  let parent = path
  while (parent !== inputsRoot) {
    const info = lstatSync(parent)
    if (info.isSymbolicLink()) fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input path contains a symbolic link')
    parent = resolve(parent, '..')
  }
  if (realpathSync(inputsRoot) !== inputsRoot) fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input root is not canonical')
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
    if (!sameIdentity(before, after) || bytes.length !== input.byteLength || hash(bytes) !== input.sha256) {
      fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input bytes do not match the fenced snapshot')
    }
    const signature = input.contentType === 'image/png' ? PNG_SIGNATURE : JPEG_SIGNATURE
    if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
      fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image input bytes do not match their declared MIME')
    }
    const dataUrl = `data:${input.contentType};base64,${bytes.toString('base64')}`
    if (dataUrl.length > MAX_EDIT_IMAGE_URL_LENGTH) {
      fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image data URL exceeds the official JSON edit limit')
    }
    return Object.freeze({
      contentType: input.contentType,
      sha256: input.sha256,
      byteLength: input.byteLength,
      dataUrl
    })
  } finally {
    closeSync(descriptor)
  }
}

const canonicalRequestDigest = ({ command, config, inputs, path, body }) => hash(Buffer.from(JSON.stringify({
  schemaVersion: 1,
  profileScope: command.profileScope,
  agentId: command.agentId,
  commandId: command.commandId,
  taskId: command.taskId,
  runId: command.runId,
  bindingId: config.bindingId,
  bindingEpoch: config.bindingEpoch,
  modelId: config.modelId,
  path,
  instruction: command.instruction,
  inputs: inputs.map(input => ({ contentType: input.contentType, sha256: input.sha256, byteLength: input.byteLength })),
  body
}), 'utf8'))

const decodeCanonicalPng = value => {
  if (typeof value !== 'string' || !value || /\s/.test(value)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image response is not canonical base64')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length < PNG_SIGNATURE.length
      || bytes.length > MAX_OUTPUT_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image response is not one bounded PNG')
  }
  return bytes
}

const responsePng = async (response, endpoint) => {
  if (!response || response.status !== 200 || response.redirected === true || response.url !== endpoint.href) {
    fail('CONTROLLED_IMAGE_PROVIDER_REJECTED', 'controlled image Provider did not return a direct 200 response')
  }
  const contentType = response.headers?.get?.('content-type')
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image Provider response is not JSON')
  }
  let payload
  try { payload = await response.json() } catch {
    fail('CONTROLLED_IMAGE_OUTCOME_UNKNOWN', 'controlled image Provider response could not be read')
  }
  if (!isObject(payload) || !Array.isArray(payload.data) || payload.data.length !== 1
      || !isObject(payload.data[0]) || Object.keys(payload.data[0]).sort().join(',') !== 'b64_json') {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image Provider response must contain exactly one base64 image')
  }
  return decodeCanonicalPng(payload.data[0].b64_json)
}

export class ControlledImageHttpExecutor {
  #profile
  #config
  #credential
  #fetch
  #ledger

  constructor({ profile, config, credential, fetchFn = globalThis.fetch, ledger } = {}) {
    if (!profile || !SAFE_ID.test(profile.profileId || '') || !SAFE_ID.test(profile.agentId || '')
        || config?.enabled !== true || typeof credential !== 'string' || !credential
        || typeof fetchFn !== 'function' || typeof ledger?.createClaim !== 'function') {
      fail('CONTROLLED_IMAGE_CONFIG_INVALID', 'controlled image executor configuration is incomplete')
    }
    this.#profile = Object.freeze({ profileId: profile.profileId, agentId: profile.agentId })
    this.#config = config
    this.#credential = credential
    this.#fetch = fetchFn
    this.#ledger = ledger
  }

  async execute({ command, runDirectory, inputs } = {}) {
    if (!isObject(command) || !SAFE_ID.test(command.commandId || '') || !SAFE_ID.test(command.taskId || '')
        || !SAFE_ID.test(command.runId || '') || typeof command.instruction !== 'string' || !command.instruction.trim()
        || command.outputId !== 'output_1' || command.outputContentMimeType !== 'image/png'
        || typeof runDirectory !== 'string' || !isAbsolute(runDirectory) || !Array.isArray(inputs)
        || inputs.length > CONTROLLED_IMAGE_MAX_INPUT_ITEMS
        || inputs.length > this.#config.maxInputItems) {
      fail('CONTROLLED_IMAGE_COMMAND_INVALID', 'controlled image execution requires one canonical PNG command with at most 16 inputs')
    }
    const canonicalRun = realpathSync(runDirectory)
    if (canonicalRun !== resolve(runDirectory)) fail('CONTROLLED_IMAGE_COMMAND_INVALID', 'controlled image run directory is not canonical')
    const verifiedInputs = inputs.map((input, index) => readVerifiedInput(canonicalRun, input, index))
    const requestPath = verifiedInputs.length ? '/v1/images/edits' : '/v1/images/generations'
    const body = verifiedInputs.length
      ? Object.freeze({
        model: this.#config.modelId,
        prompt: command.instruction,
        images: verifiedInputs.map(input => Object.freeze({ image_url: input.dataUrl })),
        n: 1,
        output_format: 'png'
      })
      : Object.freeze({ model: this.#config.modelId, prompt: command.instruction, n: 1, output_format: 'png' })
    const scopedCommand = Object.freeze({
      profileScope: this.#profile.profileId,
      agentId: this.#profile.agentId,
      commandId: command.commandId,
      taskId: command.taskId,
      runId: command.runId,
      instruction: command.instruction
    })
    const requestDigest = canonicalRequestDigest({ command: scopedCommand, config: this.#config,
      inputs: verifiedInputs, path: requestPath, body })
    this.#ledger.createClaim({
      commandId: command.commandId,
      requestDigest,
      bindingId: this.#config.bindingId,
      bindingEpoch: this.#config.bindingEpoch,
      modelId: this.#config.modelId
    })

    const endpoint = new URL(requestPath, `${this.#config.endpoint}/`)
    let response
    try {
      response = await this.#fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.#credential}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    } catch {
      fail('CONTROLLED_IMAGE_OUTCOME_UNKNOWN', 'controlled image Provider request outcome is unknown')
    }
    const bytes = await responsePng(response, endpoint)
    return Object.freeze({ outputId: 'output_1', contentType: 'image/png', bytes })
  }
}
