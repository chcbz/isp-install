import { EventEmitter } from 'node:events'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.length > 0
const deniedMethods = /(?:command|file|permission|network|mcp|dynamic.?tool|tool)/i

/** Minimal stdio JSON-RPC adapter. It exposes only real app-server events. */
export class AppServerAdapter extends EventEmitter {
  constructor({ child, send = null, now = Date.now } = {}) {
    super(); if (!child) throw new Error('APP_SERVER_CHILD_REQUIRED')
    this.child = child; this.now = now; this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.turns = new Map(); this.readback = { initialize: null, account: null, models: null, config: null, tools: null, eventMethods: [] }
    this.send = send || (frame => child.stdin.write(`${JSON.stringify(frame)}\n`))
    child.stdout.on('data', chunk => this._onData(chunk.toString('utf8')))
    child.on('exit', () => { for (const pending of this.pending.values()) pending.reject(new Error('APP_SERVER_EXITED')); this.pending.clear(); this.emit('exit') })
  }
  request(method, params = {}) { const requestId = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(requestId, { resolve, reject, method }); this.send({ id: requestId, method, params }) }) }
  notify(method, params = {}) { this.send({ method, params }) }
  async initialize() {
    this.readback.initialize = await this.request('initialize', { clientInfo: { name: 'cyf-juyiting-runtime', version: '2' } })
    this.notify('initialized', {})
    this.readback.account = await this.request('account/read', { refreshToken: false })
    this.readback.models = await this.request('model/list', {}).catch(() => null)
    this.readback.config = await this.request('config/read', {}).catch(() => null)
    this.readback.tools = await this.request('tool/catalog/read', {}).catch(() => null)
    return this.readback
  }
  async startOrResumeThread(binding, policy) {
    const params = { cwd: policy.cwd, model: policy.model, approvalPolicy: 'never', sandbox: 'read-only', config: policy.config || {}, instructions: policy.instructions || '' }
    const result = binding.threadId ? await this.request('thread/resume', { threadId: binding.threadId, ...params }) : await this.request('thread/start', params)
    const threadId = result?.thread?.id || result?.threadId
    if (!id(threadId)) throw new Error('APP_SERVER_THREAD_ID_MISSING')
    return { ...binding, threadId }
  }
  async startTurn({ threadId, clientUserMessageId, input, policy = {} }) {
    if (!id(threadId) || !id(clientUserMessageId)) throw new Error('TURN_BINDING_REQUIRED')
    const key = `${threadId}:${clientUserMessageId}`
    if (this.turns.has(key)) return this.turns.get(key)
    const turn = { threadId, clientUserMessageId, state: 'STARTING', deltaSeq: 0, final: null, startedAt: this.now() }
    this.turns.set(key, turn)
    try {
      const response = await this.request('turn/start', { threadId, clientUserMessageId, input, cwd: policy.cwd, model: policy.model, effort: policy.effort, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } })
      turn.turnId = response?.turn?.id || response?.turnId || clientUserMessageId; turn.state = 'RUNNING'; return turn
    } catch (error) { turn.state = 'ACCEPTANCE_UNKNOWN'; turn.error = error.message; this.emit('recovery_required', turn); throw error }
  }
  async interrupt(threadId, turnId) { return this.request('turn/interrupt', { threadId, turnId }) }
  async unsubscribe(threadId) { return this.request('thread/unsubscribe', { threadId }) }
  async compact(threadId) { return this.request('thread/compact/start', { threadId }) }
  async archive(threadId) { return this.request('thread/archive', { threadId }) }
  _onData(data) { this.buffer += data; let newline; while ((newline = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); if (!line.trim()) continue; let frame; try { frame = JSON.parse(line) } catch { this.emit('protocol_error', new Error('APP_SERVER_INVALID_JSON')); continue } this._frame(frame) } }
  _frame(frame) {
    if (frame.id != null && (frame.result !== undefined || frame.error !== undefined)) { const pending = this.pending.get(frame.id); if (!pending) return; this.pending.delete(frame.id); if (frame.error) pending.reject(Object.assign(new Error(frame.error.message || 'APP_SERVER_RPC_ERROR'), { code: frame.error.code })); else pending.resolve(frame.result); return }
    if (!frame.method) return
    this.readback.eventMethods.push(frame.method)
    if (frame.id != null || deniedMethods.test(frame.method)) { this._denyServerRequest(frame); return }
    const params = frame.params || {}
    if (frame.method === 'item/agentMessage/delta') {
      const delta = params.delta || params.text || params.content || params.item?.text
      if (typeof delta === 'string' && delta) this.emit('delta', { threadId: params.threadId, turnId: params.turnId, content: delta })
      return
    }
    if (frame.method === 'item/agentMessage' || frame.method === 'item/completed') {
      const content = params.text || params.content || params.item?.text
      if (typeof content === 'string') this.emit('final', { threadId: params.threadId, turnId: params.turnId, content })
      return
    }
    this.emit('event', frame)
  }
  _denyServerRequest(frame) {
    const params = frame.params || {}; const threadId = params.threadId || params.thread_id; const turnId = params.turnId || params.turn_id
    if (/user.?input/i.test(frame.method)) this.emit('clarification', { threadId, turnId, request: frame.method })
    else this.emit('policy_violation', { threadId, turnId, request: frame.method, code: 'FAST_CHAT_TOOL_POLICY_VIOLATION' })
    if (frame.id != null) this.send({ id: frame.id, error: { code: -32001, message: /user.?input/i.test(frame.method) ? 'Clarification required; confirmation cannot authorize execution' : 'Denied by CHAT read-only-constrained policy' } })
    if (id(threadId) && id(turnId)) void this.interrupt(threadId, turnId).catch(() => {})
  }
}
