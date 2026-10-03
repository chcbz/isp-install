import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, readFileSync, lstatSync, mkdirSync, symlinkSync, chmodSync, writeFileSync, linkSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ControlledImageConversationLaneV3 } from '../conversation-controlled-image-v3.mjs'
import { retainControlledImageDeliveryV3, retainedControlledImageDeliveriesV3 } from '../controlled-image-delivery-retention-v3.mjs'
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

const setup = (t, candidate, { receipt = candidate.receipt, startMode = 'success', stageMode = 'success',
  commitMode = 'success', recoveryMode = 'success', executeHook = () => {}, outputBytes = png } = {}) => {
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
    if (url.pathname.endsWith('/outputs/output_1/content')) {
      if (stageMode === 'lost') throw Error('upload ACK lost')
      if (stageMode === '404') return json(url, { unavailable: true }, 404)
      return json(url, { outputId: 'output_1', state: 'STAGED',
        sha256: stageMode === 'drift' ? 'f'.repeat(64) : init.body.get('sha256'), byteLength: Number(init.body.get('length')) }, 201)
    }
    if (url.pathname.includes('/result-commits/')) {
      const body = JSON.parse(init.body); const item = body.outputs[0]
      assert.equal(body.schemaVersion, 1); assert.equal(body.executionId, candidate.command.executionId)
      assert.equal(body.commandId, candidate.command.commandId); assert.equal(body.messageId, candidate.command.messageId)
      assert.equal(body.inputSnapshotDigest, candidate.command.inputSnapshotDigest); assert.equal(body.fence, undefined)
      assert.equal(item.sha256, sha(png)); assert.equal(item.length, png.length)
      const expected = `pwe_m_${sha(Buffer.from(`${candidate.command.taskId}\n${candidate.command.runId}\noutput_1\n${sha(png)}\n${png.length}\n`))}`
      assert.equal(url.pathname.split('/').at(-1), expected)
      if (recoveryMode === 'lost') throw Error('result ACK lost')
      if (recoveryMode === '404') return json(url, { unavailable: true }, 404)
      return json(url, { state: 'COMMITTED', manifestId: expected, items: [{ outputId: 'output_1',
        sha256: recoveryMode === 'drift' ? 'e'.repeat(64) : item.sha256,
        byteLength: item.length, contentMimeType: 'image/png' }] })
    }
    if (url.pathname.includes('/output-commits/')) {
      if (commitMode === 'lost') throw Error('commit ACK lost')
      const body = JSON.parse(init.body)
      // Match the API manifest wire independently, not the requested URL echoed back.
      const item = body.outputs[0]
      const expected = `pwe_m_${sha(Buffer.from(`${candidate.command.taskId}\n${candidate.command.runId}\n${item.outputId}\n${item.sha256}\n${item.length}\n`))}`
      assert.equal(url.pathname.split('/').at(-1), expected, 'server manifest contract')
      return json(url, { state: 'COMMITTED', manifestId: url.pathname.split('/').at(-1),
        items: [{ outputId: 'output_1', sha256: commitMode === 'drift' ? 'e'.repeat(64) : body.outputs[0].sha256 }] })
    }
    throw new Error(`unexpected ${url.pathname}`)
  }
  const lane = new ControlledImageConversationLaneV3({ apiOrigin: 'http://127.0.0.1:10018', rootDir: root,
    fetchFn, agentId: 'controlled-agent', runtimeInstanceId: 'instance-1', getAuth: () => auth,
    controlledConfig: config, execute: async args => { executeCalls++; assert.equal(args.command.operation, candidate.command.operation)
      assert.deepEqual(args.inputs.map(input => input.source), candidate.snapshot.inputs.map(input => input.source))
      executeHook(args)
      return { outputId: 'output_1', contentType: 'image/png', bytes: outputBytes } } })
  return { lane, calls, root, fetchFn, executeCalls: () => executeCalls }
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
    `/internal/agent/tasks/task_1/runs/run_edit/conversation/output-commits/pwe_m_${sha(Buffer.from(
      `task_1\nrun_edit\noutput_1\n${sha(png)}\n${png.length}\n`))}`
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

const retained = fixture => {
  const runs = resolve(fixture.root, 'conversation-runs/controlled-agent')
  const entries = readdirSync(runs)
  assert.equal(entries.length, 1, 'one uncommitted run retained')
  const directory = resolve(runs, entries[0], 'delivery')
  const record = JSON.parse(readFileSync(resolve(directory, 'receipt.json'), 'utf8'))
  const bytes = readFileSync(resolve(directory, 'output_1.png'))
  assert.equal(lstatSync(directory).mode & 0o777, 0o700)
  for (const name of ['receipt.json', 'output_1.png']) assert.equal(lstatSync(resolve(directory, name)).mode & 0o777, 0o600)
  assert.deepEqual(bytes, png)
  assert.equal(record.output.sha256, sha(png))
  assert.equal(record.output.byteLength, png.length)
  assert.equal(record.state, 'DELIVERY_PENDING')
  assert.equal(record.providerReplayAllowed, false)
  assert.equal(JSON.stringify(record).includes(auth), false, 'runtime credential never persisted')
  return record
}

test('paid PNG survives upload 404, lost ACK or mismatched staging receipt without failure or Provider replay', async t => {
  for (const stageMode of ['404', 'lost', 'drift']) await t.test(stageMode, async t => {
    const candidate = build({ operation: 'GENERATE_IMAGE', suffix: 'retained' })
    const fixture = setup(t, candidate, { stageMode })
    await assert.rejects(fixture.lane.poll(), /CONVERSATION_(RESPONSE_UNAVAILABLE|OUTCOME_UNKNOWN|STAGE_UNCERTAIN)/)
    const record = retained(fixture)
    assert.deepEqual(record.command, candidate.command)
    assert.equal(record.apiOrigin, 'http://127.0.0.1:10018')
    assert.equal(record.agentId, 'controlled-agent')
    assert.equal(fixture.executeCalls(), 1)
    assert.equal(fixture.calls.some(x => x.path.endsWith('/failure')), false)
    assert.equal(fixture.calls.some(x => x.path.includes('/output-commits/')), false)
  })
})

test('paid PNG survives uncertain commit without sending failure or repeating generation', async t => {
  for (const commitMode of ['lost', 'drift']) await t.test(commitMode, async t => {
    const fixture = setup(t, build(), { commitMode })
    await assert.rejects(fixture.lane.poll(), /CONVERSATION_(OUTCOME_UNKNOWN|COMMIT_UNCERTAIN)/)
    retained(fixture)
    assert.equal(fixture.executeCalls(), 1)
    assert.equal(fixture.calls.some(x => x.path.endsWith('/failure')), false)
  })
})

test('valid output is retained even when lease expires while Provider runs', async t => {
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const fixture = setup(t, build(), { executeHook: () => { clock += 600001 } })
  await assert.rejects(fixture.lane.poll(), /CONVERSATION_LEASE_UNCERTAIN/)
  retained(fixture)
  assert.equal(fixture.calls.some(x => /\/outputs\/|\/failure$/.test(x.path)), false)
  assert.equal(fixture.executeCalls(), 1)
})

test('only a verified commit clears the private output and recovery receipt', async t => {
  const fixture = setup(t, build())
  await fixture.lane.poll()
  assert.deepEqual(readdirSync(resolve(fixture.root, 'conversation-runs/controlled-agent')), [])
  assert.equal(fixture.executeCalls(), 1)
})

test('invalid output has no retained success record and remains an explicit failure', async t => {
  const fixture = setup(t, build(), { outputBytes: Buffer.from('not a PNG') })
  await fixture.lane.poll()
  assert.deepEqual(readdirSync(resolve(fixture.root, 'conversation-runs/controlled-agent')), [])
  assert.equal(fixture.calls.filter(x => x.path.endsWith('/failure')).length, 1)
})

test('unsafe preexisting delivery path fails closed without erasing produced output or writing outside', async t => {
  let external
  const fixture = setup(t, build(), { executeHook: ({ runDirectory }) => {
    external = resolve(fixture.root, 'outside')
    mkdirSync(external, { mode: 0o700 })
    symlinkSync(external, resolve(runDirectory, 'delivery'))
  } })
  await assert.rejects(fixture.lane.poll(), /CONVERSATION_OUTPUT_PERSISTENCE_UNCERTAIN/)
  assert.deepEqual(readdirSync(external), [])
  assert.equal(readdirSync(resolve(fixture.root, 'conversation-runs/controlled-agent')).length, 1)
  assert.equal(fixture.calls.some(x => /\/outputs\/|\/failure$/.test(x.path)), false)
})


test('retention refuses unsafe roots and never overwrites an existing receipt', async t => {
  for (const variant of ['symlink', 'public-mode', 'existing-record']) await t.test(variant, async t => {
    const root = mkdtempSync(resolve(tmpdir(), 'controlled-v3-retention-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const actual = resolve(root, 'actual'); mkdirSync(actual, { mode: 0o700 })
    let runDirectory = actual
    if (variant === 'symlink') { runDirectory = resolve(root, 'alias'); symlinkSync(actual, runDirectory) }
    if (variant === 'public-mode') chmodSync(actual, 0o755)
    const args = { runDirectory, command: build().command, apiOrigin: 'http://127.0.0.1:10018',
      agentId: 'controlled-agent', output: { outputId: 'output_1', contentType: 'image/png', bytes: png } }
    let first
    if (variant === 'existing-record') {
      retainControlledImageDeliveryV3(args)
      first = readFileSync(resolve(actual, 'delivery/receipt.json'))
    }
    assert.throws(() => retainControlledImageDeliveryV3(args), /CONVERSATION_OUTPUT_PERSISTENCE_UNCERTAIN/)
    if (first) assert.deepEqual(readFileSync(resolve(actual, 'delivery/receipt.json')), first)
    else assert.deepEqual(readdirSync(actual), [])
  })
})


const preserved = (fixture, candidate) => {
  const rootDirectory = resolve(fixture.root, 'conversation-runs/controlled-agent')
  const runDirectory = resolve(rootDirectory, `${candidate.command.runId}-retained`)
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
  retainControlledImageDeliveryV3({ runDirectory, command: candidate.command,
    output: { outputId: 'output_1', contentType: 'image/png', bytes: png },
    apiOrigin: 'http://127.0.0.1:10018', agentId: 'controlled-agent' })
  return { rootDirectory, runDirectory, receipt: readFileSync(resolve(runDirectory, 'delivery/receipt.json')) }
}

test('retained paid result recovers server STAGED/COMMITTED receipt with zero executor, START, input or upload calls', async t => {
  const candidate = build(); const fixture = setup(t, candidate); const saved = preserved(fixture, candidate)
  assert.deepEqual(await fixture.lane.poll(), { processed: 0, recovered: 1 })
  assert.equal(fixture.executeCalls(), 0)
  assert.equal(fixture.calls.filter(x => x.path.includes('/result-commits/')).length, 1)
  assert.ok(fixture.calls.every(x => x.path.includes('/result-commits/') || x.path.endsWith('/controlled-image-v3-commands')))
  assert.deepEqual(readFileSync(resolve(saved.runDirectory, 'delivery/receipt.json')), saved.receipt)
  assert.deepEqual(readFileSync(resolve(saved.runDirectory, 'delivery/output_1.png')), png)
  assert.ok(existsSync(resolve(saved.runDirectory, 'delivery/committed.json')))
  assert.deepEqual(await fixture.lane.poll(), { processed: 0 })
  const restarted = new ControlledImageConversationLaneV3({ apiOrigin: 'http://127.0.0.1:10018', rootDir: fixture.root,
    fetchFn: fixture.fetchFn, agentId: 'controlled-agent', runtimeInstanceId: 'replacement-runtime', getAuth: () => auth,
    controlledConfig: { ...config, bindingId: 'changed-provider-binding' }, execute: async () => assert.fail('no executor') })
  assert.deepEqual(await restarted.poll(), { processed: 0 })
  assert.equal(fixture.calls.filter(x => x.path.includes('/result-commits/')).length, 1)
})

test('uncertain result reconciliation preserves all bytes, stops blind retries and never falls back to generation', async t => {
  for (const recoveryMode of ['lost', '404', 'drift']) await t.test(recoveryMode, async t => {
    const candidate = build(); const fixture = setup(t, candidate, { recoveryMode }); const saved = preserved(fixture, candidate)
    await assert.rejects(fixture.lane.poll(), /CONVERSATION_(OUTCOME_UNKNOWN|RESPONSE_UNAVAILABLE|COMMIT_UNCERTAIN)/)
    assert.deepEqual(readFileSync(resolve(saved.runDirectory, 'delivery/receipt.json')), saved.receipt)
    assert.deepEqual(readFileSync(resolve(saved.runDirectory, 'delivery/output_1.png')), png)
    assert.equal(existsSync(resolve(saved.runDirectory, 'delivery/committed.json')), false)
    assert.deepEqual(await fixture.lane.poll(), { processed: 0 })
    assert.equal(fixture.calls.filter(x => x.path.includes('/result-commits/')).length, 1)
    assert.equal(fixture.executeCalls(), 0)
  })
})

test('recovery reader rejects wrong origin, Agent, byte proof, links, public modes and forged ACK', async t => {
  for (const variant of ['origin', 'agent', 'bytes', 'symlink', 'hardlink', 'public-mode', 'command', 'ack']) await t.test(variant, async t => {
    const candidate = build(); const fixture = setup(t, candidate); const saved = preserved(fixture, candidate)
    const file = resolve(saved.runDirectory, 'delivery/output_1.png')
    const receipt = resolve(saved.runDirectory, 'delivery/receipt.json')
    const args = { rootDirectory: saved.rootDirectory, apiOrigin: 'http://127.0.0.1:10018', agentId: 'controlled-agent' }
    if (variant === 'origin') args.apiOrigin = 'https://other.invalid'
    if (variant === 'agent') args.agentId = 'other-agent'
    if (variant === 'bytes') writeFileSync(file, Buffer.from('damaged'), { mode: 0o600 })
    if (variant === 'symlink') { unlinkSync(file); symlinkSync(receipt, file) }
    if (variant === 'hardlink') linkSync(file, resolve(saved.runDirectory, 'second-link'))
    if (variant === 'public-mode') chmodSync(file, 0o644)
    if (variant === 'command') { const x = JSON.parse(saved.receipt); x.command.taskId = 'other-task'; writeFileSync(receipt, JSON.stringify(x), { mode: 0o600 }) }
    if (variant === 'ack') writeFileSync(resolve(saved.runDirectory, 'delivery/committed.json'), JSON.stringify({ schemaVersion: 1,
      state: 'COMMITTED', receiptSha256: sha(saved.receipt), commandSha256: JSON.parse(saved.receipt).commandSha256,
      sha256: sha(png), byteLength: png.length, manifestId: `pwe_m_${'0'.repeat(64)}` }), { mode: 0o600 })
    assert.throws(() => retainedControlledImageDeliveriesV3(args), /CONVERSATION_OUTPUT_PERSISTENCE_UNCERTAIN/)
    assert.equal(fixture.calls.length, 0); assert.equal(fixture.executeCalls(), 0)
  })
})
