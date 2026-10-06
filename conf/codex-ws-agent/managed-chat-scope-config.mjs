import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolveCodexAppServerSchemaContract } from './app-server-adapter.mjs'

const fields = ['tenantId', 'clientId', 'ownerJiacn', 'agentId', 'generation', 'profileId']
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value)
const scope = profile => ({ tenantId: profile.managedTenantId, clientId: profile.managedClientId,
  ownerJiacn: profile.managedOwnerJiacn, agentId: profile.agentId,
  generation: profile.managedGeneration, profileId: profile.profileId })
const key = value => fields.map(field => value[field]).join('\0')
export const emptyManagedChatScopes = () => Object.freeze({ count: 0, resolve: () => null })
export const parseManagedChatScopes = raw => {
  const doc = JSON.parse(raw)
  if (!exactKeys(doc, ['schemaVersion', 'authorizations']) || doc.schemaVersion !== 1 || !Array.isArray(doc.authorizations))
    throw new Error('Invalid managed CHAT scope document')
  const byScope = new Map()
  for (const entry of doc.authorizations) {
    if (!exactKeys(entry, [...fields, 'appServerSchemaContractId']) || !fields.every(field => text(entry[field])) ||
        !/^agt_[0-9a-f]{32}$/.test(entry.agentId) || !/^hri_[0-9a-f-]{36}$/.test(entry.generation))
      throw new Error('Invalid managed CHAT authorization')
    resolveCodexAppServerSchemaContract({ appServerSchemaContractId: entry.appServerSchemaContractId })
    if (!text(entry.appServerSchemaContractId)) throw new Error('Exact CHAT schema contract required')
    if (byScope.has(key(entry))) throw new Error('Duplicate managed CHAT authorization')
    byScope.set(key(entry), Object.freeze({ ...entry }))
  }
  return Object.freeze({ count: byScope.size, resolve(profile) {
    const selected = scope(profile)
    return fields.every(field => text(selected[field])) ? byScope.get(key(selected)) || null : null
  } })
}
export const loadManagedChatScopes = path => {
  if (!text(path) || !isAbsolute(path) || realpathSync(path) !== path) throw new Error('CHAT scope path must be canonical')
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077))
    throw new Error('CHAT scope file must be private and operator-owned')
  return parseManagedChatScopes(readFileSync(path, 'utf8'))
}

// Scope is the authorization boundary. No operator-template cwd is inherited: createProfileState
// allocates a private CHAT directory from the full managed profile identity.
export const applyManagedChatScope = (profile, source, scopes = emptyManagedChatScopes()) => {
  const authorized = scopes.resolve(profile)
  if (!authorized) return profile
  return { ...profile,
    fastChatEnabled: profile.fastChatEnabled ?? true,
    appServerEnabled: profile.appServerEnabled ?? true,
    typedDeliberationEnabled: profile.typedDeliberationEnabled ?? true,
    trueDeltaEnabled: profile.trueDeltaEnabled ?? source.trueDeltaEnabled ?? false,
    chatEngine: profile.chatEngine ?? 'app-server',
    chatSandbox: profile.chatSandbox ?? 'read-only',
    chatToolPolicy: profile.chatToolPolicy ?? 'read-only-constrained',
    appServerSchemaContractId: authorized.appServerSchemaContractId,
    chatModel: profile.chatModel ?? source.chatModel ?? '',
    chatReasoningEffort: profile.chatReasoningEffort ?? source.chatReasoningEffort ?? ''
  }
}
