import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
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
const inspectionFields = ['apiOrigin', 'inputRoot', 'stateRoot', 'profileId', 'providerId', 'providerBaseUrl',
  'providerWireApi', 'model', 'networkConnectTimeoutMs', 'carrierEvidencePath', 'carrierEvidenceDigest', 'supportedInputs']
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const canonicalPath = value => text(value) && isAbsolute(value) && resolve(value) === value
const overlaps = (left, right) => left === right || left.startsWith(right + sep) || right.startsWith(left + sep)
const trustedUrl = (value, originOnly = false) => {
  try { const url = new URL(value); return text(value) && url.protocol === 'https:' && !url.username && !url.password &&
    !url.search && !url.hash && (!originOnly || url.origin === value) } catch { return false }
}
const parseInspection = value => {
  if (!exactKeys(value, inspectionFields) || !trustedUrl(value.apiOrigin, true) || !trustedUrl(value.providerBaseUrl) ||
    !['responses', 'chat'].includes(value.providerWireApi) || !['inputRoot', 'stateRoot', 'carrierEvidencePath'].every(key => canonicalPath(value[key])) ||
    overlaps(value.inputRoot, value.stateRoot) || !['profileId', 'providerId', 'model'].every(key => text(value[key])) ||
    !Number.isSafeInteger(value.networkConnectTimeoutMs) || value.networkConnectTimeoutMs <= 0 ||
    !digest(value.carrierEvidenceDigest) || !Array.isArray(value.supportedInputs) || !value.supportedInputs.length) {
    throw new Error('Invalid scoped INSPECT authorization')
  }
  const seen = new Set()
  const supportedInputs = value.supportedInputs.map(item => {
    const key = [item?.mediaKind, item?.mimeType, item?.carrier].join('\0')
    if (!exactKeys(item, ['mediaKind', 'mimeType', 'carrier', 'carrierContractDigest']) || !digest(item.carrierContractDigest) ||
      !['image\0image/png\0LOCAL_IMAGE', 'audio\0audio/wav\0LOCAL_AUDIO', 'text\0text/plain\0DIRECT_TEXT'].includes(key) || seen.has(key)) {
      throw new Error('Invalid scoped INSPECT supported input')
    }
    seen.add(key); return Object.freeze({ ...item })
  })
  return Object.freeze({ ...value, supportedInputs: Object.freeze(supportedInputs) })
}
export const parseManagedChatScopes = raw => {
  const doc = JSON.parse(raw)
  if (!exactKeys(doc, ['schemaVersion', 'authorizations']) || doc.schemaVersion !== 1 || !Array.isArray(doc.authorizations))
    throw new Error('Invalid managed CHAT scope document')
  const byScope = new Map()
  for (const entry of doc.authorizations) {
    if (!exactKeys(entry, [...fields, 'appServerSchemaContractId', ...(Object.hasOwn(entry || {}, 'inspection') ? ['inspection'] : [])]) || !fields.every(field => text(entry[field])) ||
        !/^agt_[0-9a-f]{32}$/.test(entry.agentId) || !/^hri_[0-9a-f-]{36}$/.test(entry.generation))
      throw new Error('Invalid managed CHAT authorization')
    resolveCodexAppServerSchemaContract({ appServerSchemaContractId: entry.appServerSchemaContractId })
    if (!text(entry.appServerSchemaContractId)) throw new Error('Exact CHAT schema contract required')
    if (byScope.has(key(entry))) throw new Error('Duplicate managed CHAT authorization')
    const inspection = Object.hasOwn(entry, 'inspection') ? parseInspection(entry.inspection) : null
    byScope.set(key(entry), Object.freeze({ ...entry, ...(inspection ? { inspection } : {}) }))
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
  const inspection = authorized.inspection
  const model = profile.chatModel || source.chatModel || source.codexModel || ''
  if (inspection && model && model !== inspection.model) throw new Error('Scoped INSPECT model differs from existing managed model')
  const inspectionControls = inspection ? {
    typedInspectionEnabled: profile.typedInspectionEnabled ?? true,
    typedInspectionApiOrigin: inspection.apiOrigin, typedInspectionRootDir: inspection.inputRoot, typedInspectionStateRoot: inspection.stateRoot,
    typedInspectionProfileId: inspection.profileId, typedInspectionProviderId: inspection.providerId,
    typedInspectionProviderBaseUrl: inspection.providerBaseUrl, typedInspectionProviderWireApi: inspection.providerWireApi,
    typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionNetworkConnectTimeoutMs: inspection.networkConnectTimeoutMs,
    typedInspectionCarrierEvidencePath: inspection.carrierEvidencePath, typedInspectionCarrierEvidenceDigest: inspection.carrierEvidenceDigest,
    typedInspectionSupportedInputs: inspection.supportedInputs
  } : {}
  return { ...profile, ...inspectionControls,
    fastChatEnabled: profile.fastChatEnabled ?? true,
    appServerEnabled: profile.appServerEnabled ?? true,
    typedDeliberationEnabled: profile.typedDeliberationEnabled ?? true,
    trueDeltaEnabled: profile.trueDeltaEnabled ?? source.trueDeltaEnabled ?? false,
    chatEngine: profile.chatEngine ?? 'app-server',
    chatSandbox: profile.chatSandbox ?? 'read-only',
    chatToolPolicy: profile.chatToolPolicy ?? 'read-only-constrained',
    appServerSchemaContractId: authorized.appServerSchemaContractId,
    chatModel: inspection ? inspection.model : profile.chatModel ?? source.chatModel ?? '',
    chatReasoningEffort: profile.chatReasoningEffort ?? source.chatReasoningEffort ?? ''
  }
}
