import { PROCESS_RUNTIME_INSTANCE_ID as proofRuntimeId } from '../agent-client.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  buildAgentRegistrationPayload,
  createNativeBountyExecutionRuntime,
  normalizeProfile
} from '../agent-client.mjs'

const sessionProof = (auth, agentId = 'controlled-agent', runtimeInstanceId = proofRuntimeId) => ({
  Authorization: auth, 'X-Agent-Id': agentId, 'X-Agent-Runtime-Id': runtimeInstanceId,
  'X-Agent-Installation-Id': 'synthetic-installation', 'X-Agent-Host-Id': 'synthetic-host',
  'X-Agent-Session-Generation': '7'
})
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24, 5)])
const digest = createHash('sha256').update(png).digest('hex')
const token = '12345678-1234-1234-1234-123456789abc'
const providerExecution = Object.freeze({
  providerLane: 'CONTROLLED_IMAGE_HTTP_V1', consentId: 'consent_1234567890abcdef1234567890abcdef',
  bindingId: 'binding-1', bindingEpoch: '7', modelId: 'operator-model', maxInputItems: 16,
  maxOutboundRequestAttempts: 1, precallFenceVersion: 1
})
const command = Object.freeze({
  schemaVersion: 2,
  taskId: 'task-1',
  runId: 'run-1',
  conversationId: 'conversation-1',
  commandId: 'command-1',
  messageId: 'message-1',
  instruction: '生成一幅受控图像',
  outputContentMimeType: 'image/png',
  outputId: 'output_1',
  providerExecution
})
const json = (url, payload, status = 200) => ({
  status,
  redirected: false,
  url: url.href,
  headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null },
  json: async () => payload
})

const filesBelow = root => {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else files.push(child)
    }
  }
  visit(root)
  return files
}

const setup = (t, { startMode = 'success' } = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-runtime-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = normalizeProfile({
    profileId: 'controlled-profile',
    agentId: 'controlled-agent',
    agentName: 'Controlled Agent',
    personaName: 'Controlled Agent',
    workspaceFileApiOrigin: 'http://127.0.0.1:10018',
    workspaceFileRootDir: resolve(root, 'native'),
    nativeConversationHttpPollEnabled: true,
    nativeConversationImageGenerationEnabled: false,
    controlledImageHttpEnabled: true,
    controlledImageHttpEndpoint: 'https://images.example.test',
    controlledImageHttpApiKeyEnv: 'CONTROLLED_IMAGE_KEY',
    controlledImageHttpModelId: 'operator-model',
    controlledImageHttpBindingId: 'binding-1',
    controlledImageHttpBindingEpoch: '7',
    controlledImageHttpLedgerRoot: resolve(root, 'ledger')
  })
  const events = []
  let providerCalls = 0
  const nativeFetchFn = async (url, init) => {
    events.push(`native:${url.pathname}`)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, `AgentRuntime rts1_${'a'.repeat(64)}`)
    if (url.pathname.endsWith('/commands')) return json(url, { items: [command] })
    if (url.pathname.endsWith('/lease')) return json(url, {
      executionId: 'execution-1', version: 1, token, expiresAt: Date.now() + 900000
    })
    if (url.pathname.endsWith('/conversation/inputs')) return json(url, {
      executionId: 'execution-1', leaseVersion: 1, noReferencedMaterials: true, inputs: []
    })
    if (url.pathname.endsWith('/provider-start-controlled-image')) {
      if (startMode === 'lost') throw new Error('response lost after durable START')
      if (startMode === 'malformed') return json(url, { started: 'true' })
      if (startMode === 'rejected') return json(url, { error: 'not started' }, 409)
      return json(url, { schemaVersion: 2, started: true, taskId: command.taskId, runId: command.runId,
        executionId: 'execution-1', commandId: command.commandId, messageId: command.messageId,
        providerExecution, leaseVersion: 1 })
    }
    if (url.pathname.endsWith('/outputs/output_1/content')) {
      assert.ok(init.body instanceof FormData)
      assert.equal(init.body.get('sha256'), digest)
      return json(url, { outputId: 'output_1', state: 'STAGED', sha256: digest, byteLength: png.length }, 201)
    }
    if (url.pathname.includes('/output-commits/')) return json(url, {
      manifestId: url.pathname.split('/').at(-1),
      state: 'COMMITTED',
      items: [{ outputId: 'output_1', sha256: digest }]
    })
    throw new Error(`unexpected native endpoint ${url.pathname}`)
  }
  const providerFetchFn = async (url, init) => {
    providerCalls++
    events.push(`provider:${url.pathname}`)
    assert.equal(events.at(-2), 'native:/internal/agent/tasks/task-1/runs/run-1/conversation/provider-start-controlled-image')
    assert.equal(url.href, 'https://images.example.test/v1/images/generations')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer provider-secret')
    assert.deepEqual(JSON.parse(init.body), {
      model: 'operator-model', prompt: '生成一幅受控图像', n: 1, output_format: 'png'
    })
    return json(url, { data: [{ b64_json: png.toString('base64') }] })
  }
  const runtime = createNativeBountyExecutionRuntime({
    profile,
    workspaceFileBridge: null,
    toolchainReady: false,
    getRuntimeHeaders: () => sessionProof(`AgentRuntime rts1_${'a'.repeat(64)}`),
    controlledEnv: { CONTROLLED_IMAGE_KEY: 'provider-secret' },
    nativeFetchFn,
    providerFetchFn
  })
  return { root, profile, runtime, events, providerCalls: () => providerCalls }
}

test('real controlled runtime registers only its sibling and fetches once after successful Provider START', async t => {
  const fixture = setup(t)
  assert.equal(fixture.runtime.adapterKind, 'CONTROLLED_IMAGE_HTTP_V1')
  assert.equal(fixture.runtime.nativeBountyV1Ready, false)
  const registration = buildAgentRegistrationPayload(fixture.profile, fixture.runtime, true)
  assert.deepEqual(registration.nativeProviderCredentialBinding, {
    schemaVersion: 1,
    enabled: true,
    providerLane: 'CONTROLLED_IMAGE_HTTP_V1',
    bindingId: 'binding-1',
    bindingEpoch: '7',
    modelId: 'operator-model',
    maxInputItems: 16,
    maxOutboundRequestAttempts: 1,
    precallFenceVersion: 1
  })
  assert.equal(registration.nativeBountyExecution.enabled, false)
  assert.deepEqual(registration.nativeBountyExecution.operations, [])
  assert.deepEqual(registration.controlledImageBountyExecution, {
    schemaVersion: 1, enabled: true, transport: 'PERSONAL_WORKSPACE_CONTROLLED_IMAGE_HTTP_V2',
    commandSchemaVersions: [2], leaseProtocolVersions: [1], providerStartFenceVersions: [2], resultCommitProtocolVersions: [1],
    operations: [{ operation: 'GENERATE_IMAGE', inputManifest: { schemaVersion: 1, minItems: 0, maxItems: 16, mimeTypes: ['image/jpeg', 'image/png'] },
      resultManifest: { schemaVersion: 1, minItems: 1, maxItems: 1, outputId: 'output_1', mimeTypes: ['image/png'] } }]
  })

  assert.deepEqual(await fixture.runtime.pollProtocol.poll(), { processed: 1 })
  assert.equal(fixture.providerCalls(), 1)
  assert.ok(fixture.events.indexOf('provider:/v1/images/generations')
    > fixture.events.indexOf('native:/internal/agent/tasks/task-1/runs/run-1/conversation/provider-start-controlled-image'))
  assert.equal(filesBelow(resolve(fixture.root, 'ledger')).filter(path => path.endsWith('.json')).length, 1)
})

test('lost, malformed, or rejected Provider START never reaches the controlled Provider adapter', async t => {
  for (const startMode of ['lost', 'malformed', 'rejected']) {
    await t.test(startMode, async t => {
      const fixture = setup(t, { startMode })
      await assert.rejects(fixture.runtime.pollProtocol.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
      assert.equal(fixture.providerCalls(), 0)
      assert.equal(fixture.events.some(value => value.startsWith('provider:')), false)
      assert.equal(filesBelow(resolve(fixture.root, 'ledger')).filter(path => path.endsWith('.json')).length, 0)
    })
  }
})
