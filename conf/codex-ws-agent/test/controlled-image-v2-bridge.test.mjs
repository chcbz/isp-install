import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ControlledImageConversationLane, parseControlledImageConversationCommand } from '../conversation-controlled-image.mjs'
import { parseNativeConversationCommand } from '../conversation-native.mjs'
import { buildControlledImageBountyExecutionDeclaration } from '../controlled-image-bounty-capability.mjs'

const fixturePath = resolve(import.meta.dirname, 'fixtures/controlled-image-bridge-v1.json')
const fixtureBytes = readFileSync(fixturePath)
const fixture = JSON.parse(fixtureBytes)
const command = fixture.wire.command
const receipt = fixture.wire.provider_start_receipt
const token = fixture.wire.provider_start_request.fence.token
const config = Object.freeze({ enabled: true, providerLane: 'CONTROLLED_IMAGE_HTTP_V1', bindingId: command.providerExecution.bindingId,
  bindingEpoch: command.providerExecution.bindingEpoch, modelId: command.providerExecution.modelId,
  maxInputItems: 16, maxOutboundRequestAttempts: 1, precallFenceVersion: 1 })
const auth = `AgentRuntime ${'a'.repeat(32)}`
const clone = value => JSON.parse(JSON.stringify(value))
const json = (url, payload, status = 200) => ({ status, redirected: false, url: url.href,
  headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null }, json: async () => payload })

const startReceipt = (base = receipt) => clone(base)
const run = async ({ queued = command, start = startReceipt(), snapshot, execute = async () => {
  throw new Error('executor must not run')
} } = {}) => {
  const calls = []; let executeCalls = 0
  const fetchFn = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, body: init.body })
    if (url.pathname.endsWith('/commands')) return json(url, { items: [queued] })
    if (url.pathname.endsWith('/lease')) return json(url, { executionId: receipt.executionId, version: 1, token, expiresAt: Date.now() + 60000 })
    if (url.pathname.endsWith('/conversation/inputs')) return json(url, snapshot || { executionId: receipt.executionId, leaseVersion: 1, noReferencedMaterials: true, inputs: [] })
    if (url.pathname.endsWith('/provider-start-controlled-image')) {
      if (start === 'lost') return Promise.reject(new Error('ACK lost'))
      if (start === 'conflict') return json(url, { error: 'conflict' }, 409)
      return json(url, start)
    }
    if (url.pathname.endsWith('/failure')) return json(url, { state: 'FAILED', executionId: receipt.executionId })
    if (url.pathname.endsWith('/outputs/output_1/content')) return json(url, { outputId: 'output_1', state: 'STAGED', sha256: '0'.repeat(64), byteLength: 8 }, 201)
    if (url.pathname.includes('/output-commits/')) return json(url, { state: 'COMMITTED', manifestId: url.pathname.split('/').at(-1), items: [{ outputId: 'output_1', sha256: '0'.repeat(64) }] })
    throw new Error(`unexpected ${url.pathname}`)
  }
  const lane = new ControlledImageConversationLane({ apiOrigin: 'http://127.0.0.1:10018', rootDir: '/tmp', fetchFn,
    agentId: 'controlled-agent', runtimeInstanceId: 'instance-1', getAuth: () => auth, controlledConfig: config,
    execute: async args => { executeCalls++; return execute(args) } })
  return { lane, calls, executeCalls: () => executeCalls }
}

test('frozen fixture is byte-exact expectations only', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), 'd19264d19ed04d10e737c526479b2c956b9afb182eb7c26c86a42f50c981ca87')
  for (const group of Object.values(fixture.case_groups)) for (const item of group) assert.equal(item.result, 'NOT_RUN')
})

test('controlled sibling is v2-only while native v1 remains independently parseable', () => {
  const enabled = buildControlledImageBountyExecutionDeclaration({ profile: { enabled: true, controlledImageHttpEnabled: true }, online: true,
    runtime: { adapterKind: 'CONTROLLED_IMAGE_HTTP_V1', configReady: true, credentialReady: true, httpPollEnabled: true,
      controlledImageV2Ready: true, executor: () => {}, pollProtocol: { poll () {} } } })
  assert.deepEqual(enabled, fixture.wire.controlledImageBountyExecution)
  assert.deepEqual(buildControlledImageBountyExecutionDeclaration({}), { ...enabled, enabled: false, operations: [] })
  assert.throws(() => parseControlledImageConversationCommand({ ...command, schemaVersion: 1 }), /CONTROLLED_IMAGE_COMMAND_INVALID/)
  assert.throws(() => parseNativeConversationCommand(command), /CONVERSATION_COMMAND_INVALID/)
})

test('v2 command requires the exact current operator config before lease, inputs, download, or START', async () => {
  for (const field of ['providerLane', 'bindingId', 'bindingEpoch', 'modelId', 'maxInputItems', 'maxOutboundRequestAttempts', 'precallFenceVersion']) {
    const queued = clone(command)
    queued.providerExecution[field] = typeof queued.providerExecution[field] === 'number' ? queued.providerExecution[field] + 1 : `${queued.providerExecution[field]}_drift`
    const s = await run({ queued })
    await assert.rejects(s.lane.poll(), /CONTROLLED_IMAGE_(COMMAND_INVALID|CONFIG_MISMATCH)/)
    assert.deepEqual(s.calls.map(call => call.path), ['/internal/agent/tasks/conversation-executions/commands'], field)
    assert.equal(s.executeCalls(), 0, field)
  }
  const consentDrift = clone(command)
  consentDrift.providerExecution.consentId = 'consent_drift'
  const s = await run({ queued: consentDrift })
  await assert.rejects(s.lane.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
  assert.equal(s.executeCalls(), 0)
  assert.equal(s.calls.some(call => call.path.endsWith('/provider-start-controlled-image')), true)
})

test('START wire is exact and every receipt identity/config/lease mutation yields zero executor calls', async () => {
  const s = await run({ execute: async () => ({ outputId: 'output_1', contentType: 'image/png', bytes: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10])]) }) })
  // The valid receipt path reaches the executor only after the independent v2 START request.
  await assert.rejects(s.lane.poll(), /CONVERSATION_STAGE_UNCERTAIN/)
  const startCall = s.calls.find(call => call.path.endsWith('/provider-start-controlled-image'))
  assert.deepEqual(JSON.parse(startCall.body), fixture.wire.provider_start_request)
  assert.equal(s.executeCalls(), 1)

  const mutations = ['taskId', 'runId', 'executionId', 'commandId', 'messageId', 'leaseVersion']
  for (const field of mutations) {
    const bad = startReceipt(); bad[field] = typeof bad[field] === 'number' ? 2 : `${bad[field]}_drift`
    const x = await run({ start: bad })
    await assert.rejects(x.lane.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
    assert.equal(x.executeCalls(), 0, field)
  }
  for (const field of Object.keys(receipt.providerExecution)) {
    const bad = startReceipt(); bad.providerExecution[field] = typeof bad.providerExecution[field] === 'number' ? 2 : `${bad.providerExecution[field]}_drift`
    const x = await run({ start: bad })
    await assert.rejects(x.lane.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
    assert.equal(x.executeCalls(), 0, field)
  }
  const extra = startReceipt(); extra.extra = true
  const x = await run({ start: extra })
  await assert.rejects(x.lane.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
  assert.equal(x.executeCalls(), 0)
})

test('old START receipt or ACK loss has zero controlled execution and no fallback', async () => {
  for (const start of [{ started: true }, 'lost', 'conflict']) {
    const s = await run({ start })
    await assert.rejects(s.lane.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
    assert.equal(s.executeCalls(), 0)
    assert.equal(s.calls.some(call => call.path.endsWith('/provider-start')), false)
  }
})

test('17 inputs are rejected before downloading or controlled START', async () => {
  const inputs = Array.from({ length: 17 }, (_, index) => ({ inputRef: `input_${index + 1}`, fileId: `file-${index + 1}`,
    version: 1, originalFilename: `input-${index + 1}.png`, contentMimeType: 'image/png', byteLength: 8, sha256: '0'.repeat(64) }))
  const s = await run({ snapshot: { executionId: receipt.executionId, leaseVersion: 1, noReferencedMaterials: false, inputs } })
  assert.deepEqual(await s.lane.poll(), { processed: 1 })
  assert.equal(s.executeCalls(), 0)
  assert.equal(s.calls.some(call => call.path.includes('/inputs/input_')), false)
  assert.equal(s.calls.some(call => call.path.endsWith('/provider-start-controlled-image')), false)
})
