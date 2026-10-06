import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManagedChatScopes, loadManagedChatScopes } from '../managed-chat-scope-config.mjs'
import { resolveManagedRuntimeProfile, prepareChatWorkdir } from '../agent-client.mjs'
import { buildTypedDeliberationDeclaration } from '../juyiting-typed-outcome.mjs'
const authorization = { tenantId: '0', clientId: 'fixture-client', ownerJiacn: 'fixture-owner',
  agentId: 'agt_00000000000000000000000000000001', generation: 'hri_00000000-0000-0000-0000-000000000001', profileId: 'managed:fixture:agent:generation' }
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
