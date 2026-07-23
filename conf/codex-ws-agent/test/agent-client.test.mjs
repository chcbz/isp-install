import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test, { afterEach } from 'node:test'

import {
  AgentMessageProcessor,
  MESSAGE_TYPES,
  PersistentCommandInbox,
  PROCESS_RUNTIME_INSTANCE_ID,
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

test('processing command is recovered after process restart', async () => {
  const rootDir = temporaryDirectory()
  const firstInbox = createInbox(rootDir)
  firstInbox.initialize()
  firstInbox.enqueue(normalizeInboundMessage(command(1)))
  const claimed = firstInbox.claimNext()
  assert.equal(claimed.record.commandId, 'command-1')
  assert.equal(claimed.record.messageId, 'message-1')
  assert.equal(claimed.record.taskId, 'task-1')
  assert.equal(claimed.record.workItemId, 'work-1')
  assert.equal(claimed.record.attempt, 1)
  assert.equal(claimed.record.rawPayload.messageType, MESSAGE_TYPES.COMMAND_DISPATCH)
  assert.equal(firstInbox.count('processing'), 1)

  const restartedInbox = createInbox(rootDir)
  const recovery = restartedInbox.initialize()
  assert.equal(recovery.recovered, 1)
  assert.equal(restartedInbox.count('processing'), 0)
  assert.equal(restartedInbox.count('pending'), 1)

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

  for (const directory of [inbox.profileDir, inbox.pendingDir, inbox.processingDir, inbox.archiveDir, inbox.quarantineDir]) {
    chmodSync(directory, 0o755)
  }
  chmodSync(inbox.sequencePath, 0o644)
  for (const directory of [inbox.pendingDir, inbox.processingDir, inbox.archiveDir, inbox.quarantineDir]) {
    for (const fileName of readdirSync(directory)) chmodSync(resolve(directory, fileName), 0o666)
  }

  const restarted = createInbox(rootDir)
  restarted.initialize()
  for (const directory of [restarted.profileDir, restarted.pendingDir, restarted.processingDir, restarted.archiveDir, restarted.quarantineDir]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700)
  }
  assert.equal(statSync(restarted.sequencePath).mode & 0o777, 0o600)
  for (const directory of [restarted.pendingDir, restarted.processingDir, restarted.archiveDir, restarted.quarantineDir]) {
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
