import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import {
  assertDistinctControlledImageLedgerRoots,
  controlledImageHttpConfigurationErrors,
  normalizeControlledImageHttpProfile,
  resolveControlledImageHttpConfig
} from '../controlled-image-http-config.mjs'
import { normalizeProfile } from '../agent-client.mjs'

const configured = overrides => ({
  profileId: 'controlled-profile',
  agentId: 'controlled-agent',
  controlledImageHttpEnabled: true,
  controlledImageHttpEndpoint: 'https://api.example.test',
  controlledImageHttpApiKeyEnv: 'CONTROLLED_IMAGE_KEY',
  controlledImageHttpModelId: 'operator-image-model',
  controlledImageHttpBindingId: 'binding-1',
  controlledImageHttpBindingEpoch: '7',
  controlledImageHttpLedgerRoot: '/private/controlled-ledger',
  nativeConversationHttpPollEnabled: true,
  nativeConversationImageGenerationEnabled: false,
  ...overrides
})

const env = { CONTROLLED_IMAGE_KEY: 'secret-only-in-process-memory' }

test('controlled image profile is default-off with no account, model, endpoint, or ledger fallback', () => {
  const normalized = normalizeControlledImageHttpProfile({})
  assert.deepEqual(normalized, {
    controlledImageHttpEnabled: false,
    controlledImageHttpEndpoint: '',
    controlledImageHttpApiKeyEnv: '',
    controlledImageHttpModelId: '',
    controlledImageHttpBindingId: '',
    controlledImageHttpBindingEpoch: '',
    controlledImageHttpLedgerRoot: ''
  })
  assert.deepEqual(resolveControlledImageHttpConfig({}, { env: {} }), { enabled: false })
})

test('profile parsing keeps only explicit controlled settings and never infers Codex credentials', () => {
  const profile = normalizeProfile({
    ...configured(),
    codexHome: '/private/codex-home',
    apiKey: 'websocket-key',
    controlledImageHttpEnabled: 'true'
  })
  assert.equal(profile.controlledImageHttpEnabled, true)
  assert.equal(profile.controlledImageHttpApiKeyEnv, 'CONTROLLED_IMAGE_KEY')
  assert.equal(profile.controlledImageHttpModelId, 'operator-image-model')
  assert.equal(profile.codexHome, '/private/codex-home')
  assert.equal(resolveControlledImageHttpConfig(profile, { env }).credentialPresent, true)
  assert.match(controlledImageHttpConfigurationErrors(profile, { env: {} })[0], /credential environment variable/)
  assert.equal(resolveControlledImageHttpConfig(profile, {
    env: { CONTROLLED_IMAGE_KEY: 'x'.repeat(5000) }
  }).credentialPresent, true)
  for (const invalid of ['', '   ', 'secret\rline', 'secret\nline', 'secret\0line']) {
    assert.throws(() => resolveControlledImageHttpConfig(profile, { env: { CONTROLLED_IMAGE_KEY: invalid } }))
  }
})

test('enabled config requires explicit HTTPS origin, key env, model, binding, long epoch, and absolute ledger root', () => {
  for (const candidate of [
    configured({ controlledImageHttpEndpoint: 'http://api.example.test' }),
    configured({ controlledImageHttpEndpoint: 'https://user@api.example.test' }),
    configured({ controlledImageHttpEndpoint: ' https://api.example.test' }),
    configured({ controlledImageHttpApiKeyEnv: 'bad-key' }),
    configured({ controlledImageHttpModelId: '' }),
    configured({ controlledImageHttpModelId: `m${'x'.repeat(100)}` }),
    configured({ controlledImageHttpBindingId: '' }),
    configured({ controlledImageHttpBindingId: `b${'x'.repeat(100)}` }),
    configured({ controlledImageHttpBindingEpoch: '0' }),
    configured({ controlledImageHttpBindingEpoch: '01' }),
    configured({ controlledImageHttpBindingEpoch: '9223372036854775808' }),
    configured({ controlledImageHttpLedgerRoot: 'relative/ledger' }),
    configured({ controlledImageHttpLedgerRoot: '/private/controlled-ledger ' })
  ]) assert.throws(() => resolveControlledImageHttpConfig(candidate, { env }))

  assert.doesNotThrow(() => resolveControlledImageHttpConfig(configured({
    controlledImageHttpModelId: `m${'x'.repeat(99)}`,
    controlledImageHttpBindingId: `b${'x'.repeat(99)}`
  }), { env }))

  const actual = resolveControlledImageHttpConfig(configured(), { env })
  assert.deepEqual(actual, {
    enabled: true,
    providerLane: 'CONTROLLED_IMAGE_HTTP_V1',
    endpoint: 'https://api.example.test',
    apiKeyEnv: 'CONTROLLED_IMAGE_KEY',
    modelId: 'operator-image-model',
    bindingId: 'binding-1',
    bindingEpoch: '7',
    ledgerRoot: resolve('/private/controlled-ledger'),
    maxInputItems: 16,
    maxOutboundRequestAttempts: 1,
    precallFenceVersion: 1,
    credentialPresent: true
  })
})

test('controlled executor cannot silently coexist with generic Codex imagegen or missing native poll', () => {
  assert.ok(controlledImageHttpConfigurationErrors(configured({ nativeConversationHttpPollEnabled: false }), { env })
    .some(value => value.includes('nativeConversationHttpPollEnabled')))
  assert.ok(controlledImageHttpConfigurationErrors(configured({ nativeConversationImageGenerationEnabled: true }), { env })
    .some(value => value.includes('cannot be combined')))
})

test('profile ledger roots may not be equal, nested, or shared across profiles', () => {
  const first = configured({ profileId: 'first', controlledImageHttpLedgerRoot: '/private/controlled/a' })
  for (const root of ['/private/controlled/a', '/private/controlled/a/nested', '/private/controlled']) {
    assert.throws(() => assertDistinctControlledImageLedgerRoots([
      first,
      configured({ profileId: 'second', agentId: 'second-agent', controlledImageHttpLedgerRoot: root })
    ]), /must not be equal or overlap/)
  }
  assert.doesNotThrow(() => assertDistinctControlledImageLedgerRoots([
    first,
    configured({ profileId: 'second', agentId: 'second-agent', controlledImageHttpLedgerRoot: '/private/controlled/b' })
  ]))
})
