import { createHash } from 'node:crypto'

// DATA only: this locator never grants a decision, task lease, or access to artifact bytes.
const fail = () => { throw Object.assign(new Error('DELIVERY_REVISION_INVALID'), { code: 'DELIVERY_REVISION_INVALID' }) }
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(v)
const sha = v => createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex')
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const decimal = (v, positive = false) => typeof v === 'string' && (positive ? /^[1-9][0-9]*$/ : /^(?:0|[1-9][0-9]*)$/).test(v) && BigInt(v) <= 9223372036854775807n
const text = (v, nonblank = false) => {
  if (typeof v !== 'string' || v.includes('\0') || (nonblank && !v.trim())) return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) { const low = v.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return false }
    else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}
const sorted = items => [...items].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
export const validateReviewBasis = value => {
  if (value === null) return null
  if (!exact(value, ['taskId', 'taskVersion', 'deliveryId', 'deliveryVersion', 'batchSha256', 'assignmentRevision', 'sourceMessageId', 'sourceRequestId', 'items']) ||
    !id(value.taskId) || !decimal(value.taskVersion) || !id(value.deliveryId) || !decimal(value.deliveryVersion) || !hash(value.batchSha256) ||
    !decimal(value.assignmentRevision, true) || !decimal(value.sourceMessageId, true) || !id(value.sourceRequestId) || !Array.isArray(value.items) || !value.items.length) fail()
  const items = value.items
  if (new Set(items.map(i => i?.artifactId)).size !== items.length || !items.some(i => i?.displayRole === 'RESULT') || items.some(i =>
    !exact(i, ['artifactId', 'artifactVersion', 'contentHash', 'purpose', 'displayRole']) || !id(i.artifactId) || !decimal(i.artifactVersion, true) ||
    !hash(i.contentHash) || !text(i.purpose) || !['RESULT', 'MANIFEST'].includes(i.displayRole))) fail()
  const ordered = [...items].sort((a, b) => Buffer.compare(Buffer.from(a.artifactId), Buffer.from(b.artifactId)))
  if (sha(['hall-delivery-batch-v1', value.taskId, value.deliveryId, value.deliveryVersion,
    ordered.map(i => [i.artifactId, i.artifactVersion, i.contentHash, i.purpose])]) !== value.batchSha256) fail()
  return structuredClone(value)
}
export const validateMessageRevision = (value, rawBasis) => {
  const basis = validateReviewBasis(rawBasis)
  if (!basis || !exact(value, ['instruction', 'targetArtifactIds']) || !text(value.instruction, true) || !Array.isArray(value.targetArtifactIds) ||
    !value.targetArtifactIds.length || new Set(value.targetArtifactIds).size !== value.targetArtifactIds.length || value.targetArtifactIds.some(v =>
      !id(v) || !basis.items.some(i => i.artifactId === v && i.displayRole === 'RESULT'))) fail()
  return structuredClone(value)
}
export const messageRevisionDigest = (rawBasis, parentOutcomeId, parentFinalDigest, rawRevision) => {
  const basis = validateReviewBasis(rawBasis), revision = validateMessageRevision(rawRevision, basis)
  if (!id(parentOutcomeId) || typeof parentFinalDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(parentFinalDigest)) fail()
  return sha(['hall-message-review-v1', basis.taskId, basis.sourceRequestId, basis.sourceMessageId, parentOutcomeId, parentFinalDigest,
    basis.deliveryId, basis.deliveryVersion, basis.batchSha256, sorted(revision.targetArtifactIds), revision.instruction])
}
