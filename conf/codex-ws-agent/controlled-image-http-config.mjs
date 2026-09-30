import { isAbsolute, resolve } from 'node:path'

export const CONTROLLED_IMAGE_PROVIDER_LANE = 'CONTROLLED_IMAGE_HTTP_V1'
export const CONTROLLED_IMAGE_MAX_INPUT_ITEMS = 16
export const CONTROLLED_IMAGE_MAX_OUTBOUND_REQUEST_ATTEMPTS = 1
export const CONTROLLED_IMAGE_PRECALL_FENCE_VERSION = 1

const LONG_MAX = 9223372036854775807n
const SAFE_BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]*$/

export class ControlledImageHttpConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ControlledImageHttpConfigError'
    this.code = code
  }
}

const fail = (code, message) => { throw new ControlledImageHttpConfigError(code, message) }
const text = value => typeof value === 'string' ? value : ''
const enabled = value => String(value || '').trim().toLowerCase() === 'true'

const parseEndpoint = value => {
  if (!value || value !== value.trim()) {
    fail('CONTROLLED_IMAGE_ENDPOINT_INVALID', 'controlled image endpoint must be a canonical HTTPS origin')
  }
  let endpoint
  try { endpoint = new URL(value) } catch { fail('CONTROLLED_IMAGE_ENDPOINT_INVALID', 'controlled image endpoint must be an HTTPS origin') }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    fail('CONTROLLED_IMAGE_ENDPOINT_INVALID', 'controlled image endpoint must be an HTTPS origin without credentials, path, query, or fragment')
  }
  return endpoint.origin
}

const parseEpoch = value => {
  const epoch = text(value)
  if (!/^[1-9][0-9]*$/.test(epoch)) {
    fail('CONTROLLED_IMAGE_BINDING_EPOCH_INVALID', 'controlled image binding epoch must be a positive canonical decimal string')
  }
  let parsed
  try { parsed = BigInt(epoch) } catch { fail('CONTROLLED_IMAGE_BINDING_EPOCH_INVALID', 'controlled image binding epoch is invalid') }
  if (parsed > LONG_MAX) fail('CONTROLLED_IMAGE_BINDING_EPOCH_INVALID', 'controlled image binding epoch exceeds Java long range')
  return epoch
}

export const normalizeControlledImageHttpProfile = (profile = {}, fallback = {}) => Object.freeze({
  controlledImageHttpEnabled: enabled(profile.controlledImageHttpEnabled ?? fallback.controlledImageHttpEnabled),
  controlledImageHttpEndpoint: text(profile.controlledImageHttpEndpoint ?? fallback.controlledImageHttpEndpoint),
  controlledImageHttpApiKeyEnv: text(profile.controlledImageHttpApiKeyEnv ?? fallback.controlledImageHttpApiKeyEnv),
  controlledImageHttpModelId: text(profile.controlledImageHttpModelId ?? fallback.controlledImageHttpModelId),
  controlledImageHttpBindingId: text(profile.controlledImageHttpBindingId ?? fallback.controlledImageHttpBindingId),
  controlledImageHttpBindingEpoch: text(profile.controlledImageHttpBindingEpoch ?? fallback.controlledImageHttpBindingEpoch),
  controlledImageHttpLedgerRoot: text(profile.controlledImageHttpLedgerRoot ?? fallback.controlledImageHttpLedgerRoot)
})

export const resolveControlledImageHttpConfig = (profile, { env = process.env, requireCredential = true } = {}) => {
  const normalized = normalizeControlledImageHttpProfile(profile)
  if (!normalized.controlledImageHttpEnabled) return Object.freeze({ enabled: false })
  const endpoint = parseEndpoint(normalized.controlledImageHttpEndpoint)
  const bindingId = normalized.controlledImageHttpBindingId
  const modelId = normalized.controlledImageHttpModelId
  const apiKeyEnv = normalized.controlledImageHttpApiKeyEnv
  const ledgerRoot = normalized.controlledImageHttpLedgerRoot
  if (!SAFE_BINDING_ID.test(bindingId)) fail('CONTROLLED_IMAGE_BINDING_ID_INVALID', 'controlled image bindingId must be an explicit canonical identifier')
  if (!SAFE_MODEL_ID.test(modelId)) fail('CONTROLLED_IMAGE_MODEL_ID_INVALID', 'controlled image modelId must be an explicit canonical identifier')
  if (!SAFE_ENV_NAME.test(apiKeyEnv)) fail('CONTROLLED_IMAGE_KEY_ENV_INVALID', 'controlled image API key environment variable name is invalid')
  if (!ledgerRoot || ledgerRoot !== ledgerRoot.trim() || !isAbsolute(ledgerRoot)) {
    fail('CONTROLLED_IMAGE_LEDGER_ROOT_INVALID', 'controlled image ledger root must be an explicit canonical absolute path')
  }
  const credential = env?.[apiKeyEnv]
  if (requireCredential && (typeof credential !== 'string' || !credential || credential !== credential.trim()
      || /[\r\n\0]/.test(credential))) {
    fail('CONTROLLED_IMAGE_CREDENTIAL_UNAVAILABLE', 'controlled image credential environment variable is unavailable')
  }
  return Object.freeze({
    enabled: true,
    providerLane: CONTROLLED_IMAGE_PROVIDER_LANE,
    endpoint,
    apiKeyEnv,
    modelId,
    bindingId,
    bindingEpoch: parseEpoch(normalized.controlledImageHttpBindingEpoch),
    ledgerRoot: resolve(ledgerRoot),
    maxInputItems: CONTROLLED_IMAGE_MAX_INPUT_ITEMS,
    maxOutboundRequestAttempts: CONTROLLED_IMAGE_MAX_OUTBOUND_REQUEST_ATTEMPTS,
    precallFenceVersion: CONTROLLED_IMAGE_PRECALL_FENCE_VERSION,
    credentialPresent: typeof credential === 'string' && credential.length > 0
  })
}

export const controlledImageHttpConfigurationErrors = (profile, options = {}) => {
  if (!normalizeControlledImageHttpProfile(profile).controlledImageHttpEnabled) return []
  const errors = []
  try { resolveControlledImageHttpConfig(profile, options) } catch (error) {
    errors.push(error instanceof ControlledImageHttpConfigError ? error.message : 'controlled image HTTP configuration is invalid')
  }
  if (profile?.nativeConversationHttpPollEnabled !== true) {
    errors.push('controlledImageHttpEnabled requires nativeConversationHttpPollEnabled=true')
  }
  if (profile?.nativeConversationImageGenerationEnabled === true) {
    errors.push('controlledImageHttpEnabled cannot be combined with the generic Codex native image executor')
  }
  return errors
}

export const assertDistinctControlledImageLedgerRoots = profiles => {
  const roots = []
  for (const profile of profiles) {
    if (!normalizeControlledImageHttpProfile(profile).controlledImageHttpEnabled) continue
    const root = resolve(profile.controlledImageHttpLedgerRoot)
    for (const existing of roots) {
      const prefix = `${existing.root}/`
      const reverse = `${root}/`
      if (root === existing.root || root.startsWith(prefix) || existing.root.startsWith(reverse)) {
        fail('CONTROLLED_IMAGE_LEDGER_ROOT_OVERLAP',
          `controlled image ledger roots must not be equal or overlap: ${existing.profileId} and ${profile.profileId}`)
      }
    }
    roots.push({ profileId: profile.profileId, root })
  }
}
