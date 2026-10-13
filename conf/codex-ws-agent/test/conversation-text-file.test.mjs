import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, linkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runNativeConversationTextFile, textFileExecutionDeclaration } from '../conversation-text-file.mjs'
import { EXECUTION_PAYLOAD_FILES } from '../../cyf-agent-runtime-v1/lib/execution-adapter.mjs'

const command = { taskId: 'task-1', commandId: 'cmd-1', instruction: 'write hello', outputId: 'output_1', outputContentMimeType: 'text/plain' }
const setup = () => { const root = mkdtempSync(resolve(tmpdir(), 'cyf-text-file-')); mkdirSync(resolve(root, 'outputs')); return root }
const invoke = (root, runCodexFn, patch = {}) => runNativeConversationTextFile({ profile: { codexBin: '/codex' }, command: { ...command, ...patch }, runDirectory: root, inputs: [], runCodexFn })

test('executes in the private run directory and returns bytes from the actual result file', async t => {
  const root = setup(); t.after(() => rmSync(root, { recursive: true, force: true }))
  let starts = 0
  const result = await invoke(root, async (profile, message, mode, options) => {
    starts++; assert.equal(profile.codexSandbox, 'workspace-write'); assert.equal(profile.codexApproval, 'never')
    assert.equal(mode, 'command'); assert.equal(options.codexWorkdir, root); assert.equal(options.requireWorkspace, false)
    assert.equal(options.forceNewSession, true); assert.equal(options.sendLegacyFn(), undefined)
    assert.match(message.prompt, /outputs\/result\.txt/)
    writeFileSync(resolve(root, 'outputs/result.txt'), Buffer.from('héllo\n', 'utf8'))
    return { status: 'completed', content: 'not the file content' }
  })
  assert.equal(starts, 1); assert.deepEqual(result.bytes, Buffer.from('héllo\n', 'utf8'))
  assert.deepEqual(readFileSync(resolve(root, 'outputs/result.txt')), result.bytes)
})

test('rejects completed runs without a nonempty output and rejects malformed UTF-8 and NUL bytes', async t => {
  const root = setup(); t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const bytes of [null, Buffer.alloc(0), Buffer.from([0xc3, 0x28]), Buffer.from('a\0b')]) {
    await assert.rejects(invoke(root, async () => { if (bytes) writeFileSync(resolve(root, 'outputs/result.txt'), bytes); return { status: 'completed' } }),
      error => error.code === 'CONVERSATION_TEXT_FILE_OUTPUT_INVALID')
    rmSync(resolve(root, 'outputs/result.txt'), { force: true })
  }
  await assert.rejects(invoke(root, async () => ({ status: 'failed' })), /CONVERSATION_TEXT_FILE_EXECUTION_FAILED/)
})

test('rejects output symlinks and hardlinks', async t => {
  const root = setup(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const external = resolve(root, 'external.txt'); writeFileSync(external, 'safe text')
  const output = resolve(root, 'outputs/result.txt'); symlinkSync(external, output)
  await assert.rejects(invoke(root, async () => ({ status: 'completed' })), /CONVERSATION_TEXT_FILE_OUTPUT_INVALID|CONVERSATION_TEXT_FILE_PATH_INVALID/)
  rmSync(output); linkSync(external, output)
  await assert.rejects(invoke(root, async () => ({ status: 'completed' })), /CONVERSATION_TEXT_FILE_OUTPUT_INVALID/)
})

test('rejects inputs and non-text MIME before invoking Codex', async t => {
  const root = setup(); t.after(() => rmSync(root, { recursive: true, force: true }))
  let starts = 0; const runner = async () => { starts++; return { status: 'completed' } }
  await assert.rejects(runNativeConversationTextFile({ profile: {}, command, runDirectory: root, inputs: [{}], runCodexFn: runner }), /COMMAND_INVALID/)
  await assert.rejects(invoke(root, runner, { outputContentMimeType: 'image/png' }), /COMMAND_INVALID/)
  assert.equal(starts, 0)
})

test('declaration requires online profile flag and actual text-ready native runtime', () => {
  const profile = { nativeConversationTextFileEnabled: true }
  assert.equal(textFileExecutionDeclaration({ profile, online: true, runtime: { nativeTextFileV1Ready: true } }).enabled, true)
  for (const value of [
    { profile: {}, online: true, runtime: { nativeTextFileV1Ready: true } },
    { profile, online: false, runtime: { nativeTextFileV1Ready: true } },
    { profile, online: true, runtime: null },
    { profile, online: true, runtime: { nativeTextFileV1Ready: false } }
  ]) assert.equal(textFileExecutionDeclaration(value).enabled, false)
})

test('native text lane performs one irreversible START and commits the exact output bytes', async t => {
  const { NativeConversationLane } = await import('../conversation-native.mjs')
  const { buildOutputCommit } = await import('../workspace-file-bridge.mjs')
  const { createHash } = await import('node:crypto')
  const root = setup(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const textCommand = { schemaVersion: 1, taskId: 'task-1', runId: 'run-1', conversationId: 'conv-1', commandId: 'cmd-1',
    messageId: 'msg-1', instruction: 'write text', outputContentMimeType: 'text/plain', outputId: 'output_1' }
  const bytes = Buffer.from('actual file payload\n', 'utf8'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const fence = { version: 1, token: '12345678-1234-1234-1234-123456789abc' }, paths = []
  const respond = (url, body, status = 200) => ({ status, url: url.href, redirected: false,
    headers: { get: () => 'application/json' }, json: async () => body })
  const fetchFn = async (url, init) => {
    paths.push(url.pathname)
    if (url.pathname.endsWith('/commands')) return respond(url, { items: [textCommand] })
    if (url.pathname.endsWith('/lease')) return respond(url, { executionId: 'exec-1', ...fence, expiresAt: Date.now() + 600000 })
    if (url.pathname.endsWith('/inputs')) return respond(url, { executionId: 'exec-1', leaseVersion: 1, noReferencedMaterials: true, inputs: [] })
    if (url.pathname.endsWith('/provider-start')) return respond(url, { started: true })
    if (url.pathname.endsWith('/outputs/output_1/content')) {
      const form = init.body
      assert.equal(form.get('file').name, 'output.txt')
      assert.equal(form.get('sha256'), sha256); assert.equal(form.get('length'), String(bytes.length))
      return respond(url, { outputId: 'output_1', state: 'STAGED', sha256, byteLength: bytes.length }, 201)
    }
    if (url.pathname.includes('/output-commits/')) {
      const expected = buildOutputCommit({ taskId: 'task-1', runId: 'run-1', uploads: [{ outputId: 'output_1', sha256, length: bytes.length }] }).manifestId
      assert.equal(url.pathname.split('/').at(-1), expected)
      return respond(url, { manifestId: expected, state: 'COMMITTED', items: [{ outputId: 'output_1', sha256 }] })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }
  const lane = new NativeConversationLane({ apiOrigin: 'http://127.0.0.1:10018', rootDir: root, fetchFn,
    agentId: 'agent-1', runtimeInstanceId: 'instance-1', getRuntimeHeaders: () => ({
      Authorization: `AgentRuntime rts1_${'a'.repeat(64)}`, 'X-Agent-Id': 'agent-1', 'X-Agent-Runtime-Id': 'instance-1',
      'X-Agent-Installation-Id': 'test-install', 'X-Agent-Host-Id': 'test-host', 'X-Agent-Session-Generation': '1'
    }), execute: async ({ command: received, inputs, runDirectory }) => {
      assert.equal(received.outputContentMimeType, 'text/plain'); assert.deepEqual(inputs, [])
      writeFileSync(resolve(runDirectory, 'outputs/result.txt'), bytes)
      const output = await invoke(runDirectory, async () => ({ status: 'completed' }), received)
      return { outputId: output.outputId, contentType: output.contentType, bytes: output.bytes }
    } })
  assert.deepEqual(await lane.poll(), { processed: 1 })
  assert.equal(paths.filter(path => path.endsWith('/provider-start')).length, 1)
  assert.ok(paths.some(path => path.endsWith('/outputs/output_1/content')))
  assert.ok(paths.some(path => path.includes('/output-commits/')))
})


test('Runtime installer payload closure ships the text executor and advances the Runtime package version', () => {
  assert.ok(EXECUTION_PAYLOAD_FILES.includes('conversation-text-file.mjs'))
  assert.ok(EXECUTION_PAYLOAD_FILES.includes('conversation-native.mjs'))
  assert.ok(EXECUTION_PAYLOAD_FILES.includes('workspace-file-bridge.mjs'))
  const runtimePackage = JSON.parse(readFileSync(new URL('../../cyf-agent-runtime-v1/package.json', import.meta.url), 'utf8'))
  assert.equal(runtimePackage.version, '1.1.0')
  for (const path of ['materials-chat.mjs', 'skill-conversation.mjs', 'skill-runners/local-script.mjs', 'skill-runners/native-model.mjs', 'skill-runners/image-provider.mjs']) assert.ok(EXECUTION_PAYLOAD_FILES.includes(path), path)
})
