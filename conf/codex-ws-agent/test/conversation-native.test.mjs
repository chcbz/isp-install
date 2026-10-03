import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { NativeConversationLane, parseNativeConversationCommand, validateNativeConversationOutput } from '../conversation-native.mjs'

const command = Object.freeze({ schemaVersion: 1, taskId: 'task-1', runId: 'run-1', conversationId: 'conv-1',
  commandId: 'cmd-1', messageId: 'msg-1', instruction: 'Create an authorized image with no referenced materials',
  outputContentMimeType: 'image/png', outputId: 'output_1' })
const token = '12345678-1234-1234-1234-123456789abc'
const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(12, 1)])
const digest = createHash('sha256').update(bytes).digest('hex')
const json = (url, body, status = 200) => ({ status, url: url.href, redirected: false,
  headers: { get: () => 'application/json' }, json: async () => body })
const reference = Object.freeze({ inputRef: 'input_1', fileId: 'ref-1', version: 2,
  originalFilename: '../do-not-use.png', contentMimeType: 'image/png', byteLength: bytes.length, sha256: digest })
const setup = ({ execute, response, inputSnapshot, referenceBytes = bytes,
  auth = `AgentRuntime ${'a'.repeat(32)}` } = {}) => {
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
    if (path.endsWith('/conversation/inputs')) {
      assert.deepEqual(JSON.parse(init.body), { version: 1, token })
      return json(url, inputSnapshot || { executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: true, inputs: [] })
    }
    if (path.endsWith('/inputs/input_1/content')) {
      assert.deepEqual(JSON.parse(init.body), { version: 1, token })
      return { status: 200, url: url.href, redirected: false,
        headers: { get: key => ({ 'content-type': 'application/octet-stream',
          'content-length': String(reference.byteLength) })[key] || null },
        arrayBuffer: async () => referenceBytes }
    }
    if (path.endsWith('/provider-start')) {
      assert.deepEqual(JSON.parse(init.body), { version: 1, token })
      return json(url, { started: true })
    }
    if (path.endsWith('/failure')) return json(url, { executionId: 'exec-1', state: 'FAILED' })
    if (path.endsWith('/content')) return json(url, { outputId: 'output_1', state: 'STAGED', sha256: digest, byteLength: bytes.length }, 201)
    if (path.includes('/output-commits/')) {
      const wire = `${command.taskId}\n${command.runId}\noutput_1\n${digest}\n${bytes.length}\n`
      assert.equal(path.split('/').at(-1), `pwe_m_${createHash('sha256').update(wire).digest('hex')}`, 'server manifest contract')
      return json(url, { manifestId: path.split('/').at(-1), state: 'COMMITTED',
        items: [{ outputId: 'output_1', sha256: digest }] })
    }
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
    assert.equal(s.calls.length, 4)
    assert.deepEqual(JSON.parse(s.calls[3].body), { fence: { version: 1, token }, code: 'CONVERSATION_EXECUTOR_NOT_AUTHORIZED' })
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
    assert.equal(s.calls.length, 6)
    assert.deepEqual(s.calls.map(x => x.method), ['GET', 'POST', 'POST', 'POST', 'POST', 'POST'])
    assert.equal(s.calls[3].path.endsWith('/provider-start'), true)
    assert.ok(s.calls[4].body instanceof FormData)
    assert.equal(s.calls[4].body.get('sha256'), digest)
    assert.deepEqual(JSON.parse(s.calls[5].body).outputs, [{ outputId: 'output_1', sha256: digest, length: bytes.length }])
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
test('missing or reference-bearing input snapshot fails closed before any executor or staged output', async () => {
  for (const snapshot of [
    { executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: false, inputs: [] },
    { executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: true, inputs: [{ inputId: 'reference-1' }] },
    { executionId: 'foreign', leaseVersion: 1, noReferencedMaterials: true, inputs: [] },
    { executionId: 'exec-1', leaseVersion: 2, noReferencedMaterials: true, inputs: [] },
    { executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: true, inputs: [], extra: 'unknown' }
  ]) {
    let executed = false
    const s = setup({ execute: async () => { executed = true }, response: url => {
      if (url.pathname.endsWith('/commands')) return json(url, { items: [command] })
      if (url.pathname.endsWith('/lease')) return json(url, { executionId: 'exec-1', version: 1, token,
        expiresAt: Date.now() + 900000 })
      if (url.pathname.endsWith('/conversation/inputs')) return json(url, snapshot)
      if (url.pathname.endsWith('/failure')) return json(url, { executionId: 'exec-1', state: 'FAILED' })
      throw Error('no legacy or output endpoints')
    } })
    try {
      assert.deepEqual(await s.lane.poll(), { processed: 1 })
      assert.equal(executed, false)
      assert.deepEqual(JSON.parse(s.calls.at(-1).body).code, 'CONVERSATION_INPUTS_UNAVAILABLE')
      assert.equal(s.calls.length, 4)
    } finally { s.cleanup() }
  }
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
      if (url.pathname.endsWith('/conversation/inputs')) return json(url, { executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: true, inputs: [] })
      if (url.pathname.endsWith('/provider-start')) return json(url, { started: true })
      if (url.pathname.endsWith('/content')) return json(url, { outputId: 'output_1', state: 'STAGED',
        sha256: digest, byteLength: bytes.length }, 201)
      if (url.pathname.includes('/output-commits/')) throw new Error('response lost after commit')
      throw new Error('Never report failure after ambiguous commit')
    } })
  try { await assert.rejects(s.lane.poll(), /CONVERSATION_OUTCOME_UNKNOWN/)
    assert.equal(s.calls.length, 6)
  } finally { s.cleanup() }
})

test('ambiguous Provider START never invokes engine, retries, uploads, or reports speculative failure', async () => {
  for (const replyMode of ['lost', 'malformed', 'rejected']) {
    let executed = false
    const s = setup({ execute: async () => { executed = true }, response: (url) => {
      if (url.pathname.endsWith('/commands')) return json(url, { items: [command] })
      if (url.pathname.endsWith('/lease')) return json(url, { executionId: 'exec-1', version: 1,
        token, expiresAt: Date.now() + 900000 })
      if (url.pathname.endsWith('/conversation/inputs')) return json(url, { executionId: 'exec-1',
        leaseVersion: 1, noReferencedMaterials: true, inputs: [] })
      if (url.pathname.endsWith('/provider-start')) {
        if (replyMode === 'lost') throw Error('response lost after durable marker')
        if (replyMode === 'malformed') return json(url, { started: 'true' })
        return json(url, { error: 'conflict' }, 409)
      }
      throw Error('must not upload or report failure on uncertain Provider START')
    } })
    try { await assert.rejects(s.lane.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
      assert.equal(executed, false)
      assert.equal(s.calls.length, 4)
      assert.deepEqual(readdirSync(resolve(s.root, 'conversation-runs', 'agent-1')), [])
    } finally { s.cleanup() }
  }
})
test('fenced exact reference bytes materialize in private input path and reach executor, never user filename', async () => {
  const s = setup({ inputSnapshot: { executionId: 'exec-1', leaseVersion: 1,
    noReferencedMaterials: false, inputs: [reference] },
  execute: async ({ inputs, runDirectory }) => {
    assert.deepEqual(inputs.map(x => x.relativePath), ['inputs/input_1.png'])
    assert.deepEqual(readFileSync(resolve(runDirectory, inputs[0].relativePath)), bytes)
    assert.ok(!JSON.stringify(inputs).includes('do-not-use'))
    return { outputId: 'output_1', contentType: 'image/png', bytes }
  } })
  try { assert.deepEqual(await s.lane.poll(), { processed: 1 })
    assert.ok(s.calls.some(x => x.path.endsWith('/inputs/input_1/content')))
    assert.ok(s.calls.findIndex(x => x.path.endsWith('/provider-start')) >
      s.calls.findIndex(x => x.path.endsWith('/inputs/input_1/content')))
    assert.ok(s.calls.every(x => !x.path.includes('/workspace-executions')))
    assert.deepEqual(readdirSync(resolve(s.root, 'conversation-runs', 'agent-1')), [])
  } finally { s.cleanup() }
})

test('invalid, foreign or tampered references never reach executor or output upload', async () => {
  for (const [inputSnapshot, referenceBytes, expected] of [
    [{ executionId: 'foreign', leaseVersion: 1, noReferencedMaterials: false, inputs: [reference] }, bytes, 'CONVERSATION_INPUTS_UNAVAILABLE'],
    [{ executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: false, inputs: [{ ...reference, inputRef: '../escape' }] }, bytes, 'CONVERSATION_INPUTS_UNAVAILABLE'],
    [{ executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: false, inputs: [{ ...reference, fileId: 'other', sha256: '0'.repeat(64) }] }, bytes, 'CONVERSATION_INPUTS_UNAVAILABLE'],
    [{ executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: false, inputs: [reference] }, bytes.subarray(0, 8), 'CONVERSATION_INPUT_READ_UNCERTAIN']
  ]) {
    let executed = false
    const s = setup({ inputSnapshot, referenceBytes, execute: async () => { executed = true } })
    try {
      if (expected.includes('UNCERTAIN')) await assert.rejects(s.lane.poll(), new RegExp(expected))
      else { assert.deepEqual(await s.lane.poll(), { processed: 1 })
        assert.equal(JSON.parse(s.calls.at(-1).body).code, expected) }
      assert.equal(executed, false)
      assert.ok(s.calls.every(x => !x.path.includes('/output-commits/') &&
        !x.path.endsWith('/output_1/content') && !x.path.endsWith('/provider-start')))
      const root = resolve(s.root, 'conversation-runs', 'agent-1')
      if (existsSync(root)) assert.deepEqual(readdirSync(root), [])
    } finally { s.cleanup() }
  }
})

test('disabled runtime does not fetch private reference bytes or invoke a model', async () => {
  const s = setup({ inputSnapshot: { executionId: 'exec-1', leaseVersion: 1,
    noReferencedMaterials: false, inputs: [reference] } })
  try { assert.deepEqual(await s.lane.poll(), { processed: 1 })
    assert.ok(s.calls.every(x => !x.path.endsWith('/inputs/input_1/content')))
    assert.equal(JSON.parse(s.calls.at(-1).body).code, 'CONVERSATION_EXECUTOR_NOT_AUTHORIZED')
  } finally { s.cleanup() }
})


test('multimedia output validator checks bytes rather than filename or declared MIME alone', () => {
  const cases = [
    ['image/webp', Buffer.from('RIFF0000WEBPpayload')],
    ['image/gif', Buffer.from('GIF89a0000')],
    ['audio/mpeg', Buffer.from([0x49, 0x44, 0x33, 4])],
    ['audio/wav', Buffer.from('RIFF0000WAVE')],
    ['audio/ogg', Buffer.from('OggS')],
    ['audio/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    ['text/plain', Buffer.from('你好')],
    ['text/markdown', Buffer.from('# title')],
    ['application/json', Buffer.from('{"ok":true}')],
    ['application/octet-stream', Buffer.from([0, 1, 2])]
  ]
  for (const [mime, content] of cases) assert.equal(validateNativeConversationOutput(mime, content), true, mime)
  assert.equal(validateNativeConversationOutput('application/json', Buffer.from('{bad}')), false)
  assert.equal(validateNativeConversationOutput('text/plain', Buffer.from([0xc3, 0x28])), false)
  assert.equal(validateNativeConversationOutput('audio/wav', Buffer.from('RIFF0000WEBP')), false)
  assert.equal(validateNativeConversationOutput('image/svg+xml', Buffer.from('<svg/>')), false)
})
