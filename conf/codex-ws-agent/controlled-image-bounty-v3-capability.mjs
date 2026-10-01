/**
 * Frozen controlled-image v3 source-aware declaration. This implementation slice
 * intentionally advertises it disabled until the API authority/source composition
 * has been verified end to end.
 */
export const CONTROLLED_IMAGE_BOUNTY_V3_TRANSPORT = 'PERSONAL_WORKSPACE_CONTROLLED_IMAGE_HTTP_V3'

export const buildControlledImageBountyExecutionV3Declaration = () => Object.freeze({
  schemaVersion: 1,
  enabled: false,
  transport: CONTROLLED_IMAGE_BOUNTY_V3_TRANSPORT,
  commandSchemaVersions: Object.freeze([3]),
  leaseProtocolVersions: Object.freeze([1]),
  providerStartFenceVersions: Object.freeze([3]),
  resultCommitProtocolVersions: Object.freeze([1]),
  operations: Object.freeze([])
})
