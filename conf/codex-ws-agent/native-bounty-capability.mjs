/**
 * Frozen native bounty declaration v1. This describes only the enabled local executor and
 * authenticated HTTP-poll wire; it is not evidence of task authorization, cost authorization,
 * Provider availability, or execution success.
 */
export const NATIVE_BOUNTY_TRANSPORT = 'PERSONAL_WORKSPACE_CONVERSATION_HTTP_V1'

const freezeArray = values => Object.freeze([...values])
const disabledProfileStatuses = new Set(['disabled', 'inactive', 'unavailable', 'offline'])

const operation = () => Object.freeze({
  operation: 'GENERATE_IMAGE',
  inputManifest: Object.freeze({
    schemaVersion: 1,
    minItems: 0,
    maxItems: 32,
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

export const nativeBountyExecutionEnabled = ({ profile, runtime, online } = {}) => {
  const status = String(profile?.status || '').trim().toLowerCase()
  return Boolean(
    online === true
    && profile?.enabled !== false
    && !disabledProfileStatuses.has(status)
    && profile?.nativeConversationHttpPollEnabled === true
    && profile?.nativeConversationImageGenerationEnabled === true
    && runtime?.configReady === true
    && runtime?.httpPollEnabled === true
    && runtime?.nativeBountyV1Ready === true
    && runtime?.adapterKind === 'CODEX_IMAGEGEN_NATIVE_V1'
    && typeof runtime?.executor === 'function'
    && typeof runtime?.pollProtocol?.poll === 'function'
  )
}

export const buildNativeBountyExecutionDeclaration = readiness => {
  const enabled = nativeBountyExecutionEnabled(readiness)
  return Object.freeze({
    schemaVersion: 1,
    enabled,
    transport: NATIVE_BOUNTY_TRANSPORT,
    commandSchemaVersions: freezeArray([1]),
    leaseProtocolVersions: freezeArray([1]),
    providerStartFenceVersions: freezeArray([1]),
    resultCommitProtocolVersions: freezeArray([1]),
    operations: enabled ? freezeArray([operation()]) : freezeArray([])
  })
}
