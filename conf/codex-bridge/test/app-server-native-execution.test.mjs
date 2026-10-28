import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { AppServerAdapter } from '../app-server-adapter.mjs'

const tool = { type: 'function', name: 'artifact_stage', description: 'Snapshot a draft', inputSchema: { type: 'object' } }
function fixture(nativeExecution = null) {
  const child = new EventEmitter()
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false })
  child.kill = () => { child.killed = true }
  const sent = []; let onRequest = () => {}
  const adapter = new AppServerAdapter({ child, nativeExecution, send: frame => {
    sent.push(frame)
    if (frame.method) queueMicrotask(() => {
      if (onRequest(frame) === false) return
      adapter._frame({ id: frame.id, result: frame.method.startsWith('thread/') ? { thread: { id: 'thread1' } } : { turn: { id: 'turn1' } } })
    })
  } })
  return { adapter, sent, setRequest: fn => { onRequest = fn }, event: (method, params) => adapter._frame({ method, params }) }
}
const execution = (callTool = async () => ({ outputId: 'output1' })) => ({ executionId: 'execution1', tools: [tool], checkActive() {}, callTool })
const start = f => f.adapter.runTurn({ threadId: 'thread1', clientUserMessageId: 'message1', input: 'write', policy: { cwd: '/execution' } })
const tick = () => new Promise(resolve => setImmediate(resolve))
const completed = f => f.event('turn/completed', { threadId: 'thread1', turn: { id: 'turn1', status: 'completed' } })
const call = (f, id = 'rpc1', params = {}) => f.adapter._frame({ id, method: 'item/tool/call', params: { threadId: 'thread1', turnId: 'turn1', callId: 'call1', tool: 'artifact_stage', arguments: { path: '/outputs/a.txt' }, ...params } })

test('CHAT cannot be upgraded by turn policy or tool catalog', async () => {
  const f = fixture(); try {
    await f.adapter.startOrResumeThread(null, { cwd: '/execution', sandbox: 'workspace-write', dynamicTools: [tool] })
    assert.equal(f.sent[0].params.sandbox, 'read-only'); assert.equal(f.sent[0].params.dynamicTools, undefined)
    const running = start(f); await tick()
    assert.deepEqual(f.sent.find(x => x.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
    const rejected = assert.rejects(running, /FAST_CHAT_TOOL_POLICY_VIOLATION/)
    call(f); await rejected
    assert.equal(f.sent.find(x => x.id === 'rpc1').error.code, -32001)
  } finally { f.adapter.close() }
})

test('native adapter fixes neutral cwd and writable roots and accepts tool progress without stdout leakage', async () => {
  const f = fixture(execution()); try {
    await assert.rejects(f.adapter.startOrResumeThread(null, { cwd: '/workspace' }), /NATIVE_EXECUTION_CWD_INVALID/)
    await f.adapter.startOrResumeThread(null, { cwd: '/execution' })
    assert.equal(f.sent[0].params.sandbox, 'workspace-write'); assert.deepEqual(f.sent[0].params.dynamicTools, [tool])
    const events = []; const running = f.adapter.runTurn({ threadId: 'thread1', clientUserMessageId: 'message1', input: 'write', policy: { cwd: '/execution' }, onToolEvent: e => events.push(e) })
    await tick()
    const policy = f.sent.find(x => x.method === 'turn/start').params.sandboxPolicy
    assert.deepEqual(policy.writableRoots, ['/workspace', '/outputs']); assert.equal(policy.networkAccess, false)
    f.event('item/commandExecution/outputDelta', { threadId: 'thread1', turnId: 'turn1', itemId: 'item1', delta: 'SECRET' })
    f.event('item/completed', { threadId: 'thread1', turnId: 'turn1', item: { id: 'item1', type: 'commandExecution', status: 'completed' } })
    completed(f); assert.equal((await running).finishReason, 'completed')
    assert.equal(events.length, 2); assert.ok(!JSON.stringify(events).includes('SECRET'))
  } finally { f.adapter.close() }
})

test('native tool call is execution-bound, deduplicated and completed before the turn resolves', async () => {
  let finish; let calls = 0
  const f = fixture(execution(async ctx => { calls++; assert.equal(ctx.executionId, 'execution1'); return new Promise(resolve => { finish = resolve }) }))
  try {
    const running = start(f); await tick(); call(f); call(f, 'rpc2'); await tick()
    assert.equal(calls, 1)
    let done = false; running.then(() => { done = true }); completed(f); await tick(); assert.equal(done, false)
    finish({ outputId: 'output1' }); await running; await tick()
    assert.equal(f.sent.filter(x => x.id === 'rpc1' || x.id === 'rpc2').length, 2)
    assert.equal(f.sent.find(x => x.id === 'rpc1').result.success, true)
    call(f, 'late'); assert.equal(f.sent.find(x => x.id === 'late').error.code, -32001)
  } finally { f.adapter.close() }
})

test('tool requests arriving before turn acceptance are buffered then bound to the accepted turn', async () => {
  let calls = 0; const f = fixture(execution(async () => { calls++; return {} }))
  try {
    f.setRequest(frame => { if (frame.method === 'turn/start') call(f) })
    const running = start(f); await tick(); assert.equal(calls, 1); completed(f); await running
  } finally { f.adapter.close() }
})

test('unregistered tools and ordinary permission requests remain denied in native mode', async () => {
  for (const method of ['item/tool/call', 'item/commandExecution/requestApproval']) {
    const f = fixture(execution(() => assert.fail('must not execute')))
    try {
      const running = start(f); await tick(); const rejected = assert.rejects(running, /TOOL_POLICY_VIOLATION/)
      f.adapter._frame({ id: 'forbidden', method, params: { threadId: 'thread1', turnId: 'turn1', callId: 'call2', tool: 'unknown', arguments: {} } })
      await rejected; assert.equal(f.sent.find(x => x.id === 'forbidden').error.code, -32001)
    } finally { f.adapter.close() }
  }
})

test('a recoverable draft rejection is returned to the model without terminating the authorized turn', async () => {
  const f = fixture(execution(async () => { throw Object.assign(new Error('do not expose host path'), { code: 'NATIVE_ARTIFACT_SOURCE_CHANGED', recoverableToolError: true }) }))
  try {
    const running = start(f); await tick(); call(f); await tick()
    const response = f.sent.find(x => x.id === 'rpc1').result
    assert.equal(response.success, false); assert.equal(response.contentItems[0].text, 'NATIVE_ARTIFACT_SOURCE_CHANGED')
    completed(f); assert.equal((await running).finishReason, 'completed')
  } finally { f.adapter.close() }
})

test('a new tool call cannot cross the completed-turn freeze boundary', async () => {
  let finish; let count = 0
  const f = fixture(execution(async () => { count++; return new Promise(resolve => { finish = resolve }) }))
  try {
    const running = start(f); await tick(); call(f); await tick(); completed(f)
    const rejected = assert.rejects(running, /NATIVE_EXECUTION_TOOL_POLICY_VIOLATION/)
    call(f, 'late-new', { callId: 'call2' }); await rejected; assert.equal(count, 1)
    finish({ outputId: 'output1' }); await tick()
  } finally { f.adapter.close() }
})

test('execution checkpoint callback failures reject the turn instead of escaping the stdout event handler', async () => {
  const f = fixture(execution())
  try {
    const running = f.adapter.runTurn({ threadId: 'thread1', clientUserMessageId: 'message1', input: 'write', policy: { cwd: '/execution' }, onAccepted() { throw new Error('checkpoint failed') } })
    await assert.rejects(running, /checkpoint failed/)
    assert.equal(f.adapter.turns.size, 0)
  } finally { f.adapter.close() }
})

test('native turn network follows its trusted execution binding, never model turn policy', async () => {
  for (const allowed of [false, true]) {
    const f = fixture({ ...execution(), networkAccess: allowed })
    try {
      const running = f.adapter.runTurn({ threadId: 'thread1', clientUserMessageId: 'message1', input: 'run script', policy: { cwd: '/execution', networkAccess: !allowed } })
      await tick()
      assert.equal(f.sent.find(frame => frame.method === 'turn/start').params.sandboxPolicy.networkAccess, allowed)
      completed(f); await running
    } finally { f.adapter.close() }
  }
})
