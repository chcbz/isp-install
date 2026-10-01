/** Strict source-aware input snapshot and private materialization for controlled image v3. */
import { createHash } from 'node:crypto'
import { closeSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const LONG_MAX = 9223372036854775807n
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const HASH = /^[a-f0-9]{64}$/
const MIME = new Map([['image/png', 'png'], ['image/jpeg', 'jpg']])
const SNAPSHOT_FIELDS = ['schemaVersion', 'executionId', 'leaseVersion', 'operation', 'inputSnapshotDigest', 'noReferencedMaterials', 'inputs'].sort().join(',')
const INPUT_FIELDS = ['inputRef', 'source', 'contentMimeType', 'byteLength', 'sha256'].sort().join(',')
const WORKSPACE_FIELDS = ['kind', 'fileId', 'version', 'purpose'].sort().join(',')
const ASSET_FIELDS = ['kind', 'conversationId', 'conversationGeneration', 'assetId', 'assetRevision', 'producerRequestId', 'producerStepId', 'producerExecutionId', 'producerRunId', 'producerOutputId'].sort().join(',')

export class ControlledImageV3InputError extends Error {
  constructor(code = 'CONTROLLED_IMAGE_V3_INPUTS_UNAVAILABLE') { super(code); this.code = code }
}
const deny = () => { throw new ControlledImageV3InputError() }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactFields = (value, fields) => object(value) && Object.keys(value).sort().join(',') === fields
const validId = value => typeof value === 'string' && ID.test(value)

export const isCanonicalPositiveJavaLong = value => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false
  try { return BigInt(value) <= LONG_MAX } catch { return false }
}

const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!object(value)) return value
  const result = {}
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key])
  return result
}
export const canonicalContextJsonV1 = value => JSON.stringify(canonicalValue(value))
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')

const parseSource = (source, operation, conversationId) => {
  if (!object(source) || typeof source.kind !== 'string') deny()
  if (source.kind === 'TASK_LINKED_WORKSPACE_VERSION') {
    if (!exactFields(source, WORKSPACE_FIELDS) || operation !== 'GENERATE_IMAGE'
        || !validId(source.fileId) || !isCanonicalPositiveJavaLong(source.version)
        || source.purpose !== 'REFERENCE') deny()
    return Object.freeze({ kind: source.kind, fileId: source.fileId, version: source.version, purpose: source.purpose })
  }
  if (source.kind === 'CURRENT_CONVERSATION_ASSET') {
    if (!exactFields(source, ASSET_FIELDS) || operation !== 'EDIT_IMAGE'
        || source.conversationId !== conversationId
        || !isCanonicalPositiveJavaLong(source.conversationGeneration)
        || !isCanonicalPositiveJavaLong(source.assetRevision)
        || !['assetId', 'producerRequestId', 'producerStepId', 'producerExecutionId', 'producerRunId', 'producerOutputId']
          .every(key => validId(source[key]))) deny()
    return Object.freeze({
      kind: source.kind,
      conversationId: source.conversationId,
      conversationGeneration: source.conversationGeneration,
      assetId: source.assetId,
      assetRevision: source.assetRevision,
      producerRequestId: source.producerRequestId,
      producerStepId: source.producerStepId,
      producerExecutionId: source.producerExecutionId,
      producerRunId: source.producerRunId,
      producerOutputId: source.producerOutputId
    })
  }
  deny()
}

export const controlledImageV3InputDigest = ({ command, noReferencedMaterials, inputs }) => {
  const canonicalUtf8 = canonicalContextJsonV1({
    schemaVersion: 1,
    executionId: command.executionId,
    taskId: command.taskId,
    runId: command.runId,
    conversationId: command.conversationId,
    operation: command.operation,
    noReferencedMaterials,
    inputs: inputs.map(input => ({
      inputRef: input.inputRef,
      source: input.source,
      contentMimeType: input.contentMimeType,
      byteLength: input.byteLength,
      sha256: input.sha256
    }))
  })
  return Object.freeze({ canonicalUtf8, sha256: sha256(canonicalUtf8) })
}

const sourceDescriptorValid = (source, operation, conversationId = null) => {
  if (!object(source)) return false
  if (source.kind === 'TASK_LINKED_WORKSPACE_VERSION') {
    return operation === 'GENERATE_IMAGE' && exactFields(source, WORKSPACE_FIELDS)
      && validId(source.fileId) && isCanonicalPositiveJavaLong(source.version)
      && source.purpose === 'REFERENCE'
  }
  if (source.kind === 'CURRENT_CONVERSATION_ASSET') {
    return operation === 'EDIT_IMAGE' && exactFields(source, ASSET_FIELDS)
      && (conversationId === null || source.conversationId === conversationId)
      && validId(source.conversationId) && isCanonicalPositiveJavaLong(source.conversationGeneration)
      && isCanonicalPositiveJavaLong(source.assetRevision)
      && ['assetId', 'producerRequestId', 'producerStepId', 'producerExecutionId', 'producerRunId', 'producerOutputId']
        .every(key => validId(source[key]))
  }
  return false
}

export const controlledImageV3OperationSourcesValid = (operation, inputs, conversationId = null) => {
  if (!Array.isArray(inputs) || inputs.length > 16) return false
  if (operation === 'GENERATE_IMAGE') {
    return inputs.every(input => sourceDescriptorValid(input?.source, operation, conversationId))
  }
  return operation === 'EDIT_IMAGE' && inputs.length === 1
    && sourceDescriptorValid(inputs[0]?.source, operation, conversationId)
}

export const parseControlledImageV3Inputs = (snapshot, command, leaseVersion) => {
  if (!exactFields(snapshot, SNAPSHOT_FIELDS) || snapshot.schemaVersion !== 3
      || snapshot.executionId !== command.executionId || snapshot.leaseVersion !== leaseVersion
      || snapshot.operation !== command.operation || snapshot.inputSnapshotDigest !== command.inputSnapshotDigest
      || !HASH.test(snapshot.inputSnapshotDigest || '') || !Array.isArray(snapshot.inputs)
      || snapshot.inputs.length > 16 || snapshot.noReferencedMaterials !== (snapshot.inputs.length === 0)) deny()
  const sources = new Set()
  const inputs = snapshot.inputs.map((input, index) => {
    if (!exactFields(input, INPUT_FIELDS) || input.inputRef !== `input_${index + 1}`
        || !MIME.has(input.contentMimeType) || !isCanonicalPositiveJavaLong(input.byteLength)
        || !HASH.test(input.sha256 || '')) deny()
    const source = parseSource(input.source, command.operation, command.conversationId)
    const sourceIdentity = canonicalContextJsonV1(source)
    if (sources.has(sourceIdentity)) deny()
    sources.add(sourceIdentity)
    return Object.freeze({
      inputRef: input.inputRef,
      source,
      contentMimeType: input.contentMimeType,
      byteLength: input.byteLength,
      sha256: input.sha256,
      relativePath: `inputs/${input.inputRef}.${MIME.get(input.contentMimeType)}`
    })
  })
  if (!controlledImageV3OperationSourcesValid(command.operation, inputs, command.conversationId)) deny()
  const digest = controlledImageV3InputDigest({ command, noReferencedMaterials: snapshot.noReferencedMaterials, inputs })
  if (digest.sha256 !== command.inputSnapshotDigest) deny()
  return Object.freeze({
    operation: command.operation,
    inputSnapshotDigest: command.inputSnapshotDigest,
    noReferencedMaterials: snapshot.noReferencedMaterials,
    inputs: Object.freeze(inputs),
    canonicalUtf8: digest.canonicalUtf8
  })
}

export const materializeControlledImageV3Inputs = async ({ inputs, runDirectory, readInput }) => {
  if (!Array.isArray(inputs) || typeof runDirectory !== 'string' || typeof readInput !== 'function') deny()
  const output = []
  for (const input of inputs) {
    const path = resolve(runDirectory, input.relativePath)
    if (!path.startsWith(`${resolve(runDirectory, 'inputs')}${sep}`)) deny()
    const bytes = await readInput(input)
    if (!Buffer.isBuffer(bytes) || BigInt(bytes.length) !== BigInt(input.byteLength)
        || createHash('sha256').update(bytes).digest('hex') !== input.sha256) deny()
    let descriptor
    let created = false
    try {
      descriptor = openSync(path, 'wx', 0o600)
      created = true
      let offset = 0
      while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
      closeSync(descriptor)
      descriptor = undefined
      if (realpathSync(path) !== path) deny()
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      if (created) try { unlinkSync(path) } catch { /* private run tree is removed on exit */ }
      throw error instanceof ControlledImageV3InputError ? error : new ControlledImageV3InputError()
    }
    output.push(Object.freeze({
      inputRef: input.inputRef,
      relativePath: input.relativePath,
      source: input.source,
      contentType: input.contentMimeType,
      byteLength: input.byteLength,
      sha256: input.sha256
    }))
  }
  return Object.freeze(output)
}
