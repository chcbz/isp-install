import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { CONTROLLED_IMAGE_MAX_INPUT_ITEMS } from './controlled-image-http-config.mjs'
import { CONTROLLED_IMAGE_GPT_CLI_ADAPTER } from './controlled-image-gpt-cli-config.mjs'
import { ControlledImageGptCliEgressGate } from './controlled-image-gpt-cli-egress-gate.mjs'
import {
  canonicalControlledImageRunDirectory,
  readVerifiedControlledImageV3Input,
  readVerifiedControlledImageV3PngOutput
} from './controlled-image-v3-files.mjs'
import { canonicalContextJsonV1, controlledImageV3OperationSourcesValid } from './conversation-reference-inputs-v3.mjs'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const SHA256 = /^[a-f0-9]{64}$/

export class ControlledImageGptCliV3Error extends Error {
  constructor (code, message) { super(message); this.name = 'ControlledImageGptCliV3Error'; this.code = code }
}
const fail = (code, message) => { throw new ControlledImageGptCliV3Error(code, message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

const runChild = (command, args, options, spawnFn = spawn) => new Promise((resolveRun, reject) => {
  let child
  try { child = spawnFn(command, args, { ...options, shell: false, stdio: ['ignore', 'ignore', 'ignore'] }) } catch (error) { reject(error); return }
  child.once('error', reject)
  child.once('exit', (code, signal) => resolveRun({ code, signal }))
})

const writePrivateText = (path, value) => {
  const noFollow = fsConstants.O_NOFOLLOW || 0
  const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600)
  try {
    writeFileSync(descriptor, value, { encoding: 'utf8' })
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  const directory = openSync(dirname(path), fsConstants.O_RDONLY | noFollow)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

const childEnvironment = ({ home, baseUrl = '', token = '' } = {}) => Object.freeze({
  HOME: home,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: '',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
  ...(token ? { OPENAI_API_KEY: token } : {})
})

const requestDigest = ({ command, profile, providerConfig, cliConfig, inputs, cliCommand, cliArgs }) => hash(Buffer.from(canonicalContextJsonV1({
  schemaVersion: 1,
  adapterKind: CONTROLLED_IMAGE_GPT_CLI_ADAPTER,
  profileScope: profile.profileId,
  agentId: profile.agentId,
  commandId: command.commandId,
  executionId: command.executionId,
  taskId: command.taskId,
  runId: command.runId,
  operation: command.operation,
  inputSnapshotDigest: command.inputSnapshotDigest,
  bindingId: providerConfig.bindingId,
  bindingEpoch: providerConfig.bindingEpoch,
  modelId: providerConfig.modelId,
  endpoint: providerConfig.endpoint,
  pythonSha256: cliConfig.pythonSha256,
  runnerSha256: cliConfig.runnerSha256,
  imageGenSha256: cliConfig.imageGenSha256,
  verifierSha256: cliConfig.verifierSha256,
  cliCommand,
  cliArgs,
  instruction: command.instruction,
  inputs: inputs.map(input => ({ inputRef: input.inputRef, source: input.source, contentType: input.contentType,
    sha256: input.sha256, byteLength: input.byteLength }))
}), 'utf8'))

const validateReceipt = ({ receiptPath, output, modelId }) => {
  let receipt
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) } catch { fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'image CLI verifier receipt is invalid') }
  const keys = Object.keys(receipt || {}).sort().join(',')
  if (keys !== ['check', 'checked_at', 'generation_provenance_verified', 'images', 'model_identity_verified',
    'requested_model', 'status', 'visual_review'].sort().join(',')
      || receipt.check !== 'local-image-decode' || receipt.status !== 'passed'
      || receipt.requested_model !== modelId || receipt.model_identity_verified !== false
      || receipt.generation_provenance_verified !== false || receipt.visual_review !== 'not_performed'
      || typeof receipt.checked_at !== 'string' || !receipt.checked_at
      || !Array.isArray(receipt.images) || receipt.images.length !== 1) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'image CLI verifier receipt does not match the controlled execution')
  }
  const image = receipt.images[0]
  if (!object(image) || image.path !== output.path || image.format !== 'PNG' || image.sha256 !== output.sha256
      || !Number.isSafeInteger(image.width) || image.width < 1 || !Number.isSafeInteger(image.height) || image.height < 1
      || typeof image.mode !== 'string' || !image.mode || typeof image.has_alpha !== 'boolean') {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'image CLI verifier receipt does not match the output bytes')
  }
}

export class ControlledImageGptCliExecutorV3 {
  #profile; #providerConfig; #cliConfig; #credential; #ledger; #providerFetch; #spawn; #createGate

  constructor ({ profile, providerConfig, cliConfig, credential, ledger, providerFetchFn = globalThis.fetch,
    spawnFn = spawn, createGate = options => new ControlledImageGptCliEgressGate(options) } = {}) {
    if (!profile || !SAFE_ID.test(profile.profileId || '') || !SAFE_ID.test(profile.agentId || '')
        || providerConfig?.enabled !== true || cliConfig?.enabled !== true
        || cliConfig.adapterKind !== CONTROLLED_IMAGE_GPT_CLI_ADAPTER
        || typeof credential !== 'string' || !credential || typeof ledger?.createClaim !== 'function'
        || typeof providerFetchFn !== 'function' || typeof spawnFn !== 'function' || typeof createGate !== 'function') {
      fail('CONTROLLED_IMAGE_CONFIG_INVALID', 'controlled image GPT CLI executor configuration is incomplete')
    }
    this.#profile = Object.freeze({ profileId: profile.profileId, agentId: profile.agentId })
    this.#providerConfig = providerConfig
    this.#cliConfig = cliConfig
    this.#credential = credential
    this.#ledger = ledger
    this.#providerFetch = providerFetchFn
    this.#spawn = spawnFn
    this.#createGate = createGate
  }

  async execute ({ command, runDirectory, inputs } = {}) {
    if (!object(command) || command.schemaVersion !== 3 || !SAFE_ID.test(command.commandId || '')
        || !SAFE_ID.test(command.executionId || '') || !SAFE_ID.test(command.taskId || '') || !SAFE_ID.test(command.runId || '')
        || !SAFE_ID.test(command.conversationId || '') || !['GENERATE_IMAGE', 'EDIT_IMAGE'].includes(command.operation)
        || !SHA256.test(command.inputSnapshotDigest || '') || typeof command.instruction !== 'string' || !command.instruction.trim()
        || command.outputId !== 'output_1' || command.outputContentMimeType !== 'image/png'
        || typeof runDirectory !== 'string' || !isAbsolute(runDirectory) || !Array.isArray(inputs)
        || inputs.length > CONTROLLED_IMAGE_MAX_INPUT_ITEMS || inputs.length > this.#providerConfig.maxInputItems
        || !controlledImageV3OperationSourcesValid(command.operation, inputs, command.conversationId)) {
      fail('CONTROLLED_IMAGE_COMMAND_INVALID', 'controlled image v3 operation and sources are not canonical')
    }
    const canonicalRun = canonicalControlledImageRunDirectory(runDirectory)
    const verifiedInputs = inputs.map((input, index) => readVerifiedControlledImageV3Input(canonicalRun, input, index))
    const outputPath = resolve(canonicalRun, 'outputs/output_1.png')
    const promptPath = resolve(canonicalRun, 'scratch/prompt.txt')
    const receiptPath = resolve(canonicalRun, 'scratch/output_1-validation.json')
    if (existsSync(outputPath) || existsSync(promptPath) || existsSync(receiptPath)) {
      fail('CONTROLLED_IMAGE_OUTPUT_EXISTS', 'controlled image CLI local output or evidence path already exists')
    }
    writePrivateText(promptPath, command.instruction)

    const cliCommand = verifiedInputs.length === 0 ? 'generate' : 'edit'
    const cliArgs = [cliCommand, '--model', this.#providerConfig.modelId, '--prompt-file', 'scratch/prompt.txt',
      '--size', 'auto', '--quality', 'medium', '--output-format', 'png', '--n', '1', '--no-augment']
    for (const input of verifiedInputs) cliArgs.push('--image', input.relativePath)
    cliArgs.push('--out', 'outputs/output_1.png')
    const providerPath = cliCommand === 'generate' ? '/v1/images/generations' : '/v1/images/edits'
    const digest = requestDigest({ command, profile: this.#profile, providerConfig: this.#providerConfig,
      cliConfig: this.#cliConfig, inputs: verifiedInputs, cliCommand, cliArgs })
    const gate = this.#createGate({ endpoint: this.#providerConfig.endpoint, credential: this.#credential,
      expected: { path: providerPath, modelId: this.#providerConfig.modelId, prompt: command.instruction,
        inputs: verifiedInputs.map(input => ({ sha256: input.sha256, byteLength: input.byteLength })) },
      fetchFn: this.#providerFetch })
    let gateAccess
    try { gateAccess = await gate.start() } catch { fail('CONTROLLED_IMAGE_EXECUTION_FAILED', 'controlled image CLI egress gate could not start') }
    try {
      this.#ledger.createClaim({ commandId: command.commandId, requestDigest: digest,
        bindingId: this.#providerConfig.bindingId, bindingEpoch: this.#providerConfig.bindingEpoch,
        modelId: this.#providerConfig.modelId })
      const runArgs = [this.#cliConfig.runner, '--codex-dir', this.#cliConfig.codexDir, '--', ...cliArgs]
      let execution
      try {
        execution = await runChild(this.#cliConfig.python, runArgs,
          { cwd: canonicalRun, env: childEnvironment({ home: resolve(canonicalRun, 'scratch'), ...gateAccess }) }, this.#spawn)
      } catch { fail('CONTROLLED_IMAGE_EXECUTION_FAILED', 'controlled image CLI process could not start') }
      if (execution.code !== 0 || execution.signal) {
        fail(gate.providerAttempts > 0 ? 'CONTROLLED_IMAGE_OUTCOME_UNKNOWN' : 'CONTROLLED_IMAGE_EXECUTION_FAILED',
          'controlled image CLI did not complete successfully')
      }
      const output = readVerifiedControlledImageV3PngOutput(canonicalRun)
      let verification
      try {
        verification = await runChild(this.#cliConfig.python, [this.#cliConfig.verifier, output.path,
          '--requested-model', this.#providerConfig.modelId, '--receipt', receiptPath],
        { cwd: canonicalRun, env: childEnvironment({ home: resolve(canonicalRun, 'scratch') }) }, this.#spawn)
      } catch { fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image CLI verifier could not start') }
      if (verification.code !== 0 || verification.signal) fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image CLI verifier rejected the output')
      validateReceipt({ receiptPath, output, modelId: this.#providerConfig.modelId })
      return Object.freeze({ outputId: 'output_1', contentType: 'image/png', bytes: output.bytes })
    } finally { await gate.close() }
  }
}
