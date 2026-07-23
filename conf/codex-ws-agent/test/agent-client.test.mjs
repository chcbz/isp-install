import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test, { afterEach } from 'node:test'

import {
  ACK_STATUS,
  AckOutbox,
  AgentMessageProcessor,
  CommandFingerprint,
  DurableDedupeLedger,
  LEDGER_STATUS,
  MESSAGE_TYPES,
  PersistentCommandInbox,
  PROCESS_RUNTIME_INSTANCE_ID,
  buildAckEnvelope,
  buildProtocolEnvelope,
  buildWebSocketUrl,
  normalizeInboundMessage,
  runCodex
} from '../agent-client.mjs'

const temporaryDirectories = []
afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

const temporaryDirectory = () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'codex-ws-agent-a05-'))
  temporaryDirectories.push(directory)
  return directory
}

const profile = {
  profileId: 'profile-a',
  agentId: 'agent-a',
  agentName: 'Agent A',
  personaName: 'Agent A',
  codexBin: '/bin/true',
  codexHome: '',
  codexWorkdir: process.cwd(),
  codexSandbox: 'danger-full-access',
  codexApproval: 'never',
  codexSessionMode: 'new',
  codexTimeoutMs: 1000
}

const command = number => ({
  type: 'agent_direct_message',
  schemaVersion: 1,
  messageType: MESSAGE_TYPES.COMMAND_DISPATCH,
  messageId: `message-${number}`,
  requestId: `message-${number}`,
  commandId: `command-${number}`,
  commandType: 'TASK_EXECUTE',
  targetAgentId: profile.agentId,
  taskId: 'task-1',
  workItemId: `work-${number}`,
  attempt: number,
  issuedAt: 1000 + number,
  expiresAt: 9999999999999,
  content: `run ${number}`,
  payload: { instruction: `run ${number}` }
})

const chat = () => ({
  senderName: 'Caller Name',
  personaName: 'Caller Persona',
  type: 'agent_direct_message',
  schemaVersion: 1,
  messageType: MESSAGE_TYPES.CHAT_MESSAGE,
  messageId: 'chat-message-1',
  targetAgentId: profile.agentId,
  conversationId: 'conversation-1',
  content: 'hello'
})

const taskEvent = () => ({
  type: MESSAGE_TYPES.TASK_EVENT,
  schemaVersion: 1,
  messageType: MESSAGE_TYPES.TASK_EVENT,
  messageId: 'event-message-1',
  taskId: 'task-1',
  eventType: 'task.updated',
  status: 'running'
})

const createInbox = (rootDir, options = {}) => new PersistentCommandInbox({ rootDir, profile, ...options })
const profileStorageRoot = (rootDir, selectedProfile = profile) => resolve(
  rootDir,
  Buffer.from(selectedProfile.agentId, 'utf8').toString('hex')
)

const deferred = () => {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

test('busy command is durably queued instead of dropped', async () => {
  const inbox = createInbox(temporaryDirectory())
  const firstRun = deferred()
  const started = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async message => {
      started.push(message.commandId)
      if (message.commandId === 'command-1') await firstRun.promise
      return { status: 'completed' }
    },
    runChat: async () => {}
  })
  processor.start()

  await processor.handle(command(1))
  await processor.handle(command(2))

  assert.deepEqual(started, ['command-1'])
  assert.equal(inbox.count('processing'), 1)
  assert.equal(inbox.count('pending'), 1)

  firstRun.resolve()
  await processor.waitForIdle()
  assert.deepEqual(started, ['command-1', 'command-2'])
  assert.equal(inbox.count('archive'), 2)
})

test('processing command restart enters durable recovery-required state without re-execution', async () => {
  const rootDir = temporaryDirectory()
  const firstInbox = createInbox(rootDir)
  const firstLedger = new DurableDedupeLedger({ rootDir: profileStorageRoot(rootDir), profile })
  firstInbox.initialize()
  firstLedger.initialize()
  const normalized = normalizeInboundMessage(command(1))
  const queued = firstInbox.enqueue(normalized)
  firstLedger.checkOrRecord(normalized.commandId, CommandFingerprint.compute(normalized), {
    messageId: normalized.messageId,
    commandType: normalized.commandType,
    targetAgentId: normalized.targetAgentId,
    taskId: normalized.taskId,
    workItemId: normalized.workItemId
  })
  firstLedger.recordQueueSequence(normalized.commandId, queued.record.queueSequence)
  const claimed = firstInbox.claimNext()
  firstLedger.markStarted(normalized.commandId)
  assert.equal(claimed.record.commandId, 'command-1')
  assert.equal(claimed.record.messageId, 'message-1')
  assert.equal(claimed.record.taskId, 'task-1')
  assert.equal(claimed.record.workItemId, 'work-1')
  assert.equal(claimed.record.attempt, 1)
  assert.equal(claimed.record.rawPayload.messageType, MESSAGE_TYPES.COMMAND_DISPATCH)
  assert.equal(firstInbox.count('processing'), 1)

  const restartedInbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: profileStorageRoot(rootDir), profile })
  const ackOutbox = new AckOutbox({ rootDir: profileStorageRoot(rootDir), profile })
  ledger.initialize()
  ackOutbox.initialize()
  const executed = []
  const acks = []
  const rejected = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox: restartedInbox,
    runCommand: async message => {
      executed.push(message.commandId)
      return { status: 'completed' }
    },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: envelope => { acks.push(envelope); return true },
    onReject: error => rejected.push(error.code)
  })
  const recovery = processor.start()
  await processor.waitForIdle()

  assert.equal(recovery.recoveryRequired, 1)
  assert.equal(recovery.failClosedCode, 'COMMAND_RECOVERY_REQUIRED')
  assert.equal(restartedInbox.count('processing'), 0)
  assert.equal(restartedInbox.count('pending'), 0)
  assert.equal(restartedInbox.count('recovery'), 1)
  assert.deepEqual(executed, [])
  assert.deepEqual(rejected, ['COMMAND_RECOVERY_REQUIRED'])
  assert.equal(acks.at(-1).ackStatus, ACK_STATUS.REJECTED)
  assert.match(acks.at(-1).rejectReason, /automatic re-execution is forbidden/)
  const entry = ledger.getEntry('command-1')
  assert.equal(entry.status, LEDGER_STATUS.RECOVERY_REQUIRED)
  assert.equal(entry.ackRejectedEmitted, true)
})

test('chat run emits only chat.message.delta and chat.message', async () => {
  const protocolTypes = []
  const legacyTypes = []
  const statuses = []
  class FakeChild extends EventEmitter {
    constructor() {
      super()
      this.stdout = new PassThrough()
      this.stderr = new PassThrough()
      this.exitCode = null
      this.killed = false
    }
    kill() { this.killed = true }
  }
  const child = new FakeChild()
  const run = runCodex(profile, normalizeInboundMessage(chat()), 'chat', {
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'chat reply' } })}\n`)
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0)
      })
      return child
    },
    sendProtocolFn: type => protocolTypes.push(type),
    sendLegacyFn: type => legacyTypes.push(type),
    sendStatusFn: (...args) => statuses.push(args)
  })

  const result = await run
  assert.equal(result.status, 'completed')
  assert.ok(protocolTypes.includes(MESSAGE_TYPES.CHAT_MESSAGE_DELTA))
  assert.equal(protocolTypes.at(-1), MESSAGE_TYPES.CHAT_MESSAGE)
  assert.ok(protocolTypes.every(type => [MESSAGE_TYPES.CHAT_MESSAGE_DELTA, MESSAGE_TYPES.CHAT_MESSAGE].includes(type)))
  assert.deepEqual(legacyTypes, [])
  assert.deepEqual(statuses, [])
})

test('task.event updates local state callback and never executes', async () => {
  const inbox = createInbox(temporaryDirectory())
  let commandRuns = 0
  let chatRuns = 0
  const events = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { commandRuns += 1 },
    runChat: async () => { chatRuns += 1 },
    onTaskEvent: async event => events.push(event.eventType)
  })
  processor.start()
  const result = await processor.handle(taskEvent())

  assert.equal(result.kind, 'task-event')
  assert.deepEqual(events, ['task.updated'])
  assert.equal(commandRuns, 0)
  assert.equal(chatRuns, 0)
  assert.equal(inbox.count('pending'), 0)
})

test('commands execute strictly in durable enqueue order', async () => {
  const inbox = createInbox(temporaryDirectory())
  const order = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async message => {
      order.push(message.commandId)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2))
      return { status: 'completed' }
    },
    runChat: async () => {}
  })
  processor.start()
  await Promise.all([processor.handle(command(1)), processor.handle(command(2)), processor.handle(command(3))])
  await processor.waitForIdle()

  assert.deepEqual(order, ['command-1', 'command-2', 'command-3'])
  assert.equal(inbox.count('archive'), 3)
})

test('corrupt queue file is quarantined while valid commands continue', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  inbox.initialize()
  inbox.enqueue(normalizeInboundMessage(command(1)))
  writeFileSync(resolve(inbox.pendingDir, '0000000000000-corrupt.json'), '{not json', 'utf8')

  const restartedInbox = createInbox(rootDir)
  const recovery = restartedInbox.initialize()
  assert.equal(recovery.quarantined, 1)
  assert.equal(restartedInbox.count('pending'), 1)
  assert.equal(restartedInbox.listJsonFiles(restartedInbox.quarantineDir).length, 1)

  const executed = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox: restartedInbox,
    runCommand: async message => {
      executed.push(message.commandId)
      return { status: 'completed' }
    },
    runChat: async () => {}
  })
  processor.start()
  await processor.waitForIdle()
  assert.deepEqual(executed, ['command-1'])
})

test('legacy execution types, missing messageType, and ambiguous envelopes fail closed', () => {
  assert.throws(
    () => normalizeInboundMessage({ type: 'task_assigned', content: 'do it' }),
    error => error.code === 'MESSAGE_TYPE_REQUIRED'
  )
  assert.throws(
    () => normalizeInboundMessage({ ...command(1), messageType: null }),
    error => error.code === 'INVALID_MESSAGE_TYPE'
  )
  assert.throws(
    () => normalizeInboundMessage({ ...command(1), requestId: 'different-request' }),
    error => error.code === 'ENVELOPE_FIELD_CONFLICT'
  )
  assert.throws(
    () => normalizeInboundMessage(JSON.stringify(command(1)).replace('\"schemaVersion\":1', '\"schemaVersion\":1.0')),
    error => error.code === 'INVALID_SCHEMA_VERSION'
  )
  assert.throws(
    () => normalizeInboundMessage({ ...command(1), schemaVersion: '1' }),
    error => error.code === 'INVALID_SCHEMA_VERSION'
  )
  assert.throws(
    () => normalizeInboundMessage({ ...command(1), schemaVersion: 4294967297 }),
    error => error.code === 'INVALID_SCHEMA_VERSION'
  )
  assert.throws(
    () => normalizeInboundMessage({
      ...command(1),
      payload: { messageType: MESSAGE_TYPES.TASK_EVENT, instruction: 'do it' }
    }),
    error => ['MESSAGE_TYPE_CONFLICT', 'ENVELOPE_FIELD_CONFLICT'].includes(error.code)
  )
})

test('runtimeInstanceId is process-scoped and reused by URL and v1 envelopes', () => {
  const url = new URL(buildWebSocketUrl('wss://example.test/ws', 'secret', profile))
  assert.equal(url.searchParams.get('runtimeInstanceId'), PROCESS_RUNTIME_INSTANCE_ID)
  assert.equal(url.searchParams.get('runtime_instance_id'), PROCESS_RUNTIME_INSTANCE_ID)

  const register = buildProtocolEnvelope(MESSAGE_TYPES.AGENT_REGISTER, {}, profile)
  const presence = buildProtocolEnvelope(MESSAGE_TYPES.AGENT_PRESENCE, {}, profile)
  assert.equal(register.runtimeInstanceId, PROCESS_RUNTIME_INSTANCE_ID)
  assert.equal(presence.runtimeInstanceId, PROCESS_RUNTIME_INSTANCE_ID)
  assert.equal(register.agentId, profile.agentId)
  assert.equal(register.sourceAgentId, profile.agentId)
})


test('fsync and rename failures fail closed before command execution', async () => {
  for (const failure of ['fsync', 'rename']) {
    const rootDir = temporaryDirectory()
    let enabled = false
    let runs = 0
    const inbox = createInbox(rootDir, {
      fs: {
        fsyncSync: descriptor => {
          if (enabled && failure === 'fsync') throw new Error('injected fsync failure')
          return fsyncSync(descriptor)
        },
        renameSync: (source, target) => {
          if (enabled && failure === 'rename') throw new Error('injected rename failure')
          return renameSync(source, target)
        }
      }
    })
    const processor = new AgentMessageProcessor({
      profile,
      inbox,
      runCommand: async () => { runs += 1 },
      runChat: async () => {}
    })
    processor.start()
    enabled = true
    const result = await processor.handle(command(10))
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    assert.equal(result.kind, 'rejected', failure)
    assert.equal(runs, 0, failure)
  }
})

test('claim rename and fsync failures pause the queue before execution', async () => {
  for (const failure of ['rename', 'fsync']) {
    const rootDir = temporaryDirectory()
    let enabled = false
    let runs = 0
    const rejects = []
    const inbox = createInbox(rootDir, {
      fs: {
        fsyncSync: descriptor => {
          if (enabled && failure === 'fsync') throw new Error('injected claim fsync failure')
          return fsyncSync(descriptor)
        },
        renameSync: (source, target) => {
          if (enabled && failure === 'rename') throw new Error('injected claim rename failure')
          return renameSync(source, target)
        }
      }
    })
    inbox.initialize()
    inbox.enqueue(normalizeInboundMessage(command(11)))
    const processor = new AgentMessageProcessor({
      profile,
      inbox,
      runCommand: async () => { runs += 1 },
      runChat: async () => {},
      onReject: error => rejects.push(error.code)
    })
    processor.start({ drain: false })
    enabled = true
    processor.resume()
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    assert.equal(runs, 0, failure)
    assert.equal(processor.paused, true, failure)
    assert.deepEqual(rejects, ['COMMAND_INBOX_ERROR'], failure)
  }
})

test('malformed completed marker is quarantined instead of re-executed', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  inbox.initialize()
  inbox.enqueue(normalizeInboundMessage(command(1)))
  const item = inbox.claimNext()
  const record = JSON.parse(readFileSync(item.path, 'utf8'))
  record.state = 'completed'
  delete record.outcome
  writeFileSync(item.path, `${JSON.stringify(record)}\n`, { mode: 0o600 })

  const restarted = createInbox(rootDir)
  const recovery = restarted.initialize()
  assert.equal(recovery.quarantined, 1)
  let runs = 0
  const processor = new AgentMessageProcessor({
    profile,
    inbox: restarted,
    runCommand: async () => { runs += 1 },
    runChat: async () => {}
  })
  processor.start()
  await processor.waitForIdle()
  assert.equal(runs, 0)
})

test('completed marker is settled on recovery without re-execution', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  inbox.initialize()
  inbox.enqueue(normalizeInboundMessage(command(1)))
  const item = inbox.claimNext()
  inbox.markCompleted(item, { status: 'completed' })

  const restarted = createInbox(rootDir)
  const recovery = restarted.initialize()
  assert.equal(recovery.completed, 1)
  assert.equal(restarted.count('processing'), 0)
  assert.equal(restarted.count('archive'), 1)
})

test('pending commands and persistent sequence survive restart in FIFO order', async () => {
  const rootDir = temporaryDirectory()
  const first = createInbox(rootDir)
  first.initialize()
  const one = first.enqueue(normalizeInboundMessage(command(1)))
  const two = first.enqueue(normalizeInboundMessage(command(2)))

  const restarted = createInbox(rootDir)
  restarted.initialize()
  const three = restarted.enqueue(normalizeInboundMessage(command(3)))
  assert.deepEqual([one.record.queueSequence, two.record.queueSequence, three.record.queueSequence], [1, 2, 3])

  const order = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox: restarted,
    runCommand: async message => { order.push(message.commandId); return { status: 'completed' } },
    runChat: async () => {}
  })
  processor.start()
  await processor.waitForIdle()
  assert.deepEqual(order, ['command-1', 'command-2', 'command-3'])
})

test('semantically invalid persisted commands are quarantined and never executed', async () => {
  const mutations = [
    record => { record.rawPayload = taskEvent() },
    record => { record.rawPayload.targetAgentId = 'another-agent'; record.targetAgentId = 'another-agent' },
    record => { record.rawPayload.messageId = ''; record.rawPayload.requestId = ''; record.messageId = '' },
    record => { record.rawPayload.commandId = ''; record.commandId = '' },
    record => { record.rawPayload.commandType = ''; record.commandType = '' }
  ]
  for (const [index, mutate] of mutations.entries()) {
    const rootDir = temporaryDirectory()
    const inbox = createInbox(rootDir)
    inbox.initialize()
    const item = inbox.enqueue(normalizeInboundMessage(command(index + 1)))
    const record = JSON.parse(readFileSync(item.path, 'utf8'))
    mutate(record)
    writeFileSync(item.path, `${JSON.stringify(record)}\n`, { mode: 0o600 })

    const restarted = createInbox(rootDir)
    const recovery = restarted.initialize()
    assert.equal(recovery.quarantined, 1, `mutation ${index}`)
    let runs = 0
    const processor = new AgentMessageProcessor({
      profile,
      inbox: restarted,
      runCommand: async () => { runs += 1 },
      runChat: async () => {}
    })
    processor.start()
    await processor.waitForIdle()
    assert.equal(runs, 0, `mutation ${index}`)
  }
})

test('queue initialization repairs existing directory and record permissions', () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  inbox.initialize()
  const archived = inbox.enqueue(normalizeInboundMessage(command(1)))
  inbox.complete(inbox.claimNext(), { status: 'completed' })
  writeFileSync(resolve(inbox.pendingDir, 'corrupt.json'), '{not json', { mode: 0o666 })
  createInbox(rootDir).initialize()

  for (const directory of [inbox.profileDir, inbox.pendingDir, inbox.processingDir, inbox.archiveDir, inbox.recoveryDir, inbox.quarantineDir]) {
    chmodSync(directory, 0o755)
  }
  chmodSync(inbox.sequencePath, 0o644)
  for (const directory of [inbox.pendingDir, inbox.processingDir, inbox.archiveDir, inbox.recoveryDir, inbox.quarantineDir]) {
    for (const fileName of readdirSync(directory)) chmodSync(resolve(directory, fileName), 0o666)
  }

  const restarted = createInbox(rootDir)
  restarted.initialize()
  for (const directory of [restarted.profileDir, restarted.pendingDir, restarted.processingDir, restarted.archiveDir, restarted.recoveryDir, restarted.quarantineDir]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700)
  }
  assert.equal(statSync(restarted.sequencePath).mode & 0o777, 0o600)
  for (const directory of [restarted.pendingDir, restarted.processingDir, restarted.archiveDir, restarted.recoveryDir, restarted.quarantineDir]) {
    for (const fileName of readdirSync(directory)) {
      assert.equal(statSync(resolve(directory, fileName)).mode & 0o777, 0o600, `${directory}/${fileName}`)
    }
  }
  assert.equal(archived.record.commandId, 'command-1')
})

test('chat failure and busy branches emit chat responses only', async () => {
  const protocol = []
  const message = normalizeInboundMessage(chat())
  await runCodex(profile, message, 'chat', {
    spawnFn: () => { throw new Error('spawn failed') },
    sendProtocolFn: (type, payload) => protocol.push({ type, payload }),
    sendLegacyFn: () => assert.fail('chat must not send legacy result'),
    sendStatusFn: () => assert.fail('chat must not send presence')
  })
  assert.deepEqual(protocol.map(entry => entry.type), [MESSAGE_TYPES.CHAT_MESSAGE_DELTA, MESSAGE_TYPES.CHAT_MESSAGE])
  assert.ok(protocol.every(entry => entry.payload.senderName === profile.personaName))

  const gate = deferred()
  const busyReplies = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(temporaryDirectory()),
    runCommand: async () => { await gate.promise; return { status: 'completed' } },
    runChat: async () => assert.fail('busy chat must not start Codex'),
    sendChatBusy: async inbound => busyReplies.push(inbound.senderName)
  })
  processor.start()
  await processor.handle(command(20))
  const result = await processor.handle(chat())
  assert.equal(result.kind, 'chat-busy')
  assert.deepEqual(busyReplies, ['Caller Name'])
  gate.resolve()
  await processor.waitForIdle()
})

test('public envelope preserves explicit sender identity and validate works without global WebSocket', () => {
  const envelope = buildProtocolEnvelope(MESSAGE_TYPES.CHAT_MESSAGE, {
    senderName: 'Explicit Sender',
    personaName: 'Explicit Persona'
  }, profile)
  assert.equal(envelope.senderName, 'Explicit Sender')
  assert.equal(envelope.personaName, 'Explicit Persona')

  const bootstrap = `
    delete globalThis.WebSocket;
    process.argv.push('validate-bootstrap', '--validate');
    const { main } = await import('./agent-client.mjs');
    await main();
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_API_KEY: 'test',
      CODEX_PROFILES_FILE: '',
      CODEX_PROFILES: JSON.stringify([{ profileId: 'validate', agentId: 'agent-a', codexBin: '/bin/true', codexWorkdir: '/tmp' }]),
      DEFAULT_CODEX_PROFILE: 'validate',
      CODEX_PROFILE_RELOAD_MS: '0'
    }
  })
  assert.match(output, /configuration valid/)
})


// --- A06: Command Deduplication & Acknowledgements ---

test('same commandId triggers dedupe and does not re-enqueue', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ledger.initialize()
  const ackOutbox = new AckOutbox({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ackOutbox.initialize()

  let runs = 0
  let receivedAcks = []
  let startedAcks = []
  let completedAcks = []

  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async message => {
      runs += 1
      return { status: 'completed' }
    },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: env => {
      if (env.ackStatus === ACK_STATUS.RECEIVED) receivedAcks.push(env.commandId)
      if (env.ackStatus === ACK_STATUS.STARTED) startedAcks.push(env.commandId)
      if (env.ackStatus === ACK_STATUS.SUCCEEDED) completedAcks.push(env.commandId)
      return true
    }
  })
  processor.start()

  await processor.handle(command(1))
  await processor.waitForIdle()
  // Same commandId second time
  await processor.handle(command(1))
  await processor.waitForIdle()

  assert.equal(runs, 1)
  assert.deepEqual(receivedAcks, ['command-1'])
  assert.deepEqual(startedAcks, ['command-1'])
  assert.deepEqual(completedAcks, ['command-1', 'command-1'])
})

test('same commandId with different payload causes fingerprint conflict and REJECTED', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ledger.initialize()
  const ackOutbox = new AckOutbox({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ackOutbox.initialize()

  let runs = 0
  let rejectedAcks = []

  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: env => {
      if (env.ackStatus === ACK_STATUS.REJECTED) rejectedAcks.push(env)
      return true
    }
  })
  processor.start()

  await processor.handle(command(1))
  await processor.waitForIdle()
  const terminalBeforeConflict = ledger.getEntry('command-1')

  const differentPayloadCmd = {
    ...command(1),
    payload: { instruction: 'totally different thing' }
  }
  const result = await processor.handle(differentPayloadCmd)

  assert.equal(result.kind, 'rejected')
  assert.equal(result.error.code, 'COMMAND_FINGERPRINT_CONFLICT')
  assert.equal(runs, 1)
  assert.equal(rejectedAcks.length, 1)
  assert.equal(rejectedAcks[0].ackStatus, ACK_STATUS.REJECTED)
  assert.equal(rejectedAcks[0].rejectReason, 'FINGERPRINT_CONFLICT: same commandId with different payload')

  const terminalAfterConflict = ledger.getEntry('command-1')
  assert.equal(terminalAfterConflict.status, ACK_STATUS.SUCCEEDED)
  assert.equal(terminalAfterConflict.fingerprint, terminalBeforeConflict.fingerprint)
  assert.equal(terminalAfterConflict.completedAt, terminalBeforeConflict.completedAt)
  assert.deepEqual(terminalAfterConflict.outcome, terminalBeforeConflict.outcome)
  assert.equal(terminalAfterConflict.ackRejectedEmitted, terminalBeforeConflict.ackRejectedEmitted)
  const conflicts = ledger.getConflicts('command-1')
  assert.equal(conflicts.length, 1)
  assert.notEqual(conflicts[0].conflictingFingerprint, terminalBeforeConflict.fingerprint)
  assert.equal(conflicts[0].existingStatus, ACK_STATUS.SUCCEEDED)
  assert.equal(conflicts[0].ackRejectedEmitted, true)
})

test('completed commandId re-delivery replays terminal ACK only', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ledger.initialize()
  const ackOutbox = new AckOutbox({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ackOutbox.initialize()

  let runs = 0
  const allAcks = []

  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: env => { allAcks.push(env.ackStatus); return true }
  })
  processor.start()

  await processor.handle(command(1))
  await processor.waitForIdle()
  assert.equal(runs, 1)

  // Clear acks to observe only replayed ones
  allAcks.length = 0
  await processor.handle(command(1))
  await processor.waitForIdle()

  // Duplicate replays the durable terminal state, not a fresh RECEIVED.
  assert.equal(runs, 1)
  assert.deepEqual(allAcks, ['SUCCEEDED'])
})

test('expired command before execution is REJECTED', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ledger.initialize()
  const ackOutbox = new AckOutbox({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ackOutbox.initialize()

  let runs = 0
  let rejectedAcks = []

  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: env => {
      if (env.ackStatus === ACK_STATUS.REJECTED) rejectedAcks.push(env)
      return true
    }
  })
  processor.start()

  const expiredCmd = {
    ...command(50),
    expiresAt: 1000
  }
  const result = await processor.handle(expiredCmd)

  assert.equal(result.kind, 'rejected')
  assert.equal(result.error.code, 'COMMAND_EXPIRED')
  assert.equal(runs, 0)
  assert.equal(rejectedAcks.length, 1)
  assert.equal(rejectedAcks[0].ackStatus, ACK_STATUS.REJECTED)
  assert.match(rejectedAcks[0].rejectReason, /EXPIRED/)
})

test('ack outbox retains pending ACKs when send fails and replays on reconnect', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  const ledgerDir = resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex'))

  const ledger = new DurableDedupeLedger({ rootDir: ledgerDir, profile })
  ledger.initialize()
  const ackOutbox = new AckOutbox({ rootDir: ledgerDir, profile })
  ackOutbox.initialize()

  let sendSucceeds = false
  let runs = 0

  const processor1 = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: () => sendSucceeds
  })
  processor1.start()

  await processor1.handle(command(1))
  await processor1.waitForIdle()
  assert.equal(runs, 0, 'STARTED not sent in FIFO order must prevent command execution')

  const pendingPreReplay = ackOutbox.pendingEnvelopes()
  assert.ok(pendingPreReplay.length >= 1, 'outbox should have pending ACKs after failed sends')

  // Simulate reconnect and drain the already-initialized durable outbox.
  sendSucceeds = true
  const processor2 = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: () => sendSucceeds
  })
  const replayed = processor2.replayAcks()
  assert.ok(replayed >= 1, 'should replay at least one pending ACK')

  const pendingPostReplay = ackOutbox.pendingEnvelopes()
  assert.equal(pendingPostReplay.length, 0, 'outbox should be empty after successful replay')
})

test('live command ACKs recover from an initial RECEIVED send failure in global FIFO order', async () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ledger.initialize()
  ackOutbox.initialize()

  const attempts = []
  const delivered = []
  let firstAttempt = true
  let runs = 0
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: envelope => {
      attempts.push(envelope.ackStatus)
      if (firstAttempt) {
        firstAttempt = false
        return false
      }
      delivered.push(envelope.ackStatus)
      return true
    }
  })
  processor.start()

  await processor.handle(command(81))
  await processor.waitForIdle()

  assert.equal(runs, 1)
  assert.deepEqual(attempts, [
    ACK_STATUS.RECEIVED,
    ACK_STATUS.RECEIVED,
    ACK_STATUS.STARTED,
    ACK_STATUS.SUCCEEDED
  ])
  assert.deepEqual(delivered, [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED])
  assert.equal(ackOutbox.pendingEnvelopes().length, 0)
  const entry = ledger.getEntry('command-81')
  assert.equal(entry.ackReceivedEmitted, true)
  assert.equal(entry.ackStartedEmitted, true)
  assert.equal(entry.ackCompletedEmitted, true)
})

test('older pending ACK blocks a live ACK and leaves the current durable marker false', () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ledger.initialize()
  ackOutbox.initialize()

  const current = normalizeInboundMessage(command(82))
  ledger.checkOrRecord(current.commandId, CommandFingerprint.compute(current), {
    messageId: current.messageId,
    commandType: current.commandType,
    targetAgentId: current.targetAgentId,
    taskId: current.taskId,
    workItemId: current.workItemId
  })
  ackOutbox.enqueue(
    buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'older-pending' }),
    { kind: 'none' }
  )
  const attempted = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => ({ status: 'completed' }),
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: envelope => {
      attempted.push(envelope.commandId)
      return envelope.commandId !== 'older-pending'
    }
  })

  const delivery = processor._emitAck(ACK_STATUS.RECEIVED, {
    commandId: current.commandId,
    messageId: current.messageId
  })

  assert.deepEqual(delivery, {
    persisted: true,
    sent: false,
    markerPersisted: false,
    dequeued: false
  })
  assert.deepEqual(attempted, ['older-pending'])
  assert.deepEqual(
    ackOutbox.pendingEnvelopes().map(item => item.envelope.commandId),
    ['older-pending', current.commandId]
  )
  assert.equal(ledger.getEntry(current.commandId).ackReceivedEmitted, false)
})

test('live ACK reports success only after its own ordered marker and dequeue complete', () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ledger.initialize()
  ackOutbox.initialize()

  const older = normalizeInboundMessage(command(83))
  const current = normalizeInboundMessage(command(84))
  for (const message of [older, current]) {
    ledger.checkOrRecord(message.commandId, CommandFingerprint.compute(message), {
      messageId: message.messageId,
      commandType: message.commandType,
      targetAgentId: message.targetAgentId,
      taskId: message.taskId,
      workItemId: message.workItemId
    })
  }
  ackOutbox.enqueue(
    buildAckEnvelope(profile, ACK_STATUS.RECEIVED, {
      commandId: older.commandId,
      messageId: older.messageId
    }),
    { kind: 'entry' }
  )
  const delivered = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => ({ status: 'completed' }),
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: envelope => { delivered.push(envelope.commandId); return true }
  })

  const delivery = processor._emitAck(ACK_STATUS.RECEIVED, {
    commandId: current.commandId,
    messageId: current.messageId
  })

  assert.deepEqual(delivery, {
    persisted: true,
    sent: true,
    markerPersisted: true,
    dequeued: true
  })
  assert.deepEqual(delivered, [older.commandId, current.commandId])
  assert.equal(ledger.getEntry(older.commandId).ackReceivedEmitted, true)
  assert.equal(ledger.getEntry(current.commandId).ackReceivedEmitted, true)
  assert.equal(ackOutbox.pendingEnvelopes().length, 0)
})

test('two initialized ACK outboxes allocate one FIFO sequence across instances and restart', () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const outboxA = new AckOutbox({
    rootDir: storageRoot,
    profile,
    now: () => 123456789,
    createId: () => 'z-last-lexically'
  })
  const outboxB = new AckOutbox({
    rootDir: storageRoot,
    profile,
    now: () => 123456789,
    createId: () => 'a-first-lexically'
  })
  outboxA.initialize()
  outboxB.initialize()
  outboxA.enqueue(buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'command-fifo' }), { kind: 'none' })
  outboxB.enqueue(buildAckEnvelope(profile, ACK_STATUS.STARTED, { commandId: 'command-fifo' }), { kind: 'none' })
  outboxA.enqueue(buildAckEnvelope(profile, ACK_STATUS.SUCCEEDED, { commandId: 'command-fifo' }), { kind: 'none' })

  assert.deepEqual(
    outboxB.pendingEnvelopes().map(item => item.envelope.ackStatus),
    [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED]
  )
  assert.deepEqual(outboxA.pendingEnvelopes().map(item => item.record.queueSequence), [1, 2, 3])

  const restarted = new AckOutbox({
    rootDir: storageRoot,
    profile,
    now: () => 123456789,
    createId: () => 'restart'
  })
  restarted.initialize()
  restarted.enqueue(
    buildAckEnvelope(profile, ACK_STATUS.REJECTED, { commandId: 'command-fifo', messageId: 'dispatch-fifo' }),
    { kind: 'none' }
  )
  const pending = restarted.pendingEnvelopes()
  assert.deepEqual(pending.map(item => item.record.queueSequence), [1, 2, 3, 4])
  assert.deepEqual(
    pending.map(item => item.envelope.ackStatus),
    [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED, ACK_STATUS.REJECTED]
  )
  assert.ok(pending.every(item => item.record.createdAt === 123456789))
})

test('duplicate ACK queueSequence is quarantined and replay fails closed before send', () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ackOutbox.initialize()
  ackOutbox.enqueue(buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'duplicate-sequence' }), { kind: 'none' })
  ackOutbox.enqueue(buildAckEnvelope(profile, ACK_STATUS.STARTED, { commandId: 'duplicate-sequence' }), { kind: 'none' })
  const alreadyInitializedObserver = new AckOutbox({ rootDir: storageRoot, profile })
  alreadyInitializedObserver.initialize()

  const firstFile = readdirSync(ackOutbox.acksDir).filter(name => name.endsWith('.json')).sort()[0]
  const duplicate = JSON.parse(readFileSync(resolve(ackOutbox.acksDir, firstFile), 'utf8'))
  writeFileSync(
    resolve(ackOutbox.acksDir, `${String(duplicate.queueSequence).padStart(20, '0')}-duplicate.json`),
    `${JSON.stringify(duplicate)}\n`,
    { mode: 0o600 }
  )
  let sends = 0
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => ({ status: 'completed' }),
    runChat: async () => {},
    ackOutbox,
    sendFn: () => { sends += 1; return true }
  })

  assert.equal(processor.replayAcks(), 0)
  assert.equal(sends, 0)
  assert.equal(processor.failClosedError?.code, 'ACK_OUTBOX_SEQUENCE_CORRUPT')
  assert.equal(ackOutbox.hasCorruption(), true)
  const quarantineReasons = readdirSync(ackOutbox.quarantineDir)
    .filter(name => name.endsWith('.reason.txt'))
    .map(name => readFileSync(resolve(ackOutbox.quarantineDir, name), 'utf8'))
  assert.ok(quarantineReasons.some(reason => /duplicate ACK queueSequence/.test(reason)))
  assert.throws(
    () => alreadyInitializedObserver.pendingEnvelopes(),
    error => error.code === 'ACK_OUTBOX_CORRUPT'
  )
})

test('valid ACK sequence rollback is detected after the outbox becomes empty', () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ackOutbox.initialize()
  const queued = ackOutbox.enqueue(
    buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'rollback-empty' }),
    { kind: 'none' }
  )
  ackOutbox.dequeue(queued.fileName)
  assert.equal(readdirSync(ackOutbox.acksDir).filter(name => name.endsWith('.json')).length, 0)
  writeFileSync(ackOutbox.sequencePath, `${JSON.stringify({ formatVersion: 1, lastSequence: 0 })}\n`, { mode: 0o600 })

  const restarted = new AckOutbox({ rootDir: storageRoot, profile })
  const initialization = restarted.initialize()
  assert.equal(initialization.corruptions, 1)
  assert.equal(restarted.hasCorruption(), true)
  assert.match(restarted.corruptionSummary(), /rollback\/conflict/)
  assert.throws(
    () => restarted.enqueue(buildAckEnvelope(profile, ACK_STATUS.STARTED, { commandId: 'rollback-empty' })),
    error => error.code === 'ACK_OUTBOX_CORRUPT'
  )
})

test('pending ACK above durable high-water is quarantined on startup', () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const first = new AckOutbox({ rootDir: storageRoot, profile })
  first.initialize()
  const record = {
    formatVersion: 1,
    queueSequence: 5,
    envelope: buildAckEnvelope(profile, ACK_STATUS.STARTED, { commandId: 'future-pending' }),
    marker: { kind: 'none' },
    createdAt: Date.now(),
    attempts: 0
  }
  writeFileSync(
    resolve(first.acksDir, '00000000000000000005-future.json'),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 }
  )

  const restarted = new AckOutbox({ rootDir: storageRoot, profile })
  const initialization = restarted.initialize()
  assert.equal(initialization.corruptions, 1)
  assert.equal(restarted.hasCorruption(), true)
  assert.match(restarted.corruptionSummary(), /exceeds durable high-water/)
  assert.equal(readdirSync(restarted.acksDir).filter(name => name.endsWith('.json')).length, 0)
})

test('ACK sequence lock contention and lock fsync failure fail closed without allocation', () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile, lockTimeoutMs: 0 })
  ackOutbox.initialize()

  ackOutbox.fs.mkdirSync(ackOutbox.lockPath, { mode: 0o700 })
  writeFileSync(ackOutbox.lockOwnerPath, JSON.stringify({ acquiredAt: 0 }), { mode: 0o600 })
  assert.throws(
    () => ackOutbox.enqueue(buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'lock-contention' })),
    error => error.code === 'ACK_OUTBOX_LOCK_TIMEOUT'
  )
  assert.equal(ackOutbox.fs.existsSync(ackOutbox.lockPath), true, 'stale lock must not be stolen')
  rmSync(ackOutbox.lockPath, { recursive: true, force: true })

  const originalMkdir = ackOutbox.fs.mkdirSync
  const originalFsync = ackOutbox.fs.fsyncSync
  let failLockFsync = false
  ackOutbox.fs.mkdirSync = (path, options) => {
    const result = originalMkdir(path, options)
    if (path === ackOutbox.lockPath) failLockFsync = true
    return result
  }
  ackOutbox.fs.fsyncSync = descriptor => {
    if (failLockFsync) {
      failLockFsync = false
      const error = new Error('injected lock fsync failure')
      error.code = 'EIO'
      throw error
    }
    return originalFsync(descriptor)
  }
  assert.throws(
    () => ackOutbox.enqueue(buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'lock-fsync' })),
    error => error.code === 'ACK_OUTBOX_LOCK_ERROR'
  )
  assert.equal(JSON.parse(readFileSync(ackOutbox.sequencePath, 'utf8')).lastSequence, 0)
  assert.equal(readdirSync(ackOutbox.acksDir).filter(name => name.endsWith('.json')).length, 0)
})

const prepareAckQuarantineLockRace = rootDir => {
  const storageRoot = profileStorageRoot(rootDir)
  const waiting = new AckOutbox({ rootDir: storageRoot, profile })
  const quarantining = new AckOutbox({ rootDir: storageRoot, profile })
  waiting.initialize()
  quarantining.initialize()
  waiting.enqueue(buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'quarantine-race' }), { kind: 'none' })

  const originalFile = readdirSync(waiting.acksDir).find(name => name.endsWith('.json'))
  const duplicate = JSON.parse(readFileSync(resolve(waiting.acksDir, originalFile), 'utf8'))
  writeFileSync(
    resolve(waiting.acksDir, `${String(duplicate.queueSequence).padStart(20, '0')}-race-duplicate.json`),
    `${JSON.stringify(duplicate)}\n`,
    { mode: 0o600 }
  )

  waiting.fs.mkdirSync(waiting.lockPath, { mode: 0o700 })
  writeFileSync(waiting.lockOwnerPath, JSON.stringify({
    pid: process.pid + 1,
    runtimeInstanceId: 'other-runtime',
    operation: 'barrier'
  }), { mode: 0o600 })
  let barrierRuns = 0
  waiting.sleepSync = () => {
    barrierRuns += 1
    rmSync(waiting.lockPath, { recursive: true, force: true })
    assert.throws(
      () => quarantining.pendingEnvelopes(),
      error => error.code === 'ACK_OUTBOX_SEQUENCE_CORRUPT'
    )
  }
  return { waiting, barrierRuns: () => barrierRuns }
}

test('enqueue rechecks durable quarantine after waiting for the sequence lock', () => {
  const rootDir = temporaryDirectory()
  const { waiting, barrierRuns } = prepareAckQuarantineLockRace(rootDir)
  const sequenceBefore = JSON.parse(readFileSync(waiting.sequencePath, 'utf8')).lastSequence
  const highWaterBefore = readdirSync(waiting.highWaterDir).filter(name => /^\d{20}\.json$/.test(name)).length

  assert.throws(
    () => waiting.enqueue(buildAckEnvelope(profile, ACK_STATUS.STARTED, { commandId: 'quarantine-race' }), { kind: 'none' }),
    error => error.code === 'ACK_OUTBOX_CORRUPT'
  )

  assert.equal(barrierRuns(), 1)
  assert.equal(JSON.parse(readFileSync(waiting.sequencePath, 'utf8')).lastSequence, sequenceBefore)
  assert.equal(readdirSync(waiting.highWaterDir).filter(name => /^\d{20}\.json$/.test(name)).length, highWaterBefore)
})

test('replay rechecks durable quarantine after lock wait and sends nothing', () => {
  const rootDir = temporaryDirectory()
  const { waiting, barrierRuns } = prepareAckQuarantineLockRace(rootDir)
  let sends = 0
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => ({ status: 'completed' }),
    runChat: async () => {},
    ackOutbox: waiting,
    sendFn: () => { sends += 1; return true }
  })

  assert.equal(processor.replayAcks(), 0)
  assert.equal(barrierRuns(), 1)
  assert.equal(sends, 0)
  assert.equal(processor.failClosedError?.code, 'ACK_OUTBOX_CORRUPT')
})

test('replay-held lock makes nested enqueue fail immediately instead of deadlocking', () => {
  const rootDir = temporaryDirectory()
  const ackOutbox = new AckOutbox({ rootDir: profileStorageRoot(rootDir), profile, lockTimeoutMs: 5000 })
  ackOutbox.initialize()
  ackOutbox.enqueue(buildAckEnvelope(profile, ACK_STATUS.RECEIVED, { commandId: 'nested-enqueue' }), { kind: 'none' })
  let nestedAttempts = 0
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => ({ status: 'completed' }),
    runChat: async () => {},
    ackOutbox,
    sendFn: () => {
      nestedAttempts += 1
      assert.throws(
        () => ackOutbox.enqueue(buildAckEnvelope(profile, ACK_STATUS.STARTED, { commandId: 'nested-enqueue' }), { kind: 'none' }),
        error => error.code === 'ACK_OUTBOX_LOCK_REENTRANT'
      )
      return false
    }
  })

  assert.equal(processor.replayAcks(), 0)
  assert.equal(nestedAttempts, 1)
  assert.equal(ackOutbox.pendingEnvelopes().length, 1)
})

test('ACK replay stops immediately when the first send returns false or throws', () => {
  for (const mode of ['false', 'throw']) {
    const rootDir = temporaryDirectory()
    const ackOutbox = new AckOutbox({ rootDir: profileStorageRoot(rootDir), profile, now: () => 1000 })
    ackOutbox.initialize()
    for (const status of [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED]) {
      ackOutbox.enqueue(buildAckEnvelope(profile, status, { commandId: `first-${mode}` }), { kind: 'none' })
    }
    const attempted = []
    const processor = new AgentMessageProcessor({
      profile,
      inbox: createInbox(rootDir),
      runCommand: async () => ({ status: 'completed' }),
      runChat: async () => {},
      ackOutbox,
      sendFn: envelope => {
        attempted.push(envelope.ackStatus)
        if (mode === 'throw') throw new Error('offline')
        return false
      }
    })

    assert.equal(processor.replayAcks(), 0, mode)
    assert.deepEqual(attempted, [ACK_STATUS.RECEIVED], mode)
    assert.deepEqual(
      ackOutbox.pendingEnvelopes().map(item => item.envelope.ackStatus),
      [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED],
      mode
    )
  }
})

test('ACK replay stops at a failed middle item and never sends later ACKs', () => {
  for (const mode of ['false', 'throw']) {
    const rootDir = temporaryDirectory()
    const ackOutbox = new AckOutbox({ rootDir: profileStorageRoot(rootDir), profile, now: () => 1000 })
    ackOutbox.initialize()
    for (const status of [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED]) {
      ackOutbox.enqueue(buildAckEnvelope(profile, status, { commandId: `middle-${mode}` }), { kind: 'none' })
    }
    const attempted = []
    const processor = new AgentMessageProcessor({
      profile,
      inbox: createInbox(rootDir),
      runCommand: async () => ({ status: 'completed' }),
      runChat: async () => {},
      ackOutbox,
      sendFn: envelope => {
        attempted.push(envelope.ackStatus)
        if (envelope.ackStatus !== ACK_STATUS.STARTED) return true
        if (mode === 'throw') throw new Error('offline')
        return false
      }
    })

    assert.equal(processor.replayAcks(), 1, mode)
    assert.deepEqual(attempted, [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED], mode)
    assert.deepEqual(
      ackOutbox.pendingEnvelopes().map(item => item.envelope.ackStatus),
      [ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED],
      mode
    )
  }
})


test('send false or throw keeps ACK markers false and records in the durable outbox', async () => {
  for (const [index, sendFn] of [
    ['false', () => false],
    ['throw', () => { throw new Error('offline') }]
  ].entries()) {
    const rootDir = temporaryDirectory()
    const ledger = new DurableDedupeLedger({ rootDir: profileStorageRoot(rootDir), profile })
    const ackOutbox = new AckOutbox({ rootDir: profileStorageRoot(rootDir), profile })
    ledger.initialize()
    ackOutbox.initialize()
    const processor = new AgentMessageProcessor({
      profile,
      inbox: createInbox(rootDir),
      runCommand: async () => ({ status: 'completed' }),
      runChat: async () => {},
      ledger,
      ackOutbox,
      sendFn
    })
    processor.start()
    await processor.handle(command(60 + index))
    await processor.waitForIdle()

    const entry = ledger.getEntry(`command-${60 + index}`)
    assert.equal(entry.ackReceivedEmitted, false, sendFn.name)
    assert.equal(entry.ackStartedEmitted, false, sendFn.name)
    assert.equal(entry.ackCompletedEmitted, false, sendFn.name)
    assert.equal(ackOutbox.pendingEnvelopes().length, 3)
  }
})

test('ACK marker persistence failure retains sent ACK for at-least-once replay', () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: profileStorageRoot(rootDir), profile })
  const ackOutbox = new AckOutbox({ rootDir: profileStorageRoot(rootDir), profile })
  inbox.initialize()
  ledger.initialize()
  ackOutbox.initialize()
  const normalized = normalizeInboundMessage(command(70))
  ledger.checkOrRecord(normalized.commandId, CommandFingerprint.compute(normalized), {
    messageId: normalized.messageId,
    commandType: normalized.commandType,
    targetAgentId: normalized.targetAgentId,
    taskId: normalized.taskId,
    workItemId: normalized.workItemId
  })
  const queued = inbox.enqueue(normalized)
  ledger.recordQueueSequence(normalized.commandId, queued.record.queueSequence)
  const errors = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => ({ status: 'completed' }),
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: () => true,
    onReject: error => errors.push(error.code)
  })
  processor.start({ drain: false })
  ledger.markAckEmitted = () => { throw new Error('marker fsync failed') }

  const emitted = processor._emitAck(ACK_STATUS.RECEIVED, {
    commandId: normalized.commandId,
    messageId: normalized.messageId,
    taskId: normalized.taskId,
    workItemId: normalized.workItemId
  })

  assert.deepEqual(emitted, {
    persisted: true,
    sent: true,
    markerPersisted: false,
    dequeued: false
  })
  assert.deepEqual(errors, ['ACK_MARKER_PERSIST_ERROR'])
  assert.equal(ackOutbox.pendingEnvelopes().length, 1)
  const persisted = JSON.parse(readFileSync(resolve(ledger.ledgerDir, `${Buffer.from(normalized.commandId).toString('hex')}.json`), 'utf8'))
  assert.equal(persisted.ackReceivedEmitted, false)
})

test('STARTED ACK persistence failure fail-closes before command side effects', async () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const inbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  let failNextAckFsync = false
  const ackOutbox = new AckOutbox({
    rootDir: storageRoot,
    profile,
    fs: {
      fsyncSync: descriptor => {
        if (failNextAckFsync) {
          failNextAckFsync = false
          throw new Error('injected STARTED ACK fsync failure')
        }
        return fsyncSync(descriptor)
      }
    }
  })
  ledger.initialize()
  ackOutbox.initialize()

  let runs = 0
  const acks = []
  const errors = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: envelope => {
      acks.push(envelope)
      if (envelope.ackStatus === ACK_STATUS.RECEIVED) {
        queueMicrotask(() => { failNextAckFsync = true })
      }
      return true
    },
    onReject: error => errors.push(error.code)
  })
  processor.start({ drain: false })

  await processor.handle(command(71))
  processor.resume()
  await processor.waitForIdle()

  assert.equal(runs, 0)
  assert.equal(inbox.count('pending'), 0)
  assert.equal(inbox.count('processing'), 0)
  assert.equal(inbox.count('recovery'), 1)
  const recovery = inbox.list('recovery')[0]
  assert.equal(recovery.commandId, 'command-71')
  assert.match(recovery.recoveryReason, /STARTED_ACK_NOT_DURABLE/)
  const entry = ledger.getEntry('command-71')
  assert.equal(entry.status, LEDGER_STATUS.RECOVERY_REQUIRED)
  assert.notEqual(entry.status, ACK_STATUS.SUCCEEDED)
  assert.match(entry.rejectReason, /STARTED_ACK_NOT_DURABLE/)
  assert.deepEqual(acks.map(envelope => envelope.ackStatus), [ACK_STATUS.RECEIVED, ACK_STATUS.REJECTED])
  assert.equal(entry.ackStartedEmitted, false)
  assert.equal(entry.ackRejectedEmitted, true)
  assert.equal(ackOutbox.pendingEnvelopes().length, 0)
  assert.ok(errors.includes('ACK_OUTBOX_PERSIST_ERROR'))
})

test('orphan RECEIVED ledger is reconciled to recovery-required across restart', async () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const normalized = normalizeInboundMessage(command(72))

  // Simulate a crash after the RECEIVED ledger fsync but before inbox enqueue.
  const ledgerBeforeCrash = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  ledgerBeforeCrash.initialize()
  ledgerBeforeCrash.checkOrRecord(normalized.commandId, CommandFingerprint.compute(normalized), {
    messageId: normalized.messageId,
    commandType: normalized.commandType,
    targetAgentId: normalized.targetAgentId,
    taskId: normalized.taskId,
    workItemId: normalized.workItemId
  })

  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ledger.initialize()
  ackOutbox.initialize()
  let sendSucceeds = false
  let runs = 0
  const acks = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: envelope => {
      if (sendSucceeds) acks.push(envelope)
      return sendSucceeds
    }
  })

  const startup = processor.start()
  assert.equal(startup.paused, true)
  assert.equal(startup.failClosedCode, 'COMMAND_RECOVERY_REQUIRED')
  assert.equal(runs, 0)
  const reconciled = ledger.getEntry(normalized.commandId)
  assert.equal(reconciled.status, LEDGER_STATUS.RECOVERY_REQUIRED)
  assert.match(reconciled.rejectReason, /ORPHAN_LEDGER_NO_INBOX/)
  assert.equal(reconciled.ackRejectedEmitted, false)
  const pending = ackOutbox.pendingEnvelopes()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].envelope.ackStatus, ACK_STATUS.REJECTED)

  sendSucceeds = true
  assert.equal(processor.replayAcks(), 1)
  assert.equal(ackOutbox.pendingEnvelopes().length, 0)
  assert.equal(ledger.getEntry(normalized.commandId).ackRejectedEmitted, true)

  const redelivery = { ...command(72), messageId: 'message-72-redelivery', requestId: 'message-72-redelivery' }
  const result = await processor.handle(redelivery)
  assert.equal(result.kind, 'command-duplicate')
  assert.equal(runs, 0)
  assert.deepEqual(acks.map(envelope => envelope.ackStatus), [ACK_STATUS.REJECTED, ACK_STATUS.REJECTED])
  assert.equal(acks.at(-1).correlationId, 'message-72-redelivery')
})

test('corrupt ledger is quarantined and the profile rejects and pauses', async () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const firstLedger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  firstLedger.initialize()
  writeFileSync(resolve(firstLedger.ledgerDir, `${Buffer.from('command-80').toString('hex')}.json`), '{bad ledger', { mode: 0o600 })

  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  const initialization = ledger.initialize()
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ackOutbox.initialize()
  const errors = []
  let runs = 0
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: () => true,
    onReject: error => errors.push(error.code)
  })
  const recovery = processor.start()
  const result = await processor.handle(command(80))

  assert.equal(initialization.corruptions, 1)
  assert.equal(recovery.paused, true)
  assert.equal(result.kind, 'rejected')
  assert.equal(result.error.code, 'DEDUPE_LEDGER_CORRUPT')
  assert.equal(runs, 0)
  assert.ok(errors.includes('DEDUPE_LEDGER_CORRUPT'))
  assert.ok(readdirSync(ledger.quarantineDir).some(name => name.endsWith('.json')))
  assert.ok(readdirSync(ledger.blockedDir).some(name => name.endsWith('.json')))
})

test('corrupt ACK is quarantined with an explicit fail-closed error', async () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  ledger.initialize()
  const firstOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  firstOutbox.initialize()
  writeFileSync(resolve(firstOutbox.acksDir, '000000000000001-corrupt.json'), '{bad ack', { mode: 0o600 })

  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  const initialization = ackOutbox.initialize()
  const errors = []
  let runs = 0
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: () => true,
    onReject: error => errors.push(error.code)
  })
  const recovery = processor.start()
  const result = await processor.handle(command(81))

  assert.equal(initialization.corruptions, 1)
  assert.equal(recovery.paused, true)
  assert.equal(result.kind, 'rejected')
  assert.equal(result.error.code, 'ACK_OUTBOX_CORRUPT')
  assert.equal(runs, 0)
  assert.ok(errors.includes('ACK_OUTBOX_CORRUPT'))
  assert.ok(readdirSync(ackOutbox.quarantineDir).some(name => name.endsWith('.json')))
  assert.ok(readdirSync(ackOutbox.quarantineDir).some(name => name.endsWith('.reason.txt')))
})


test('A06 durable ledger and ACK paths enforce private permissions', async () => {
  const rootDir = temporaryDirectory()
  const storageRoot = profileStorageRoot(rootDir)
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile })
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile })
  ledger.initialize()
  ackOutbox.initialize()
  const processor = new AgentMessageProcessor({
    profile,
    inbox: createInbox(rootDir),
    runCommand: async () => ({ status: 'completed' }),
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: () => false
  })
  processor.start()
  await processor.handle(command(82))
  await processor.waitForIdle()

  for (const directory of [
    ledger.ledgerDir,
    ledger.conflictsDir,
    ledger.quarantineDir,
    ledger.blockedDir,
    ackOutbox.acksDir,
    ackOutbox.quarantineDir,
    ackOutbox.highWaterDir
  ]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700, directory)
  }
  for (const directory of [ledger.ledgerDir, ackOutbox.acksDir, ackOutbox.highWaterDir]) {
    for (const fileName of readdirSync(directory)) {
      assert.equal(statSync(resolve(directory, fileName)).mode & 0o777, 0o600, `${directory}/${fileName}`)
    }
  }
  assert.equal(statSync(ackOutbox.sequencePath).mode & 0o777, 0o600, ackOutbox.sequencePath)
})

test('ack envelope uses an independent messageId and remains A03 normalizer-compatible', () => {
  const meta = {
    commandId: 'cmd-1',
    messageId: 'msg-1',
    commandType: 'TEST',
    taskId: 'task-1',
    workItemId: 'work-1'
  }
  const envelope = buildAckEnvelope(profile, ACK_STATUS.RECEIVED, meta)
  const secondEnvelope = buildAckEnvelope(profile, ACK_STATUS.STARTED, meta)

  assert.equal(envelope.schemaVersion, 1)
  assert.equal(envelope.messageType, MESSAGE_TYPES.COMMAND_ACK)
  assert.equal(envelope.commandId, 'cmd-1')
  assert.notEqual(envelope.messageId, 'msg-1')
  assert.notEqual(envelope.messageId, secondEnvelope.messageId)
  assert.equal(envelope.correlationId, 'msg-1')
  assert.equal(envelope.targetAgentId, undefined)
  assert.equal(envelope.ackStatus, ACK_STATUS.RECEIVED)
  assert.ok(Number.isSafeInteger(envelope.ackAt))
  assert.equal(envelope.taskId, 'task-1')
  assert.equal(envelope.workItemId, 'work-1')
  assert.equal(envelope.sourceAgentId, profile.agentId)
  assert.equal(envelope.runtimeInstanceId, PROCESS_RUNTIME_INSTANCE_ID)

  const normalized = normalizeInboundMessage({ ...envelope, requestId: envelope.messageId })
  assert.equal(normalized.messageId, envelope.messageId)
  assert.equal(normalized.correlationId, 'msg-1')
  assert.equal(normalized.messageType, MESSAGE_TYPES.COMMAND_ACK)
})

test('rejected ack includes rejectReason', () => {
  const envelope = buildAckEnvelope(profile, ACK_STATUS.REJECTED, {
    commandId: 'cmd-2',
    rejectReason: 'EXPIRED: too old'
  })
  assert.equal(envelope.ackStatus, ACK_STATUS.REJECTED)
  assert.equal(envelope.rejectReason, 'EXPIRED: too old')
})

test('ledger survives cross-restart and correctly identifies duplicates', async () => {
  const rootDir = temporaryDirectory()
  const ledgerDir = resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex'))

  // Phase 1: execute a command
  const inbox1 = createInbox(rootDir)
  const ledger1 = new DurableDedupeLedger({ rootDir: ledgerDir, profile })
  ledger1.initialize()
  const ackOutbox1 = new AckOutbox({ rootDir: ledgerDir, profile })
  ackOutbox1.initialize()

  let runs = 0
  const processor1 = new AgentMessageProcessor({
    profile,
    inbox: inbox1,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger: ledger1,
    ackOutbox: ackOutbox1,
    sendFn: () => true
  })
  processor1.start()
  await processor1.handle(command(1))
  await processor1.waitForIdle()
  assert.equal(runs, 1)

  // Phase 2: restart - new ledger reads the same directory
  const inbox2 = createInbox(rootDir)
  const ledger2 = new DurableDedupeLedger({ rootDir: ledgerDir, profile })
  ledger2.initialize()
  const ackOutbox2 = new AckOutbox({ rootDir: ledgerDir, profile })
  ackOutbox2.initialize()

  const processor2 = new AgentMessageProcessor({
    profile,
    inbox: inbox2,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger: ledger2,
    ackOutbox: ackOutbox2,
    sendFn: () => true
  })
  processor2.start()

  await processor2.handle(command(1))
  await processor2.waitForIdle()
  assert.equal(runs, 1, 'should not re-execute after restart')

  // Check ledger entry
  const entry = ledger2.getEntry('command-1')
  assert.ok(entry)
  assert.equal(entry.status, ACK_STATUS.SUCCEEDED)
  assert.equal(entry.commandId, 'command-1')
})

test('fingerprint is stable for semantically identical payloads', () => {
  const cmd1 = normalizeInboundMessage(command(1))
  const cmd2 = normalizeInboundMessage(command(1))
  assert.equal(CommandFingerprint.compute(cmd1), CommandFingerprint.compute(cmd2))
})

test('fingerprint stays stable when payload field order changes', () => {
  const cmd1 = normalizeInboundMessage({
    ...command(1),
    payload: {
      instruction: 'run 1',
      details: { alpha: 1, beta: 2 }
    }
  })
  const cmd2 = normalizeInboundMessage({
    ...command(1),
    payload: {
      details: { beta: 2, alpha: 1 },
      instruction: 'run 1'
    }
  })
  assert.equal(CommandFingerprint.compute(cmd1), CommandFingerprint.compute(cmd2))
})

test('fingerprint differs for different payloads', () => {
  const cmd1 = normalizeInboundMessage(command(1))
  const cmd2 = normalizeInboundMessage({
    ...command(1),
    payload: { instruction: 'different', details: { alpha: 1 } }
  })
  const changedOuterPrompt = normalizeInboundMessage({
    ...command(1),
    content: 'different effective prompt'
  })
  assert.notEqual(CommandFingerprint.compute(cmd1), CommandFingerprint.compute(cmd2))
  assert.notEqual(CommandFingerprint.compute(cmd1), CommandFingerprint.compute(changedOuterPrompt))
})


test('fingerprint includes deep business payload and ignores transport redelivery metadata', () => {
  const first = normalizeInboundMessage({
    ...command(90),
    messageId: 'dispatch-a',
    requestId: 'dispatch-a',
    runtimeInstanceId: 'runtime-a',
    correlationId: 'correlation-a',
    sentAt: 100,
    payload: {
      instruction: 'run deep task',
      plan: {
        transport: { messageId: 'nested-message-a', sessionId: 'session-a' },
        steps: [{ name: 'one', values: [1, 2, 3] }, { name: 'two', enabled: true }]
      }
    }
  })
  const redelivery = normalizeInboundMessage({
    ...command(90),
    messageId: 'dispatch-b',
    requestId: 'dispatch-b',
    runtimeInstanceId: 'runtime-b',
    correlationId: 'correlation-b',
    sentAt: 200,
    payload: {
      plan: {
        steps: [{ values: [1, 2, 3], name: 'one' }, { enabled: true, name: 'two' }],
        transport: { sessionId: 'session-b', messageId: 'nested-message-b' }
      },
      instruction: 'run deep task'
    }
  })
  const reorderedArray = normalizeInboundMessage({
    ...command(90),
    messageId: 'dispatch-c',
    requestId: 'dispatch-c',
    payload: {
      instruction: 'run deep task',
      plan: {
        transport: { messageId: 'ignored', sessionId: 'ignored' },
        steps: [{ name: 'two', enabled: true }, { name: 'one', values: [1, 2, 3] }]
      }
    }
  })
  const changedNestedValue = normalizeInboundMessage({
    ...command(90),
    messageId: 'dispatch-d',
    requestId: 'dispatch-d',
    payload: {
      instruction: 'run deep task',
      plan: {
        steps: [{ name: 'one', values: [1, 2, 4] }, { name: 'two', enabled: true }]
      }
    }
  })

  const fingerprint = CommandFingerprint.compute(first)
  assert.equal(fingerprint, CommandFingerprint.compute(redelivery))
  assert.notEqual(fingerprint, CommandFingerprint.compute(reorderedArray))
  assert.notEqual(fingerprint, CommandFingerprint.compute(changedNestedValue))
})

test('same commandId is isolated across agent profiles', async () => {
  const rootDir = temporaryDirectory()
  const profileB = { ...profile, profileId: 'profile-b', agentId: 'agent-b', agentName: 'Agent B', personaName: 'Agent B' }
  const runs = { a: 0, b: 0 }
  const createRuntime = (selectedProfile, key, instruction) => {
    const storageRoot = profileStorageRoot(rootDir, selectedProfile)
    const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile: selectedProfile })
    const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile: selectedProfile })
    ledger.initialize()
    ackOutbox.initialize()
    const inbox = new PersistentCommandInbox({ rootDir, profile: selectedProfile })
    const processor = new AgentMessageProcessor({
      profile: selectedProfile,
      inbox,
      runCommand: async () => { runs[key] += 1; return { status: 'completed' } },
      runChat: async () => {},
      ledger,
      ackOutbox,
      sendFn: () => true
    })
    processor.start()
    const dispatch = {
      ...command(91),
      messageId: `message-${key}`,
      requestId: `message-${key}`,
      commandId: 'shared-command-id',
      targetAgentId: selectedProfile.agentId,
      content: instruction,
      payload: { instruction }
    }
    return { storageRoot, ledger, processor, dispatch }
  }

  const runtimeA = createRuntime(profile, 'a', 'payload for agent a')
  const runtimeB = createRuntime(profileB, 'b', 'different payload for agent b')
  await runtimeA.processor.handle(runtimeA.dispatch)
  await runtimeB.processor.handle(runtimeB.dispatch)
  await Promise.all([runtimeA.processor.waitForIdle(), runtimeB.processor.waitForIdle()])

  assert.deepEqual(runs, { a: 1, b: 1 })
  assert.notEqual(runtimeA.storageRoot, runtimeB.storageRoot)
  assert.equal(runtimeA.ledger.getEntry('shared-command-id').status, ACK_STATUS.SUCCEEDED)
  assert.equal(runtimeB.ledger.getEntry('shared-command-id').status, ACK_STATUS.SUCCEEDED)
  assert.equal(runtimeA.ledger.getConflicts('shared-command-id').length, 0)
  assert.equal(runtimeB.ledger.getConflicts('shared-command-id').length, 0)
})

test('completed command across restart replays terminal ACK without re-execution', async () => {
  const rootDir = temporaryDirectory()
  const ledgerDir = resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex'))

  // Execute and complete a command
  const inbox1 = createInbox(rootDir)
  const ledger1 = new DurableDedupeLedger({ rootDir: ledgerDir, profile })
  ledger1.initialize()
  const ackOutbox1 = new AckOutbox({ rootDir: ledgerDir, profile })
  ackOutbox1.initialize()

  let runs = 0
  const processor1 = new AgentMessageProcessor({
    profile,
    inbox: inbox1,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger: ledger1,
    ackOutbox: ackOutbox1,
    sendFn: () => true
  })
  processor1.start()
  await processor1.handle(command(10))
  await processor1.waitForIdle()
  assert.equal(runs, 1)

  // Restart: new processor, clear acks list
  const inbox2 = createInbox(rootDir)
  const ledger2 = new DurableDedupeLedger({ rootDir: ledgerDir, profile })
  ledger2.initialize()
  const ackOutbox2 = new AckOutbox({ rootDir: ledgerDir, profile })
  ackOutbox2.initialize()

  const replayedAcks = []
  const processor2 = new AgentMessageProcessor({
    profile,
    inbox: inbox2,
    runCommand: async () => { runs += 1; return { status: 'completed' } },
    runChat: async () => {},
    ledger: ledger2,
    ackOutbox: ackOutbox2,
    sendFn: env => { replayedAcks.push(env.ackStatus); return true }
  })
  processor2.start()

  await processor2.handle(command(10))
  await processor2.waitForIdle()
  assert.equal(runs, 1, 'must not re-execute completed command after restart')
  assert.deepEqual(replayedAcks, ['SUCCEEDED'], 'completed duplicate replays current terminal ACK')
})

test('command fails and ACK reflects FAILED status', async () => {
  const rootDir = temporaryDirectory()
  const inbox = createInbox(rootDir)
  const ledger = new DurableDedupeLedger({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ledger.initialize()
  const ackOutbox = new AckOutbox({
    rootDir: resolve(rootDir, Buffer.from(profile.agentId, 'utf8').toString('hex')),
    profile
  })
  ackOutbox.initialize()

  const allAcks = []
  const processor = new AgentMessageProcessor({
    profile,
    inbox,
    runCommand: async () => { throw new Error('command failure') },
    runChat: async () => {},
    ledger,
    ackOutbox,
    sendFn: env => { allAcks.push(env.ackStatus); return true }
  })
  processor.start()

  await processor.handle(command(1))
  await processor.waitForIdle()

  assert.deepEqual(allAcks, ['RECEIVED', 'STARTED', 'FAILED'])
  const entry = ledger.getEntry('command-1')
  assert.equal(entry.status, ACK_STATUS.FAILED)
  assert.ok(entry.outcome)
  assert.equal(entry.outcome.status, 'failed')

  allAcks.length = 0
  await processor.handle(command(1))
  await processor.waitForIdle()
  assert.deepEqual(allAcks, ['FAILED'])
})

test('all 5 ACK status constants are defined', () => {
  assert.equal(ACK_STATUS.RECEIVED, 'RECEIVED')
  assert.equal(ACK_STATUS.STARTED, 'STARTED')
  assert.equal(ACK_STATUS.SUCCEEDED, 'SUCCEEDED')
  assert.equal(ACK_STATUS.FAILED, 'FAILED')
  assert.equal(ACK_STATUS.REJECTED, 'REJECTED')
})

test('standalone --validate still works with a06 additions', () => {
  const output = execFileSync(process.execPath, ['agent-client.mjs', '--validate'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_API_KEY: 'test',
      CODEX_PROFILES_FILE: '',
      CODEX_PROFILES: JSON.stringify([{ profileId: 'validate', agentId: 'agent-a', codexBin: '/bin/true', codexWorkdir: '/tmp' }]),
      DEFAULT_CODEX_PROFILE: 'validate',
      CODEX_PROFILE_RELOAD_MS: '0'
    }
  })
  assert.match(output, /configuration valid/)
})
