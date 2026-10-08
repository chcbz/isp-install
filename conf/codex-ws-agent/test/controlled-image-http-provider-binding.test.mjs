import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAgentRegistrationPayload, normalizeProfile } from '../agent-client.mjs'
import { buildNativeProviderCredentialBinding } from '../controlled-image-http-provider-binding.mjs'

const profile = normalizeProfile({
  profileId: 'controlled-profile', agentId: 'controlled-agent', agentName: 'Controlled', personaName: 'Controlled',
  controlledImageHttpEnabled: true, nativeConversationHttpPollEnabled: true,
  controlledImageHttpEndpoint: 'https://api.example.test', controlledImageHttpApiKeyEnv: 'IMAGE_KEY',
  controlledImageHttpModelId: 'operator-model', controlledImageHttpBindingId: 'binding-1',
  controlledImageHttpBindingEpoch: '9', controlledImageHttpLedgerRoot: '/private/ledger'
})
const config = Object.freeze({ enabled: true, providerLane: 'CONTROLLED_IMAGE_HTTP_V1', bindingId: 'binding-1',
  bindingEpoch: '9', modelId: 'operator-model', maxInputItems: 16, maxOutboundRequestAttempts: 1,
  precallFenceVersion: 1 })
const runtime = Object.freeze({ configReady: true, credentialReady: true, httpPollEnabled: true,
  adapterKind: 'CONTROLLED_IMAGE_HTTP_V1', nativeBountyV1Ready: false, controlledConfig: config,
  executor: () => {}, pollProtocol: { poll() {} } })

const enabled = {
  schemaVersion: 1,
  enabled: true,
  providerLane: 'CONTROLLED_IMAGE_HTTP_V1',
  bindingId: 'binding-1',
  bindingEpoch: '9',
  modelId: 'operator-model',
  maxInputItems: 16,
  maxOutboundRequestAttempts: 1,
  precallFenceVersion: 1
}

test('registration sibling is exact nine-field enabled shape only for live controlled runtime', () => {
  const declaration = buildNativeProviderCredentialBinding({ profile, runtime, online: true })
  assert.deepEqual(declaration, enabled)
  assert.equal(Object.keys(declaration).length, 9)
  assert.equal(Object.isFrozen(declaration), true)
  const payload = buildAgentRegistrationPayload(profile, runtime, true)
  assert.deepEqual(payload.nativeProviderCredentialBinding, enabled)
  assert.equal(payload.nativeBountyExecution.enabled, false)
  assert.equal(payload.nativeBountyExecution.operations.length, 0)
})

test('disabled declaration is exactly two fields for offline, missing credential, poll, config, or controlled adapter', () => {
  for (const readiness of [
    { profile, runtime, online: false },
    { profile: { ...profile, enabled: true, status: 'offline' }, runtime, online: true },
    { profile, runtime: { ...runtime, credentialReady: false }, online: true },
    { profile, runtime: { ...runtime, pollProtocol: null }, online: true },
    { profile, runtime: { ...runtime, configReady: false }, online: true },
    { profile, runtime: { ...runtime, adapterKind: 'CODEX_IMAGEGEN_NATIVE_V1' }, online: true },
    { profile: { ...profile, controlledImageHttpEnabled: false }, runtime, online: true }
  ]) assert.deepEqual(buildNativeProviderCredentialBinding(readiness), { schemaVersion: 1, enabled: false })
})

test('generic Codex executor can advertise native-v1 but never controlled credential binding', () => {
  const generic = { configReady: true, credentialReady: false, httpPollEnabled: true,
    adapterKind: 'CODEX_IMAGEGEN_NATIVE_V1', nativeBountyV1Ready: true,
    executor: () => {}, pollProtocol: { poll() {} }, controlledConfig: null }
  const genericProfile = { ...profile, controlledImageHttpEnabled: false,
    nativeConversationImageGenerationEnabled: true }
  const payload = buildAgentRegistrationPayload(genericProfile, generic, true)
  assert.equal(payload.nativeBountyExecution.enabled, true)
  assert.deepEqual(payload.nativeProviderCredentialBinding, { schemaVersion: 1, enabled: false })
})


test('exact CLI adapter maps to the existing server controlled provider lane without changing the nine-field wire', () => {
  const cliRuntime = { ...runtime, adapterKind: 'GPT_IMAGE_CLI_V1', controlledImageV3Ready: true }
  assert.deepEqual(buildNativeProviderCredentialBinding({ profile, runtime: cliRuntime, online: true }), enabled)
  assert.equal(buildAgentRegistrationPayload(profile, null, true, null, null, cliRuntime)
    .nativeProviderCredentialBinding.providerLane, 'CONTROLLED_IMAGE_HTTP_V1')
})
