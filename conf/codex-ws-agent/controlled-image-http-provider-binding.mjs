import {
  CONTROLLED_IMAGE_MAX_INPUT_ITEMS,
  CONTROLLED_IMAGE_MAX_OUTBOUND_REQUEST_ATTEMPTS,
  CONTROLLED_IMAGE_PRECALL_FENCE_VERSION,
  CONTROLLED_IMAGE_PROVIDER_LANE
} from './controlled-image-http-config.mjs'
import { CONTROLLED_IMAGE_GPT_CLI_ADAPTER } from './controlled-image-gpt-cli-config.mjs'

const disabled = () => Object.freeze({ schemaVersion: 1, enabled: false })
const disabledProfileStatuses = new Set(['disabled', 'inactive', 'unavailable', 'offline'])

export const nativeProviderCredentialBindingEnabled = ({ profile, runtime, online } = {}) => Boolean(
  online === true
  && !disabledProfileStatuses.has(String(profile?.status || '').trim().toLowerCase())
  && profile?.enabled !== false
  && profile?.controlledImageHttpEnabled === true
  && [CONTROLLED_IMAGE_PROVIDER_LANE, CONTROLLED_IMAGE_GPT_CLI_ADAPTER].includes(runtime?.adapterKind)
  && runtime?.configReady === true
  && runtime?.credentialReady === true
  && runtime?.httpPollEnabled === true
  && typeof runtime?.executor === 'function'
  && typeof runtime?.pollProtocol?.poll === 'function'
  && runtime?.controlledConfig?.providerLane === CONTROLLED_IMAGE_PROVIDER_LANE
)

export const buildNativeProviderCredentialBinding = readiness => {
  if (!nativeProviderCredentialBindingEnabled(readiness)) return disabled()
  const config = readiness.runtime.controlledConfig
  return Object.freeze({
    schemaVersion: 1,
    enabled: true,
    providerLane: CONTROLLED_IMAGE_PROVIDER_LANE,
    bindingId: config.bindingId,
    bindingEpoch: config.bindingEpoch,
    modelId: config.modelId,
    maxInputItems: CONTROLLED_IMAGE_MAX_INPUT_ITEMS,
    maxOutboundRequestAttempts: CONTROLLED_IMAGE_MAX_OUTBOUND_REQUEST_ATTEMPTS,
    precallFenceVersion: CONTROLLED_IMAGE_PRECALL_FENCE_VERSION
  })
}
