import { prepareImageDerivative } from './image-input-file.mjs'
/** Authorized materials in the original CHAT turn. Reuses the existing byte
 * materializer, measured carrier isolation and durable CHAT inbox; no new lane. */
import { canonicalSha256 } from './chat-runtime.mjs'
import { buildTypedInspectionNativeInputs, finalizeTypedInspectionInputReceipt } from './typed-inspection-input-carriers.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const bindingKeys = ['tenantId', 'ownerJiacn', 'clientId', 'conversationId', 'conversationGeneration', 'taskId', 'requestId', 'turnId', 'targetAgentId']
export const materialsContentPath = (message, ref) => `/internal/agent/chat/requests/${message.requestId}/turns/${message.turnId}/materials/inputs/${ref}/content`
export function resolveChatMaterials(profile, message) {
  const facts = message?.contextSnapshot?.facts || {}
  if (!Object.hasOwn(facts, 'materialsInput')) return null
  const value = facts.materialsInput, manifest = value?.manifest
  if (message.durable !== true || (message.route || message.routing?.interactionMode) !== 'CHAT' || facts.typedInspection
      || message.targetAgentId !== profile.agentId || bindingKeys.some(key => !id(String(message[key] ?? '')))
      || facts.conversation?.id !== message.conversationId || String(facts.conversation?.generation) !== String(message.conversationGeneration)
      || facts.task?.id !== message.taskId || facts.targetAgentId !== profile.agentId) fail('MATERIALS_BINDING_INVALID')
  if (!exact(value, ['schemaVersion', 'authorizationId', 'manifestDigest', 'manifest']) || value.schemaVersion !== 1 || !digest(value.manifestDigest)
      || !exact(manifest, ['schemaVersion', 'profile', 'sources']) || manifest.schemaVersion !== 1
      || !exact(manifest.profile, ['schemaVersion', 'supportedInputs']) || manifest.profile.schemaVersion !== 1
      || !Array.isArray(manifest.profile.supportedInputs) || !Array.isArray(manifest.sources) || !manifest.sources.length) fail('MATERIALS_MANIFEST_INVALID')
  const formats = new Map()
  for (const format of manifest.profile.supportedInputs) {
    if (!exact(format, ['mediaKind', 'mimeType', 'carrier', 'carrierContractDigest'])
        || !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT'].includes(format.carrier)
        || ({ DIRECT_TEXT: 'text', LOCAL_IMAGE: 'image', LOCAL_AUDIO: 'audio', PARSED_TEXT: 'file' })[format.carrier] !== format.mediaKind
        || typeof format.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(format.mimeType)
        || !digest(format.carrierContractDigest) || formats.has(format.mimeType)) fail('MATERIALS_PROFILE_INVALID')
    formats.set(format.mimeType, format)
  }
  let previous = null
  for (const source of manifest.sources) {
    const format = formats.get(source.mimeType)
    if (!exact(source, ['sourceRefId', 'sourceKind', 'sha256', 'byteLength', 'mimeType', 'carrier', 'carrierContractDigest', 'downloadUrl'])
        || !id(source.sourceRefId) || (previous !== null && source.sourceRefId <= previous)
        || !['TASK_WORKSPACE_FILE', 'TASK_LINKED_WORKSPACE_VERSION', 'CURRENT_CONVERSATION_ASSET', 'EXECUTION_RESULT', 'FORMAL_ARTIFACT'].includes(source.sourceKind)
        || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)
        || typeof source.byteLength !== 'string' || !/^(0|[1-9][0-9]*)$/.test(source.byteLength) || BigInt(source.byteLength) > BigInt(Number.MAX_SAFE_INTEGER)
        || !format || source.carrier !== format.carrier || source.carrierContractDigest !== format.carrierContractDigest
        || source.downloadUrl !== materialsContentPath(message, source.sourceRefId)) fail('MATERIALS_SOURCE_INVALID')
    previous = source.sourceRefId
  }
  const binding = Object.fromEntries(bindingKeys.map(key => [key, key === 'conversationGeneration' ? String(message[key]) : message[key]]))
  if (canonicalSha256({ domain: 'juyiting.materials-input', binding, manifest }) !== value.manifestDigest
      || value.authorizationId !== `materials_${value.manifestDigest.slice(7, 47)}`) fail('MATERIALS_MANIFEST_DIGEST_MISMATCH')
  return freeze(structuredClone(value))
}
export function materialsEngineBinding(message, materials, profileRuntime) {
  return { schemaVersion: 1, requestKey: message.dedupeKey || message.messageId, authorizationId: materials.authorizationId,
    manifestDigest: materials.manifestDigest, requestId: message.requestId, turnId: message.turnId,
    inputPolicyDigest: profileRuntime.contractReadback.inputPolicyDigest }
}
export async function prepareChatMaterials({ profile, message, materials, materializer, profileRuntime, adapters = {} }) {
  const measured = profileRuntime?.contractReadback
  if (!materializer || measured?.measured !== true || !['STRICT_NO_TOOLS', 'MANIFEST_READ_ONLY'].includes(measured.toolPolicy)
      || measured.recovery !== 'durable-inbox-turn-readback-v1') fail('MATERIALS_CARRIER_UNAVAILABLE')
  for (const input of materials.manifest.profile.supportedInputs) {
    if (!measured.supportedInputs?.some(item => canonicalSha256(item) === canonicalSha256(input))) fail('MATERIALS_CARRIER_BINDING_CHANGED')
  }
  const materialized = await materializer.materialize({ message, typed: materials, contract: 'materials' })
  const sources = materialized.sources.map(source => {
    const base = { sourceRefId: source.sourceRefId, sha256: source.sha256, byteLength: source.byteLength,
      mimeType: source.mimeType, carrier: source.carrier, carrierContractDigest: source.carrierContractDigest, bytes: source.bytes }
    if (source.carrier === 'LOCAL_IMAGE' && source.mimeType !== 'image/png') return { ...base, path: profileRuntime.mapInputPath(source.path, materialized.directory), derivative: prepareImageDerivative(source, path => profileRuntime.mapInputPath(path, materialized.directory)) }
    return source.carrier === 'LOCAL_IMAGE' || source.carrier === 'LOCAL_AUDIO'
      ? { ...base, path: profileRuntime.mapInputPath(source.path, materialized.directory) }
      : source.carrier === 'PARSED_TEXT' ? { ...base, parser: source.parser, parsedText: source.parsedText } : base
  })
  const converted = buildTypedInspectionNativeInputs({ authorizationId: materials.authorizationId, manifestDigest: materials.manifestDigest, sources, adapters })
  return { ...converted, inputDirectory: materialized.directory }
}
const finalPreimage = value => { const { finalDigest, ...preimage } = value; return preimage }
export function buildMaterialsChatFinal({ message, materials, rawOutcome, receiptDraft, engineThreadId, engineTurnId, threadKey, validateOutcome, finalSeq = message.__deltaSeq || '0' }) {
  if (typeof finalSeq !== 'string' || !/^(0|[1-9][0-9]*)$/.test(finalSeq)) fail('MATERIALS_FINAL_SEQUENCE_INVALID')
  const outcome = validateOutcome(rawOutcome)
  const receipt = finalizeTypedInspectionInputReceipt({ receiptDraft, engineThreadId, engineTurnId })
  const outboundMessageId = `materials_final_${canonicalSha256({ requestId: message.requestId, turnId: message.turnId,
    dispatchId: message.dispatchId, outcome, receipt }).slice(7)}`
  const prepared = { schemaVersion: 1, contract: 'juyiting-materials-chat-final-v1', authorizationId: materials.authorizationId,
    manifestDigest: materials.manifestDigest, requestId: message.requestId, turnId: message.turnId, dispatchId: message.dispatchId,
    outboundMessageId, content: outcome.text,
    extra: { status: 'completed', routeUsed: 'CHAT_FAST', productPolicy: 'fixed-materials-read-only', threadGeneration: threadKey,
      finalSeq, outcomeContractVersion: outcome.schemaVersion, interactionOutcome: outcome, inspectionInputReceipt: receipt, outboundMessageId },
    result: { status: 'final_computed', computationStatus: 'completed', serverPersistence: 'unconfirmed', threadId: engineThreadId,
      turnId: engineTurnId, threadKey, inputDigest: receipt.inputDigest, outboundMessageId } }
  return freeze({ ...prepared, finalDigest: canonicalSha256(prepared) })
}
export async function publishMaterialsChatFinal({ profile, message, materials, finalPrepared, validateOutcome, controls, sendFinal }) {
  if (!exact(finalPrepared, ['schemaVersion', 'contract', 'authorizationId', 'manifestDigest', 'requestId', 'turnId', 'dispatchId', 'outboundMessageId', 'content', 'extra', 'result', 'finalDigest'])
      || finalPrepared.finalDigest !== canonicalSha256(finalPreimage(finalPrepared))) fail('MATERIALS_FINAL_PREPARED_INVALID')
  const receipt = finalPrepared.extra?.inspectionInputReceipt
  if (!object(receipt)) fail('MATERIALS_FINAL_PREPARED_INVALID')
  const { engineThreadId, engineTurnId, ...receiptDraft } = receipt
  if (receiptDraft.authorizationId !== materials.authorizationId || receiptDraft.manifestDigest !== materials.manifestDigest
      || receiptDraft.sources?.length !== materials.manifest.sources.length || receiptDraft.sources.some((source, i) => {
        const frozen = materials.manifest.sources[i]; return source.sourceRefId !== frozen.sourceRefId || source.sha256 !== frozen.sha256
          || source.byteLength !== frozen.byteLength || source.carrier !== frozen.carrier
      })) fail('MATERIALS_RECEIPT_BINDING_INVALID')
  const expected = buildMaterialsChatFinal({ message, materials, rawOutcome: finalPrepared.extra.interactionOutcome, receiptDraft,
    engineThreadId, engineTurnId, threadKey: finalPrepared.result?.threadKey, validateOutcome, finalSeq: finalPrepared.extra.finalSeq })
  if (canonicalSha256(expected) !== canonicalSha256(finalPrepared)) fail('MATERIALS_FINAL_PREPARED_INVALID')
  let sent = false, errorCode = null
  try { sent = await sendFinal(profile, message, expected.content, expected.extra) === true } catch (error) { errorCode = error.code || 'CHAT_FINAL_SEND_FAILED' }
  const publication = { schemaVersion: 1, outboundMessageId: expected.outboundMessageId,
    state: sent ? 'WS_WRITE_ACCEPTED_PERSISTENCE_UNCONFIRMED' : 'NOT_SENT', errorCode }
  await controls.markFinalPublication?.(publication)
  return { ...expected.result, status: 'recovery_required', finalDigest: expected.finalDigest,
    recoveryReason: sent ? 'FINAL_SERVER_PERSISTENCE_UNCONFIRMED' : 'FINAL_PUBLISH_NOT_SENT', publicationState: publication.state }
}
