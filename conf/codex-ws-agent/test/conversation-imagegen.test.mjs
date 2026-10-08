import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runNativeConversationImage } from '../agent-client.mjs'

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40, 2)])
const command = Object.freeze({ taskId: 'task-1', commandId: 'command-1', instruction: '画一只鸟',
  outputContentMimeType: 'image/png', outputId: 'output_1' })
const run = (overrides = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), 'mmd-imagegen-'))
  mkdirSync(resolve(root, 'inputs'))
  mkdirSync(resolve(root, 'outputs'))
  mkdirSync(resolve(root, 'scratch'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }),
    args: { profile: { agentId: 'agent-1' }, command, runDirectory: root, inputs: [],
      validateOutput: () => {}, ...overrides } }
}

test('native adapter accepts only a single authenticated imagegen event, never Codex text', async () => {
  const s = run()
  try {
    let calls = 0
    const output = await runNativeConversationImage({ ...s.args, runCodexFn: async (_profile, message, mode, opts) => {
      calls++
      assert.equal(mode, 'command')
      assert.equal(opts.codexWorkdir, s.root)
      assert.equal(opts.forceNewSession, true)
      assert.deepEqual(opts.imagePaths, [])
      assert.match(message.prompt, /画一只鸟/)
      assert.match(message.prompt, /built-in imagegen/)
      opts.onImageGenerationResult({ type: 'image_generation_call', status: 'completed', result: png.toString('base64') })
      return { status: 'completed', output: 'The file is at /tmp/fake.png' }
    } })
    assert.equal(calls, 1)
    assert.equal(output.outputId, 'output_1')
    assert.equal(output.contentType, 'image/png')
    assert.deepEqual(output.bytes, png)
  } finally { s.cleanup() }
})

test('text-only success, duplicate imagegen and uncompleted Codex runs fail without a deliverable', async () => {
  const s = run()
  try {
    await assert.rejects(runNativeConversationImage({ ...s.args, runCodexFn: async () => ({ status: 'completed', output: 'image.png' }) }),
      error => error.code === 'WORKSPACE_IMAGEGEN_RESULT_MISSING')
    await assert.rejects(runNativeConversationImage({ ...s.args, runCodexFn: async (_p, _m, _mode, opts) => {
      for (let i = 0; i < 2; i++) opts.onImageGenerationResult({ type: 'image_generation_call', status: 'completed', result: png.toString('base64') })
      return { status: 'completed' }
    } }), error => error.code === 'WORKSPACE_IMAGEGEN_RESULT_AMBIGUOUS')
    await assert.rejects(runNativeConversationImage({ ...s.args, runCodexFn: async () => ({ status: 'failed' }) }),
      error => error.code === 'CONVERSATION_IMAGEGEN_FAILED')
  } finally { s.cleanup() }
})

test('only private, materialized image input paths are forwarded to imagegen', async () => {
  const s = run()
  try {
    writeFileSync(resolve(s.root, 'inputs/input_1.png'), png)
    const expected = resolve(s.root, 'inputs/input_1.png')
    await runNativeConversationImage({ ...s.args, inputs: [{ relativePath: 'inputs/input_1.png' }],
      runCodexFn: async (_p, message, _mode, opts) => {
        assert.deepEqual(opts.imagePaths, [expected])
        assert.match(message.prompt, /inputs\/input_1.png/)
        opts.onImageGenerationResult({ type: 'image_generation_call', status: 'completed', result: png.toString('base64') })
        return { status: 'completed' }
      } })
    let called = false
    await assert.rejects(runNativeConversationImage({ ...s.args, inputs: [{ relativePath: '../secret.png' }],
      runCodexFn: async () => { called = true } }), error => error.code === 'CONVERSATION_IMAGE_INPUT_INVALID')
    assert.equal(called, false)
  } finally { s.cleanup() }
})
