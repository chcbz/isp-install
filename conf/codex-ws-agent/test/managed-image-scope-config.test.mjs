import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildAgentRegistrationPayload,
  createControlledImageV3SourceRuntime,
  inheritManagedRuntimeCapabilities,
  resolveManagedRuntimeProfile
} from '../agent-client.mjs'
import {
  emptyManagedImageScopeAuthorizations,
  loadManagedImageScopeAuthorizations,
  parseManagedImageScopeAuthorizations
} from '../managed-image-scope-config.mjs'

const AGENT = 'agt_0123456789abcdef0123456789abcdef'
const GENERATION = 'hri_00000000-0000-0000-0000-000000000001'
const PROFILE = `managed:${AGENT}:${GENERATION}`
const scope = overrides => ({
  tenantId: 'tenant-a',
  clientId: 'client-a',
  ownerJiacn: 'owner-a',
  agentId: AGENT,
  generation: GENERATION,
  profileId: PROFILE,
  nativeConversationHttpPollEnabled: true,
  controlledImageHttpEnabled: true,
  controlledImageHttpEndpoint: 'https://images.example.test',
  controlledImageHttpApiKeyEnv: 'MANAGED_IMAGE_KEY',
  controlledImageHttpModelId: 'operator-model',
  controlledImageHttpBindingId: 'binding-15',
  controlledImageHttpBindingEpoch: '7',
  controlledImageHttpLedgerRoot: '/private/managed-image/tenant-a/owner-a/generation-1',
  ...overrides
})
const document = (...authorizations) => JSON.stringify({ schemaVersion: 1, authorizations })
const profile = overrides => ({
  profileId: PROFILE,
  agentId: AGENT,
  managedTenantId: 'tenant-a',
  managedClientId: 'client-a',
  managedOwnerJiacn: 'owner-a',
  managedGeneration: GENERATION,
  codexHome: '/private/managed-host/agent/home',
  codexWorkdir: '/private/managed-host/agent/work',
  enabled: true,
  status: '',
  agentName: 'Managed Agent',
  personaName: 'Managed Agent',
  ...overrides
})
const source = overrides => ({
  workspaceFileApiOrigin: 'http://127.0.0.1:10018',
  workspaceFileRootDir: '/private/workspace-files',
  nativeConversationHttpPollEnabled: false,
  nativeConversationImageGenerationEnabled: true,
  controlledImageHttpEnabled: true,
  controlledImageHttpEndpoint: 'https://shared-credentials.example.test',
  controlledImageHttpApiKeyEnv: 'SHARED_KEY',
  controlledImageHttpModelId: 'shared-model',
  controlledImageHttpBindingId: 'shared-binding',
  controlledImageHttpBindingEpoch: '99',
  controlledImageHttpLedgerRoot: '/private/shared-ledger',
  ...overrides
})

test('legacy managed profile stays controlled-image disabled and never inherits shared controlled credentials', () => {
  const legacy = inheritManagedRuntimeCapabilities(profile(), source())
  assert.equal(legacy.workspaceFileApiOrigin, 'http://127.0.0.1:10018')
  assert.equal(legacy.nativeConversationImageGenerationEnabled, true)
  assert.equal(legacy.controlledImageHttpEnabled, false)
  assert.deepEqual([
    legacy.controlledImageHttpEndpoint,
    legacy.controlledImageHttpApiKeyEnv,
    legacy.controlledImageHttpModelId,
    legacy.controlledImageHttpBindingId,
    legacy.controlledImageHttpBindingEpoch,
    legacy.controlledImageHttpLedgerRoot
  ], ['', '', '', '', '', ''])
  assert.equal(resolveManagedRuntimeProfile(profile(), source(), emptyManagedImageScopeAuthorizations()).controlledImageHttpEnabled, false)
})

test('exact tenant client owner agent generation and profile scope enables only its operator image tuple', () => {
  const authorizations = parseManagedImageScopeAuthorizations(document(scope()))
  const managed = resolveManagedRuntimeProfile(profile(), source(), authorizations)
  assert.equal(managed.nativeConversationHttpPollEnabled, true)
  assert.equal(managed.nativeConversationImageGenerationEnabled, false)
  assert.equal(managed.controlledImageHttpEnabled, true)
  assert.equal(managed.controlledImageHttpEndpoint, 'https://images.example.test')
  assert.equal(managed.controlledImageHttpApiKeyEnv, 'MANAGED_IMAGE_KEY')
  assert.equal(managed.controlledImageHttpModelId, 'operator-model')
  assert.equal(managed.controlledImageHttpBindingId, 'binding-15')
  assert.equal(managed.controlledImageHttpBindingEpoch, '7')
  assert.equal(managed.controlledImageHttpLedgerRoot, '/private/managed-image/tenant-a/owner-a/generation-1')
})

test('every managed authority dimension and runtime-directory overlap fail closed', () => {
  const authorizations = parseManagedImageScopeAuthorizations(document(scope()))
  for (const changed of [
    { managedTenantId: 'tenant-b' },
    { managedClientId: 'client-b' },
    { managedOwnerJiacn: 'owner-b' },
    { agentId: 'agt_11111111111111111111111111111111' },
    { managedGeneration: 'hri_00000000-0000-0000-0000-000000000002' },
    { profileId: `${PROFILE}:other` },
    { codexHome: '/private/managed-image' },
    { codexWorkdir: '/private/managed-image/tenant-a/owner-a/generation-1/scratch' }
  ]) {
    const managed = resolveManagedRuntimeProfile(profile(changed), source(), authorizations)
    assert.equal(managed.controlledImageHttpEnabled, false, JSON.stringify(changed))
    assert.equal(managed.controlledImageHttpApiKeyEnv, '', JSON.stringify(changed))
  }
})

test('duplicate scopes and equal nested or local ledger roots are rejected', () => {
  assert.throws(() => parseManagedImageScopeAuthorizations(document(scope(), scope())), /Duplicate/)
  const second = scope({ agentId: 'agt_11111111111111111111111111111111',
    generation: 'hri_00000000-0000-0000-0000-000000000002',
    profileId: 'managed:other', controlledImageHttpLedgerRoot: `${scope().controlledImageHttpLedgerRoot}/nested` })
  assert.throws(() => parseManagedImageScopeAuthorizations(document(scope(), second)), /must not be equal or overlap/)
  assert.throws(() => parseManagedImageScopeAuthorizations(document(scope()), { reservedProfiles: [{
    profileId: 'local', controlledImageHttpEnabled: true,
    controlledImageHttpLedgerRoot: '/private/managed-image'
  }] }), /must not be equal or overlap/)
})

test('operator file must be canonical private owned data and malformed config disables loading', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'managed-image-scopes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = resolve(root, 'scopes.json')
  writeFileSync(path, document(scope()), { mode: 0o600 })
  assert.equal(loadManagedImageScopeAuthorizations(path).count, 1)
  chmodSync(path, 0o640)
  assert.throws(() => loadManagedImageScopeAuthorizations(path), /private operator-owned/)
  chmodSync(path, 0o600)
  const link = resolve(root, 'scopes-link.json')
  symlinkSync(path, link)
  assert.throws(() => loadManagedImageScopeAuthorizations(link), /canonical absolute path/)
  assert.throws(() => parseManagedImageScopeAuthorizations('{'), /valid JSON/)
  assert.throws(() => parseManagedImageScopeAuthorizations(JSON.stringify({ schemaVersion: 1, authorizations: [], extra: true })), /schema/)
  assert.throws(() => parseManagedImageScopeAuthorizations(document(scope({ controlledImageHttpBindingEpoch: 7 }))), /binding epoch/)
})

test('exact managed authorization reaches real registration and poll runtime composition without Provider access', async () => {
  const ledgerOptions = []
  const executorOptions = []
  const pollOptions = []
  let polls = 0
  const managed = resolveManagedRuntimeProfile(profile(), source(), parseManagedImageScopeAuthorizations(document(scope())))
  const runtime = createControlledImageV3SourceRuntime({
    profile: managed,
    getAuth: () => `AgentRuntime ${'a'.repeat(32)}`,
    controlledEnv: { MANAGED_IMAGE_KEY: 'fixture-secret' },
    providerFetchFn: async () => assert.fail('Provider fetch must not run during registration or idle poll wiring'),
    nativeFetchFn: async () => assert.fail('native fetch is owned by the fake poll protocol in this fixture'),
    createLedger: options => { ledgerOptions.push(options); return { fixture: true } },
    createExecutor: options => { executorOptions.push(options); return { execute: async () => assert.fail('executor must stay idle') } },
    createPollProtocol: options => { pollOptions.push(options); return { poll: async () => { polls++; return { processed: 0 } } } },
    runtimeInstanceId: 'managed-runtime-fixture'
  })
  assert.equal(runtime.controlledImageV3Ready, true)
  const registration = buildAgentRegistrationPayload(managed, null, true, null, null, runtime)
  assert.equal(registration.controlledImageBountyExecutionV3.enabled, true)
  assert.deepEqual(registration.controlledImageBountyExecutionV3.operations.map(item => item.operation), ['GENERATE_IMAGE', 'EDIT_IMAGE'])
  assert.deepEqual(registration.nativeProviderCredentialBinding, {
    schemaVersion: 1,
    enabled: true,
    providerLane: 'CONTROLLED_IMAGE_HTTP_V1',
    bindingId: 'binding-15',
    bindingEpoch: '7',
    modelId: 'operator-model',
    maxInputItems: 16,
    maxOutboundRequestAttempts: 1,
    precallFenceVersion: 1
  })
  assert.deepEqual(ledgerOptions, [{ rootDir: '/private/managed-image/tenant-a/owner-a/generation-1',
    profileId: PROFILE, agentId: AGENT }])
  assert.equal(executorOptions[0].credential, 'fixture-secret')
  assert.equal(pollOptions[0].agentId, AGENT)
  assert.equal(await runtime.pollProtocol.poll().then(result => result.processed), 0)
  assert.equal(polls, 1)
})
