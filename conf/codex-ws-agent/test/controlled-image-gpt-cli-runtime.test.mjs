import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildAgentRegistrationPayload,
  createControlledImageV3SourceRuntime,
  createNativeBountyExecutionRuntime,
  normalizeProfile
} from '../agent-client.mjs'
import { controlledImageV3InputDigest } from '../conversation-reference-inputs-v3.mjs'

const PYTHON = process.env.CYF_GPT_IMAGE_CLI_TEST_PYTHON || ''
const CODEX_DIR = process.env.CYF_GPT_IMAGE_CLI_TEST_CODEX_DIR || '/root/.codex'
const RUNNER = `${CODEX_DIR}/skills/gpt-image-cli/scripts/run.py`
const VERIFIER = `${CODEX_DIR}/skills/gpt-image-cli/scripts/verify_images.py`
const IMAGE_GEN = `${CODEX_DIR}/skills/.system/imagegen/scripts/image_gen.py`
const actual = [PYTHON, RUNNER, VERIFIER, IMAGE_GEN].every(existsSync) ? test : test.skip
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgEpH7DwABpAE8k4sOtwAAAABJRU5ErkJggg==', 'base64')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fileSha = path => sha(readFileSync(path))
const token = '12345678-1234-1234-1234-123456789abc'
const providerExecution = Object.freeze({ providerLane: 'CONTROLLED_IMAGE_HTTP_V1',
  consentId: 'consent_1234567890abcdef1234567890abcdef', bindingId: 'binding-cli-1', bindingEpoch: '8',
  modelId: 'gpt-image-2.5', maxInputItems: 16, maxOutboundRequestAttempts: 1, precallFenceVersion: 1 })
const source = Object.freeze({ kind: 'CURRENT_CONVERSATION_ASSET', conversationId: 'conversation-1',
  conversationGeneration: '7', assetId: 'ast-previous', assetRevision: '2', producerRequestId: 'request-previous',
  producerStepId: 'step-previous', producerExecutionId: 'execution-previous', producerRunId: 'run-previous',
  producerOutputId: 'output_1' })
const baseCommand = { schemaVersion: 3, executionId: 'execution-edit', taskId: 'task-1', runId: 'run-edit',
  conversationId: 'conversation-1', commandId: 'command-edit-cli', messageId: 'message-edit', operation: 'EDIT_IMAGE',
  instruction: '把上一稿中的天空改为黄昏', inputSnapshotDigest: '0'.repeat(64), outputContentMimeType: 'image/png',
  outputId: 'output_1', providerExecution }
const input = Object.freeze({ inputRef: 'input_1', source, contentMimeType: 'image/png', byteLength: String(png.length), sha256: sha(png) })
const inputSnapshotDigest = controlledImageV3InputDigest({ command: baseCommand, noReferencedMaterials: false, inputs: [input] }).sha256
const command = Object.freeze({ ...baseCommand, inputSnapshotDigest })
const snapshot = Object.freeze({ schemaVersion: 3, executionId: command.executionId, leaseVersion: 1,
  operation: command.operation, inputSnapshotDigest, noReferencedMaterials: false, inputs: [input] })
const receipt = Object.freeze({ schemaVersion: 3, started: true, taskId: command.taskId, runId: command.runId,
  conversationId: command.conversationId, executionId: command.executionId, commandId: command.commandId,
  messageId: command.messageId, operation: command.operation, inputSnapshotDigest, providerExecution, leaseVersion: 1 })
const json = (url, payload, status = 200) => {
  const bytes = Buffer.from(JSON.stringify(payload))
  return { status, redirected: false, url: url.href,
    headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => payload, arrayBuffer: async () => bytes }
}
const binary = (url, bytes) => ({ status: 200, redirected: false, url: url.href,
  headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/octet-stream'
    : key.toLowerCase() === 'content-length' ? String(bytes.length) : null },
  arrayBuffer: async () => bytes })

actual('local CLI profile registers and completes the real v3 poll START input skill stage commit chain with zero Provider network', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-cli-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = normalizeProfile({ profileId: 'controlled-cli-profile', agentId: 'controlled-cli-agent',
    agentName: 'Controlled CLI Agent', personaName: 'Controlled CLI Agent', workspaceFileApiOrigin: 'http://127.0.0.1:10018',
    workspaceFileRootDir: resolve(root, 'native'), nativeConversationHttpPollEnabled: true,
    nativeConversationImageGenerationEnabled: false, controlledImageHttpEnabled: true,
    controlledImageHttpEndpoint: 'https://images.example.test', controlledImageHttpApiKeyEnv: 'CONTROLLED_IMAGE_KEY',
    controlledImageHttpModelId: 'gpt-image-2.5', controlledImageHttpBindingId: 'binding-cli-1',
    controlledImageHttpBindingEpoch: '8', controlledImageHttpLedgerRoot: resolve(root, 'ledger'),
    controlledImageExecutorKind: 'GPT_IMAGE_CLI_V1', controlledImageCliPython: PYTHON,
    controlledImageCliPythonSha256: fileSha(PYTHON), controlledImageCliRunner: RUNNER,
    controlledImageCliRunnerSha256: fileSha(RUNNER), controlledImageCliVerifier: VERIFIER,
    controlledImageCliVerifierSha256: fileSha(VERIFIER), controlledImageCliCodexDir: CODEX_DIR,
    controlledImageCliImageGenSha256: fileSha(IMAGE_GEN)
  })
  let providerCalls = 0; let startCalls = 0; let stagedBytes = null; let committed = 0
  const nativeFetchFn = async (url, init) => {
    if (url.pathname.endsWith('/controlled-image-v3-commands')) return json(url, { items: [command] })
    if (url.pathname.endsWith('/lease')) return json(url, { executionId: command.executionId, version: 1, token,
      expiresAt: Date.now() + 900000 })
    if (url.pathname.endsWith('/conversation/inputs-v3')) return json(url, snapshot)
    if (url.pathname.endsWith('/conversation/inputs/input_1/content')) return binary(url, png)
    if (url.pathname.endsWith('/provider-start-controlled-image-v3')) { startCalls++; return json(url, receipt) }
    if (url.pathname.endsWith('/outputs/output_1/content')) {
      stagedBytes = Buffer.from(await init.body.get('file').arrayBuffer())
      return json(url, { outputId: 'output_1', state: 'STAGED', sha256: sha(stagedBytes), byteLength: stagedBytes.length }, 201)
    }
    if (url.pathname.includes('/output-commits/')) {
      committed++
      const body = JSON.parse(init.body)
      return json(url, { manifestId: url.pathname.split('/').at(-1), state: 'COMMITTED',
        items: [{ outputId: 'output_1', sha256: body.outputs[0].sha256 }] })
    }
    throw new Error(`unexpected native endpoint ${url.pathname}`)
  }
  const providerFetchFn = async (url, init) => {
    providerCalls++
    assert.equal(startCalls, 1)
    assert.equal(url.href, 'https://images.example.test/v1/images/edits')
    assert.equal(init.redirect, 'error')
    return json(url, { data: [{ b64_json: png.toString('base64') }] })
  }
  const runtime = createControlledImageV3SourceRuntime({ profile, controlledEnv: { CONTROLLED_IMAGE_KEY: 'fixture-secret' },
    getAuth: () => `AgentRuntime ${'a'.repeat(32)}`, nativeFetchFn, providerFetchFn,
    runtimeInstanceId: 'runtime-cli-v3-test' })
  assert.equal(runtime.adapterKind, 'GPT_IMAGE_CLI_V1')
  assert.equal(runtime.controlledImageV3Ready, true)
  const registration = buildAgentRegistrationPayload(profile, null, true, null, null, runtime)
  assert.equal(registration.controlledImageBountyExecutionV3.enabled, true)
  assert.equal(registration.nativeProviderCredentialBinding.enabled, true)
  assert.deepEqual(await runtime.pollProtocol.poll(), { processed: 1 })
  assert.equal(providerCalls, 1)
  assert.equal(startCalls, 1)
  assert.equal(committed, 1)
  assert.deepEqual(stagedBytes, png)
})


test('explicit CLI selection with missing frozen config disables v2 and v3 without constructing HTTP executors', () => {
  const profile = normalizeProfile({
    profileId: 'controlled-cli-disabled', agentId: 'controlled-cli-disabled-agent',
    agentName: 'Controlled CLI Disabled', personaName: 'Controlled CLI Disabled',
    workspaceFileApiOrigin: 'http://127.0.0.1:10018', workspaceFileRootDir: '/private/controlled-cli-disabled',
    nativeConversationHttpPollEnabled: true, nativeConversationImageGenerationEnabled: false,
    controlledImageHttpEnabled: true, controlledImageHttpEndpoint: 'https://images.example.test',
    controlledImageHttpApiKeyEnv: 'CONTROLLED_IMAGE_KEY', controlledImageHttpModelId: 'gpt-image-2.5',
    controlledImageHttpBindingId: 'binding-cli-disabled', controlledImageHttpBindingEpoch: '1',
    controlledImageHttpLedgerRoot: '/private/controlled-cli-disabled-ledger',
    controlledImageExecutorKind: 'GPT_IMAGE_CLI_V1'
  })
  let httpConstructed = 0
  const v3 = createControlledImageV3SourceRuntime({ profile, controlledEnv: { CONTROLLED_IMAGE_KEY: 'fixture-secret' },
    createHttpExecutor: () => { httpConstructed++; return { execute () {} } },
    createPollProtocol: () => ({ poll () {} }) })
  assert.equal(v3.controlledImageV3Ready, false)
  assert.equal(v3.adapterKind, 'GPT_IMAGE_CLI_V1')
  const v2 = createNativeBountyExecutionRuntime({ profile, workspaceFileBridge: {},
    controlledEnv: { CONTROLLED_IMAGE_KEY: 'fixture-secret' },
    createControlledExecutor: () => { httpConstructed++; return { execute () {} } },
    createControlledPollProtocol: () => ({ poll () {} }) })
  assert.equal(v2.controlledImageV2Ready, false)
  assert.equal(v2.adapterKind, 'GPT_IMAGE_CLI_V1')
  assert.equal(httpConstructed, 0)
})
