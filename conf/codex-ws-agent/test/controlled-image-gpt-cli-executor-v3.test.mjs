import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { resolveControlledImageGptCliConfig } from '../controlled-image-gpt-cli-config.mjs'
import { ControlledImageGptCliEgressGate } from '../controlled-image-gpt-cli-egress-gate.mjs'
import { ControlledImageGptCliExecutorV3 } from '../controlled-image-gpt-cli-executor-v3.mjs'
import { ControlledImageHttpLedger } from '../controlled-image-http-ledger.mjs'

const PYTHON = process.env.CYF_GPT_IMAGE_CLI_TEST_PYTHON || ''
const CODEX_DIR = process.env.CYF_GPT_IMAGE_CLI_TEST_CODEX_DIR || '/root/.codex'
const RUNNER = `${CODEX_DIR}/skills/gpt-image-cli/scripts/run.py`
const VERIFIER = `${CODEX_DIR}/skills/gpt-image-cli/scripts/verify_images.py`
const IMAGE_GEN = `${CODEX_DIR}/skills/.system/imagegen/scripts/image_gen.py`
const integrationReady = [PYTHON, RUNNER, VERIFIER, IMAGE_GEN].every(existsSync)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgEpH7DwABpAE8k4sOtwAAAABJRU5ErkJggg==', 'base64')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fileSha = path => sha(readFileSync(path))
const providerConfig = root => Object.freeze({ enabled: true, endpoint: 'https://images.example.test', apiKeyEnv: 'IMAGE_KEY',
  modelId: 'gpt-image-2.5', bindingId: 'binding-cli-1', bindingEpoch: '8', maxInputItems: 16,
  maxOutboundRequestAttempts: 1, precallFenceVersion: 1, ledgerRoot: resolve(root, 'ledger'),
  providerLane: 'CONTROLLED_IMAGE_HTTP_V1' })
const cliProfile = () => ({ controlledImageExecutorKind: 'GPT_IMAGE_CLI_V1', controlledImageCliPython: PYTHON,
  controlledImageCliPythonSha256: fileSha(PYTHON), controlledImageCliRunner: RUNNER,
  controlledImageCliRunnerSha256: fileSha(RUNNER), controlledImageCliVerifier: VERIFIER,
  controlledImageCliVerifierSha256: fileSha(VERIFIER), controlledImageCliCodexDir: CODEX_DIR,
  controlledImageCliImageGenSha256: fileSha(IMAGE_GEN) })
const workspaceSource = Object.freeze({ kind: 'TASK_LINKED_WORKSPACE_VERSION', fileId: 'file_1', version: '3', purpose: 'REFERENCE' })
const assetSource = Object.freeze({ kind: 'CURRENT_CONVERSATION_ASSET', conversationId: 'conversation_1',
  conversationGeneration: '7', assetId: 'ast_previous', assetRevision: '1', producerRequestId: 'request_previous',
  producerStepId: 'step_previous', producerExecutionId: 'execution_previous', producerRunId: 'run_previous',
  producerOutputId: 'output_1' })
const command = (id, operation = 'GENERATE_IMAGE') => Object.freeze({ schemaVersion: 3, executionId: `execution_${id}`,
  taskId: 'task_1', runId: `run_${id}`, conversationId: 'conversation_1', commandId: id, operation,
  instruction: operation === 'EDIT_IMAGE' ? '把上一稿改成黄昏' : '生成一幅山水画', inputSnapshotDigest: 'a'.repeat(64),
  outputId: 'output_1', outputContentMimeType: 'image/png' })
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-cli-executor-'))
  const runDirectory = resolve(root, 'run')
  for (const part of ['inputs', 'outputs', 'scratch']) mkdirSync(resolve(runDirectory, part), { recursive: true, mode: 0o700 })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ledger = new ControlledImageHttpLedger({ rootDir: resolve(root, 'ledger'), profileId: 'profile-a',
    agentId: 'agent-a' })
  return { root, runDirectory, ledger }
}
const materialized = (f, source, index = 1) => {
  const relativePath = `inputs/input_${index}.png`
  writeFileSync(resolve(f.runDirectory, relativePath), png, { mode: 0o600 })
  return Object.freeze({ inputRef: `input_${index}`, relativePath, source, contentType: 'image/png',
    byteLength: String(png.length), sha256: sha(png) })
}
const response = status => new Response(JSON.stringify(status === 200
  ? { data: [{ b64_json: png.toString('base64') }] }
  : { error: { message: 'fixture rejection', type: 'fixture_error' } }),
{ status, headers: { 'content-type': 'application/json' } })
const make = (f, fetchFn, gates = []) => new ControlledImageGptCliExecutorV3({
  profile: { profileId: 'profile-a', agentId: 'agent-a' }, providerConfig: providerConfig(f.root),
  cliConfig: resolveControlledImageGptCliConfig(cliProfile()), credential: 'provider-secret', ledger: f.ledger,
  providerFetchFn: fetchFn, createGate: options => { const gate = new ControlledImageGptCliEgressGate(options); gates.push(gate); return gate }
})

const actual = integrationReady ? test : test.skip

actual('actual unmodified run.py and image_gen.py generate through one controlled fake upstream then verify PNG', async t => {
  const f = fixture(t); const gates = []; let upstream = 0
  const selected = command('command_cli_generate')
  const executor = make(f, async (url, init) => {
    upstream++
    assert.equal(existsSync(f.ledger.claimPath(selected.commandId)), true)
    assert.equal(url.href, 'https://images.example.test/v1/images/generations')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer provider-secret')
    return response(200)
  }, gates)
  const output = await executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] })
  assert.deepEqual(output, { outputId: 'output_1', contentType: 'image/png', bytes: png })
  assert.equal(upstream, 1)
  assert.equal(gates[0].providerAttempts, 1)
  assert.equal(gates[0].localRequests, 1)
})

actual('actual unmodified CLI edit sends the exact materialized current asset through multipart once', async t => {
  const f = fixture(t); const gates = []; let upstream = 0
  const selected = command('command_cli_edit', 'EDIT_IMAGE')
  const input = materialized(f, assetSource)
  const executor = make(f, async (url, init) => {
    upstream++
    assert.equal(url.href, 'https://images.example.test/v1/images/edits')
    assert.match(init.headers['Content-Type'], /^multipart\/form-data;/)
    return response(200)
  }, gates)
  const output = await executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [input] })
  assert.deepEqual(output.bytes, png)
  assert.equal(upstream, 1)
  assert.equal(gates[0].providerAttempts, 1)
})

actual('SDK retry behavior can hit loopback again but never creates a second upstream request', async t => {
  const f = fixture(t); const gates = []; let upstream = 0
  const selected = command('command_cli_retry_fence')
  const executor = make(f, async () => { upstream++; return response(500) }, gates)
  await assert.rejects(executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_OUTCOME_UNKNOWN')
  assert.equal(upstream, 1)
  assert.equal(gates[0].providerAttempts, 1)
  assert.ok(gates[0].localRequests >= 2, 'the real SDK should retry locally after the fixture 500')
  const replayRun = resolve(f.root, 'replay-run')
  for (const part of ['inputs', 'outputs', 'scratch']) mkdirSync(resolve(replayRun, part), { recursive: true, mode: 0o700 })
  await assert.rejects(executor.execute({ command: selected, runDirectory: replayRun, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  assert.equal(upstream, 1)
})

actual('upstream redirect/network rejection remains one unknown attempt and is not followed or retried upstream', async t => {
  const f = fixture(t); const gates = []; let upstream = 0
  const executor = make(f, async (url, init) => {
    upstream++
    assert.equal(init.redirect, 'error')
    throw new TypeError('redirect blocked by fixture')
  }, gates)
  await assert.rejects(executor.execute({ command: command('command_cli_redirect'), runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_OUTCOME_UNKNOWN')
  assert.equal(upstream, 1)
  assert.equal(gates[0].providerAttempts, 1)
})

actual('workspace reference generation uses edit without changing the business operation or source identity', async t => {
  const f = fixture(t); let path = ''
  const selected = command('command_cli_reference')
  const input = materialized(f, workspaceSource)
  const executor = make(f, async url => { path = url.pathname; return response(200) })
  await executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [input] })
  assert.equal(path, '/v1/images/edits')
})

actual('invalid Provider image bytes retain the claim and never create a second upstream request', async t => {
  const f = fixture(t); const gates = []; let upstream = 0
  const selected = command('command_cli_invalid_output')
  const executor = make(f, async () => {
    upstream++
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not-a-png').toString('base64') }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }, gates)
  await assert.rejects(executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] }),
    error => ['CONTROLLED_IMAGE_OUTCOME_UNKNOWN', 'CONTROLLED_IMAGE_RESPONSE_INVALID'].includes(error.code))
  assert.equal(upstream, 1)
  assert.equal(gates[0].providerAttempts, 1)
  assert.equal(existsSync(f.ledger.claimPath(selected.commandId)), true)
})

actual('an existing direct HTTP lane claim blocks CLI execution for the same command after adapter switching', async t => {
  const f = fixture(t); let upstream = 0
  const selected = command('command_cross_adapter_claim')
  f.ledger.createClaim({ commandId: selected.commandId, requestDigest: 'b'.repeat(64),
    bindingId: 'binding-cli-1', bindingEpoch: '7', modelId: 'gpt-image-2.5' })
  const executor = make(f, async () => { upstream++; return response(200) })
  await assert.rejects(executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  assert.equal(upstream, 0)
})

actual('ordinary workspace INPUT edit and mixed generation preserve selected bytes through the actual CLI', async t => {
  for (const [operation, sources] of [
    ['EDIT_IMAGE', [{ ...workspaceSource, purpose: 'INPUT' }]],
    ['GENERATE_IMAGE', [{ ...workspaceSource, purpose: 'INPUT' }, assetSource]],
    ['GENERATE_IMAGE', [assetSource]]
  ]) {
    await t.test(`${operation}-${sources.length}-${sources[0].kind}`, async t => {
      const f = fixture(t); let upstream = 0
      const selected = command('ordinary_materials', operation)
      const inputs = sources.map((source, index) => materialized(f, source, index + 1))
      const executor = make(f, async (url, init) => {
        upstream++
        assert.equal(url.pathname, '/v1/images/edits')
        const body = Buffer.from(init.body)
        assert.equal(body.includes(png), true, 'real PNG input bytes reach the fake upstream')
        assert.equal((body.toString('latin1').match(/filename="input_[12]\.png"/g) || []).length, sources.length)
        return response(200)
      })
      assert.deepEqual((await executor.execute({ command: selected, runDirectory: f.runDirectory, inputs })).bytes, png)
      assert.equal(upstream, 1)
      assert.deepEqual(inputs.map(input => input.source), sources)
    })
  }
})
