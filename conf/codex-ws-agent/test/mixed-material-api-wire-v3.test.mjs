// Frozen historical bytes remain audit input; execution is now original CHAT/v4.
// Carrier transfer coverage lives in materials-chat.test.mjs, including all 32
// original PNG/WAV/text/JSON sources, host receipts and durable no-provider replay.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { normalizeInboundMessage, runFastChat, runReadOnlyInspection } from '../agent-client.mjs'
import { canonicalSha256 } from '../chat-runtime.mjs'
import { resolveTypedInspectionRequest } from '../typed-inspection-runtime.mjs'
const raw = readFileSync(new URL('./fixtures/mixed-material-api-wire-v3.json', import.meta.url))
const fixture = JSON.parse(raw), provenance = JSON.parse(readFileSync(new URL('./fixtures/mixed-material-api-wire-v3.provenance.json', import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const profile = { agentId: 'agent' }
test('frozen API v3 wire remains immutable historical source evidence with all 32 actual input hashes', () => {
  assert.equal(hash(raw), provenance.fixtureSha256)
  const inspection = normalizeInboundMessage(JSON.stringify(fixture.inspection)), typed = resolveTypedInspectionRequest(profile, inspection)
  assert.equal(typed.manifest.sources.length, 32); assert.equal(canonicalSha256(typed.manifest), typed.manifestDigest)
  for (const source of typed.manifest.sources) {
    const material = fixture.materials.find(item => item.sourceRefId === source.sourceRefId)
    const bytes = Buffer.from(material.bytesBase64, 'base64'); assert.equal(hash(bytes), source.sha256); assert.equal(String(bytes.length), source.byteLength)
  }
})
test('historical CHAT v3 cannot propose automatic INSPECT or fall back to a new legacy model call', async () => {
  const message = normalizeInboundMessage(JSON.stringify(fixture.chat))
  await assert.rejects(runFastChat(profile, message, { fallback: () => assert.fail('no legacy execution') }), error => error.code === 'ACTION_PROTOCOL_VERSION_INVALID')
})
test('independent INSPECT execution is retired before download/model, even with valid historical authorization', async () => {
  const message = normalizeInboundMessage(JSON.stringify(fixture.inspection))
  await assert.rejects(runReadOnlyInspection(profile, message, { materializer: { materialize: () => assert.fail('no new INSPECT download') },
    adapter: { runTurn: () => assert.fail('no new INSPECT turn') } }), error => error.code === 'INSPECT_ROUTE_RETIRED')
})
test('archived native manifest source/scope corruption is rejected, never silently truncated or rebound', () => {
  for (const mutate of [value => { value.payload.contextSnapshot.facts.typedInspection.manifest.scope.ownerJiacn = 'foreign' },
    value => { value.payload.contextSnapshot.facts.typedInspection.manifest.sources[0].selector.purpose = 'OUTPUT' },
    value => { value.payload.contextSnapshot.facts.typedInspection.manifest.sources.pop() }]) {
    const value = structuredClone(fixture.inspection); mutate(value)
    assert.throws(() => resolveTypedInspectionRequest(profile, normalizeInboundMessage(JSON.stringify(value))))
  }
})
