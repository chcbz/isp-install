import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManagedChatScopes, loadManagedChatScopes } from '../managed-chat-scope-config.mjs'
import { normalizeProfile, resolveManagedRuntimeProfile, prepareChatWorkdir, publishMeasuredRuntimeCapabilities, observeTypedRuntimeAuthentication } from '../agent-client.mjs'
import { buildTypedDeliberationDeclaration } from '../juyiting-typed-outcome.mjs'
const authorization = { tenantId: '0', clientId: 'fixture-client', ownerJiacn: 'fixture-owner',
  agentId: 'agt_00000000000000000000000000000001', generation: 'hri_00000000-0000-0000-0000-000000000001', profileId: 'managed:fixture:agent:generation', appServerSchemaContractId: 'codex-cli-0.160.0' }
const profile = { profileId: authorization.profileId, agentId: authorization.agentId,
  managedTenantId: authorization.tenantId, managedClientId: authorization.clientId,
  managedOwnerJiacn: authorization.ownerJiacn, managedGeneration: authorization.generation }
const doc = entries => JSON.stringify({ schemaVersion: 1, authorizations: entries })
const scopes = parseManagedChatScopes(doc([authorization]))
test('exact scoped composition enables native typed CHAT, not a fabricated READY', () => {
  const enabled = resolveManagedRuntimeProfile(profile, { chatWorkdir: '/forbidden/template' }, undefined, scopes)
  assert.equal(enabled.fastChatEnabled, true); assert.equal(enabled.appServerEnabled, true)
  assert.equal(enabled.typedDeliberationEnabled, true); assert.equal(enabled.chatEngine, 'app-server')
  assert.equal(enabled.chatSandbox, 'read-only'); assert.equal(enabled.chatToolPolicy, 'read-only-constrained')
  assert.equal(enabled.chatWorkdir, undefined)
  assert.equal(enabled.appServerSchemaContractId, 'codex-cli-0.160.0')
  assert.equal(buildTypedDeliberationDeclaration(enabled, null).state, 'UNAVAILABLE')
})
test('every identity dimension is exact; global defaults cannot enable unrelated managed CHAT', () => {
  const keys = ['managedTenantId', 'managedClientId', 'managedOwnerJiacn', 'agentId', 'managedGeneration', 'profileId']
  for (const field of keys) {
    const changed = { ...profile, [field]: profile[field] + '-other' }
    const result = resolveManagedRuntimeProfile(changed, { fastChatEnabled: true, typedDeliberationEnabled: true }, undefined, scopes)
    assert.equal(result.typedDeliberationEnabled, undefined)
  }
  assert.equal(resolveManagedRuntimeProfile(profile, { typedDeliberationEnabled: true }).typedDeliberationEnabled, undefined)
})
test('explicit disabled profile stays disabled', () => {
  const result = resolveManagedRuntimeProfile({ ...profile, fastChatEnabled: false, typedDeliberationEnabled: false }, {}, undefined, scopes)
  assert.equal(result.fastChatEnabled, false); assert.equal(buildTypedDeliberationDeclaration(result, null), null)
})
test('reject duplicate, extra fields and wildcard authorizations', () => {
  assert.throws(() => parseManagedChatScopes(doc([authorization, authorization])))
  assert.throws(() => parseManagedChatScopes(doc([{ ...authorization, chatWorkdir: '/tmp/shared' }])))
  assert.throws(() => parseManagedChatScopes(doc([{ ...authorization, agentId: '*' }])))
})
test('operator file permissions and symlink enforced', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-chat-scope-test-'))
  try {
    const file = join(root, 'scope.json'); writeFileSync(file, doc([authorization]), { mode: 0o600 })
    assert.equal(loadManagedChatScopes(file).count, 1)
    chmodSync(file, 0o644); assert.throws(() => loadManagedChatScopes(file)); chmodSync(file, 0o600)
    symlinkSync(file, join(root, 'link')); assert.throws(() => loadManagedChatScopes(join(root, 'link')))
  } finally { rmSync(root, { recursive: true }) }
})

test('managed CHAT workdirs are private and identity-isolated', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-chat-cwd-test-'))
  try {
    const first = prepareChatWorkdir({ rootDir: root, profile, forbidden: [] })
    const other = prepareChatWorkdir({ rootDir: root, profile: { ...profile, profileId: profile.profileId + ':other', managedGeneration: 'hri_00000000-0000-0000-0000-000000000002' }, forbidden: [] })
    assert.notEqual(first, other)
    assert.equal(prepareChatWorkdir({ rootDir: root, profile, forbidden: [] }), first)
  } finally { rmSync(root, { recursive: true }) }
})

test('unknown or missing exact native schema remains rejected', () => {
  assert.throws(() => parseManagedChatScopes(doc([{ ...authorization, appServerSchemaContractId: 'codex-cli-unknown' }])))
  const { appServerSchemaContractId, ...missing } = authorization
  assert.throws(() => parseManagedChatScopes(doc([missing])))
})

test('readiness updates acknowledged registration, not a presence-only declaration', () => {
  let registrations = 0
  const state = { disposed: false, ws: { readyState: 1 }, registration: { snapshot: () => ({ stage: 'registered' }) } }
  const registerFn = selected => { assert.equal(selected, profile); registrations++; return true }
  assert.equal(publishMeasuredRuntimeCapabilities(profile, state, { registerFn }), true)
  assert.equal(registrations, 1)
  for (const altered of [{ ...state, disposed: true }, { ...state, ws: { readyState: 3 } },
      { ...state, registration: { snapshot: () => ({ stage: 'idle' }) } }])
    assert.equal(publishMeasuredRuntimeCapabilities(profile, altered, { registerFn }), false)
  assert.equal(registrations, 1)
})

const nativeReceipt = { typedDeliberation: { state: 'READY' }, runtimeAuth: {
  scheme: 'native-runtime-v1', tenantId: profile.managedTenantId, clientId: profile.managedClientId,
  ownerJiacn: profile.managedOwnerJiacn, agentId: profile.agentId, runtimeInstanceId: 'fixture-runtime'
} }
test('typed native diagnostics reads once without claiming, exposing tokens, or reading work bodies', async () => {
  let calls = 0, cancelled = false
  const result = await observeTypedRuntimeAuthentication({ profile: { ...profile, typedDeliberationEnabled: true },
    receipt: nativeReceipt, authHeader: 'AgentRuntime rts1_' + '1'.repeat(64), apiOrigin: 'http://localhost:10018',
    runtimeInstanceId: 'fixture-runtime', fetchFn: async (url, options) => {
      calls++; assert.equal(url.pathname, '/internal/agent/tasks/workspace-executions/commands')
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error')
      return { status: 401, body: { cancel: async () => { cancelled = true } },
        json: () => assert.fail('Must not read returned work/secret data') }
    } })
  assert.equal(calls, 1); assert.equal(cancelled, true)
  assert.deepEqual(result, { state: 'CURRENT_BINDING_DENIED', httpStatus: 401 })
})
test('typed native diagnostics never queries another scope, disabled profile, or unavailable receipt', async () => {
  for (const args of [ { profile }, { receipt: { ...nativeReceipt, typedDeliberation: { state: 'UNAVAILABLE' } } },
      { receipt: { ...nativeReceipt, runtimeAuth: { ...nativeReceipt.runtimeAuth, ownerJiacn: 'other-owner' } } },
      { authHeader: '' }, { runtimeInstanceId: 'other-runtime' }, { apiOrigin: 'http://user:password@localhost' } ]) {
    const result = await observeTypedRuntimeAuthentication({ profile: { ...profile, typedDeliberationEnabled: true },
      receipt: nativeReceipt, authHeader: 'AgentRuntime rts1_' + '1'.repeat(64), apiOrigin: 'http://localhost:10018',
      runtimeInstanceId: 'fixture-runtime', ...args, fetchFn: () => assert.fail('Unexpected diagnostic read') })
    assert.notEqual(result.state, 'HTTP_OBSERVED')
  }
})


const inspection = { inputRoot:'/private/inspect-inputs', stateRoot:'/private/inspect-state',
  profileId:'measured-inspection', providerId:'configured-provider', providerBaseUrl:'https://provider.example.test/v1',
  providerWireApi:'responses', model:'existing-model', networkConnectTimeoutMs:15000, carrierEvidencePath:'/private/carrier.json',
  carrierEvidenceDigest:`sha256:${'1'.repeat(64)}`, supportedInputs:[{mediaKind:'image',mimeType:'image/png',carrier:'LOCAL_IMAGE',carrierContractDigest:`sha256:${'2'.repeat(64)}`}] }
test('scoped INSPECT controls apply only to the exact authorized managed identity and preserve measurement gate', () => {
  const grants = parseManagedChatScopes(doc([{ ...authorization, inspection }]))
  const result = resolveManagedRuntimeProfile(profile, {codexModel:'existing-model', workspaceFileApiOrigin:'http://127.0.0.1:19001'}, undefined, grants)
  assert.equal(result.typedInspectionEnabled,true)
  assert.equal(result.typedInspectionProfileId,inspection.profileId)
  assert.equal(result.typedInspectionProviderNetwork,'restricted-proxy')
  assert.equal(result.typedInspectionCarrierEvidenceDigest,inspection.carrierEvidenceDigest)
  assert.equal(result.chatModel,'existing-model')
  assert.equal(Object.isFrozen(result.typedInspectionSupportedInputs),true)
  for(const field of ['managedTenantId','managedClientId','managedOwnerJiacn','agentId','managedGeneration','profileId']) {
    const denied=resolveManagedRuntimeProfile({...profile,[field]:profile[field]+'other'}, {typedInspectionEnabled:true}, undefined, grants)
    assert.equal(denied.typedInspectionEnabled,undefined)
    assert.equal(denied.typedInspectionCarrierEvidencePath,undefined)
  }
  assert.equal(resolveManagedRuntimeProfile(profile,{typedInspectionEnabled:true},undefined,scopes).typedInspectionEnabled,undefined)
})
test('scoped INSPECT does not override an explicit disabled profile or switch the existing model', () => {
  const grants=parseManagedChatScopes(doc([{...authorization,inspection}]))
  assert.equal(resolveManagedRuntimeProfile({...profile,typedInspectionEnabled:false},{codexModel:'existing-model', workspaceFileApiOrigin:'http://127.0.0.1:19001'},undefined,grants).typedInspectionEnabled,false)
  assert.throws(()=>resolveManagedRuntimeProfile(profile,{codexModel:'other-model'},undefined,grants),/differs from existing/)
})
test('scoped INSPECT fails closed on malformed controls, overlapping roots, unmeasured carrier or unsupported format', () => {
  for(const patch of [{apiOrigin:'https://user:secret@api.example.test'}, {providerBaseUrl:'http://provider.example.test'},
    {inputRoot:'../inputs'}, {stateRoot:inspection.inputRoot+'/child'}, {carrierEvidenceDigest:''},
    {networkConnectTimeoutMs:0}, {carrierEvidencePath:'/private/../carrier.json'}, {supportedInputs:[]},
    {supportedInputs:[{...inspection.supportedInputs[0],mimeType:'application/pdf'}]},
    {supportedInputs:[inspection.supportedInputs[0],inspection.supportedInputs[0]]}, {unsafe:true}])
    assert.throws(()=>parseManagedChatScopes(doc([{...authorization,inspection:{...inspection,...patch}}])))
})


test('INSPECT uses the same operator native API origin as all other lanes, independent of API port/deployment', () => {
  const grants = parseManagedChatScopes(doc([{ ...authorization, inspection }]))
  for (const workspaceFileApiOrigin of ['http://127.0.0.1:19001', 'http://[::1]:28082', 'https://native.example.test:9443']) {
    const enabled = resolveManagedRuntimeProfile({ ...profile, workspaceFileApiOrigin: 'https://untrusted-profile.example.test' },
      { codexModel: 'existing-model', workspaceFileApiOrigin }, undefined, grants)
    assert.equal(enabled.workspaceFileApiOrigin, workspaceFileApiOrigin)
    assert.equal(Object.hasOwn(enabled, 'typedInspectionApiOrigin'), false)
    assert.equal(enabled.typedInspectionProviderBaseUrl, inspection.providerBaseUrl)
    assert.equal(enabled.typedInspectionCarrierEvidenceDigest, inspection.carrierEvidenceDigest)
    for (const field of ['managedTenantId', 'managedClientId', 'managedOwnerJiacn', 'agentId', 'managedGeneration', 'profileId']) {
      assert.equal(resolveManagedRuntimeProfile({ ...profile, [field]: profile[field] + '-other' },
        { workspaceFileApiOrigin }, undefined, grants).typedInspectionEnabled, undefined)
    }
  }
})

test('scope cannot override the native API destination; missing/unsafe shared origin stays closed', () => {
  for (const apiOrigin of ['https://api.example.test', 'http://127.0.0.1:10018'])
    assert.throws(() => parseManagedChatScopes(doc([{ ...authorization, inspection: { ...inspection, apiOrigin } }])))
  const grants = parseManagedChatScopes(doc([{ ...authorization, inspection }]))
  for (const workspaceFileApiOrigin of ['', undefined, 'http://remote.example.test:19001',
    'https://user:secret@native.example.test', 'https://native.example.test/internal',
    'https://native.example.test?x=1', 'https://native.example.test#x', 'file:///tmp/api']) {
    assert.throws(() => resolveManagedRuntimeProfile(profile, { workspaceFileApiOrigin }, undefined, grants))
  }
  assert.throws(() => parseManagedChatScopes(doc([{ ...authorization, inspection: { ...inspection,
    providerBaseUrl: 'http://127.0.0.1:19001' } }])))
})

test('independent INSPECT API profile setting is rejected, not silently retained as a compatibility path', () => {
  assert.throws(() => normalizeProfile({ typedInspectionApiOrigin: 'https://other.example.test' }), /Separate typedInspectionApiOrigin/)
  assert.throws(() => normalizeProfile({}, { typedInspectionApiOrigin: 'http://127.0.0.1:19001' }), /Separate typedInspectionApiOrigin/)
})

// Current unified transport never restores the retired native credential format.
test('typed native diagnostics rejects retired32hex and redacted credentials before fetch', async () => {
  for (const authHeader of ['AgentRuntime ' + '1'.repeat(32), 'AgentRuntime REDACTED_SESSION_TOKEN', 'Bearer legacy-key']) {
    const result = await observeTypedRuntimeAuthentication({ profile: { ...profile, typedDeliberationEnabled: true },
      receipt: nativeReceipt, authHeader, apiOrigin: 'http://localhost:10018', runtimeInstanceId: 'fixture-runtime',
      fetchFn: () => assert.fail('retired authorization cannot enter HTTP execution') })
    assert.equal(result.state, 'RECEIPT_BINDING_MISMATCH')
  }
})
