import { PROCESS_RUNTIME_INSTANCE_ID as proofRuntimeId } from '../agent-client.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAgentPresencePayload,
  buildCodexArgs,
  buildAgentRegistrationPayload,
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

test('new registration never trusts image capability prose or legacy profile toggles; only measured skills advertise execution', () => {
  const profile = configuredProfile(), runtime = null
  for (const current of [profile, { ...profile, skills: ['imagegen'], abilities: ['GENERATE_IMAGE'] }, { ...profile, status: 'offline' }]) {
    const payload = buildAgentRegistrationPayload(current, runtime, true)
    assert.equal(payload.nativeBountyExecution, undefined)
    assert.equal(payload.nativeTextFileExecution, undefined)
    assert.equal(payload.skillExecution, undefined)
    assert.deepEqual(payload.runtimeCapabilities.profiles.EXECUTE, { supported: false, enabled: false })
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

  const serverDeclaration = buildAgentRegistrationPayload(server, null, true).nativeBountyExecution
  const localDeclaration = buildAgentRegistrationPayload(local, null, true).nativeBountyExecution
  assert.deepEqual(localDeclaration, serverDeclaration)
  assert.equal(localDeclaration, undefined)
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
  assert.equal(presence.runtimeCapabilities, undefined)
  assert.deepEqual(buildAgentRegistrationPayload(enabled).runtimeCapabilities.profiles.EXECUTE, { supported: false, enabled: false })
})


test('ordinary profile flag is inherited, while mixed image runtime does not advertise text execution', () => {
  const inherited = inheritManagedRuntimeCapabilities({}, { nativeConversationTextFileEnabled: true })
  assert.equal(inherited.nativeConversationTextFileEnabled, true)
  const profile = configuredProfile({ nativeConversationTextFileEnabled: true, nativeConversationImageGenerationEnabled: true })
  const runtime = null
  assert.equal(buildAgentRegistrationPayload(profile, runtime, true).nativeTextFileExecution, undefined)
})

test('Codex text run args pin private run directory, workspace-write, never approval, exec mode, and fresh session', () => {
  const profile = { codexBin: '/opt/codex', codexApproval: 'never', codexSandbox: 'workspace-write', codexModel: 'model-x', codexSessionMode: 'resume' }
  const args = buildCodexArgs(profile, { taskId: 'task-1' }, 'prompt', '/private/run', true)
  assert.deepEqual(args.slice(0, 7), ['--ask-for-approval', 'never', 'exec', '--cd', '/private/run', '--sandbox', 'workspace-write'])
  assert.ok(args.includes('--skip-git-repo-check'))
  assert.equal(args.at(-1), 'prompt')
  assert.equal(args.includes('resume'), false)
})
