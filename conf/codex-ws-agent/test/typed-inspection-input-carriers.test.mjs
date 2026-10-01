import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildTypedInspectionNativeInputs, finalizeTypedInspectionInputReceipt, TypedInspectionInputCarrierError } from '../typed-inspection-input-carriers.mjs'

const fixturePath = process.env.CYF_TYPED_INSPECTION_DIGEST_FIXTURE
  || resolve(import.meta.dirname, '../../../../sdd/specs/juyiting-multimedia-deliberation/fixtures/typed-inspection-input-digests-v1.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const code = expected => error => error instanceof TypedInspectionInputCarrierError && error.code === expected
const adapters = {
  localImage: { supportedMimeTypes: ['image/png'], toNativeInput: ({ path }) => ({ type: 'localImage', path }) },
  localAudio: { supportedMimeTypes: ['audio/wav'], toNativeInput: ({ path }) => ({ type: 'localAudio', path }) }
}
const materializedSource = (vector, path = null) => ({
  sourceRefId: vector.contributionPreimage.sourceRefId, sha256: vector.contributionPreimage.sha256,
  byteLength: vector.contributionPreimage.byteLength, mimeType: vector.contributionPreimage.mimeType,
  carrier: vector.contributionPreimage.carrier, carrierContractDigest: vector.contributionPreimage.carrierContractDigest,
  bytes: Buffer.from(vector.sourceContentUtf8Fixture, 'utf8'),
  ...(path === null ? {} : { path }),
  ...(vector.contributionPreimage.carrier === 'PARSED_TEXT' ? {
    parser: { parserConfigDigest: vector.contributionPreimage.parserConfigDigest, sourceByteDigest: vector.contributionPreimage.sourceByteDigest,
      extractedTextDigest: vector.contributionPreimage.extractedTextDigest }, parsedText: vector.extractedText
  } : {})
})
const sources = () => fixture.vectors.map((vector, index) => materializedSource(vector, index === 1 ? '/private/input-2.png' : index === 2 ? '/private/input-3.wav' : null))
const args = (input = sources(), injectedAdapters = adapters) => ({ authorizationId: fixture.authorizationId, manifestDigest: fixture.manifestDigest, sources: input, adapters: injectedAdapters })

test('shared four-carrier vectors reproduce canonical contribution and input digests without native capability claims', () => {
  const built = buildTypedInspectionNativeInputs(args())
  assert.equal(built.inputDigest, fixture.inputDigest)
  assert.deepEqual(built.inspectionInputReceiptDraft.sources, fixture.vectors.map(vector => vector.receiptSource))
  assert.deepEqual(built.nativeInputs, [
    { type: 'text', text: fixture.vectors[0].nativeText }, { type: 'localImage', path: '/private/input-2.png' },
    { type: 'localAudio', path: '/private/input-3.wav' }, { type: 'text', text: fixture.vectors[3].nativeText }
  ])
  assert.equal(Object.hasOwn(built.inspectionInputReceiptDraft, 'engineThreadId'), false)
  assert.equal(Object.hasOwn(built.inspectionInputReceiptDraft, 'engineTurnId'), false)
})

test('receipt finalizer only appends actual IDs after preparation and preserves the frozen draft', () => {
  const built = buildTypedInspectionNativeInputs(args())
  const receipt = finalizeTypedInspectionInputReceipt({ receiptDraft: built.inspectionInputReceiptDraft, engineThreadId: 'thread-1', engineTurnId: 'turn-1' })
  assert.deepEqual(receipt, { ...built.inspectionInputReceiptDraft, engineThreadId: 'thread-1', engineTurnId: 'turn-1' })
  assert.equal(built.inputDigest, fixture.inputDigest)
  assert.throws(() => finalizeTypedInspectionInputReceipt({ receiptDraft: { ...built.inspectionInputReceiptDraft, schemaVersion: 2 }, engineThreadId: 'thread-1', engineTurnId: 'turn-1' }), code('TYPED_INSPECTION_RECEIPT_INVALID'))
})

test('sourceRefId order is strict, source alias and duplicate injection are rejected rather than reordered', () => {
  const input = sources()
  assert.throws(() => buildTypedInspectionNativeInputs(args([input[1], input[0], ...input.slice(2)])), code('TYPED_INSPECTION_SOURCE_ORDER_INVALID'))
  assert.throws(() => buildTypedInspectionNativeInputs(args([input[0], { ...input[0], sourceRefId: input[0].sourceRefId }, ...input.slice(1)])), code('TYPED_INSPECTION_SOURCE_ORDER_INVALID'))
  const aliased = { ...input[0], sourceRef: input[0].sourceRefId }; delete aliased.sourceRefId
  assert.throws(() => buildTypedInspectionNativeInputs(args([aliased, ...input.slice(1)])), code('TYPED_INSPECTION_SOURCE_INVALID'))
  assert.throws(() => buildTypedInspectionNativeInputs(args([{ ...input[0], carrier: 'UNKNOWN' }, ...input.slice(1)])), code('TYPED_INSPECTION_UNKNOWN_CARRIER'))
})

test('DIRECT_TEXT rejects malformed UTF-8 while retaining BOM and exact untrusted text wrapping', () => {
  const direct = sources()[0]; const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), direct.bytes])
  const bomSource = { ...direct, bytes: bom, sha256: hash(bom), byteLength: String(bom.length) }
  assert.match(buildTypedInspectionNativeInputs(args([bomSource])).nativeInputs[0].text, /^UNTRUSTED INSPECTION MATERIAL \(source_.*\):\n\ufeffbird\r\n$/)
  const malformed = Buffer.from([0xc3, 0x28])
  assert.throws(() => buildTypedInspectionNativeInputs(args([{ ...direct, bytes: malformed, sha256: hash(malformed), byteLength: '2' }])), code('TYPED_INSPECTION_DIRECT_TEXT_INVALID_UTF8'))
})

test('PARSED_TEXT requires explicit scalar parser provenance and LOCAL adapters preserve exact native type and opaque path', () => {
  const input = sources(); const parsed = input[3]
  assert.throws(() => buildTypedInspectionNativeInputs(args([...input.slice(0, 3), { ...parsed, parsedText: '\ud800' }])), code('TYPED_INSPECTION_PARSED_TEXT_PROVENANCE_INVALID'))
  assert.throws(() => buildTypedInspectionNativeInputs(args([...input.slice(0, 3), { ...parsed, parser: { ...parsed.parser, extra: true } }])), code('TYPED_INSPECTION_PARSED_TEXT_PROVENANCE_INVALID'))
  const badType = { ...adapters, localImage: { ...adapters.localImage, toNativeInput: ({ path }) => ({ type: 'text', path }) } }
  assert.throws(() => buildTypedInspectionNativeInputs(args(input, badType)), code('TYPED_INSPECTION_LOCAL_IMAGE_UNSUPPORTED'))
  const badPath = { ...adapters, localAudio: { ...adapters.localAudio, toNativeInput: () => ({ type: 'localAudio', path: '/other' }) } }
  assert.throws(() => buildTypedInspectionNativeInputs(args(input, badPath)), code('TYPED_INSPECTION_LOCAL_AUDIO_UNSUPPORTED'))
  assert.throws(() => buildTypedInspectionNativeInputs(args(input, {})), code('TYPED_INSPECTION_LOCAL_IMAGE_UNSUPPORTED'))
})
