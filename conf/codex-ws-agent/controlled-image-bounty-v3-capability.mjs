/** Source-aware controlled-image v3 declaration. */
import {
  CONTROLLED_IMAGE_MAX_INPUT_ITEMS,
  CONTROLLED_IMAGE_MAX_OUTBOUND_REQUEST_ATTEMPTS,
  CONTROLLED_IMAGE_PRECALL_FENCE_VERSION,
  CONTROLLED_IMAGE_PROVIDER_LANE
} from './controlled-image-http-config.mjs'
import { nativeProviderCredentialBindingEnabled } from './controlled-image-http-provider-binding.mjs'

export const CONTROLLED_IMAGE_BOUNTY_V3_TRANSPORT = 'PERSONAL_WORKSPACE_CONTROLLED_IMAGE_HTTP_V3'

const freezeArray = values => Object.freeze([...values])
const disabledStatuses = new Set(['disabled', 'inactive', 'unavailable', 'offline'])

const resultManifest = () => Object.freeze({
  schemaVersion: 1,
  minItems: 1,
  maxItems: 1,
  outputId: 'output_1',
  mimeTypes: freezeArray(['image/png'])
})

const operation = (name, minItems, maxItems, sourceKind) => Object.freeze({
  operation: name,
  inputManifest: Object.freeze({
    schemaVersion: 3,
    minItems,
    maxItems,
    mimeTypes: freezeArray(['image/jpeg', 'image/png']),
    sourceKinds: freezeArray([sourceKind])
  }),
  resultManifest: resultManifest()
})

const exactControlledPolicy = (profile, runtime) => Boolean(
  runtime?.controlledConfig?.enabled === true
  && runtime.controlledConfig.providerLane === CONTROLLED_IMAGE_PROVIDER_LANE
  && runtime.controlledConfig.bindingId === profile?.controlledImageHttpBindingId
  && runtime.controlledConfig.bindingEpoch === profile?.controlledImageHttpBindingEpoch
  && runtime.controlledConfig.modelId === profile?.controlledImageHttpModelId
  && runtime.controlledConfig.maxInputItems === CONTROLLED_IMAGE_MAX_INPUT_ITEMS
  && runtime.controlledConfig.maxOutboundRequestAttempts === CONTROLLED_IMAGE_MAX_OUTBOUND_REQUEST_ATTEMPTS
  && runtime.controlledConfig.precallFenceVersion === CONTROLLED_IMAGE_PRECALL_FENCE_VERSION
)

export const controlledImageBountyExecutionV3Enabled = ({ profile, runtime, online } = {}) => Boolean(
  online === true
  && profile?.enabled !== false
  && !disabledStatuses.has(String(profile?.status || '').trim().toLowerCase())
  && profile?.controlledImageHttpEnabled === true
  && runtime?.controlledImageV3Ready === true
  && exactControlledPolicy(profile, runtime)
  && nativeProviderCredentialBindingEnabled({ profile, runtime, online })
)

export const buildControlledImageBountyExecutionV3Declaration = readiness => {
  const enabled = controlledImageBountyExecutionV3Enabled(readiness)
  return Object.freeze({
    schemaVersion: 1,
    enabled,
    transport: CONTROLLED_IMAGE_BOUNTY_V3_TRANSPORT,
    commandSchemaVersions: freezeArray([3]),
    leaseProtocolVersions: freezeArray([1]),
    providerStartFenceVersions: freezeArray([3]),
    resultCommitProtocolVersions: freezeArray([1]),
    operations: enabled ? freezeArray([
      operation('GENERATE_IMAGE', 0, 16, 'TASK_LINKED_WORKSPACE_VERSION'),
      operation('EDIT_IMAGE', 1, 1, 'CURRENT_CONVERSATION_ASSET')
    ]) : freezeArray([])
  })
}
