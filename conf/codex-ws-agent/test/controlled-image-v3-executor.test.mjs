import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ControlledImageHttpExecutorV3 } from '../controlled-image-http-executor-v3.mjs'
import { ControlledImageHttpLedger } from '../controlled-image-http-ledger.mjs'

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 3)])
const jpeg = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(32, 4)])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const response = (url, payload = { data: [{ b64_json: png.toString('base64') }] }, status = 200) => ({
  status, redirected: false, url: url.href,
  headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null },
  json: async () => payload
})
const config = root => Object.freeze({ enabled: true, endpoint: 'https://images.example.test', apiKeyEnv: 'IMAGE_KEY',
  modelId: 'operator-model', bindingId: 'binding-1', bindingEpoch: '1', maxInputItems: 16,
  maxOutboundRequestAttempts: 1, precallFenceVersion: 1, ledgerRoot: resolve(root, 'ledger'),
  providerLane: 'CONTROLLED_IMAGE_HTTP_V1' })
const workspaceSource = (fileId = 'file_1') => Object.freeze({ kind: 'TASK_LINKED_WORKSPACE_VERSION',
  fileId, version: '3', purpose: 'REFERENCE' })
const assetSource = Object.freeze({ kind: 'CURRENT_CONVERSATION_ASSET', conversationId: 'conversation_1',
  conversationGeneration: '7', assetId: 'ast_previous', assetRevision: '1',
  producerRequestId: 'request_previous', producerStepId: 'step_previous',
  producerExecutionId: 'execution_previous', producerRunId: 'run_previous', producerOutputId: 'output_1' })
const command = (commandId, operation = 'GENERATE_IMAGE') => Object.freeze({ schemaVersion: 3,
  executionId: `execution_${commandId}`, taskId: 'task_1', runId: `run_${commandId}`,
  conversationId: 'conversation_1', commandId, operation,
  instruction: operation === 'EDIT_IMAGE' ? '把上一稿改成黄昏' : '生成一幅山水画',
  inputSnapshotDigest: operation === 'EDIT_IMAGE' ? 'b'.repeat(64) : 'a'.repeat(64),
  outputId: 'output_1', outputContentMimeType: 'image/png' })
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-v3-executor-'))
  const runDirectory = resolve(root, 'run')
  for (const part of ['inputs', 'outputs', 'scratch']) mkdirSync(resolve(runDirectory, part), { recursive: true, mode: 0o700 })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ledger = new ControlledImageHttpLedger({ rootDir: resolve(root, 'ledger'), profileId: 'profile-a', agentId: 'agent-a' })
  return { root, runDirectory, ledger }
}
const materialized = (f, source, bytes = png, index = 1) => {
  const ext = bytes === jpeg ? 'jpg' : 'png'
  const contentType = bytes === jpeg ? 'image/jpeg' : 'image/png'
  const relativePath = `inputs/input_${index}.${ext}`
  writeFileSync(resolve(f.runDirectory, relativePath), bytes, { mode: 0o600 })
  return Object.freeze({ inputRef: `input_${index}`, relativePath, source, contentType,
    byteLength: String(bytes.length), sha256: sha(bytes) })
}
const make = (f, fetchFn, ledger = f.ledger) => new ControlledImageHttpExecutorV3({
  profile: { profileId: 'profile-a', agentId: 'agent-a' }, config: config(f.root),
  credential: 'provider-secret', fetchFn, ledger
})

const assertProviderBody = (options, expected) => {
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers.Authorization, 'Bearer provider-secret')
  assert.equal(options.headers['Content-Type'], 'application/json')
  const body = JSON.parse(options.body)
  assert.deepEqual(body, expected)
  assert.equal('response_format' in body, false)
  assert.equal(JSON.stringify(body).includes('file_id'), false)
  assert.equal(JSON.stringify(body).includes('https://'), false)
}

test('v3 empty generation durably claims before one exact generations request', async t => {
  const f = fixture(t)
  const selected = command('command_empty')
  let calls = 0
  const executor = make(f, async (url, options) => {
    calls++
    assert.equal(existsSync(f.ledger.claimPath(selected.commandId)), true)
    assert.equal(url.href, 'https://images.example.test/v1/images/generations')
    assertProviderBody(options, { model: 'operator-model', prompt: selected.instruction, n: 1, output_format: 'png' })
    return response(url)
  })
  const output = await executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] })
  assert.equal(calls, 1)
  assert.deepEqual(output, { outputId: 'output_1', contentType: 'image/png', bytes: png })
})

test('workspace GENERATE and exact current-conversation EDIT route to JSON edits with source-aware claims', async t => {
  for (const scenario of [
    { id: 'workspace', operation: 'GENERATE_IMAGE', source: workspaceSource(), bytes: jpeg },
    { id: 'asset', operation: 'EDIT_IMAGE', source: assetSource, bytes: png },
    { id: 'workspace_input_edit', operation: 'EDIT_IMAGE', source: { ...workspaceSource(), purpose: 'INPUT' }, bytes: png },
    { id: 'asset_generate', operation: 'GENERATE_IMAGE', source: assetSource, bytes: png }
  ]) {
    await t.test(scenario.id, async t => {
      const f = fixture(t)
      const selected = command(`command_${scenario.id}`, scenario.operation)
      const input = materialized(f, scenario.source, scenario.bytes)
      const executor = make(f, async (url, options) => {
        assert.equal(existsSync(f.ledger.claimPath(selected.commandId)), true)
        assert.equal(url.href, 'https://images.example.test/v1/images/edits')
        assertProviderBody(options, { model: 'operator-model', prompt: selected.instruction,
          images: [{ image_url: `data:${input.contentType};base64,${scenario.bytes.toString('base64')}` }],
          n: 1, output_format: 'png' })
        return response(url)
      })
      assert.deepEqual((await executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [input] })).bytes, png)
      const claim = JSON.parse(readFileSync(f.ledger.claimPath(selected.commandId), 'utf8'))
      assert.match(claim.requestDigest, /^[a-f0-9]{64}$/)
    })
  }
})

test('same command with changed operation or source revision is blocked by the original durable claim', async t => {
  const f = fixture(t)
  let calls = 0
  const executor = make(f, async url => { calls++; return response(url) })
  const first = command('command_same', 'GENERATE_IMAGE')
  const workspace = materialized(f, workspaceSource(), png)
  await executor.execute({ command: first, runDirectory: f.runDirectory, inputs: [workspace] })
  const originalClaim = JSON.parse(readFileSync(f.ledger.claimPath(first.commandId), 'utf8'))
  const changed = command('command_same', 'EDIT_IMAGE')
  await assert.rejects(executor.execute({ command: changed, runDirectory: f.runDirectory,
    inputs: [{ ...workspace, source: assetSource }] }), error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  const restartedLedger = new ControlledImageHttpLedger({ rootDir: resolve(f.root, 'ledger'), profileId: 'profile-a', agentId: 'agent-a' })
  const restarted = make(f, async () => { calls++; return response(new URL('https://images.example.test/v1/images/edits')) }, restartedLedger)
  await assert.rejects(restarted.execute({ command: first, runDirectory: f.runDirectory,
    inputs: [{ ...workspace, source: { ...workspace.source, version: '4' } }] }),
  error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  assert.equal(calls, 1)
  assert.deepEqual(JSON.parse(readFileSync(f.ledger.claimPath(first.commandId), 'utf8')), originalClaim)
})

test('malformed source, wrong cardinality, and symlink fail before claim and Provider fetch', async t => {
  const f = fixture(t)
  let calls = 0
  const executor = make(f, async () => { calls++; throw new Error('must not fetch') })
  const valid = materialized(f, workspaceSource(), png)
  const malformed = command('command_malformed')
  await assert.rejects(executor.execute({ command: malformed, runDirectory: f.runDirectory,
    inputs: [{ ...valid, source: { ...workspaceSource(), extra: true } }] }),
  error => error.code === 'CONTROLLED_IMAGE_COMMAND_INVALID')
  assert.equal(existsSync(f.ledger.claimPath(malformed.commandId)), false)

  const noAsset = command('command_no_asset', 'EDIT_IMAGE')
  await assert.rejects(executor.execute({ command: noAsset, runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_COMMAND_INVALID')
  assert.equal(existsSync(f.ledger.claimPath(noAsset.commandId)), false)

  rmSync(resolve(f.runDirectory, valid.relativePath))
  const external = resolve(f.root, 'external.png')
  writeFileSync(external, png, { mode: 0o600 })
  symlinkSync(external, resolve(f.runDirectory, valid.relativePath))
  const symlink = command('command_symlink')
  await assert.rejects(executor.execute({ command: symlink, runDirectory: f.runDirectory, inputs: [valid] }),
    error => error.code === 'CONTROLLED_IMAGE_INPUT_INVALID')
  assert.equal(existsSync(f.ledger.claimPath(symlink.commandId)), false)
  assert.equal(calls, 0)
})

test('unknown network outcome retains the v3 claim and restart attempt never fetches twice', async t => {
  const f = fixture(t)
  let calls = 0
  const selected = command('command_unknown')
  const executor = make(f, async () => { calls++; throw new Error('socket lost') })
  await assert.rejects(executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_OUTCOME_UNKNOWN')
  const restartedLedger = new ControlledImageHttpLedger({ rootDir: resolve(f.root, 'ledger'), profileId: 'profile-a', agentId: 'agent-a' })
  const restarted = make(f, async () => { calls++; throw new Error('must not fetch after restart') }, restartedLedger)
  await assert.rejects(restarted.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  assert.equal(calls, 1)
  assert.equal(existsSync(f.ledger.claimPath(selected.commandId)), true)
})

// Observed existing Codex connection response: data[0] also contains generation_id.
test('provider generation_id metadata preserves exact output bytes and never authorizes a second call', async t => {
  const f = fixture(t)
  let calls = 0
  const executor = make(f, async url => {
    calls++
    return response(url, { data: [{ b64_json: png.toString('base64'), generation_id: 'provider-generation-1' }] })
  })
  const selected = command('metadata_response')
  const args = { command: selected, runDirectory: f.runDirectory, inputs: [] }
  const output = await executor.execute(args)
  assert.deepEqual(output, { outputId: 'output_1', contentType: 'image/png', bytes: png })
  await assert.rejects(executor.execute(args), error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  assert.equal(calls, 1)
})

test('generation metadata cannot replace image bytes or introduce alternative output/authority fields', async t => {
  const cases = [
    { generation_id: 'provider-generation-1' },
    ...[null, 3, {}, [], ''].map(generation_id => ({ b64_json: png.toString('base64'), generation_id })),
    { b64_json: 'not base64!', generation_id: 'provider-generation-1' },
    { b64_json: png.toString('base64'), generation_id: 'provider-generation-1', url: 'https://example.test/image.png' },
    { b64_json: png.toString('base64'), generation_id: 'provider-generation-1', outputId: 'other-output' }
  ]
  for (const [index, item] of cases.entries()) {
    await t.test(String(index), async t => {
      const f = fixture(t)
      let calls = 0
      const executor = make(f, async url => { calls++; return response(url, { data: [item] }) })
      const args = { command: command(`metadata_invalid_${index}`), runDirectory: f.runDirectory, inputs: [] }
      await assert.rejects(executor.execute(args), error => error.code === 'CONTROLLED_IMAGE_RESPONSE_INVALID')
      await assert.rejects(executor.execute(args), error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
      assert.equal(calls, 1)
    })
  }
})
