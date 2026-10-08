import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAgentPresencePayload,
  buildAgentRegistrationPayload,
  createNativeBountyExecutionRuntime,
  inheritManagedRuntimeCapabilities,
  normalizeProfile
} from '../agent-client.mjs'

const configuredProfile = overrides => normalizeProfile({
  profileId: 'native-server',
  agentId: 'native-server',
  agentName: 'Native Server',
  personaName: 'Native Server',
  codexBin: '/bin/true',
  codexWorkdir: process.cwd(),
  workspaceFileApiOrigin: 'https://api.example.test',
  workspaceFileRootDir: '/private/native-runs',
  nativeConversationHttpPollEnabled: true,
  nativeConversationImageGenerationEnabled: true,
  ...overrides
})

const runtimeFor = (profile, hooks = {}) => createNativeBountyExecutionRuntime({
  profile,
  workspaceFileBridge: hooks.workspaceFileBridge === undefined ? {} : hooks.workspaceFileBridge,
  toolchainReady: hooks.toolchainReady === undefined ? true : hooks.toolchainReady,
  getAuth: () => `AgentRuntime ${'a'.repeat(32)}`,
  executeImage: hooks.executeImage || (async () => { throw new Error('declaration must not execute Provider work') }),
  createPollProtocol: hooks.createPollProtocol || (options => ({ poll: async () => ({ processed: 0 }), options }))
})

const expectedEnabledDeclaration = {
  schemaVersion: 1,
  enabled: true,
  transport: 'PERSONAL_WORKSPACE_CONVERSATION_HTTP_V1',
  commandSchemaVersions: [1],
  leaseProtocolVersions: [1],
  providerStartFenceVersions: [1],
  resultCommitProtocolVersions: [1],
  operations: [{
    operation: 'GENERATE_IMAGE',
    inputManifest: {
      schemaVersion: 1,
      minItems: 0,
      maxItems: 32,
      mimeTypes: ['image/jpeg', 'image/png']
    },
    resultManifest: {
      schemaVersion: 1,
      minItems: 1,
      maxItems: 1,
      outputId: 'output_1',
      mimeTypes: ['image/png']
    }
  }]
}

const assertDisabled = declaration => {
  assert.equal(declaration.enabled, false)
  assert.deepEqual(declaration.operations, [])
  assert.equal(declaration.transport, 'PERSONAL_WORKSPACE_CONVERSATION_HTTP_V1')
}

test('agent.register declares only the exact enabled GENERATE_IMAGE HTTP-poll contract', () => {
  const profile = configuredProfile()
  const runtime = runtimeFor(profile)
  const payload = buildAgentRegistrationPayload(profile, runtime, true)

  assert.deepEqual(payload.nativeBountyExecution, expectedEnabledDeclaration)
  assert.deepEqual(payload.runtimeCapabilities.profiles.EXECUTE, { supported: false, enabled: false })
  assert.equal(Object.isFrozen(payload.nativeBountyExecution), true)
  assert.equal(Object.isFrozen(payload.nativeBountyExecution.operations), true)
  assert.equal(Object.isFrozen(payload.nativeBountyExecution.operations[0].inputManifest), true)
})

test('missing config, disabled executor, offline state, or skill/profile hints stay disabled', () => {
  const profile = configuredProfile()
  const ready = runtimeFor(profile)

  assertDisabled(buildAgentRegistrationPayload(
    configuredProfile({ workspaceFileRootDir: '' }),
    runtimeFor(configuredProfile({ workspaceFileRootDir: '' })),
    true
  ).nativeBountyExecution)
  assertDisabled(buildAgentRegistrationPayload(
    configuredProfile({ nativeConversationImageGenerationEnabled: false }),
    ready,
    true
  ).nativeBountyExecution)
  assertDisabled(buildAgentRegistrationPayload(profile, ready, false).nativeBountyExecution)
  assertDisabled(buildAgentRegistrationPayload(
    configuredProfile({ status: 'offline', skills: ['imagegen'], abilities: ['GENERATE_IMAGE'] }),
    ready,
    true
  ).nativeBountyExecution)
  assertDisabled(buildAgentRegistrationPayload(
    configuredProfile({
      nativeConversationHttpPollEnabled: false,
      nativeConversationImageGenerationEnabled: false,
      skills: ['imagegen'],
      abilities: ['GENERATE_IMAGE']
    }),
    { configReady: true, httpPollEnabled: true, executor: () => {}, pollProtocol: { poll() {} } },
    true
  ).nativeBountyExecution)
})

test('runtime readiness requires an actual executor, usable local config, and poll implementation without probing them', () => {
  const profile = configuredProfile()
  let executorCalls = 0
  let pollCalls = 0
  const runtime = runtimeFor(profile, {
    executeImage: async () => { executorCalls++; return null },
    createPollProtocol: options => ({
      options,
      poll: async () => { pollCalls++; return { processed: 0 } }
    })
  })

  assert.equal(runtime.configReady, true)
  assert.equal(runtime.httpPollEnabled, true)
  assert.equal(typeof runtime.executor, 'function')
  assert.equal(typeof runtime.pollProtocol.poll, 'function')
  assert.equal(executorCalls, 0)
  assert.equal(pollCalls, 0)

  for (const unavailable of [
    runtimeFor(profile, { toolchainReady: false }),
    runtimeFor(profile, { workspaceFileBridge: null }),
    runtimeFor(profile, { createPollProtocol: () => ({}) }),
    runtimeFor(configuredProfile({ nativeConversationHttpPollEnabled: false }))
  ]) {
    assert.equal(unavailable.configReady, false)
    assert.equal(unavailable.executor, null)
    assert.equal(unavailable.pollProtocol, null)
  }
})

test('server and managed-local profiles use the same frozen declaration protocol', () => {
  const server = configuredProfile()
  const local = inheritManagedRuntimeCapabilities({
    profileId: 'managed:local',
    agentId: 'managed-local',
    agentName: 'Managed Local',
    personaName: 'Managed Local',
    enabled: true,
    status: ''
  }, server)

  const serverDeclaration = buildAgentRegistrationPayload(server, runtimeFor(server), true).nativeBountyExecution
  const localDeclaration = buildAgentRegistrationPayload(local, runtimeFor(local), true).nativeBountyExecution
  assert.deepEqual(localDeclaration, serverDeclaration)
  assert.deepEqual(localDeclaration, expectedEnabledDeclaration)
})

test('native executor flags are strict config and never mutate fast-v1 presence capabilities', () => {
  const enabled = configuredProfile({
    nativeConversationHttpPollEnabled: 'true',
    nativeConversationImageGenerationEnabled: 'true'
  })
  const hintsOnly = configuredProfile({
    nativeConversationHttpPollEnabled: '1',
    nativeConversationImageGenerationEnabled: '1',
    skills: ['imagegen']
  })
  assert.equal(enabled.nativeConversationHttpPollEnabled, true)
  assert.equal(enabled.nativeConversationImageGenerationEnabled, true)
  assert.equal(hintsOnly.nativeConversationHttpPollEnabled, false)
  assert.equal(hintsOnly.nativeConversationImageGenerationEnabled, false)

  const presence = buildAgentPresencePayload(enabled, 'online')
  assert.equal('nativeBountyExecution' in presence, false)
  assert.deepEqual(presence.runtimeCapabilities.profiles.EXECUTE, { supported: false, enabled: false })
})
