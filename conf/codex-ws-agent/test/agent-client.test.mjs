import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
