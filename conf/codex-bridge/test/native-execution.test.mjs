import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { runNativeExecution } from '../native-execution.mjs'
// Engine transport double: proves owner orchestration/recovery, not a model run.
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'native-owner-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const command = { executionProtocolVersion: 5, executionId: 'execution1', commandId: 'cmd1', messageId: 'message1', snapshotDigest: 'a'.repeat(64), skills: [], inputRefs: [], instruction: 'create text', parameters: {}, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1', outputs: { dataSchema: null, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: true } }
  const store = new SkillExecutionStore({ rootDirectory: root, scope: { agentId: 'agent1' }, command })
  const events = []; let policy; let mode = 'success'; let runs = 0
  const adapter = {
    startOrResumeThread: async (_binding, value) => { assert.equal(value.cwd, '/execution'); assert.match(value.developerInstructions, /\/usr\/lib\/cyf-\*\/README\.md/); events.push('thread'); return { threadId: 'thread1' } },
    runTurn: async options => {
      runs++; events.push('turn'); assert.equal(options.policy.cwd, '/execution')
      if (mode === 'acceptance-unknown') throw Object.assign(new Error('reply lost'), { code: 'TURN_ACCEPTANCE_UNKNOWN' })
      options.onAccepted({ threadId: 'thread1', turnId: 'turn1' })
      if (mode === 'no-proposal') return { threadId: 'thread1', turnId: 'turn1', finishReason: 'completed', content: 'browser launch failed' }
      // Simulate bytes written by the engine in its mounted draft directory.
      writeFileSync(resolve(store.directory, 'drafts/result.txt'), 'actual draft')
      const ctx = { executionId: command.executionId, threadId: 'thread1', turnId: 'turn1' }
      const a = await policy.callTool({ ...ctx, callId: 'stage1', tool: 'artifact_stage', arguments: { path: '/outputs/result.txt', displayName: 'result.txt', mediaTypeHint: 'text/plain' } })
      await policy.callTool({ ...ctx, callId: 'proposal1', tool: 'result_propose', arguments: { artifactRefs: [a.artifactRef], summary: 'done', data: null } })
      if (mode === 'terminal-lost') throw Object.assign(new Error('connection lost'), { code: 'TURN_ACCEPTANCE_UNKNOWN' })
      return { threadId: 'thread1', turnId: 'turn1', finishReason: 'completed', content: 'done' }
    },
    reconcileTurn: async () => { events.push('reconcile'); return mode === 'terminal-lost' ? { status: 'TERMINAL', terminalStatus: 'completed', turnId: 'turn1' } : { status: 'ABSENT' } },
    shutdown: async () => { events.push('shutdown') }
  }
  const profileRuntime = { openNativeExecutionAdapter: async (_inputs, _key, _binding, options) => { policy = options.nativeExecution; return adapter }, suspendAdapter: async () => { events.push('suspend') } }
  const request = { command, inputs: [], entries: [], store, checkActive() {}, profileRuntime, model: 'fixture-model' }
  return { command, store, request, events, runs: () => runs, setMode: value => { mode = value } }
}
test('native owner collects actual drafts and suspends engine before returning durable result', async t => {
  const f = fixture(t); const result = await runNativeExecution(f.request)
  assert.equal(f.store.readBlob(result.result.artifacts[0].outputId).toString(), 'actual draft')
  assert.deepEqual(result.result.effectDependencies, []); assert.deepEqual(f.events, ['thread', 'turn', 'suspend'])
})
test('lost terminal is reconciled from the original turn and proposal without another model turn', async t => {
  const f = fixture(t); f.setMode('terminal-lost')
  await assert.rejects(runNativeExecution(f.request), error => error.code === 'SKILL_RESULT_UNKNOWN' && error.cause.message === 'connection lost'); assert.equal(f.store.loadResult(), null)
  const result = await runNativeExecution(f.request); assert.equal(result.result.artifacts.length, 1); assert.equal(f.runs(), 1)
  assert.deepEqual(f.events, ['thread', 'turn', 'suspend', 'reconcile', 'suspend'])
})
test('unknown turn acceptance is never treated as permission to create a new turn', async t => {
  const f = fixture(t); f.setMode('acceptance-unknown')
  await assert.rejects(runNativeExecution(f.request), error => error.code === 'SKILL_RESULT_UNKNOWN' && error.cause.code === 'TURN_ACCEPTANCE_UNKNOWN')
  await assert.rejects(runNativeExecution(f.request), /SKILL_RESULT_UNKNOWN/)
  assert.equal(f.runs(), 1); assert.equal(f.store.loadResult(), null)
})
test('expired authority aborts native startup and still suspends its execution-owned adapter', async t => {
  const f = fixture(t); const controller = new AbortController(); controller.abort()
  await assert.rejects(runNativeExecution({ ...f.request, signal: controller.signal }), /SKILL_LEASE_UNCERTAIN/)
  assert.equal(f.runs(), 0); assert.deepEqual(f.events, ['suspend'])
})


test('authority revocation cancels pending profile startup, before any model turn exists', async t => {
  const f = fixture(t); const controller = new AbortController(); let rejectStartup; let opened
  const started = new Promise(resolve => { opened = resolve })
  f.request.profileRuntime.openNativeExecutionAdapter = () => new Promise((_resolve, reject) => { rejectStartup = reject; opened() })
  f.request.profileRuntime.suspendAdapter = async () => {
    f.events.push('suspend')
    rejectStartup?.(Object.assign(new Error('SKILL_LEASE_UNCERTAIN'), { code: 'SKILL_LEASE_UNCERTAIN' }))
  }
  const run = runNativeExecution({ ...f.request, signal: controller.signal })
  await started; controller.abort()
  await assert.rejects(run, /SKILL_LEASE_UNCERTAIN/)
  assert.equal(f.runs(), 0); assert.ok(f.events.includes('suspend'))
})

for (const [engineCode, expectedCode] of [
  ['TURN_FAILED', 'NATIVE_EXECUTION_TURN_FAILED'],
  ['TURN_INTERRUPTED', 'NATIVE_EXECUTION_TURN_INTERRUPTED'],
  ['APP_SERVER_RPC_TIMEOUT', 'NATIVE_EXECUTION_ENGINE_UNAVAILABLE']
]) test(`native owner scopes ${engineCode} without publishing a result or replaying`, async t => {
  const f = fixture(t)
  const cause = Object.assign(new Error('engine failure'), { code: engineCode })
  let attempts = 0
  f.request.profileRuntime.openNativeExecutionAdapter = async () => ({
    startOrResumeThread: async () => ({ threadId: 'thread1' }),
    runTurn: async ({ onAccepted }) => {
      attempts++; onAccepted({ threadId: 'thread1', turnId: 'turn1' }); throw cause
    },
    reconcileTurn: async () => ({ status: 'ABSENT' })
  })
  await assert.rejects(runNativeExecution(f.request), error => error.code === expectedCode && error.cause === cause)
  assert.equal(f.store.loadResult(), null)
  assert.equal(f.store.read('native-turn').turnId, 'turn1')
  await assert.rejects(runNativeExecution(f.request), /SKILL_RESULT_UNKNOWN/)
  assert.equal(attempts, 1)
  assert.deepEqual(f.events, ['suspend', 'suspend'])
})

for (const terminalStatus of ['failed', 'interrupted']) test(`confirmed ${terminalStatus} recovery stays a known failure without another model turn`, async t => {
  const f = fixture(t); f.setMode('terminal-lost')
  await assert.rejects(runNativeExecution(f.request), /SKILL_RESULT_UNKNOWN/)
  f.request.profileRuntime.openNativeExecutionAdapter = async () => ({
    reconcileTurn: async () => ({ status: 'TERMINAL', terminalStatus, turnId: 'turn1' })
  })
  await assert.rejects(runNativeExecution(f.request), error => error.code === `NATIVE_EXECUTION_TURN_${terminalStatus.toUpperCase()}`)
  assert.equal(f.runs(), 1)
  assert.equal(f.store.loadResult(), null)
})

test('native owner forwards selected configuration and derives script network only from approved origins', async t => {
  const f = fixture(t)
  f.command.toolPolicyRef = 'NATIVE_SKILL_SCRIPT_V1'
  const skillConfiguration = [{ skillKey: 'example', configuration: { apiKey: 'fixture-only' }, networkOrigins: ['https://service.example'] }]
  const original = f.request.profileRuntime.openNativeExecutionAdapter
  f.request.profileRuntime.openNativeExecutionAdapter = async (...args) => {
    assert.deepEqual(args[3].skillConfiguration, skillConfiguration)
    assert.equal(args[3].nativeExecution.networkAccess, true)
    return original(...args)
  }
  await runNativeExecution({ ...f.request, skillConfiguration })
})

test('local files policy cannot receive script credentials or acquire network', async t => {
  const f = fixture(t)
  await assert.rejects(runNativeExecution({ ...f.request, skillConfiguration: [{ networkOrigins: ['https://service.example'] }] }), /NATIVE_SKILL_CONFIG_POLICY_MISMATCH/)
  assert.equal(f.runs(), 0)
  const original = f.request.profileRuntime.openNativeExecutionAdapter
  f.request.profileRuntime.openNativeExecutionAdapter = async (...args) => {
    assert.equal(args[3].nativeExecution.networkAccess, false)
    assert.deepEqual(args[3].skillConfiguration, [])
    return original(...args)
  }
  await runNativeExecution(f.request)
})

test('browser availability does not add a bridge tool or a browser workflow', async t => {
  const f = fixture(t)
  f.request.profileRuntime.nativeBrowserReady = true
  const original = f.request.profileRuntime.openNativeExecutionAdapter
  f.request.profileRuntime.openNativeExecutionAdapter = async (...args) => {
    assert.deepEqual(args[3].nativeExecution.tools.map(tool => tool.name), ['artifact_stage', 'result_propose'])
    return original(...args)
  }
  const result = await runNativeExecution(f.request)
  assert.equal(result.result.artifacts.length, 1)
})

// task560: model honestly reports browser failure instead of fabricating files.
test('completed turn missing required proposal reports execution failure and reconciliation never replays', async t => {
  const f = fixture(t); f.setMode('no-proposal')
  await assert.rejects(runNativeExecution(f.request), error => error.code === 'NATIVE_EXECUTION_TURN_FAILED' && error.cause.code === 'NATIVE_PROPOSAL_REQUIRED')
  assert.equal(f.store.read('native-final-message').content, 'browser launch failed')
  assert.equal(f.store.loadResult(), null)
  f.request.profileRuntime.openNativeExecutionAdapter = async () => ({
    reconcileTurn: async () => ({ status: 'TERMINAL', terminalStatus: 'completed', turnId: 'turn1' })
  })
  await assert.rejects(runNativeExecution(f.request), error => error.code === 'NATIVE_EXECUTION_TURN_FAILED' && error.cause.code === 'NATIVE_PROPOSAL_REQUIRED')
  assert.equal(f.runs(), 1)
  assert.equal(f.store.loadResult(), null)
})
