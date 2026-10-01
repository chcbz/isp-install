import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  buildAgentRegistrationPayload,
  createControlledImageV3SourceRuntime,
  normalizeProfile
} from '../agent-client.mjs'
import { controlledImageV3InputDigest } from '../conversation-reference-inputs-v3.mjs'

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24, 5)])
const digest = createHash('sha256').update(png).digest('hex')
const token = '12345678-1234-1234-1234-123456789abc'
const providerExecution = Object.freeze({
  providerLane: 'CONTROLLED_IMAGE_HTTP_V1', consentId: 'consent_1234567890abcdef1234567890abcdef',
  bindingId: 'binding-1', bindingEpoch: '7', modelId: 'operator-model', maxInputItems: 16,
  maxOutboundRequestAttempts: 1, precallFenceVersion: 1
})
const source = Object.freeze({ kind: 'CURRENT_CONVERSATION_ASSET', conversationId: 'conversation-1',
  conversationGeneration: '7', assetId: 'ast-previous', assetRevision: '2',
  producerRequestId: 'request-previous', producerStepId: 'step-previous',
  producerExecutionId: 'execution-previous', producerRunId: 'run-previous', producerOutputId: 'output_1' })
const baseCommand = {
  schemaVersion: 3, executionId: 'execution-edit', taskId: 'task-1', runId: 'run-edit',
  conversationId: 'conversation-1', commandId: 'command-edit', messageId: 'message-edit',
  operation: 'EDIT_IMAGE', instruction: '把上一稿中的天空改为黄昏', inputSnapshotDigest: '0'.repeat(64),
  outputContentMimeType: 'image/png', outputId: 'output_1', providerExecution
}
const input = Object.freeze({ inputRef: 'input_1', source, contentMimeType: 'image/png',
  byteLength: String(png.length), sha256: digest })
const inputSnapshotDigest = controlledImageV3InputDigest({ command: baseCommand,
  noReferencedMaterials: false, inputs: [input] }).sha256
const command = Object.freeze({ ...baseCommand, inputSnapshotDigest })
const snapshot = Object.freeze({ schemaVersion: 3, executionId: command.executionId, leaseVersion: 1,
  operation: command.operation, inputSnapshotDigest, noReferencedMaterials: false, inputs: [input] })
const receipt = Object.freeze({ schemaVersion: 3, started: true, taskId: command.taskId, runId: command.runId,
  conversationId: command.conversationId, executionId: command.executionId, commandId: command.commandId,
  messageId: command.messageId, operation: command.operation, inputSnapshotDigest,
  providerExecution, leaseVersion: 1 })
const json = (url, payload, status = 200) => ({ status, redirected: false, url: url.href,
  headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null }, json: async () => payload })
const binary = (url, bytes) => ({ status: 200, redirected: false, url: url.href,
  headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/octet-stream'
    : key.toLowerCase() === 'content-length' ? String(bytes.length) : null }, arrayBuffer: async () => bytes })
const filesBelow = root => {
  const files = []
  const visit = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name); if (entry.isDirectory()) visit(child); else files.push(child)
  } }
  visit(root)
  return files
}

const setup = (t, { startMode = 'success' } = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-v3-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = normalizeProfile({
    profileId: 'controlled-profile', agentId: 'controlled-agent', agentName: 'Controlled Agent',
    personaName: 'Controlled Agent', workspaceFileApiOrigin: 'http://127.0.0.1:10018',
    workspaceFileRootDir: resolve(root, 'native'), nativeConversationHttpPollEnabled: true,
    nativeConversationImageGenerationEnabled: false, controlledImageHttpEnabled: true,
    controlledImageHttpEndpoint: 'https://images.example.test',
    controlledImageHttpApiKeyEnv: 'CONTROLLED_IMAGE_KEY', controlledImageHttpModelId: 'operator-model',
    controlledImageHttpBindingId: 'binding-1', controlledImageHttpBindingEpoch: '7',
    controlledImageHttpLedgerRoot: resolve(root, 'ledger')
  })
  const events = []
  let providerCalls = 0
  let startCalls = 0
  const nativeFetchFn = async (url, init) => {
    events.push(`native:${url.pathname}`)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, `AgentRuntime ${'a'.repeat(32)}`)
    if (url.pathname.endsWith('/controlled-image-v3-commands')) return json(url, { items: [command] })
    if (url.pathname.endsWith('/lease')) return json(url, {
      executionId: command.executionId, version: 1, token, expiresAt: Date.now() + 900000
    })
    if (url.pathname.endsWith('/conversation/inputs-v3')) {
      assert.deepEqual(JSON.parse(init.body), { version: 1, token })
      return json(url, snapshot)
    }
    if (url.pathname.endsWith('/conversation/inputs/input_1/content')) {
      assert.deepEqual(JSON.parse(init.body), { version: 1, token })
      return binary(url, png)
    }
    if (url.pathname.endsWith('/provider-start-controlled-image-v3')) {
      startCalls++
      assert.deepEqual(JSON.parse(init.body), { schemaVersion: 3, commandId: command.commandId,
        messageId: command.messageId, executionId: command.executionId, operation: command.operation,
        inputSnapshotDigest, providerExecution, fence: { version: 1, token } })
      if (startMode === 'lost') throw new Error('response lost after durable START')
      if (startMode === 'drift') return json(url, { ...receipt, operation: 'GENERATE_IMAGE' })
      return json(url, receipt)
    }
    if (url.pathname.endsWith('/outputs/output_1/content')) {
      assert.ok(init.body instanceof FormData)
      assert.equal(init.body.get('sha256'), digest)
      assert.equal(init.body.get('length'), String(png.length))
      return json(url, { outputId: 'output_1', state: 'STAGED', sha256: digest, byteLength: png.length }, 201)
    }
    if (url.pathname.includes('/output-commits/')) return json(url, {
      manifestId: url.pathname.split('/').at(-1), state: 'COMMITTED',
      items: [{ outputId: 'output_1', sha256: digest }]
    })
    throw new Error(`unexpected native endpoint ${url.pathname}`)
  }
  const providerFetchFn = async (url, init) => {
    providerCalls++
    events.push(`provider:${url.pathname}`)
    assert.equal(events.at(-2), 'native:/internal/agent/tasks/task-1/runs/run-edit/conversation/provider-start-controlled-image-v3')
    assert.equal(url.href, 'https://images.example.test/v1/images/edits')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer provider-secret')
    assert.deepEqual(JSON.parse(init.body), { model: 'operator-model', prompt: command.instruction,
      images: [{ image_url: `data:image/png;base64,${png.toString('base64')}` }], n: 1, output_format: 'png' })
    return json(url, { data: [{ b64_json: png.toString('base64') }] })
  }
  const runtime = createControlledImageV3SourceRuntime({ profile,
    getAuth: () => `AgentRuntime ${'a'.repeat(32)}`, controlledEnv: { CONTROLLED_IMAGE_KEY: 'provider-secret' },
    nativeFetchFn, providerFetchFn, runtimeInstanceId: 'runtime-v3-test' })
  return { root, profile, runtime, events, providerCalls: () => providerCalls, startCalls: () => startCalls }
}

test('registration remains exact disabled while the composed v3 runtime manually executes one exact-asset EDIT', async t => {
  const fixture = setup(t)
  assert.equal(fixture.runtime.configReady, true)
  assert.equal(fixture.runtime.credentialReady, true)
  assert.equal(fixture.runtime.controlledImageV3Ready, false)
  assert.equal(fixture.runtime.adapterKind, 'CONTROLLED_IMAGE_HTTP_V1')
  const registration = buildAgentRegistrationPayload(fixture.profile, fixture.runtime, true)
  assert.deepEqual(registration.controlledImageBountyExecutionV3, {
    schemaVersion: 1, enabled: false, transport: 'PERSONAL_WORKSPACE_CONTROLLED_IMAGE_HTTP_V3',
    commandSchemaVersions: [3], leaseProtocolVersions: [1], providerStartFenceVersions: [3],
    resultCommitProtocolVersions: [1], operations: []
  })

  assert.deepEqual(await fixture.runtime.pollProtocol.poll(), { processed: 1 })
  assert.equal(fixture.startCalls(), 1)
  assert.equal(fixture.providerCalls(), 1)
  assert.ok(fixture.events.indexOf('provider:/v1/images/edits')
    > fixture.events.indexOf('native:/internal/agent/tasks/task-1/runs/run-edit/conversation/provider-start-controlled-image-v3'))
  assert.equal(filesBelow(resolve(fixture.root, 'ledger')).filter(path => path.endsWith('.json')).length, 1)
})

test('lost or drifted v3 START receipt leaves zero Provider calls and zero pre-call claims', async t => {
  for (const startMode of ['lost', 'drift']) {
    await t.test(startMode, async t => {
      const fixture = setup(t, { startMode })
      await assert.rejects(fixture.runtime.pollProtocol.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
      assert.equal(fixture.startCalls(), 1)
      assert.equal(fixture.providerCalls(), 0)
      assert.equal(fixture.events.some(value => value.startsWith('provider:')), false)
      assert.equal(filesBelow(resolve(fixture.root, 'ledger')).filter(path => path.endsWith('.json')).length, 0)
    })
  }
})
