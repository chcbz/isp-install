import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ControlledImageConversationLaneV3 } from '../conversation-controlled-image-v3.mjs'
import { controlledImageV3InputDigest } from '../conversation-reference-inputs-v3.mjs'

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24, 9)])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const token = '11111111-1111-4111-8111-111111111111'
const providerExecution = Object.freeze({ providerLane: 'CONTROLLED_IMAGE_HTTP_V1',
  consentId: 'consent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bindingId: 'offline-test-binding',
  bindingEpoch: '1', modelId: 'offline-test-model', maxInputItems: 16,
  maxOutboundRequestAttempts: 1, precallFenceVersion: 1 })
const config = Object.freeze({ enabled: true, providerLane: 'CONTROLLED_IMAGE_HTTP_V1',
  bindingId: 'offline-test-binding', bindingEpoch: '1', modelId: 'offline-test-model',
  maxInputItems: 16, maxOutboundRequestAttempts: 1, precallFenceVersion: 1 })
const auth = `AgentRuntime ${'a'.repeat(32)}`
const json = (url, payload, status = 200) => ({ status, redirected: false, url: url.href,
  headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null }, json: async () => payload })
const binary = (url, bytes) => ({ status: 200, redirected: false, url: url.href,
  headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/octet-stream'
    : key.toLowerCase() === 'content-length' ? String(bytes.length) : null }, arrayBuffer: async () => bytes })

const build = ({ operation = 'EDIT_IMAGE', sources = null, suffix = 'edit' } = {}) => {
  const command = { schemaVersion: 3, executionId: `execution_${suffix}`, taskId: 'task_1', runId: `run_${suffix}`,
    conversationId: 'conversation_1', commandId: `command_${suffix}`, messageId: `message_${suffix}`, operation,
    instruction: operation === 'EDIT_IMAGE' ? '修改上一稿' : '画一只鸟', inputSnapshotDigest: '0'.repeat(64),
    outputContentMimeType: 'image/png', outputId: 'output_1', providerExecution }
  const selected = sources ?? (operation === 'EDIT_IMAGE' ? [{ kind: 'CURRENT_CONVERSATION_ASSET',
    conversationId: 'conversation_1', conversationGeneration: '7', assetId: 'ast_previous', assetRevision: '1',
    producerRequestId: 'request_previous', producerStepId: 'step_previous', producerExecutionId: 'execution_previous',
    producerRunId: 'run_previous', producerOutputId: 'output_1' }] : [])
  const inputs = selected.map((source, index) => ({ inputRef: `input_${index + 1}`, source,
    contentMimeType: 'image/png', byteLength: String(png.length), sha256: sha(png) }))
  const noReferencedMaterials = inputs.length === 0
  command.inputSnapshotDigest = controlledImageV3InputDigest({ command, noReferencedMaterials, inputs }).sha256
  const snapshot = { schemaVersion: 3, executionId: command.executionId, leaseVersion: 1, operation,
    inputSnapshotDigest: command.inputSnapshotDigest, noReferencedMaterials, inputs }
  const receipt = { schemaVersion: 3, started: true, taskId: command.taskId, runId: command.runId,
    conversationId: command.conversationId, executionId: command.executionId, commandId: command.commandId,
    messageId: command.messageId, operation, inputSnapshotDigest: command.inputSnapshotDigest,
    providerExecution, leaseVersion: 1 }
  return { command, snapshot, receipt }
}

const setup = (t, candidate, { receipt = candidate.receipt, startMode = 'success' } = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-v3-lane-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = []
  let executeCalls = 0
  const fetchFn = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, body: init.body })
    if (url.pathname.endsWith('/controlled-image-v3-commands')) return json(url, { items: [candidate.command] })
    if (url.pathname.endsWith('/lease')) return json(url, { executionId: candidate.command.executionId,
      version: 1, token, expiresAt: Date.now() + 600000 })
    if (url.pathname.endsWith('/inputs-v3')) return json(url, candidate.snapshot)
    if (/\/inputs\/input_[0-9]+\/content$/.test(url.pathname)) return binary(url, png)
    if (url.pathname.endsWith('/provider-start-controlled-image-v3')) {
      if (startMode === 'lost') throw new Error('ACK lost')
      if (startMode === 'conflict') return json(url, { error: 'conflict' }, 409)
      return json(url, receipt)
    }
    if (url.pathname.endsWith('/failure')) return json(url, { state: 'FAILED', executionId: candidate.command.executionId })
    if (url.pathname.endsWith('/outputs/output_1/content')) return json(url, { outputId: 'output_1', state: 'STAGED',
      sha256: init.body.get('sha256'), byteLength: Number(init.body.get('length')) }, 201)
    if (url.pathname.includes('/output-commits/')) {
      const body = JSON.parse(init.body)
      return json(url, { state: 'COMMITTED', manifestId: url.pathname.split('/').at(-1),
        items: [{ outputId: 'output_1', sha256: body.outputs[0].sha256 }] })
    }
    throw new Error(`unexpected ${url.pathname}`)
  }
  const lane = new ControlledImageConversationLaneV3({ apiOrigin: 'http://127.0.0.1:10018', rootDir: root,
    fetchFn, agentId: 'controlled-agent', runtimeInstanceId: 'instance-1', getAuth: () => auth,
    controlledConfig: config, execute: async args => { executeCalls++; assert.equal(args.command.operation, candidate.command.operation)
      assert.deepEqual(args.inputs.map(input => input.source), candidate.snapshot.inputs.map(input => input.source))
      return { outputId: 'output_1', contentType: 'image/png', bytes: png } } })
  return { lane, calls, executeCalls: () => executeCalls }
}

test('v3 lane uses the independent inbox, inputs-v3, exact asset source, one START, then existing PNG commit', async t => {
  const candidate = build()
  const fixture = setup(t, candidate)
  assert.deepEqual(await fixture.lane.poll(), { processed: 1 })
  assert.equal(fixture.executeCalls(), 1)
  assert.deepEqual(fixture.calls.map(call => call.path), [
    '/internal/agent/tasks/conversation-executions/controlled-image-v3-commands',
    '/internal/agent/tasks/task_1/runs/run_edit/conversation/lease',
    '/internal/agent/tasks/task_1/runs/run_edit/conversation/inputs-v3',
    '/internal/agent/tasks/task_1/runs/run_edit/conversation/inputs/input_1/content',
    '/internal/agent/tasks/task_1/runs/run_edit/conversation/provider-start-controlled-image-v3',
    '/internal/agent/tasks/task_1/runs/run_edit/conversation/outputs/output_1/content',
    `/internal/agent/tasks/task_1/runs/run_edit/conversation/output-commits/native_${sha(Buffer.from(
      `${candidate.command.executionId}\noutput_1\n${sha(png)}`)).slice(0, 40)}`
  ])
  const start = fixture.calls.find(call => call.path.endsWith('/provider-start-controlled-image-v3'))
  assert.deepEqual(JSON.parse(start.body), { schemaVersion: 3, commandId: candidate.command.commandId,
    messageId: candidate.command.messageId, executionId: candidate.command.executionId,
    operation: candidate.command.operation, inputSnapshotDigest: candidate.command.inputSnapshotDigest,
    providerExecution, fence: { version: 1, token } })
})

test('START ACK loss, conflict, or receipt operation/digest drift yields zero executor calls', async t => {
  const candidate = build({ operation: 'GENERATE_IMAGE', suffix: 'generate' })
  for (const selected of ['lost', 'conflict', 'operation', 'digest']) {
    await t.test(selected, async t => {
      const receipt = structuredClone(candidate.receipt)
      if (selected === 'operation') receipt.operation = 'EDIT_IMAGE'
      if (selected === 'digest') receipt.inputSnapshotDigest = 'f'.repeat(64)
      const fixture = setup(t, candidate, { receipt, startMode: ['lost', 'conflict'].includes(selected) ? selected : 'success' })
      await assert.rejects(fixture.lane.poll(), /CONVERSATION_PROVIDER_START_UNCERTAIN/)
      assert.equal(fixture.executeCalls(), 0)
    })
  }
})

test('17 inputs and operation/source mismatches reject before download, START, or executor', async t => {
  const workspace = index => ({ kind: 'TASK_LINKED_WORKSPACE_VERSION', fileId: `file_${index}`,
    version: String(index), purpose: 'REFERENCE' })
  const over = build({ operation: 'GENERATE_IMAGE', suffix: 'over', sources: Array.from({ length: 17 }, (_, i) => workspace(i + 1)) })
  const wrong = build({ operation: 'EDIT_IMAGE', suffix: 'wrong', sources: [workspace(1)] })
  for (const candidate of [over, wrong]) {
    await t.test(candidate.command.commandId, async t => {
      const fixture = setup(t, candidate)
      assert.deepEqual(await fixture.lane.poll(), { processed: 1 })
      assert.equal(fixture.executeCalls(), 0)
      assert.equal(fixture.calls.some(call => /\/inputs\/input_/.test(call.path)), false)
      assert.equal(fixture.calls.some(call => call.path.endsWith('/provider-start-controlled-image-v3')), false)
    })
  }
})
