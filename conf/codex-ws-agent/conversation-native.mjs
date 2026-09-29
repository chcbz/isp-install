/**
 * Native CONVERSATION lane, API d713abd4. Never share CHAT/command dispatch or the
 * unfenced workspace file bridge. API owns root -> grant -> execution transactions.
 * Only scoped inbox -> lease -> renew -> fenced stage/commit/fail are permitted.
 * A fenced input snapshot is required; reference materials still have no approved resolver.
 * Without a separately supplied, local, no-charge verified executor we fail closed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const BASE = '/internal/agent/tasks'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const TOKEN = /^[0-9a-fA-F-]{36}$/
const AUTH = /^AgentRuntime [0-9a-f]{32}$/
const MIME = new Set(['image/png', 'image/jpeg'])
const SHA = bytes => createHash('sha256').update(bytes).digest('hex')
export class NativeConversationError extends Error {
  constructor(code) { super(code); this.code = code }
}
const deny = code => { throw new NativeConversationError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && ID.test(value)
const isFence = value => object(value) && Number.isSafeInteger(value.version) && value.version > 0 && TOKEN.test(value.token || '')
const isLease = value => object(value) && id(value.executionId) && isFence(value)
  && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now()
export const parseNativeConversationCommand = value => {
  if (!object(value) || Object.keys(value).sort().join() !==
    ['commandId', 'conversationId', 'instruction', 'messageId', 'outputContentMimeType', 'outputId', 'runId', 'schemaVersion', 'taskId'].sort().join()
    || value.schemaVersion !== 1 || !['taskId', 'runId', 'conversationId', 'commandId', 'messageId', 'outputId'].every(k => id(value[k]))
    || typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 16000
    || !MIME.has(value.outputContentMimeType) || value.outputId !== 'output_1') deny('CONVERSATION_COMMAND_INVALID')
  return Object.freeze({ ...value })
}
const originOf = value => {
  let url
  try { url = new URL(value) } catch { deny('CONVERSATION_ORIGIN_INVALID') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) deny('CONVERSATION_ORIGIN_INVALID')
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
export class NativeConversationLane {
  #origin; #root; #fetch; #agentId; #instanceId; #auth; #run; #execute; #active = false
  constructor({ apiOrigin, rootDir, fetchFn = globalThis.fetch, agentId, runtimeInstanceId,
    getAuth, execute = null }) {
    this.#origin = originOf(apiOrigin)
    if (!rootDir || !isAbsolute(rootDir) || typeof fetchFn !== 'function' ||
        !id(agentId) || !id(runtimeInstanceId) || typeof getAuth !== 'function') deny('CONVERSATION_CONFIG_INVALID')
    this.#root = resolve(rootDir, 'conversation-runs', agentId)
    this.#fetch = fetchFn; this.#agentId = agentId; this.#instanceId = runtimeInstanceId
    this.#auth = getAuth; this.#execute = execute
  }
  #headers() {
    const auth = this.#auth()
    if (!AUTH.test(auth || '')) deny('CONVERSATION_AUTH_UNAVAILABLE')
    return { Authorization: auth, 'X-Agent-Id': this.#agentId, 'X-Agent-Runtime-Id': this.#instanceId }
  }
  async #request(path, method, data, status = 200) {
    const endpoint = new URL(path, `${this.#origin}/`)
    if (endpoint.origin !== this.#origin || endpoint.pathname !== path || endpoint.search || endpoint.hash)
      deny('CONVERSATION_ENDPOINT_INVALID')
    const headers = { ...this.#headers(), Accept: 'application/json' }
    if (data !== undefined && !(data instanceof FormData)) headers['Content-Type'] = 'application/json'
    let reply
    try { reply = await this.#fetch(endpoint, {
      method, redirect: 'error', headers,
      ...(data === undefined ? {} : { body: data instanceof FormData ? data : JSON.stringify(data) })
    }) } catch { deny('CONVERSATION_OUTCOME_UNKNOWN') }
    checkDirect(reply, endpoint, status)
    try { return await reply.json() } catch { deny('CONVERSATION_RESPONSE_UNAVAILABLE') }
  }
  async poll() {
    if (this.#active) return { processed: 0, busy: true }
    this.#active = true
    try {
      const envelope = await this.#request(`${BASE}/conversation-executions/commands`, 'GET')
      if (!object(envelope) || Object.keys(envelope).join() !== 'items' || !Array.isArray(envelope.items)
          || envelope.items.length > 16) deny('CONVERSATION_INBOX_INVALID')
      let processed = 0
      for (const raw of envelope.items) {
        const command = parseNativeConversationCommand(raw)
        await this.#process(command)
        processed++
      }
      return { processed }
    } finally { this.#active = false }
  }
  async #process(command) {
    const path = `${BASE}/${command.taskId}/runs/${command.runId}/conversation`
    // Claim is the only trusted execution admission; never infer authority from a chat message.
    const lease = await this.#request(`${path}/lease`, 'POST', {
      commandId: command.commandId, messageId: command.messageId
    })
    if (!isLease(lease)) deny('CONVERSATION_LEASE_UNCERTAIN')
    const fence = { version: lease.version, token: lease.token }
    let timer; let running = true; let renewalError; let currentExpiry = lease.expiresAt
    const renew = async () => {
      try {
        const next = await this.#request(`${path}/lease/renew`, 'POST', fence)
        if (!isLease(next) || next.executionId !== lease.executionId || next.version !== fence.version || next.token !== fence.token)
          deny('CONVERSATION_LEASE_UNCERTAIN')
        currentExpiry = next.expiresAt
        if (running) timer = setTimeout(() => { void renew() }, Math.max(1, Math.floor((next.expiresAt - Date.now()) / 2)))
      } catch (error) { renewalError = error }
    }
    let runDirectory
    try {
      // A claimed lease alone does not attest that the execution has no materials.
      // Refuse unknown, mismatched or reference-bearing manifests; never fall back to
      // the legacy unfenced /inputs endpoint or infer absence from the queue payload.
      const inputSnapshot = await this.#request(`${path}/inputs`, 'POST', fence)
      if (!object(inputSnapshot) || Object.keys(inputSnapshot).sort().join() !==
          ['executionId', 'inputs', 'leaseVersion', 'noReferencedMaterials'].sort().join() ||
          inputSnapshot.executionId !== lease.executionId || inputSnapshot.leaseVersion !== fence.version ||
          inputSnapshot.noReferencedMaterials !== true || !Array.isArray(inputSnapshot.inputs) ||
          inputSnapshot.inputs.length !== 0) deny('CONVERSATION_INPUTS_UNAVAILABLE')
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      // Separate run tree; never use CHAT workdir or existing file-command roots.
      mkdirSync(this.#root, { recursive: true, mode: 0o700 })
      if (realpathSync(this.#root) !== this.#root) deny('CONVERSATION_RUN_ROOT_UNSAFE')
      runDirectory = mkdtempSync(resolve(this.#root, `${command.runId}-${randomUUID()}-`))
      for (const part of ['inputs', 'outputs', 'scratch']) mkdirSync(resolve(runDirectory, part), { mode: 0o700 })
      timer = setTimeout(() => { void renew() }, Math.max(1, Math.floor((lease.expiresAt - Date.now()) / 2)))
      // Reference manifests and paid execution are still unsupported. The production
      // runtime deliberately has NO executor: no model call, fake image or unknown-cost billing.
      if (typeof this.#execute !== 'function') deny('CONVERSATION_EXECUTOR_NOT_AUTHORIZED')
      // A paid Provider call is forbidden until the durable, single-use admission is
      // acknowledged by the API. An ambiguous ACK can mean it committed: never retry.
      let providerReceipt
      try { providerReceipt = await this.#request(`${path}/provider-start`, 'POST', fence) }
      catch { deny('CONVERSATION_PROVIDER_START_UNCERTAIN') }
      if (!object(providerReceipt) || Object.keys(providerReceipt).join() !== 'started'
          || providerReceipt.started !== true) deny('CONVERSATION_PROVIDER_START_UNCERTAIN')
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      const output = await this.#execute(Object.freeze({ command, runDirectory, inputs: Object.freeze([]) }))
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      if (!object(output) || output.outputId !== command.outputId || output.contentType !== command.outputContentMimeType
          || !Buffer.isBuffer(output.bytes) || output.bytes.length < 16 || output.bytes.length > 16 * 1024 * 1024
          || !(command.outputContentMimeType === 'image/png'
            ? output.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : output.bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))) deny('CONVERSATION_OUTPUT_INVALID')
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      const sha256 = SHA(output.bytes)
      const form = new FormData()
      form.set('file', new Blob([output.bytes], { type: output.contentType }),
        output.contentType === 'image/png' ? 'output.png' : 'output.jpg')
      for (const [k, v] of Object.entries({ version: String(fence.version), token: fence.token,
        sha256, length: String(output.bytes.length) })) form.set(k, v)
      const staged = await this.#request(`${path}/outputs/${command.outputId}/content`, 'POST', form, 201)
      if (!object(staged) || staged.outputId !== command.outputId || staged.sha256 !== sha256
          || staged.byteLength !== output.bytes.length || staged.state !== 'STAGED') deny('CONVERSATION_STAGE_UNCERTAIN')
      const manifestId = `native_${SHA(Buffer.from(`${lease.executionId}\n${command.outputId}\n${sha256}`)).slice(0, 40)}`
      if (renewalError || Date.now() >= currentExpiry) deny('CONVERSATION_LEASE_UNCERTAIN')
      const committed = await this.#request(`${path}/output-commits/${manifestId}`, 'POST', {
        fence, outputs: [{ outputId: command.outputId, sha256, length: output.bytes.length }]
      })
      if (!object(committed) || committed.state !== 'COMMITTED' || committed.manifestId !== manifestId
          || !Array.isArray(committed.items) || committed.items.length !== 1
          || committed.items[0].outputId !== command.outputId || committed.items[0].sha256 !== sha256)
        deny('CONVERSATION_COMMIT_UNCERTAIN')
      return { committed: true }
    } catch (error) {
      const code = error instanceof NativeConversationError ? error.code : 'CONVERSATION_EXECUTION_FAILED'
      // Never turn an ambiguous write/lease expiry into a success or a misleading terminal fail.
      if (code.includes('UNCERTAIN') || code === 'CONVERSATION_OUTCOME_UNKNOWN' || renewalError) throw error
      const failed = await this.#request(`${path}/failure`, 'POST', { fence, code })
      if (!object(failed) || failed.state !== 'FAILED' || failed.executionId !== lease.executionId)
        deny('CONVERSATION_FAILURE_UNCERTAIN')
      return { failed: true, code }
    } finally {
      running = false; clearTimeout(timer)
      if (runDirectory) rmSync(runDirectory, { recursive: true, force: false })
    }
  }
}
