/**
 * Frozen controlled-image execution declaration v1.  This is a sibling of
 * nativeBountyExecution, never a widening or rename of its v1 wire.
 */
export const CONTROLLED_IMAGE_BOUNTY_TRANSPORT = 'PERSONAL_WORKSPACE_CONTROLLED_IMAGE_HTTP_V2'

const freezeArray = values => Object.freeze([...values])
const disabledStatuses = new Set(['disabled', 'inactive', 'unavailable', 'offline'])

const operation = () => Object.freeze({
  operation: 'GENERATE_IMAGE',
  inputManifest: Object.freeze({
    schemaVersion: 1,
    minItems: 0,
    maxItems: 16,
    mimeTypes: freezeArray(['image/jpeg', 'image/png'])
  }),
  resultManifest: Object.freeze({
    schemaVersion: 1,
    minItems: 1,
    maxItems: 1,
    outputId: 'output_1',
    mimeTypes: freezeArray(['image/png'])
  })
})

export const controlledImageBountyExecutionEnabled = ({ profile, runtime, online } = {}) => Boolean(
  online === true
  && profile?.enabled !== false
  && !disabledStatuses.has(String(profile?.status || '').trim().toLowerCase())
  && profile?.controlledImageHttpEnabled === true
  && runtime?.adapterKind === 'CONTROLLED_IMAGE_HTTP_V1'
  && runtime?.configReady === true
  && runtime?.credentialReady === true
  && runtime?.httpPollEnabled === true
  && runtime?.controlledImageV2Ready === true
  && typeof runtime?.executor === 'function'
  && typeof runtime?.pollProtocol?.poll === 'function'
)

export const buildControlledImageBountyExecutionDeclaration = readiness => {
  const enabled = controlledImageBountyExecutionEnabled(readiness)
  return Object.freeze({
    schemaVersion: 1,
    enabled,
    transport: CONTROLLED_IMAGE_BOUNTY_TRANSPORT,
    commandSchemaVersions: freezeArray([2]),
    leaseProtocolVersions: freezeArray([1]),
    providerStartFenceVersions: freezeArray([2]),
    resultCommitProtocolVersions: freezeArray([1]),
    operations: enabled ? freezeArray([operation()]) : freezeArray([])
  })
}
