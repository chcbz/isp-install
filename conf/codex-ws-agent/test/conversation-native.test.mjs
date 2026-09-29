import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { NativeConversationLane, parseNativeConversationCommand } from '../conversation-native.mjs'

const command = Object.freeze({ schemaVersion: 1, taskId: 'task-1', runId: 'run-1', conversationId: 'conv-1',
  commandId: 'cmd-1', messageId: 'msg-1', instruction: 'Create an authorized image with no referenced materials',
  outputContentMimeType: 'image/png', outputId: 'output_1' })
const token = '12345678-1234-1234-1234-123456789abc'
const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(12, 1)])
const digest = createHash('sha256').update(bytes).digest('hex')
const json = (url, body, status = 200) => ({ status, url: url.href, redirected: false,
  headers: { get: () => 'application/json' }, json: async () => body })
const setup = ({ execute, response, auth = `AgentRuntime ${'a'.repeat(32)}` } = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), 'mmd-native-test-'))
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, headers: init.headers, body: init.body })
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, auth)
    assert.equal(init.headers['X-Agent-Id'], 'agent-1')
    assert.equal(init.headers['X-Agent-Runtime-Id'], 'instance-1')
    const path = url.pathname
    if (response) return response(url, init, calls)
    if (path.endsWith('/commands')) return json(url, { items: [command] })
    if (path.endsWith('/lease')) {
      assert.deepEqual(JSON.parse(init.body), { commandId: command.commandId, messageId: command.messageId })
      return json(url, { executionId: 'exec-1', version: 1, token, expiresAt: Date.now() + 900000 })
    }
    if (path.endsWith('/lease/renew')) return json(url, { executionId: 'exec-1', version: 1, token, expiresAt: Date.now() + 900000 })
    if (path.endsWith('/failure')) return json(url, { executionId: 'exec-1', state: 'FAILED' })
    if (path.endsWith('/content')) return json(url, { outputId: 'output_1', state: 'STAGED', sha256: digest, byteLength: bytes.length }, 201)
    if (path.includes('/output-commits/')) return json(url, { manifestId: path.split('/').at(-1), state: 'COMMITTED',
      items: [{ outputId: 'output_1', sha256: digest }] })
    throw new Error('Unexpected API endpoint')
  }
  const lane = new NativeConversationLane({ apiOrigin: 'http://127.0.0.1:10018', rootDir: root,
    fetchFn, agentId: 'agent-1', runtimeInstanceId: 'instance-1', getAuth: () => auth, execute })
  return { lane, root, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
test('rejects malformed or reference-bearing queue commands before any claim', async () => {
  assert.throws(() => parseNativeConversationCommand({ ...command, inputManifest: [] }), /CONVERSATION_COMMAND_INVALID/)
  assert.throws(() => parseNativeConversationCommand({ ...command, outputId: '../escape' }), /CONVERSATION_COMMAND_INVALID/)
  const s = setup({ response: url => json(url, { items: [{ ...command, inputManifest: [{ inputId: 'x' }] }] }) })
  try { await assert.rejects(s.lane.poll(), /CONVERSATION_COMMAND_INVALID/)
    assert.deepEqual(s.calls.map(c => c.path), ['/internal/agent/tasks/conversation-executions/commands'])
  } finally { s.cleanup() }
})
test('default native client claims then reports true failure; no paid/model call or legacy workspace endpoint', async () => {
  const s = setup()
  try {
    assert.deepEqual(await s.lane.poll(), { processed: 1 })
    assert.equal(s.calls.length, 3)
    assert.deepEqual(JSON.parse(s.calls[2].body), { fence: { version: 1, token }, code: 'CONVERSATION_EXECUTOR_NOT_AUTHORIZED' })
    assert.ok(s.calls.every(c => c.path.includes('/conversation') && !c.path.includes('/workspace-executions')))
    assert.deepEqual(readdirSync(resolve(s.root, 'conversation-runs', 'agent-1')), [])
  } finally { s.cleanup() }
})
test('separately supplied no-charge executor stays inside scoped dirs and only exact server commit is success', async () => {
  const s = setup({ execute: async ({ command: received, inputs, runDirectory }) => {
    assert.equal(received.runId, command.runId); assert.deepEqual(inputs, [])
    assert.ok(runDirectory.includes('/conversation-runs/agent-1/run-1-'))
    assert.deepEqual(readdirSync(runDirectory).sort(), ['inputs', 'outputs', 'scratch'])
    return { outputId: 'output_1', contentType: 'image/png', bytes }
  } })
  try { assert.deepEqual(await s.lane.poll(), { processed: 1 })
    assert.equal(s.calls.length, 4)
    assert.deepEqual(s.calls.map(x => x.method), ['GET', 'POST', 'POST', 'POST'])
    assert.ok(s.calls[2].body instanceof FormData)
    assert.equal(s.calls[2].body.get('sha256'), digest)
    assert.deepEqual(JSON.parse(s.calls[3].body).outputs, [{ outputId: 'output_1', sha256: digest, length: bytes.length }])
    assert.deepEqual(readdirSync(resolve(s.root, 'conversation-runs', 'agent-1')), [])
  } finally { s.cleanup() }
})
test('unknown claim transport outcome never retries, starts engine or reports a speculative failure', async () => {
  let executed = false
  const s = setup({ execute: async () => { executed = true }, response: (url) => {
    if (url.pathname.endsWith('/commands')) return json(url, { items: [command] })
    throw new Error('lost claim response')
  } })
  try { await assert.rejects(s.lane.poll(), /CONVERSATION_OUTCOME_UNKNOWN/)
    assert.equal(executed, false); assert.equal(s.calls.length, 2)
  } finally { s.cleanup() }
})
test('redirected response is rejected before claiming a command', async () => {
  const s = setup({ response: url => ({ ...json(url, { items: [command] }), redirected: true }) })
  try { await assert.rejects(s.lane.poll(), /CONVERSATION_RESPONSE_UNAVAILABLE/)
    assert.equal(s.calls.length, 1)
  } finally { s.cleanup() }
})
test('invalid artifact triggers fenced failure, not a completion receipt', async () => {
  const s = setup({ execute: async () => ({ outputId: 'output_1', contentType: 'image/png', bytes: Buffer.alloc(20) }) })
  try { assert.deepEqual(await s.lane.poll(), { processed: 1 })
    assert.deepEqual(JSON.parse(s.calls.at(-1).body).code, 'CONVERSATION_OUTPUT_INVALID')
  } finally { s.cleanup() }
})
test('wrong lease receipt never starts execution, uploads or reports speculative failure', async () => {
  let executed = false
  const s = setup({ execute: async () => { executed = true }, response: url => {
    if (url.pathname.endsWith('/commands')) return json(url, { items: [command] })
    if (url.pathname.endsWith('/lease')) return json(url, { executionId: 'exec-1', version: 1,
      token: 'invalid', expiresAt: Date.now() + 900000 })
    throw new Error('Unexpected write')
  } })
  try { await assert.rejects(s.lane.poll(), /CONVERSATION_LEASE_UNCERTAIN/)
    assert.equal(executed, false); assert.equal(s.calls.length, 2)
  } finally { s.cleanup() }
})
test('unknown commit outcome is not treated as failed or completed; no unsafe retry', async () => {
  const s = setup({ execute: async () => ({ outputId: 'output_1', contentType: 'image/png', bytes }),
    response: (url, init) => {
      if (url.pathname.endsWith('/commands')) return json(url, { items: [command] })
      if (url.pathname.endsWith('/lease')) return json(url, { executionId: 'exec-1', version: 1,
        token, expiresAt: Date.now() + 900000 })
      if (url.pathname.endsWith('/content')) return json(url, { outputId: 'output_1', state: 'STAGED',
        sha256: digest, byteLength: bytes.length }, 201)
      if (url.pathname.includes('/output-commits/')) throw new Error('response lost after commit')
      throw new Error('Never report failure after ambiguous commit')
    } })
  try { await assert.rejects(s.lane.poll(), /CONVERSATION_OUTCOME_UNKNOWN/)
    assert.equal(s.calls.length, 4)
  } finally { s.cleanup() }
})
