import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
  assertDistinctControlledImageLedgerRoots,
  resolveControlledImageHttpConfig
} from './controlled-image-http-config.mjs'

const TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'authorizations'])
const AUTHORIZATION_KEYS = Object.freeze([
  'tenantId',
  'clientId',
  'ownerJiacn',
  'agentId',
  'generation',
  'profileId',
  'nativeConversationHttpPollEnabled',
  'controlledImageHttpEnabled',
  'controlledImageHttpEndpoint',
  'controlledImageHttpApiKeyEnv',
  'controlledImageHttpModelId',
  'controlledImageHttpBindingId',
  'controlledImageHttpBindingEpoch',
  'controlledImageHttpLedgerRoot'
])

const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key))

const wellFormedUnicode = value => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

const exactText = value => typeof value === 'string' && value.length > 0 && value === value.trim() &&
  !/[\x00-\x1f\x7f]/u.test(value) && wellFormedUnicode(value)

const managedProfileScope = profile => ({
  tenantId: profile?.managedTenantId,
  clientId: profile?.managedClientId,
  ownerJiacn: profile?.managedOwnerJiacn,
  agentId: profile?.agentId,
  generation: profile?.managedGeneration,
  profileId: profile?.profileId
})

const scopeFields = Object.freeze(['tenantId', 'clientId', 'ownerJiacn', 'agentId', 'generation', 'profileId'])
const scopeKey = scope => scopeFields.map(field => scope[field]).join('\0')
const rootsOverlap = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)

const normalizeAuthorization = input => {
  if (!exactKeys(input, AUTHORIZATION_KEYS) ||
      !scopeFields.every(field => exactText(input[field])) ||
      !/^agt_[0-9a-f]{32}$/.test(input.agentId) ||
      !/^hri_[0-9a-f-]{36}$/.test(input.generation) ||
      input.nativeConversationHttpPollEnabled !== true || input.controlledImageHttpEnabled !== true) {
    throw new Error('Invalid managed image scope authorization')
  }
  const controlled = {
    controlledImageHttpEnabled: true,
    controlledImageHttpEndpoint: input.controlledImageHttpEndpoint,
    controlledImageHttpApiKeyEnv: input.controlledImageHttpApiKeyEnv,
    controlledImageHttpModelId: input.controlledImageHttpModelId,
    controlledImageHttpBindingId: input.controlledImageHttpBindingId,
    controlledImageHttpBindingEpoch: input.controlledImageHttpBindingEpoch,
    controlledImageHttpLedgerRoot: input.controlledImageHttpLedgerRoot
  }
  const resolved = resolveControlledImageHttpConfig(controlled, { env: {}, requireCredential: false })
  return Object.freeze({
    ...Object.fromEntries(scopeFields.map(field => [field, input[field]])),
    nativeConversationHttpPollEnabled: true,
    ...controlled,
    controlledImageHttpEndpoint: resolved.endpoint,
    controlledImageHttpBindingEpoch: resolved.bindingEpoch,
    controlledImageHttpLedgerRoot: resolved.ledgerRoot
  })
}

export const managedImageScopeMatches = (profile, authorization) => {
  if (!authorization) return false
  const scope = managedProfileScope(profile)
  return scopeFields.every(field => exactText(scope[field]) && authorization[field] === scope[field])
}

export const emptyManagedImageScopeAuthorizations = () => Object.freeze({
  resolve: () => null,
  count: 0
})

export const parseManagedImageScopeAuthorizations = (raw, { reservedProfiles = [] } = {}) => {
  let document
  try { document = JSON.parse(String(raw)) } catch { throw new Error('Managed image scope config must be valid JSON') }
  if (!exactKeys(document, TOP_LEVEL_KEYS) || document.schemaVersion !== 1 || !Array.isArray(document.authorizations)) {
    throw new Error('Managed image scope config schema is invalid')
  }
  const authorizations = document.authorizations.map(normalizeAuthorization)
  const byScope = new Map()
  for (const authorization of authorizations) {
    const key = scopeKey(authorization)
    if (byScope.has(key)) throw new Error('Duplicate managed image scope authorization')
    byScope.set(key, authorization)
  }
  assertDistinctControlledImageLedgerRoots([
    ...reservedProfiles,
    ...authorizations.map(authorization => ({ profileId: authorization.profileId, ...authorization }))
  ])
  return Object.freeze({
    count: byScope.size,
    resolve(profile) {
      const scope = managedProfileScope(profile)
      if (!scopeFields.every(field => exactText(scope[field]))) return null
      const authorization = byScope.get(scopeKey(scope)) || null
      if (!managedImageScopeMatches(profile, authorization)) return null
      const ledgerRoot = resolve(authorization.controlledImageHttpLedgerRoot)
      for (const runtimePath of [profile.codexHome, profile.codexWorkdir]) {
        if (typeof runtimePath === 'string' && runtimePath && isAbsolute(runtimePath) &&
            rootsOverlap(ledgerRoot, resolve(runtimePath))) return null
      }
      return authorization
    }
  })
}

export const loadManagedImageScopeAuthorizations = (path, options = {}) => {
  if (!exactText(path) || !isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error('Managed image scope config path must be an existing canonical absolute path')
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Managed image scope config must be a private operator-owned file')
  }
  return parseManagedImageScopeAuthorizations(readFileSync(path, 'utf8'), options)
}
