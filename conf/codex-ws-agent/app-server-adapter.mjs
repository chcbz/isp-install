import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const id = value => typeof value === 'string' && value.length > 0
const deniedMethods = /(?:command|file|permission|network|mcp|dynamic.?tool|tool)/i
const terminalMethods = new Set(['turn/failed', 'turn/cancelled', 'turn/interrupted'])
export const CODEX_APP_SERVER_SCHEMA = Object.freeze({ cliVersion: '0.153.4', bundleSha256: 'b06f77062369d481a59cc70720c12b89cb9dd49c385863923262102d3ad6c978' })

const binaryMeasurementCache = new Map()
const failTrust = message => { const error = new Error(message); error.code = 'APP_SERVER_BINARY_UNTRUSTED'; return error }
export function measureCodexAppServerBinary(profile, {
  expected = CODEX_APP_SERVER_SCHEMA, spawnSyncFn = spawnSync, cache = binaryMeasurementCache, temporaryRoot = tmpdir()
} = {}) {
  let binary; let stat; let binarySha256
  try {
    binary = realpathSync(profile.codexBin); stat = statSync(binary)
    if (!stat.isFile()) throw new Error('not a regular file')
    binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex')
  } catch (error) { throw failTrust(`CODEX_APP_SERVER_BINARY_MEASUREMENT_FAILED:${error.code || error.message}`) }
  const cacheKey = [binary, stat.dev, stat.ino, stat.size, stat.mtimeMs, binarySha256, expected.cliVersion, expected.bundleSha256].join(':')
  if (cache.has(cacheKey)) return cache.get(cacheKey)
  const version = spawnSyncFn(binary, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome || '' } })
  if (version.error || version.status !== 0 || version.signal) throw failTrust('CODEX_APP_SERVER_VERSION_MEASUREMENT_FAILED')
  const versionOutput = String(version.stdout || '').trim()
  if (versionOutput !== `codex-cli ${expected.cliVersion}`) throw failTrust(`CODEX_APP_SERVER_VERSION_MISMATCH:${versionOutput}`)
  const generated = mkdtempSync(resolve(temporaryRoot, 'codex-app-server-schema-'))
  try {
    try {
      const schema = spawnSyncFn(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', generated], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome || '' }
      })
      if (schema.error || schema.status !== 0 || schema.signal) throw failTrust('CODEX_APP_SERVER_SCHEMA_MEASUREMENT_FAILED')
      const bundle = readFileSync(resolve(generated, 'codex_app_server_protocol.schemas.json'))
      const bundleSha256 = createHash('sha256').update(bundle).digest('hex')
      if (bundleSha256 !== expected.bundleSha256) throw failTrust(`CODEX_APP_SERVER_SCHEMA_MISMATCH:${bundleSha256}`)
      const measurement = Object.freeze({
        measured: true, cliVersion: expected.cliVersion, versionOutput, bundleSha256,
        binarySha256, binaryIdentityDigest: createHash('sha256').update(cacheKey).digest('hex'),
        binaryStat: { size: String(stat.size), mtimeMs: String(Math.trunc(stat.mtimeMs)), dev: String(stat.dev), ino: String(stat.ino) }
      })
      cache.set(cacheKey, measurement); return measurement
    } catch (error) {
      if (error.code === 'APP_SERVER_BINARY_UNTRUSTED') throw error
      throw failTrust(`CODEX_APP_SERVER_SCHEMA_MEASUREMENT_FAILED:${error.code || error.message}`)
    }
  } finally { rmSync(generated, { recursive: true, force: true }) }
}

export class AppServerAdapter extends EventEmitter {
  static spawn(profile, { spawnFn = spawn, cwd, requestTimeoutMs = 15000, schemaMeasurement = null } = {}) {
    const child = spawnFn(profile.codexBin, ['app-server'], {
      cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome, NO_PROXY: '*', no_proxy: '*' }
    })
    return new AppServerAdapter({ child, requestTimeoutMs, schemaMeasurement })
  }
  constructor({ child, send = null, now = Date.now, requestTimeoutMs = 15000, maxStderrBytes = 1024 * 1024, schemaMeasurement = null } = {}) {
    super(); if (!child) throw new Error('APP_SERVER_CHILD_REQUIRED')
    this.child = child; this.now = now; this.requestTimeoutMs = requestTimeoutMs; this.maxStderrBytes = maxStderrBytes
    this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.stderrBytes = 0; this.closed = false
    this.turns = new Map(); this.readback = { initialize: null, account: null, models: null, config: null, tools: null, eventMethods: [], schema: schemaMeasurement || { ...CODEX_APP_SERVER_SCHEMA, measured: false } }
    this.send = send || (frame => child.stdin.write(`${JSON.stringify(frame)}\n`))
    child.stdout.on('data', chunk => this._onData(chunk.toString('utf8')))
    child.stderr?.on('data', chunk => { this.stderrBytes += chunk.length; if (this.stderrBytes > this.maxStderrBytes) this.close(new Error('APP_SERVER_STDERR_LIMIT')) })
    child.on('error', error => this.close(error)); child.on('exit', () => this.close(new Error('APP_SERVER_EXITED')))
  }
  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('APP_SERVER_CLOSED'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); const error = new Error(`APP_SERVER_RPC_TIMEOUT:${method}`); error.code = 'APP_SERVER_RPC_TIMEOUT'; reject(error) }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, method, timer }); this.send({ id: requestId, method, params })
    })
  }
  notify(method, params = {}) { if (!this.closed) this.send({ method, params }) }
  async initialize() {
    this.readback.initialize = await this.request('initialize', { clientInfo: { name: 'cyf-juyiting-runtime', version: '2' } })
    this.notify('initialized', {})
    this.readback.account = await this.request('account/read', { refreshToken: false })
    this.readback.models = await this.request('model/list', {})
    this.readback.config = await this.request('config/read', {})
    this.readback.tools = await this.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }).catch(error => ({ unavailable: true, reason: error.code || error.message }))
    return this.readback
  }
  async startOrResumeThread(binding, policy) {
    const params = { cwd: policy.cwd, model: policy.model || undefined, approvalPolicy: 'never', sandbox: 'read-only', config: { ...(policy.config || {}), network: false }, developerInstructions: policy.developerInstructions || policy.instructions || '', ...(policy.baseInstructions ? { baseInstructions: policy.baseInstructions } : {}) }
    const result = binding?.threadId ? await this.request('thread/resume', { threadId: binding.threadId, ...params }) : await this.request('thread/start', params)
    const threadId = result?.thread?.id || result?.threadId
    if (!id(threadId)) throw new Error('APP_SERVER_THREAD_ID_MISSING')
    return { ...(binding || {}), threadId, state: 'HOT', updatedAt: this.now() }
  }
  async runTurn({ threadId, clientUserMessageId, input, policy = {}, onAccepted = () => {}, onDelta = () => {}, onClarification = () => {} }) {
    if (!id(threadId) || !id(clientUserMessageId)) throw new Error('TURN_BINDING_REQUIRED')
    const provisional = `${threadId}:${clientUserMessageId}`
    if (this.turns.has(provisional)) throw new Error('TURN_ALREADY_ACTIVE')
    const turn = { threadId, clientUserMessageId, state: 'STARTING', startedAt: this.now(), turnId: null }
    this.turns.set(provisional, turn)

    let finalContent = ''; let settled = false; const buffered = []
    let resolveTerminal; let rejectTerminal
    const terminalPromise = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject })
    const cleanup = () => {
      this.off('delta', delta); this.off('final', final); this.off('terminal', terminal)
      this.off('clarification', clarification); this.off('policy_violation', violation); this.off('exit', exited)
      this.turns.delete(provisional)
      if (turn.turnId) this.turns.delete(`${threadId}:${turn.turnId}`)
    }
    const matches = event => event.threadId === threadId && event.turnId === turn.turnId
    const settle = (error, value) => {
      if (settled) return
      settled = true; cleanup()
      if (error) rejectTerminal(error); else resolveTerminal(value)
    }
    const consume = (kind, event) => {
      if (event.threadId !== threadId) return
      if (!turn.turnId) { buffered.push([kind, event]); return }
      if (!matches(event)) return
      if (kind === 'delta') onDelta(event)
      else if (kind === 'final') finalContent = event.content
      else if (kind === 'clarification') onClarification(event)
      else if (kind === 'violation') settle(Object.assign(new Error(event.code), { code: event.code }))
      else if (kind === 'terminal') {
        if (event.status === 'completed') settle(null, { turnId: turn.turnId, threadId, content: finalContent, finishReason: 'completed' })
        else settle(Object.assign(new Error(`TURN_${event.status.toUpperCase()}`), { code: `TURN_${event.status.toUpperCase()}` }))
      }
    }
    const delta = event => consume('delta', event)
    const final = event => consume('final', event)
    const terminal = event => consume('terminal', event)
    const clarification = event => consume('clarification', event)
    const violation = event => consume('violation', event)
    const exited = () => { if (turn.turnId) settle(Object.assign(new Error('APP_SERVER_EXITED_DURING_TURN'), { code: 'TURN_ACCEPTANCE_UNKNOWN', turn: { ...turn } })) }
    this.on('delta', delta); this.on('final', final); this.on('terminal', terminal)
    this.on('clarification', clarification); this.on('policy_violation', violation); this.on('exit', exited)

    let response
    try {
      const userInput = Array.isArray(input) ? input : [{ type: 'text', text: String(input) }]
      response = await this.request('turn/start', { threadId, clientUserMessageId, input: userInput, cwd: policy.cwd, model: policy.model || undefined, effort: policy.effort || undefined, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    } catch (cause) {
      cleanup(); turn.state = 'ACCEPTANCE_UNKNOWN'; turn.error = cause.message
      const reconciliation = await this.reconcileTurn(turn).catch(() => ({ status: 'RECOVERY_REQUIRED' }))
      const error = Object.assign(cause, { code: 'TURN_ACCEPTANCE_UNKNOWN', turn: { ...turn }, reconciliation })
      this.emit('recovery_required', { ...turn, reconciliation }); throw error
    }
    const turnId = response?.turn?.id || response?.turnId
    if (!id(turnId)) {
      cleanup(); turn.state = 'ACCEPTANCE_UNKNOWN'
      const reconciliation = await this.reconcileTurn(turn).catch(() => ({ status: 'RECOVERY_REQUIRED' }))
      this.emit('recovery_required', { ...turn, reason: 'TURN_START_RESPONSE_MISSING_ID', reconciliation })
      throw Object.assign(new Error('TURN_START_RESPONSE_MISSING_ID'), { code: 'TURN_ACCEPTANCE_UNKNOWN', turn: { ...turn }, reconciliation })
    }
    turn.turnId = turnId; turn.state = 'RUNNING'; this.turns.set(`${threadId}:${turnId}`, turn); onAccepted({ threadId, turnId })
    for (const [kind, event] of buffered.splice(0)) consume(kind, event)
    return terminalPromise
  }
  async reconcileTurn({ threadId, turnId = null, clientUserMessageId = null }) {
    try {
      const result = await this.request('thread/read', { threadId, includeTurns: true })
      const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : []
      const matched = turns.find(candidate => candidate?.id === turnId || (clientUserMessageId && candidate?.items?.some(item => item?.type === 'userMessage' && item?.clientId === clientUserMessageId)))
      if (!matched) return { status: 'ABSENT', result, turnId, clientUserMessageId }
      if (matched.status === 'inProgress') return { status: 'ACCEPTED', result, turn: matched, turnId: matched.id, clientUserMessageId }
      if (['completed', 'failed', 'interrupted'].includes(matched.status)) return { status: 'TERMINAL', terminalStatus: matched.status, error: matched.error || null, result, turn: matched, turnId: matched.id, clientUserMessageId }
      return { status: 'RECOVERY_REQUIRED', result, turn: matched, turnId: matched.id, clientUserMessageId }
    } catch {
      return { status: 'RECOVERY_REQUIRED', turnId, clientUserMessageId }
    }
  }
  interrupt(threadId, turnId) { return this.request('turn/interrupt', { threadId, turnId }) }
  unsubscribe(threadId) { return this.request('thread/unsubscribe', { threadId }) }
  compact(threadId) { return this.request('thread/compact/start', { threadId }) }
  archive(threadId) { return this.request('thread/archive', { threadId }) }
  close(reason = new Error('APP_SERVER_CLOSED')) {
    if (this.closed) return; this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason) } this.pending.clear()
    try { if (this.child.exitCode === null && !this.child.killed) this.child.kill('SIGTERM') } catch {}
    this.emit('exit', reason)
  }
  async shutdown({ timeoutMs = 5000 } = {}) {
    const child = this.child
    this.close(new Error('APP_SERVER_DISPOSED'))
    if (child.exitCode !== null) return
    await new Promise(resolveShutdown => {
      let settled = false
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); child.off('exit', finish); resolveShutdown() }
      child.once('exit', finish)
      const timer = setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL') } catch {}
        setTimeout(finish, 100).unref?.()
      }, timeoutMs)
      timer.unref?.()
    })
  }
  _onData(data) {
    this.buffer += data
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) { this.close(new Error('APP_SERVER_FRAME_LIMIT')); return }
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); if (!line.trim()) continue; let frame; try { frame = JSON.parse(line) } catch { this.emit('protocol_error', new Error('APP_SERVER_INVALID_JSON')); continue } this._frame(frame) }
  }
  _frame(frame) {
    if (frame.id != null && (frame.result !== undefined || frame.error !== undefined)) { const pending = this.pending.get(frame.id); if (!pending) return; this.pending.delete(frame.id); clearTimeout(pending.timer); if (frame.error) pending.reject(Object.assign(new Error(frame.error.message || 'APP_SERVER_RPC_ERROR'), { code: frame.error.code })); else pending.resolve(frame.result); return }
    if (!frame.method) return
    if (!this.readback.eventMethods.includes(frame.method)) this.readback.eventMethods.push(frame.method)
    if (frame.id != null || deniedMethods.test(frame.method)) { this._denyServerRequest(frame); return }
    const params = frame.params || {}; const threadId = params.threadId || params.thread_id; const turnId = params.turnId || params.turn_id || params.turn?.id
    if (frame.method === 'item/agentMessage/delta') { const content = params.delta || params.text || params.content; if (typeof content === 'string' && content) this.emit('delta', { threadId, turnId, content }); return }
    if (frame.method === 'item/agentMessage') { const content = params.text || params.content || params.item?.text; if (typeof content === 'string') this.emit('final', { threadId, turnId, content }); return }
    if (frame.method === 'item/completed') { const item = params.item || {}; if (['agentMessage', 'agent_message'].includes(item.type) && typeof item.text === 'string') this.emit('final', { threadId, turnId, content: item.text }); return }
    if (frame.method === 'turn/completed') {
      const turn = params.turn
      const status = turn?.status; const completedTurnId = turn?.id
      if (!id(completedTurnId) || !['completed', 'interrupted', 'failed', 'inProgress'].includes(status)) { this.emit('protocol_error', new Error('APP_SERVER_INVALID_TURN_COMPLETED')); return }
      if (status !== 'inProgress') this.emit('terminal', { threadId, turnId: completedTurnId, status, error: turn.error || null })
      else this.emit('event', frame)
      return
    }
    if (terminalMethods.has(frame.method)) { this.emit('terminal', { threadId, turnId, status: frame.method === 'turn/cancelled' ? 'interrupted' : frame.method.slice(5), error: params.error || null }); return }
    this.emit('event', frame)
  }
  _denyServerRequest(frame) {
    const params = frame.params || {}; const threadId = params.threadId || params.thread_id; const turnId = params.turnId || params.turn_id
    const clarification = /user.?input/i.test(frame.method)
    if (clarification) this.emit('clarification', { threadId, turnId, request: frame.method })
    else this.emit('policy_violation', { threadId, turnId, request: frame.method, code: 'FAST_CHAT_TOOL_POLICY_VIOLATION' })
    if (frame.id != null) this.send({ id: frame.id, error: { code: -32001, message: clarification ? 'Clarification only; it cannot authorize execution' : 'Denied by read-only-constrained CHAT policy' } })
    if (!clarification && id(threadId) && id(turnId)) void this.interrupt(threadId, turnId).catch(() => {})
  }
}
