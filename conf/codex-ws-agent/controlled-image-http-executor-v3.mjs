import { responsePng } from './skill-runners/image-http-codec.mjs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { CONTROLLED_IMAGE_MAX_INPUT_ITEMS, isControlledImageProfileIdentity } from './controlled-image-http-config.mjs'
import {
  CONTROLLED_IMAGE_MAX_EDIT_IMAGE_URL_LENGTH,
  canonicalControlledImageRunDirectory,
  readVerifiedControlledImageV3Input
} from './controlled-image-v3-files.mjs'
import { canonicalContextJsonV1, controlledImageV3OperationSourcesValid } from './conversation-reference-inputs-v3.mjs'

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

export class ControlledImageHttpV3Error extends Error {
  constructor (code, message) { super(message); this.name = 'ControlledImageHttpV3Error'; this.code = code }
}
const fail = (code, message) => { throw new ControlledImageHttpV3Error(code, message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

const verifiedHttpInput = (runDirectory, input, index) => {
  const verified = readVerifiedControlledImageV3Input(runDirectory, input, index)
  const dataUrl = `data:${verified.contentType};base64,${verified.bytes.toString('base64')}`
  if (dataUrl.length > CONTROLLED_IMAGE_MAX_EDIT_IMAGE_URL_LENGTH) {
    fail('CONTROLLED_IMAGE_INPUT_INVALID', 'controlled image data URL exceeds the official JSON edit limit')
  }
  return Object.freeze({ ...verified, dataUrl })
}

const requestDigest = ({ command, profile, config, inputs, path, body }) => hash(Buffer.from(canonicalContextJsonV1({
  schemaVersion: 3,
  profileScope: profile.profileId,
  agentId: profile.agentId,
  commandId: command.commandId,
  executionId: command.executionId,
  taskId: command.taskId,
  runId: command.runId,
  operation: command.operation,
  inputSnapshotDigest: command.inputSnapshotDigest,
  bindingId: config.bindingId,
  bindingEpoch: config.bindingEpoch,
  modelId: config.modelId,
  path,
  instruction: command.instruction,
  inputs: inputs.map(input => ({ inputRef: input.inputRef, source: input.source, contentType: input.contentType,
    sha256: input.sha256, byteLength: input.byteLength })),
  body
}), 'utf8'))


export class ControlledImageHttpExecutorV3 {
  #profile; #config; #credential; #fetch; #ledger
  constructor ({ profile, config, credential, fetchFn = globalThis.fetch, ledger } = {}) {
    if (!profile || !isControlledImageProfileIdentity(profile.profileId, profile.agentId) || !SAFE_ID.test(profile.agentId || '')
        || config?.enabled !== true || typeof credential !== 'string' || !credential
        || typeof fetchFn !== 'function' || typeof ledger?.createClaim !== 'function') {
      fail('CONTROLLED_IMAGE_CONFIG_INVALID', 'controlled image v3 executor configuration is incomplete')
    }
    this.#profile = Object.freeze({ profileId: profile.profileId, agentId: profile.agentId })
    this.#config = config
    this.#credential = credential
    this.#fetch = fetchFn
    this.#ledger = ledger
  }

  async execute ({ command, runDirectory, inputs } = {}) {
    if (!object(command) || command.schemaVersion !== 3 || !SAFE_ID.test(command.commandId || '')
        || !SAFE_ID.test(command.executionId || '') || !SAFE_ID.test(command.taskId || '') || !SAFE_ID.test(command.runId || '')
        || !SAFE_ID.test(command.conversationId || '')
        || !['GENERATE_IMAGE', 'EDIT_IMAGE'].includes(command.operation)
        || !SHA256.test(command.inputSnapshotDigest || '')
        || typeof command.instruction !== 'string' || !command.instruction.trim()
        || command.outputId !== 'output_1' || command.outputContentMimeType !== 'image/png'
        || typeof runDirectory !== 'string' || !isAbsolute(runDirectory) || !Array.isArray(inputs)
        || inputs.length > CONTROLLED_IMAGE_MAX_INPUT_ITEMS || inputs.length > this.#config.maxInputItems
        || !controlledImageV3OperationSourcesValid(command.operation, inputs, command.conversationId)) {
      fail('CONTROLLED_IMAGE_COMMAND_INVALID', 'controlled image v3 operation and sources are not canonical')
    }
    const canonicalRun = canonicalControlledImageRunDirectory(runDirectory)
    const verifiedInputs = inputs.map((input, index) => verifiedHttpInput(canonicalRun, input, index))
    const requestPath = command.operation === 'GENERATE_IMAGE' && verifiedInputs.length === 0
      ? '/v1/images/generations' : '/v1/images/edits'
    const body = verifiedInputs.length
      ? Object.freeze({ model: this.#config.modelId, prompt: command.instruction,
        images: verifiedInputs.map(input => Object.freeze({ image_url: input.dataUrl })), n: 1, output_format: 'png' })
      : Object.freeze({ model: this.#config.modelId, prompt: command.instruction, n: 1, output_format: 'png' })
    const digest = requestDigest({ command, profile: this.#profile, config: this.#config,
      inputs: verifiedInputs, path: requestPath, body })
    this.#ledger.createClaim({ commandId: command.commandId, requestDigest: digest,
      bindingId: this.#config.bindingId, bindingEpoch: this.#config.bindingEpoch, modelId: this.#config.modelId })

    const endpoint = new URL(requestPath, `${this.#config.endpoint}/`)
    let response
    try {
      response = await this.#fetch(endpoint, { method: 'POST', redirect: 'error', headers: {
        Authorization: `Bearer ${this.#credential}`, Accept: 'application/json', 'Content-Type': 'application/json'
      }, body: JSON.stringify(body) })
    } catch { fail('CONTROLLED_IMAGE_OUTCOME_UNKNOWN', 'controlled image Provider request outcome is unknown') }
    const bytes = await responsePng(response, endpoint)
    return Object.freeze({ outputId: 'output_1', contentType: 'image/png', bytes })
  }
}
