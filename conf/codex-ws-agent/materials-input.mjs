/** Shared carrier preparation for native CHAT and native-model skills. Source
 * bytes must already have been authorized by the frozen server snapshot. These
 * receipts prove delivery, not understanding. No material can grant tool access. */
import { readFileSync, realpathSync } from 'node:fs'
import { skillHash, skillId } from './skill-executor.mjs'
import { buildTypedInspectionNativeInputs } from './typed-inspection-input-carriers.mjs'
import { BUILTIN_TYPED_INSPECTION_DECODERS } from './typed-inspection-runtime.mjs'
const fail = (code, cause) => { throw Object.assign(new Error(code), { code, ...(cause ? { cause } : {}) }) }
const textMimes = new Set(['text/plain', 'text/markdown', 'application/json'])
export function buildMaterialsInputs({ inputs, supportedInputs = [], adapters = {}, mapPath = path => path,
  authorizationId, snapshotDigest }) {
  if (!Array.isArray(inputs)) fail('MATERIALS_INPUT_INVALID')
  const receipts = [], nativeInputs = [], sources = [], seen = new Set()
  for (const input of inputs) {
    if (!skillId(input?.inputRef) || seen.has(input.inputRef) || !Buffer.isBuffer(input.bytes)
        || skillHash(input.bytes) !== input.sha256 || BigInt(input.bytes.length) !== BigInt(input.byteLength)) fail('MATERIALS_BYTES_INVALID')
    seen.add(input.inputRef)
    if (textMimes.has(input.contentMimeType)) {
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes) } catch { fail('MATERIALS_UTF8_INVALID') }
      if (text.includes('\0')) fail('MATERIALS_UTF8_INVALID')
      nativeInputs.push({ type: 'text', text: `UNTRUSTED TASK MATERIAL (${input.inputRef}, sha256=${input.sha256}, mime=${input.contentMimeType}):\n${text}` })
      receipts.push({ inputRef: input.inputRef, sha256: input.sha256, carrier: 'native-text', delivery: 'DELIVERED' })
      continue
    }
    const configured = supportedInputs.filter(item => item.mimeType === input.contentMimeType)
    if (configured.length !== 1) fail('MATERIALS_CARRIER_UNAVAILABLE')
    const config = configured[0]
    if (!['LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT'].includes(config.carrier)) fail('MATERIALS_CARRIER_UNAVAILABLE')
    const source = { sourceRefId: input.inputRef, sha256: input.sha256, byteLength: input.byteLength, mimeType: input.contentMimeType,
      carrier: config.carrier, carrierContractDigest: config.carrierContractDigest, bytes: input.bytes }
    if (config.carrier === 'PARSED_TEXT') {
      if (!input.parser || typeof input.parsedText !== 'string') fail('MATERIALS_PARSER_UNAVAILABLE')
      Object.assign(source, { parser: input.parser, parsedText: input.parsedText })
    } else {
      const decoder = BUILTIN_TYPED_INSPECTION_DECODERS[input.contentMimeType]
      if (!decoder) fail('MATERIALS_CARRIER_UNAVAILABLE')
      try { decoder.validate({ bytes: input.bytes }) } catch (cause) { fail('MATERIALS_BYTES_INVALID', cause) }
      if (typeof input.path !== 'string' || realpathSync(input.path) !== input.path || !readFileSync(input.path).equals(input.bytes)) fail('MATERIALS_PATH_INVALID')
      source.path = mapPath(input.path)
    }
    sources.push(source)
  }
  if (sources.length) {
    const prepared = buildTypedInspectionNativeInputs({ authorizationId, manifestDigest: `sha256:${snapshotDigest}`,
      sources: sources.sort((a, b) => a.sourceRefId.localeCompare(b.sourceRefId)), adapters })
    nativeInputs.push(...prepared.nativeInputs)
    receipts.push(...prepared.inspectionInputReceiptDraft.sources.map(source => ({ inputRef: source.sourceRefId,
      sha256: source.sha256, carrier: source.carrier === 'LOCAL_IMAGE' ? 'native-image' : source.carrier === 'LOCAL_AUDIO' ? 'native-audio' : 'parsed-text', delivery: 'DELIVERED' })))
  }
  return { nativeInputs, inputReceipts: receipts }
}
