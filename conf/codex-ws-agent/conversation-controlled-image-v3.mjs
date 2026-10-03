/** Source-aware controlled-image v3 lane. It never parses or falls back to v1/v2 commands. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { buildOutputCommit } from './workspace-file-bridge.mjs'
import { NativeConversationError, validateNativeConversationOutput } from './conversation-native.mjs'
import { materializeControlledImageV3Inputs, parseControlledImageV3Inputs } from './conversation-reference-inputs-v3.mjs'
import { retainControlledImageDeliveryV3, retainedControlledImageDeliveriesV3, acknowledgeRetainedControlledImageDeliveryV3 } from './controlled-image-delivery-retention-v3.mjs'

const BASE = '/internal/agent/tasks'
const INBOX = `${BASE}/conversation-executions/controlled-image-v3-commands`
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const CONSENT = /^consent_[0-9a-f]{32}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const AUTH = /^AgentRuntime [0-9a-f]{32}$/
const PROVIDER_LANE = 'CONTROLLED_IMAGE_HTTP_V1'
const LONG_MAX = 9223372036854775807n
const PROVIDER_FIELDS = ['providerLane', 'consentId', 'bindingId', 'bindingEpoch', 'modelId', 'maxInputItems', 'maxOutboundRequestAttempts', 'precallFenceVersion'].sort().join(',')
const COMMAND_FIELDS = ['schemaVersion', 'executionId', 'taskId', 'runId', 'conversationId', 'commandId', 'messageId', 'operation', 'instruction', 'inputSnapshotDigest', 'outputContentMimeType', 'outputId', 'providerExecution'].sort().join(',')
const RECEIPT_FIELDS = ['schemaVersion', 'started', 'taskId', 'runId', 'conversationId', 'executionId', 'commandId', 'messageId', 'operation', 'inputSnapshotDigest', 'providerExecution', 'leaseVersion'].sort().join(',')
const SHA = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && ID.test(value)
const deny = code => { throw new NativeConversationError(code) }
const isFence = value => object(value) && Number.isSafeInteger(value.version) && value.version > 0 && TOKEN.test(value.token || '')
const isLease = value => object(value) && id(value.executionId) && isFence(value)
  && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now()
const canonicalEpoch = value => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false
  try { return BigInt(value) <= LONG_MAX } catch { return false }
}

const parseProviderExecution = value => {
  if (!object(value) || Object.keys(value).sort().join(',') !== PROVIDER_FIELDS
      || value.providerLane !== PROVIDER_LANE || !CONSENT.test(value.consentId || '')
      || typeof value.bindingId !== 'string' || !PROVIDER_ID.test(value.bindingId)
      || !canonicalEpoch(value.bindingEpoch) || typeof value.modelId !== 'string' || !PROVIDER_ID.test(value.modelId)
      || value.maxInputItems !== 16 || value.maxOutboundRequestAttempts !== 1 || value.precallFenceVersion !== 1) {
    deny('CONTROLLED_IMAGE_V3_COMMAND_INVALID')
  }
  return Object.freeze({ providerLane: value.providerLane, consentId: value.consentId, bindingId: value.bindingId,
    bindingEpoch: value.bindingEpoch, modelId: value.modelId, maxInputItems: value.maxInputItems,
    maxOutboundRequestAttempts: value.maxOutboundRequestAttempts, precallFenceVersion: value.precallFenceVersion })
}

export const parseControlledImageV3ConversationCommand = value => {
  if (!object(value) || Object.keys(value).sort().join(',') !== COMMAND_FIELDS || value.schemaVersion !== 3
      || !['executionId', 'taskId', 'runId', 'conversationId', 'commandId', 'messageId', 'outputId'].every(key => id(value[key]))
      || !['GENERATE_IMAGE', 'EDIT_IMAGE'].includes(value.operation)
      || typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 16000
      || !HASH.test(value.inputSnapshotDigest || '')
      || value.outputContentMimeType !== 'image/png' || value.outputId !== 'output_1') deny('CONTROLLED_IMAGE_V3_COMMAND_INVALID')
  return Object.freeze({ ...value, providerExecution: parseProviderExecution(value.providerExecution) })
}

const sameProviderExecution = (left, right) => left.providerLane === right.providerLane
  && left.consentId === right.consentId && left.bindingId === right.bindingId
  && left.bindingEpoch === right.bindingEpoch && left.modelId === right.modelId
  && left.maxInputItems === right.maxInputItems
  && left.maxOutboundRequestAttempts === right.maxOutboundRequestAttempts
  && left.precallFenceVersion === right.precallFenceVersion

const originOf = value => {
  let url
  try { url = new URL(value) } catch { deny('CONVERSATION_ORIGIN_INVALID') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:'
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) deny('CONVERSATION_ORIGIN_INVALID')
  return url.origin
}
const checkDirect = (reply, endpoint, status) => {
  if (reply?.status !== status || reply.redirected) deny('CONVERSATION_RESPONSE_UNAVAILABLE')
  let actual
  try { actual = new URL(reply.url) } catch { deny('CONVERSATION_RESPONSE_UNAVAILABLE') }
  if (actual.href !== endpoint.href) deny('CONVERSATION_RESPONSE_UNAVAILABLE')
  if (reply.headers?.get?.('content-type') && !/^application\/json(?:\s*;|$)/i.test(reply.headers.get('content-type')))
    deny('CONVERSATION_RESPONSE_UNAVAILABLE')
}

export class ControlledImageConversationLaneV3 {
  #recoveryAttempted = new Set(); #retainedExecutions = new Set()
  #origin; #root; #fetch; #agentId; #instanceId; #auth; #execute; #controlledConfig; #active = false
  constructor ({ apiOrigin, rootDir, fetchFn = globalThis.fetch, agentId, runtimeInstanceId, getAuth, execute = null, controlledConfig } = {}) {
    this.#origin = originOf(apiOrigin)
    if (!rootDir || !isAbsolute(rootDir) || typeof fetchFn !== 'function' || !id(agentId) || !id(runtimeInstanceId)
        || typeof getAuth !== 'function' || typeof execute !== 'function' || !controlledConfig?.enabled) deny('CONTROLLED_IMAGE_CONFIG_INVALID')
    this.#root = resolve(rootDir, 'conversation-runs', agentId)
    this.#fetch = fetchFn; this.#agentId = agentId; this.#instanceId = runtimeInstanceId; this.#auth = getAuth; this.#execute = execute
    this.#controlledConfig = Object.freeze({ providerLane: controlledConfig.providerLane, bindingId: controlledConfig.bindingId,
      bindingEpoch: controlledConfig.bindingEpoch, modelId: controlledConfig.modelId,
      maxInputItems: controlledConfig.maxInputItems, maxOutboundRequestAttempts: controlledConfig.maxOutboundRequestAttempts,
      precallFenceVersion: controlledConfig.precallFenceVersion })
  }
  #headers () {
    const auth = this.#auth()
    if (!AUTH.test(auth || '')) deny('CONVERSATION_AUTH_UNAVAILABLE')
    return { Authorization: auth, 'X-Agent-Id': this.#agentId, 'X-Agent-Runtime-Id': this.#instanceId }
  }
  async #request (path, method, data, status = 200) {
    const endpoint = new URL(path, `${this.#origin}/`)
    if (endpoint.origin !== this.#origin || endpoint.pathname !== path || endpoint.search || endpoint.hash) deny('CONVERSATION_ENDPOINT_INVALID')
    const headers = { ...this.#headers(), Accept: 'application/json' }
    if (data !== undefined && !(data instanceof FormData)) headers['Content-Type'] = 'application/json'
    let reply
    try { reply = await this.#fetch(endpoint, { method, redirect: 'error', headers,
      ...(data === undefined ? {} : { body: data instanceof FormData ? data : JSON.stringify(data) }) }) }
    catch { deny('CONVERSATION_OUTCOME_UNKNOWN') }
    checkDirect(reply, endpoint, status)
    try { return await reply.json() } catch { deny('CONVERSATION_RESPONSE_UNAVAILABLE') }
  }
  async #readInput (path, fence, input) {
    const endpoint = new URL(`${path}/inputs/${input.inputRef}/content`, `${this.#origin}/`)
    let reply
    try { reply = await this.#fetch(endpoint, { method: 'POST', redirect: 'error', headers: {
      ...this.#headers(), Accept: 'application/octet-stream', 'Content-Type': 'application/json'
    }, body: JSON.stringify(fence) }) } catch { deny('CONVERSATION_INPUT_READ_UNCERTAIN') }
    if (reply?.status !== 200 || reply.redirected || reply.url !== endpoint.href
        || reply.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream'
        || reply.headers?.get?.('content-length') !== input.byteLength) deny('CONVERSATION_INPUT_READ_UNCERTAIN')
    const chunks = []
    let length = 0n
    try {
      if (reply.body && typeof reply.body.getReader === 'function') {
        const reader = reply.body.getReader()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!(value instanceof Uint8Array)) deny('CONVERSATION_INPUT_READ_UNCERTAIN')
            length += BigInt(value.length)
            if (length > BigInt(input.byteLength)) deny('CONVERSATION_INPUT_READ_UNCERTAIN')
            chunks.push(Buffer.from(value))
          }
        } finally { reader.releaseLock() }
      } else {
        const bytes = Buffer.from(await reply.arrayBuffer())
        length = BigInt(bytes.length)
        if (length > BigInt(input.byteLength)) deny('CONVERSATION_INPUT_READ_UNCERTAIN')
        chunks.push(bytes)
      }
    } catch { deny('CONVERSATION_INPUT_READ_UNCERTAIN') }
    if (length !== BigInt(input.byteLength)) deny('CONVERSATION_INPUT_READ_UNCERTAIN')
    return Buffer.concat(chunks)
  }
  #matchesConfig (providerExecution) {
    return providerExecution.providerLane === this.#controlledConfig.providerLane
      && providerExecution.bindingId === this.#controlledConfig.bindingId
      && providerExecution.bindingEpoch === this.#controlledConfig.bindingEpoch
      && providerExecution.modelId === this.#controlledConfig.modelId
      && providerExecution.maxInputItems === this.#controlledConfig.maxInputItems
      && providerExecution.maxOutboundRequestAttempts === this.#controlledConfig.maxOutboundRequestAttempts
      && providerExecution.precallFenceVersion === this.#controlledConfig.precallFenceVersion
  }
  #parseStartReceipt (receipt, command, lease) {
    if (!object(receipt) || Object.keys(receipt).sort().join(',') !== RECEIPT_FIELDS || receipt.schemaVersion !== 3
        || receipt.started !== true || receipt.taskId !== command.taskId || receipt.runId !== command.runId
        || receipt.conversationId !== command.conversationId || receipt.executionId !== command.executionId
        || receipt.executionId !== lease.executionId || receipt.commandId !== command.commandId
        || receipt.messageId !== command.messageId || receipt.operation !== command.operation
        || receipt.inputSnapshotDigest !== command.inputSnapshotDigest
        || !Number.isSafeInteger(receipt.leaseVersion) || receipt.leaseVersion !== lease.version) {
      deny('CONVERSATION_PROVIDER_START_UNCERTAIN')
    }
    let providerExecution
    try { providerExecution = parseProviderExecution(receipt.providerExecution) } catch { deny('CONVERSATION_PROVIDER_START_UNCERTAIN') }
    if (!sameProviderExecution(providerExecution, command.providerExecution) || !this.#matchesConfig(providerExecution))
      deny('CONVERSATION_PROVIDER_START_UNCERTAIN')
  }
  async #recoverStagedResults () {
    let recovered = 0
    const retained = retainedControlledImageDeliveriesV3({ rootDirectory: this.#root,
      apiOrigin: this.#origin, agentId: this.#agentId })
    for (const item of retained) {
      const command = parseControlledImageV3ConversationCommand(item.record.command)
      this.#retainedExecutions.add(command.executionId) // Retained paid outputs never return to START.
      const key = `${item.runDirectory}\n${item.receiptSha256}`
      if (item.acknowledged || this.#recoveryAttempted.has(key)) continue
      const proof = item.record.output
      const { manifestId } = buildOutputCommit({ taskId: command.taskId, runId: command.runId,
        uploads: [{ outputId: proof.outputId, sha256: proof.sha256, length: proof.byteLength }] })
      // One reconciliation attempt per immutable record/process. An uncertain/error reply retains
      // bytes and requires attributable remediation, not repeated blind HTTP or a Provider retry.
      this.#recoveryAttempted.add(key)
      const committed = await this.#request(`${BASE}/${command.taskId}/runs/${command.runId}/conversation/result-commits/${manifestId}`,
        'POST', { schemaVersion: 1, executionId: command.executionId, commandId: command.commandId,
          messageId: command.messageId, inputSnapshotDigest: command.inputSnapshotDigest,
          outputs: [{ outputId: proof.outputId, sha256: proof.sha256, length: proof.byteLength }] })
      if (!object(committed) || committed.state !== 'COMMITTED' || committed.manifestId !== manifestId
          || !Array.isArray(committed.items) || committed.items.length !== 1
          || committed.items[0].outputId !== proof.outputId || committed.items[0].sha256 !== proof.sha256
          || committed.items[0].byteLength !== proof.byteLength || committed.items[0].contentMimeType !== proof.contentType) {
        deny('CONVERSATION_COMMIT_UNCERTAIN')
      }
      acknowledgeRetainedControlledImageDeliveryV3({ retained: item, manifestId,
        apiOrigin: this.#origin, agentId: this.#agentId })
      recovered++
    }
    return recovered
  }
  async poll () {
    if (this.#active) return { processed: 0, busy: true }
    this.#active = true
    try {
      const recovered = await this.#recoverStagedResults()
      const envelope = await this.#request(INBOX, 'GET')
      if (!object(envelope) || Object.keys(envelope).join() !== 'items' || !Array.isArray(envelope.items)
          || envelope.items.length > 16) deny('CONVERSATION_INBOX_INVALID')
      let processed = 0
      for (const raw of envelope.items) {
        const command = parseControlledImageV3ConversationCommand(raw)
        if (this.#retainedExecutions.has(command.executionId)) continue
        await this.#process(command); processed++
      }
      return recovered ? { processed, recovered } : { processed }
    } finally { this.#active = false }
  }
  async #process (command) {
    if (!this.#matchesConfig(command.providerExecution)) deny('CONTROLLED_IMAGE_CONFIG_MISMATCH')
    const path = `${BASE}/${command.taskId}/runs/${command.runId}/conversation`
    const lease = await this.#request(`${path}/lease`, 'POST', { commandId: command.commandId, messageId: command.messageId })
    if (!isLease(lease) || lease.executionId !== command.executionId) deny('CONVERSATION_LEASE_UNCERTAIN')
    const fence = { version: lease.version, token: lease.token }
    let timer; let running = true; let renewalError; let currentExpiry = lease.expiresAt
    const renew = async () => {
      try {
        const next = await this.#request(`${path}/lease/renew`, 'POST', fence)
        if (!isLease(next) || next.executionId !== command.executionId
            || next.version !== fence.version || next.token !== fence.token) deny('CONVERSATION_LEASE_UNCERTAIN')
        currentExpiry = next.expiresAt
        if (running) timer = setTimeout(() => { void renew() }, Math.max(1, Math.floor((next.expiresAt - Date.now()) / 2)))
      } catch (error) { renewalError = error }
    }
    let runDirectory; let outputProduced = false; let commitConfirmed = false
    try {
      const snapshot = await this.#request(`${path}/inputs-v3`, 'POST', fence)
      const parsed = parseControlledImageV3Inputs(snapshot, command, fence.version)
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      mkdirSync(this.#root, { recursive: true, mode: 0o700 })
      if (realpathSync(this.#root) !== this.#root) deny('CONVERSATION_RUN_ROOT_UNSAFE')
      runDirectory = mkdtempSync(resolve(this.#root, `${command.runId}-${randomUUID()}-`))
      for (const part of ['inputs', 'outputs', 'scratch']) mkdirSync(resolve(runDirectory, part), { mode: 0o700 })
      timer = setTimeout(() => { void renew() }, Math.max(1, Math.floor((lease.expiresAt - Date.now()) / 2)))
      const inputs = await materializeControlledImageV3Inputs({ inputs: parsed.inputs, runDirectory,
        readInput: input => this.#readInput(path, fence, input) })
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      let receipt
      try {
        receipt = await this.#request(`${path}/provider-start-controlled-image-v3`, 'POST', {
          schemaVersion: 3, commandId: command.commandId, messageId: command.messageId,
          executionId: command.executionId, operation: command.operation,
          inputSnapshotDigest: command.inputSnapshotDigest, providerExecution: command.providerExecution, fence
        })
      } catch { deny('CONVERSATION_PROVIDER_START_UNCERTAIN') }
      this.#parseStartReceipt(receipt, command, lease)
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      const output = await this.#execute(Object.freeze({ command, runDirectory, inputs }))
      if (!object(output) || output.outputId !== 'output_1' || output.contentType !== 'image/png'
          || !validateNativeConversationOutput('image/png', output.bytes)) deny('CONVERSATION_OUTPUT_INVALID')
      // The paid result must survive an expired lease, failed upload or lost commit ACK.
      // Persist before checking the lease again; retained bytes never permit Provider replay.
      outputProduced = true
      retainControlledImageDeliveryV3({ runDirectory, command, output,
        apiOrigin: this.#origin, agentId: this.#agentId })
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      const outputSha = SHA(output.bytes)
      const form = new FormData()
      form.set('file', new Blob([output.bytes], { type: output.contentType }), 'output.png')
      for (const [key, value] of Object.entries({ version: String(fence.version), token: fence.token,
        sha256: outputSha, length: String(output.bytes.length) })) form.set(key, value)
      const staged = await this.#request(`${path}/outputs/output_1/content`, 'POST', form, 201)
      if (!object(staged) || staged.outputId !== 'output_1' || staged.sha256 !== outputSha
          || staged.byteLength !== output.bytes.length || staged.state !== 'STAGED') deny('CONVERSATION_STAGE_UNCERTAIN')
      // Reuse the API task/run/output/hash/length manifest; keep conversation fencing.
      const { manifestId } = buildOutputCommit({ taskId: command.taskId, runId: command.runId,
        uploads: [{ outputId: 'output_1', sha256: outputSha, length: output.bytes.length }] })
      const committed = await this.#request(`${path}/output-commits/${manifestId}`, 'POST', {
        fence, outputs: [{ outputId: 'output_1', sha256: outputSha, length: output.bytes.length }]
      })
      if (!object(committed) || committed.state !== 'COMMITTED' || committed.manifestId !== manifestId
          || !Array.isArray(committed.items) || committed.items.length !== 1
          || committed.items[0].outputId !== 'output_1' || committed.items[0].sha256 !== outputSha) {
        deny('CONVERSATION_COMMIT_UNCERTAIN')
      }
      commitConfirmed = true
      return { committed: true }
    } catch (error) {
      // Do not mark a produced image failed just because result transport failed.
      // Preserve the exact run and propagate uncertainty; there is no automatic retry.
      if (outputProduced) throw error
      const code = typeof error?.code === 'string'
        && (error.code.startsWith('CONVERSATION_') || error.code.startsWith('CONTROLLED_IMAGE_'))
        ? error.code : 'CONVERSATION_EXECUTION_FAILED'
      if (code.includes('UNCERTAIN') || code === 'CONVERSATION_OUTCOME_UNKNOWN'
          || code === 'CONTROLLED_IMAGE_OUTCOME_UNKNOWN' || code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED'
          || code === 'CONTROLLED_IMAGE_CLAIM_CORRUPT' || code === 'CONTROLLED_IMAGE_CLAIM_IO_FAILED' || renewalError) throw error
      const failed = await this.#request(`${path}/failure`, 'POST', { fence, code })
      if (!object(failed) || failed.state !== 'FAILED' || failed.executionId !== lease.executionId)
        deny('CONVERSATION_FAILURE_UNCERTAIN')
      return { failed: true, code }
    } finally {
      running = false; clearTimeout(timer)
      if (runDirectory && (!outputProduced || commitConfirmed)) rmSync(runDirectory, { recursive: true, force: false })
    }
  }
}
