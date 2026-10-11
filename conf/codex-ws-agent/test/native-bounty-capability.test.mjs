import { PROCESS_RUNTIME_INSTANCE_ID as proofRuntimeId } from '../agent-client.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAgentPresencePayload,
  buildCodexArgs,
  buildAgentRegistrationPayload,
  createNativeBountyExecutionRuntime,
  inheritManagedRuntimeCapabilities,
  normalizeProfile
} from '../agent-client.mjs'

const sessionProof = (auth, agentId = 'native-server', runtimeInstanceId = proofRuntimeId) => ({
  Authorization: auth, 'X-Agent-Id': agentId, 'X-Agent-Runtime-Id': runtimeInstanceId,
  'X-Agent-Installation-Id': 'synthetic-installation', 'X-Agent-Host-Id': 'synthetic-host',
  'X-Agent-Session-Generation': '7'
})
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
  getRuntimeHeaders: () => sessionProof(`AgentRuntime rts1_${'a'.repeat(64)}`, profile.agentId),
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


test('text-file native lane is selected only by explicit flag and stays separate from image readiness', async () => {
  const profile = configuredProfile({ nativeConversationImageGenerationEnabled: false, nativeConversationTextFileEnabled: true })
  let created; let executions = 0
  const runtime = createNativeBountyExecutionRuntime({ profile, getRuntimeHeaders: () => sessionProof(`AgentRuntime rts1_${'a'.repeat(64)}`, profile.agentId),
    executeTextFile: async args => { executions++; return args },
    createPollProtocol: options => { created = options; return { poll() {} } } })
  assert.equal(runtime.adapterKind, 'CODEX_TEXT_FILE_NATIVE_V1')
  assert.equal(runtime.nativeTextFileV1Ready, true)
  assert.equal(runtime.nativeBountyV1Ready, false)
  assert.equal(runtime.credentialReady, false)
  assert.equal(runtime.executor, created.execute)
  assert.deepEqual(await runtime.executor({ command: { outputContentMimeType: 'text/plain' } }), { command: { outputContentMimeType: 'text/plain' } })
  assert.throws(() => runtime.executor({ command: { outputContentMimeType: 'image/png' } }), /CONVERSATION_TEXT_FILE_COMMAND_INVALID/)
  assert.equal(executions, 1)
  const registration = buildAgentRegistrationPayload(profile, runtime, true)
  assert.equal(registration.nativeTextFileExecution.enabled, true)
  assert.deepEqual(registration.nativeTextFileExecution.mimeTypes, ['text/plain'])
  assert.equal(registration.nativeTextFileExecution.maxSources, 0)
  assert.equal(buildAgentRegistrationPayload(profile, runtime, false).nativeTextFileExecution.enabled, false)
  assert.equal(buildAgentPresencePayload(profile, 'offline', { nativeRuntime: runtime }).nativeTextFileExecution, undefined)
})

test('text-file lane cannot be inherited for managed identities or mixed with image lanes', () => {
  const inherited = inheritManagedRuntimeCapabilities({}, { nativeConversationTextFileEnabled: true })
  assert.equal(inherited.nativeConversationTextFileEnabled, true)
  const profile = configuredProfile({ nativeConversationTextFileEnabled: true, nativeConversationImageGenerationEnabled: true })
  const runtime = runtimeFor(profile)
  assert.equal(runtime.nativeTextFileV1Ready, false)
  assert.equal(buildAgentRegistrationPayload(profile, runtime, true).nativeTextFileExecution.enabled, false)
})

test('Codex text run args pin private run directory, workspace-write, never approval, exec mode, and fresh session', () => {
  const profile = { codexBin: '/opt/codex', codexApproval: 'never', codexSandbox: 'workspace-write', codexModel: 'model-x', codexSessionMode: 'resume' }
  const args = buildCodexArgs(profile, { taskId: 'task-1' }, 'prompt', '/private/run', true)
  assert.deepEqual(args.slice(0, 7), ['--ask-for-approval', 'never', 'exec', '--cd', '/private/run', '--sandbox', 'workspace-write'])
  assert.ok(args.includes('--skip-git-repo-check'))
  assert.equal(args.at(-1), 'prompt')
  assert.equal(args.includes('resume'), false)
})
