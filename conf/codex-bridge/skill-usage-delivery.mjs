import { pendingProviderUsage } from './provider-usage-receipts.mjs'
import { pendingNativeUsage, acknowledgeNativeUsage } from './native-usage-receipts.mjs'
import { readNativeJson } from './native-json.mjs'
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseSkillCommand, skillDigest, skillId } from './skill-executor.mjs'
import { SkillExecutionStore } from './skill-execution-store.mjs'
import { nativeSessionHeaders } from './conversation-native.mjs'
const BASE = '/internal/agent/tasks'
const fail = (code, cause = null) => { throw Object.assign(new Error(code), { code, ...(cause ? { cause } : {}) }) }
const originOf = value => {
  let url; try { url = new URL(value) } catch { fail('SKILL_API_ORIGIN_INVALID') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('SKILL_API_ORIGIN_INVALID')
  return url.origin
}
/** Source-only delivery shared by the live conversation lane and stopped handover.
 * Has no registry, runner, model, command polling, lease acquisition or result commit.
 * pendingCommands exposes saved unfinished work to the live subclass only. */
export class SkillUsageDelivery {
  constructor({ apiOrigin, rootDir, agentId, runtimeInstanceId, scope, getRuntimeHeaders, fetchFn = globalThis.fetch, now = Date.now, random = Math.random }) {
    this.origin = originOf(apiOrigin)
    if (!isAbsolute(rootDir || '') || !skillId(agentId) || !skillId(runtimeInstanceId) || typeof getRuntimeHeaders !== 'function'
        || typeof fetchFn !== 'function' || !scope || scope.agentId !== agentId) fail('SKILL_LANE_CONFIG_INVALID')
    this.root = resolve(rootDir, 'skill-runs'); this.agentId = agentId; this.instanceId = runtimeInstanceId
    this.scope = scope; this.auth = getRuntimeHeaders; this.fetch = fetchFn; this.now = now; this.random = random
    // Discovery index only: original commands, observations and receipts stay authoritative.
    this.pendingExecutionIds = null
    this.pendingUsage = []; this.usageRetries = new Map()
  }
  headers() { return nativeSessionHeaders(this.auth(), this.agentId, this.instanceId) }
  async request(path, method, body, statuses = [200]) {
    const endpoint = new URL(path, `${this.origin}/`)
    if (endpoint.origin !== this.origin || endpoint.pathname !== path || endpoint.search || endpoint.hash) fail('SKILL_API_PATH_INVALID')
    const proof = this.headers(), headers = { ...proof, Accept: 'application/json' }
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
    let response
    try { response = await this.fetch(endpoint, { method, redirect: 'error', headers,
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) }) }
    catch (cause) { fail('SKILL_TRANSPORT_UNKNOWN', cause) }
    if (JSON.stringify(proof) !== JSON.stringify(this.headers())) {
      try { await response?.body?.cancel?.() } catch {}
      fail('SKILL_SESSION_CHANGED')
    }
    if (!response || !statuses.includes(response.status) || response.redirected === true || response.url !== endpoint.href) {
      try { await response?.body?.cancel?.() } catch {}
      throw Object.assign(new Error('SKILL_API_RESPONSE_UNCONFIRMED'), { code: 'SKILL_API_RESPONSE_UNCONFIRMED', status: response?.status })
    }
    if (response.headers?.get?.('content-type') && !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type'))) {
      try { await response?.body?.cancel?.() } catch {}
      fail('SKILL_API_RESPONSE_UNCONFIRMED')
    }
    try { return await readNativeJson(response) } catch (cause) { fail('SKILL_API_RESPONSE_UNCONFIRMED', cause) }
  }
  resetPendingDiscovery() { this.pendingExecutionIds = null }

  pendingCommands() {
    this.pendingCommandErrors = []
    this.pendingUsage = []; this.pendingUsageErrors = []
    const subject = resolve(this.root, skillDigest({ ...this.scope, apiOrigin: this.origin }))
    if (!existsSync(subject)) {
      if (this.pendingExecutionIds?.size) fail('SKILL_STORE_UNSAFE')
      this.pendingExecutionIds = new Set()
      return []
    }
    if (realpathSync(subject) !== subject || !lstatSync(subject).isDirectory()) fail('SKILL_STORE_UNSAFE')
    const pending = [], unresolved = new Set()
    for (const id of this.pendingExecutionIds ?? readdirSync(subject)) {
      if (!skillId(id)) fail('SKILL_STORE_UNSAFE')
      const directory = resolve(subject, id)
      if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) fail('SKILL_STORE_UNSAFE')
      const fd = openSync(resolve(directory, 'command.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      let command
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid() || (stat.mode & 0o077)) fail('SKILL_STORE_UNSAFE')
        try { command = parseSkillCommand(readFileSync(fd)) } catch (error) {
          // Historical commands without a current authority binding are not executable.
          // Preserve them and report their failure, but do not starve unrelated current work.
          if (error?.code !== 'SKILL_COMMAND_INVALID') throw error
          this.pendingCommandErrors.push({ executionId: id, error })
          continue
        }
      } finally { closeSync(fd) }
      if (command.executionId !== id) fail('SKILL_STORE_IDENTITY_CONFLICT')
      const store = new SkillExecutionStore({ rootDirectory: this.root, scope: { ...this.scope, apiOrigin: this.origin }, command })
      try {
        const usage = pendingNativeUsage(store)
        for (const item of [...(usage ? [usage] : []), ...pendingProviderUsage(store)]) { this.pendingUsage.push({ command, store, ...item }); unresolved.add(id) }
      } catch (error) {
        if (!['NATIVE_USAGE_RECEIPT_CONFLICT', 'NATIVE_USAGE_SOURCE_MISSING', 'PROVIDER_USAGE_SOURCE_INVALID'].includes(error?.code)) throw error
        this.pendingUsageErrors.push({ executionId: id, code: error.code }); unresolved.add(id)
      }
      if (store.read('attempt') && !store.read('receipt') && !store.read('failure-receipt')) {
        pending.push(command)
        unresolved.add(id)
      }
    }
    // Publish only after a successful scan; a partial/unsafe scan must not lose pending work.
    this.pendingExecutionIds = unresolved
    return pending
  }
  async deliverPendingUsage() {
    const errors = [...(this.pendingUsageErrors || [])]
    for (const item of this.pendingUsage) {
      const { command, store } = item
      const retry = this.usageRetries.get(command.executionId)
      if (retry && this.now() < retry.nextAt) continue
      try {
        const receipt = await this.request(`${BASE}/${command.taskId}/runs/${command.runId}/conversation/${item.endpoint || 'usage'}`, 'POST', item.payload)
        acknowledgeNativeUsage(store, item, receipt)
        this.usageRetries.delete(command.executionId)
      } catch (error) {
        if (/^SKILL_(?:SESSION|STORE|SCOPE)_/.test(error?.code || '')) throw error
        // Only delivery retries; this path never calls process(), resumes a lease,
        // or invokes a model. A failed write/unknown HTTP reply remains on disk.
        const attempt = Math.min((retry?.attempt ?? 0) + 1, 6)
        const delay = Math.floor(Math.min(300000, 15000 * 2 ** (attempt - 1)) * (0.8 + 0.2 * this.random()))
        this.usageRetries.set(command.executionId, { attempt, nextAt: this.now() + delay })
        errors.push({ executionId: command.executionId, code: error?.code || 'NATIVE_USAGE_DELIVERY_FAILED' })
      }
    }
    return errors
  }

  /** Call under the stopped subject's writer gate and original authenticated binding.
   * Two passes deliver STARTED then TERMINAL; no timer, execution or lease recovery.
   * Confirmed means durable evidence acceptance, not known usage, price or zero cost. */
  async flush() {
    const errors = []
    for (let phase = 0; phase < 2; phase++) {
      this.resetPendingDiscovery()
      this.pendingCommands()
      errors.push(...this.pendingCommandErrors.map(({ executionId, error }) => ({ executionId, code: error.code })))
      errors.push(...await this.deliverPendingUsage())
      if (errors.length || !this.pendingUsage.length) break
    }
    this.resetPendingDiscovery()
    this.pendingCommands()
    const remainingErrors = [...this.pendingUsageErrors,
      ...this.pendingCommandErrors.map(({ executionId, error }) => ({ executionId, code: error.code }))]
    return { confirmed: !errors.length && !remainingErrors.length && !this.pendingUsage.length,
      pending: this.pendingUsage.length, errors: errors.length ? errors : remainingErrors }
  }
}
