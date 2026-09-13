import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  ACK_STATUS,
  AckOutbox,
  AgentMessageProcessor,
  DurableDedupeLedger,
  PersistentCommandInbox,
  runCodex
} from '../agent-client.mjs'
import {
  ReassignmentWorkItemLease,
  WORK_ITEM_LEASE_FAILURE
} from '../work-item-lease.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const AGENT = 'agt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const PREVIOUS_COMMAND = 'cmd_hall_action_' + 'a'.repeat(64)
const COMMAND = 'cmd_hall_action_' + 'b'.repeat(64)
const REASSIGNMENT = 'rsn_' + 'c'.repeat(64)
const profile = {
  profileId: 'lease-profile', agentId: AGENT, agentName: 'Lease Agent', personaName: 'Lease Agent',
  codexBin: '/bin/true', codexHome: '', codexWorkdir: process.cwd(), codexSandbox: 'workspace-write',
  codexApproval: 'never', codexSessionMode: 'new', codexTimeoutMs: 0
}

const command = overrides => ({
  schemaVersion: 1,
  messageType: 'command.dispatch',
  messageId: 'message-e05',
  commandId: COMMAND,
  commandType: 'WORK_ITEM_EXECUTE',
  tenantId: 'tenant-a',
  clientId: 'client-a',
  taskId: 'task-a',
  workItemId: 'work-a',
  targetAgentId: AGENT,
  issuedAt: 1000,
  expiresAt: 9999999999999,
  attempt: 1,
  payload: {
    actionType: 'work_item_execute',
    instruction: 'Execute reassigned work item',
    conversationType: 'juyiting',
    reason: 'lease_expired_reassignment',
    autonomyLevel: 'autonomous',
    requiresApproval: false,
    context: {
      contextVersion: '5',
      referenceIds: [PREVIOUS_COMMAND],
      tags: ['lease-expired', 'reassignment']
    }
  },
  ...overrides
})

const response = (url, status, body) => {
  const bytes = Buffer.from(JSON.stringify(body))
  return {
    status,
    url: url.toString(),
    redirected: false,
    headers: { get: name => name.toLowerCase() === 'content-length'
      ? String(bytes.length) : name.toLowerCase() === 'content-type' ? 'application/json' : null },
    arrayBuffer: async () => bytes
  }
}

const leaseBody = overrides => ({
  reassignmentId: REASSIGNMENT,
  commandId: COMMAND,
  taskId: 'task-a',
  workItemId: 'work-a',
  agentId: AGENT,
  status: 'claimed',
  leaseToken: 'lease-token-secret',
  leaseUntil: 50_000,
  workItemVersion: 5,
  attemptCount: 1,
  maxAttempts: 3,
  changedAt: 10_000,
  ...overrides
})

const coordinator = overrides => new ReassignmentWorkItemLease({
  profile,
  runtimeInstanceId: 'runtime-local-1',
  tenantId: 'tenant-a',
  clientId: 'client-a',
  subjectAgentId: AGENT,
  leaseDurationMillis: 30_000,
  wsUrl: 'wss://api.example.test/ws/agent/channel',
  tokenProvider: () => 'header.payload.signature',
  bindingResolver: () => ({ reassignmentId: REASSIGNMENT, sourceCommandId: PREVIOUS_COMMAND }),
  schedule: () => 1,
  cancel: () => {},
  now: () => 0,
  ...overrides
})

test('frozen backend reassignment envelope fails closed because reassignmentId is not transported', () => {
  const lease = coordinator({ bindingResolver: () => null, fetchFn: async () => assert.fail('must not call API') })
  assert.throws(
    () => lease.preflight(command()),
    error => error.code === WORK_ITEM_LEASE_FAILURE.BINDING_UNAVAILABLE
  )
})

test('partial reassignment markers fail closed instead of bypassing the lease path', () => {
  const lease = coordinator({ fetchFn: async () => assert.fail('must not call API') })
  assert.throws(
    () => lease.preflight(command({
      payload: { ...command().payload, context: { ...command().payload.context, tags: ['reassignment'] } }
    })),
    error => error.code === WORK_ITEM_LEASE_FAILURE.COMMAND_INVALID
  )
})

test('processor rejects reassignment before RECEIVED when target-scoped JWT configuration is absent', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'codex-e05-reject-'))
  try {
    const lease = new ReassignmentWorkItemLease({
      profile, runtimeInstanceId: 'runtime-local-1', wsUrl: 'wss://api.example.test/ws/agent/channel'
    })
    const storage = resolve(root, Buffer.from(AGENT).toString('hex'))
    const ledger = new DurableDedupeLedger({ rootDir: storage, profile })
    const ackOutbox = new AckOutbox({ rootDir: storage, profile })
    ledger.initialize()
    ackOutbox.initialize()
    const acks = []
    let runs = 0
    const processor = new AgentMessageProcessor({
      profile,
      inbox: new PersistentCommandInbox({ rootDir: root, profile }),
      runCommand: async () => { runs += 1; return { status: 'completed' } },
      runChat: async () => {},
      validateCommand: message => lease.preflight(message),
      ledger,
      ackOutbox,
      sendFn: envelope => { acks.push(envelope); return true }
    })
    processor.start()
    const result = await processor.handle(command())
    await processor.waitForIdle()

    assert.equal(result.kind, 'rejected')
    assert.equal(result.error.code, WORK_ITEM_LEASE_FAILURE.AUTH_UNAVAILABLE)
    assert.equal(runs, 0)
    assert.deepEqual(acks.map(item => item.ackStatus), [ACK_STATUS.REJECTED])
    assert.equal(ledger.getEntry(COMMAND).status, ACK_STATUS.REJECTED)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('authenticated fake transport uses only exact read/start/heartbeat paths and command-bound bodies', async () => {
  const calls = []
  const replies = [
    leaseBody(),
    leaseBody({ status: 'running', workItemVersion: 6, changedAt: 10_100 }),
    leaseBody({ status: 'running', workItemVersion: 7, leaseUntil: 80_000, changedAt: 10_200 })
  ]
  const lease = coordinator({
    fetchFn: async (url, options) => {
      calls.push({ url: url.toString(), options })
      return response(url, 200, replies.shift())
    }
  })
  let executed = 0
  const result = await lease.execute(command(), async ({ signal }) => {
    executed += 1
    assert.equal(signal.aborted, false)
    return { status: 'completed', exitCode: 0 }
  })

  assert.equal(result.status, 'completed')
  assert.equal(executed, 1)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    `/agent/tasks/task-a/work-items/work-a/reassignments/${REASSIGNMENT}/lease`,
    `/agent/tasks/task-a/work-items/work-a/reassignments/${REASSIGNMENT}/lease/start`,
    `/agent/tasks/task-a/work-items/work-a/reassignments/${REASSIGNMENT}/lease/heartbeat`
  ])
  for (const call of calls) {
    const url = new URL(call.url)
    assert.equal(url.origin, 'https://api.example.test')
    assert.deepEqual([...url.searchParams], [['actorAgentId', AGENT]])
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.headers.Authorization, 'Bearer header.payload.signature')
    assert.deepEqual(Object.keys(JSON.parse(call.options.body)).sort(),
      call === calls[2]
        ? ['commandId', 'expectedWorkItemVersion', 'leaseDurationMillis'].sort()
        : ['commandId', 'expectedWorkItemVersion'].sort())
  }
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body).expectedWorkItemVersion), [5, 5, 6])
  assert.equal(JSON.parse(calls[2].options.body).leaseDurationMillis, 30_000)
})

test('old command rejection is not retried and never invokes Codex', async () => {
  let calls = 0
  let runs = 0
  const lease = coordinator({
    fetchFn: async url => {
      calls += 1
      return response(url, 409, { code: 'WORK_ITEM_SOURCE_COMMAND_INVALID' })
    }
  })
  const result = await lease.execute(command(), async () => { runs += 1; return { status: 'completed' } })
  assert.equal(result.status, 'recovery_required')
  assert.match(result.errorMessage, /WORK_ITEM_LEASE_STALE/)
  assert.equal(calls, 1)
  assert.equal(runs, 0)
})

test('changed lease fence after start is rejected without execution or retry', async () => {
  let calls = 0
  let runs = 0
  const lease = coordinator({
    fetchFn: async url => {
      calls += 1
      return response(url, 200, calls === 1
        ? leaseBody()
        : leaseBody({ status: 'running', workItemVersion: 6, leaseToken: 'different-fence', changedAt: 10_100 }))
    }
  })
  const result = await lease.execute(command(), async () => { runs += 1; return { status: 'completed' } })
  assert.equal(result.status, 'recovery_required')
  assert.match(result.errorMessage, /WORK_ITEM_LEASE_STALE/)
  assert.equal(calls, 2)
  assert.equal(runs, 0)
})

test('same-version heartbeat with a changed expiry is stale and never authorizes execution', async () => {
  let calls = 0
  let runs = 0
  const lease = coordinator({
    fetchFn: async url => {
      calls += 1
      if (calls === 1) return response(url, 200, leaseBody())
      if (calls === 2) return response(url, 200, leaseBody({ status: 'running', workItemVersion: 6, changedAt: 10_100 }))
      return response(url, 200, leaseBody({ status: 'running', workItemVersion: 6, leaseUntil: 80_000, changedAt: 10_200 }))
    }
  })
  const result = await lease.execute(command(), async () => { runs += 1; return { status: 'completed' } })
  assert.equal(result.status, 'recovery_required')
  assert.match(result.errorMessage, /WORK_ITEM_LEASE_STALE/)
  assert.equal(calls, 3)
  assert.equal(runs, 0)
})

test('unchanged heartbeat no-op preserves the valid running fence', async () => {
  let calls = 0
  let runs = 0
  const lease = coordinator({
    fetchFn: async url => {
      calls += 1
      if (calls === 1) return response(url, 200, leaseBody())
      return response(url, 200, leaseBody({ status: 'running', workItemVersion: 6, changedAt: 10_100 }))
    }
  })
  const result = await lease.execute(command(), async () => { runs += 1; return { status: 'completed' } })
  assert.equal(result.status, 'completed')
  assert.equal(calls, 3)
  assert.equal(runs, 1)
})

test('heartbeat stale rejection aborts the active run once and does not issue another API call', async () => {
  const scheduled = []
  let calls = 0
  const lease = coordinator({
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return callback },
    cancel: () => {},
    fetchFn: async url => {
      calls += 1
      if (calls === 1) return response(url, 200, leaseBody())
      if (calls === 2) return response(url, 200, leaseBody({ status: 'running', workItemVersion: 6, changedAt: 10_100 }))
      if (calls === 3) return response(url, 200, leaseBody({ status: 'running', workItemVersion: 7, leaseUntil: 80_000, changedAt: 10_200 }))
      return response(url, 409, { code: 'WORK_ITEM_REASSIGNMENT_STALE' })
    }
  })
  const executing = lease.execute(command(), ({ signal }) => new Promise(resolveRun => {
    signal.addEventListener('abort', () => resolveRun({ status: 'recovery_required', errorMessage: 'aborted' }), { once: true })
  }))
  while (scheduled.length < 2) await new Promise(resolvePromise => setImmediate(resolvePromise))
  const heartbeatTimer = scheduled.sort((left, right) => left.delay - right.delay).shift()
  await heartbeatTimer.callback()
  const result = await executing

  assert.equal(result.status, 'recovery_required')
  assert.match(result.errorMessage, /WORK_ITEM_LEASE_STALE/)
  assert.equal(calls, 4)
})

test('hung heartbeat cannot outlive the server lease or trigger another execution', async () => {
  const scheduled = []
  let calls = 0
  let runs = 0
  const lease = coordinator({
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return callback },
    cancel: () => {},
    fetchFn: async url => {
      calls += 1
      if (calls === 1) return response(url, 200, leaseBody())
      if (calls === 2) return response(url, 200, leaseBody({ status: 'running', workItemVersion: 6, changedAt: 10_100 }))
      if (calls === 3) return response(url, 200, leaseBody({ status: 'running', workItemVersion: 7, leaseUntil: 80_000, changedAt: 10_200 }))
      return new Promise(() => {})
    }
  })
  const executing = lease.execute(command(), ({ signal }) => new Promise(resolveRun => {
    runs += 1
    signal.addEventListener('abort', () => resolveRun({ status: 'recovery_required', errorMessage: 'aborted' }), { once: true })
  }))
  while (scheduled.length < 2) await new Promise(resolvePromise => setImmediate(resolvePromise))
  const heartbeatTimer = scheduled.find(item => item.delay === 10_000)
  const expiryTimer = scheduled.find(item => item.delay === 80_000)
  void heartbeatTimer.callback()
  while (calls < 4) await new Promise(resolvePromise => setImmediate(resolvePromise))
  expiryTimer.callback()
  const result = await executing

  assert.equal(result.status, 'recovery_required')
  assert.match(result.errorMessage, /WORK_ITEM_LEASE_STALE/)
  assert.equal(calls, 4)
  assert.equal(runs, 1)
})

test('configured Codex timeout remains recovery-required and emits no false FAILED result', async () => {
  class Child extends EventEmitter {
    constructor() {
      super()
      this.stdout = new PassThrough()
      this.stderr = new PassThrough()
      this.exitCode = null
      this.killed = false
    }
    kill() {
      if (this.killed) return true
      this.killed = true
      queueMicrotask(() => { this.exitCode = 143; this.emit('close', 143) })
      return true
    }
  }
  const legacy = []
  const result = await runCodex(
    { ...profile, codexTimeoutMs: 2 },
    command({ instruction: 'bounded timeout fixture' }),
    'command',
    {
      spawnFn: () => new Child(),
      sendLegacyFn: type => legacy.push(type),
      sendStatusFn: () => {},
      requireWorkspace: false,
      timeoutAsRecoveryRequired: true
    }
  )
  assert.equal(result.status, 'recovery_required')
  assert.match(result.errorMessage, /CODEX_TIMEOUT_UNCONFIRMED/)
  assert.deepEqual(legacy, [])
})
