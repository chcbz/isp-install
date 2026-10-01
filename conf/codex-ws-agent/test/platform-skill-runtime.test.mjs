import assert from 'node:assert/strict'
import test from 'node:test'

import { PlatformSkillRuntime, PLATFORM_SKILL_PROTOCOL } from '../platform-skill-runtime.mjs'

const profile = { profileId: 'profile-a', agentId: 'agent-a', codexHome: '/tmp/codex-home' }
const runtimeScope = { scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a',
  agentId: 'agent-a', runtimeInstanceId: 'runtime-a', contextPackEnabled: true }
const base = overrides => new PlatformSkillRuntime({
  profile,
  commandInboxDir: '/tmp/inbox',
  wsUrl: 'wss://api.example.invalid/ws',
  authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`,
  availability: () => true,
  ...overrides
})

test('default-off runtime advertises no controlled protocol and never constructs a manager', async () => {
  let constructions = 0
  const runtime = base({ managerFactory: () => { constructions++; throw new Error('must not construct') } })
  assert.deepEqual(runtime.commandProtocols, [])
  assert.deepEqual(await runtime.activateAndRecover(runtimeScope), { active: false, recovered: [] })
  const result = await runtime.execute({ commandType: 'PLATFORM_SKILL_INSTALL', commandId: 'command-a' })
  assert.equal(result.status, 'failed')
  assert.match(result.errorMessage, /^CONTROLLED_COMMAND_UNAVAILABLE:/)
  assert.equal(constructions, 0)
})

test('enabled but unsupported production bridge is not advertised or initialized', async () => {
  let constructions = 0
  const runtime = base({ enabled: true, availability: () => false, managerFactory: () => { constructions++; return {} } })
  assert.deepEqual(runtime.commandProtocols, [])
  assert.deepEqual(await runtime.activateAndRecover(runtimeScope), { active: false, recovered: [] })
  assert.equal(constructions, 0)
})


test('archive protocol is advertised only when explicitly enabled and its production bridge is supported', async () => {
  let runnerOptions
  const manager = { initialize: () => {}, reconcileCommandOutcome: () => null }
  const runtime = base({
    archiveEnabled: true,
    archiveAvailability: () => true,
    managerFactory: () => manager,
    archiveRunnerFactory: options => {
      runnerOptions = options
      return { execute: async () => ({ status: 'completed' }), reconcileCommandOutcome: () => null }
    }
  })
  assert.deepEqual(runtime.commandProtocols, ['ARCHIVE_MAINTENANCE_EXECUTE/v1'])
  assert.equal((await runtime.activateAndRecover(runtimeScope)).active, true)
  assert.deepEqual(runnerOptions.runtimeScope, runtimeScope)
  assert.equal((await runtime.execute({ commandType: 'ARCHIVE_MAINTENANCE_EXECUTE', commandId: 'archive-a' })).status, 'completed')

  const unsupported = base({ archiveEnabled: true, archiveAvailability: () => false, managerFactory: () => manager })
  assert.deepEqual(unsupported.commandProtocols, [])
  assert.deepEqual(await unsupported.activateAndRecover(runtimeScope), { active: false, recovered: [] })
})

test('enabled runtime advertises only PLATFORM_SKILL_INSTALL/v1 and routes after recovery', async () => {
  const calls = []
  let options
  const manager = {
    maxReplayBatch: 32,
    initialize: () => calls.push('initialize'),
    replayPending: async () => { calls.push('recover'); return [] },
    execute: async message => { calls.push(`execute:${message.commandId}`); return { status: 'completed' } },
    reconcileCommandOutcome: message => ({ status: 'completed', authoritative: message.commandId === 'command-a' })
  }
  const runtime = base({ enabled: true, managerFactory: value => { options = value; return manager } })
  assert.deepEqual(runtime.commandProtocols, [PLATFORM_SKILL_PROTOCOL])
  assert.equal(runtime.commandProtocols.includes('ARCHIVE_MAINTENANCE_EXECUTE/v1'), false)
  const activated = await runtime.activateAndRecover(runtimeScope)
  assert.equal(activated.active, true)
  assert.deepEqual(calls, ['initialize', 'recover'])
  assert.deepEqual(options.runtimeScope, runtimeScope)
  assert.equal(options.sessionSignal.aborted, false)
  assert.equal(options.authorizationProvider({}), `AgentRuntime ${'a'.repeat(32)}`)
  assert.equal((await runtime.execute({ commandType: 'PLATFORM_SKILL_INSTALL', commandId: 'command-a' })).status, 'completed')
  assert.equal(runtime.reconcileCommandOutcome({ commandId: 'command-a' }).authoritative, true)
})

test('disconnect fences an in-progress recovery generation and prevents activation authority', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let signal
  const manager = {
    maxReplayBatch: 32,
    initialize: () => {},
    replayPending: async () => { await gate; return [] },
    execute: async () => ({ status: 'completed' }),
    reconcileCommandOutcome: () => ({ status: 'completed', authoritative: true })
  }
  const runtime = base({ enabled: true, managerFactory: options => { signal = options.sessionSignal; return manager } })
  const recovery = runtime.activateAndRecover(runtimeScope)
  await new Promise(resolve => setImmediate(resolve))
  runtime.disconnect('test rotation')
  assert.equal(signal.aborted, true)
  release()
  const result = await recovery
  assert.equal(result.active, false)
  assert.equal(result.stale, true)
  assert.equal(runtime.ready, false)
  assert.equal(runtime.reconcileCommandOutcome({ commandId: 'command-a' }), null)
  assert.equal((await runtime.execute({ commandType: 'PLATFORM_SKILL_INSTALL', commandId: 'command-a' })).status, 'failed')
})


test('recovery drains more than sixteen bounded pages and becomes ready only after explicit manager completion', async () => {
  let page = 0
  const manager = {
    maxReplayBatch: 32,
    replayPendingComplete: false,
    initialize: () => {},
    replayPending: async () => {
      page += 1
      if (page <= 16) return Array.from({ length: 32 }, (_, index) => ({ page, index }))
      manager.replayPendingComplete = true
      return [{ page, index: 0 }]
    },
    execute: async () => ({ status: 'completed' }),
    reconcileCommandOutcome: () => null
  }
  const runtime = base({ enabled: true, managerFactory: () => manager })
  const result = await runtime.activateAndRecover(runtimeScope)
  assert.equal(result.active, true)
  assert.equal(result.recovered.length, 513)
  assert.equal(page, 17)
  assert.equal(runtime.ready, true)
})

test('manager options cannot override server authority, state namespace, or socket fencing', async () => {
  let options
  const manager = { maxReplayBatch: 32, replayPendingComplete: true, initialize: () => {}, replayPending: async () => [],
    execute: async () => ({ status: 'completed' }), reconcileCommandOutcome: () => null }
  const runtime = base({
    enabled: true,
    managerOptions: { runtimeScope: { agentId: 'forged' }, authorizationProvider: () => 'forged', sessionSignal: null,
      stateRoot: '/forged', wsUrl: 'wss://forged.invalid' },
    managerFactory: value => { options = value; return manager }
  })
  assert.equal((await runtime.activateAndRecover(runtimeScope)).active, true)
  assert.deepEqual(options.runtimeScope, runtimeScope)
  assert.notEqual(options.stateRoot, '/forged')
  assert.equal(options.wsUrl, 'wss://api.example.invalid/ws')
  assert.equal(options.authorizationProvider({}), `AgentRuntime ${'a'.repeat(32)}`)
  assert.equal(options.sessionSignal.aborted, false)
})


test('socket rotation makes an in-flight archive result nonterminal even when the stale runner resolves completed', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const manager = { initialize: () => {}, reconcileCommandOutcome: () => null }
  const runner = { execute: async () => { await gate; return { status: 'completed' } }, reconcileCommandOutcome: () => null }
  const runtime = base({ archiveEnabled: true, archiveAvailability: () => true, managerFactory: () => manager, archiveRunnerFactory: () => runner })
  assert.equal((await runtime.activateAndRecover(runtimeScope)).active, true)
  const executing = runtime.execute({ commandType: 'ARCHIVE_MAINTENANCE_EXECUTE', commandId: 'archive-stale' })
  await new Promise(resolve => setImmediate(resolve))
  runtime.disconnect('test registration rotation')
  release()
  const outcome = await executing
  assert.equal(outcome.status, 'recovery_required')
  assert.match(outcome.errorMessage, /socket registration rotated/)
})
