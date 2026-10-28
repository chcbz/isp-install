import test from 'node:test'
import assert from 'node:assert/strict'
import { SkillBindings, parseSkillBindings } from '../skill-bindings.mjs'
import { buildMaterialsInputs } from '../materials-input.mjs'
import { SkillEffects, SkillExecutionStore } from '../skill-execution-store.mjs'
import { ImageMagick, MagickFormat, MagickColors } from '@imagemagick/magick-wasm'
import { skillHash } from '../skill-executor.mjs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
const scope = { tenantId: 't', clientId: 'c', ownerJiacn: 'o', agentId: 'a' }
const configuration = () => ({ schemaVersion: 1, providers: { imageDefault: { adapter: 'image-http', endpoint: 'https://images.example.test', model: 'gpt-image-1', credentialEnv: 'IMAGE_TOKEN', revision: '1' } }, subjects: { a: { providerAliases: { image: 'imageDefault' } } }, costInfoOverrides: {} })
const bindingFixture = () => new SkillBindings({ load: () => configuration(), credentialEnvironment: { IMAGE_TOKEN: 'fixture-not-real-secret' } })
const descriptor = entrypoint => ({ manifest: { entrypoint, requirements: { providerAlias: 'image' }, outputs: { dataSchema: { type: 'object' } } } })
const effect = { invoke: async (_id, _request, fn) => fn() }
const material = (text, mime = 'text/plain') => { const bytes = Buffer.from(text); return { inputRef: 'input_1', contentMimeType: mime, bytes, byteLength: String(bytes.length), sha256: skillHash(bytes) } }
test('one shared bindings config never substitutes another subject or process.env credential', async () => {
  assert.equal(parseSkillBindings(configuration()).providers.imageDefault.revision, '1')
  const bindings = bindingFixture(), result = await bindings.resolve({ scope, alias: 'image' })
  assert.equal(result.ready, true); assert.equal(result.scope, scope)
  assert.equal((await bindings.resolve({ scope: { ...scope, agentId: 'foreign' }, alias: 'image' })).ready, false)
  assert.equal((await new SkillBindings({ load: () => configuration() }).resolve({ scope, alias: 'image' })).ready, false)
  for (const patch of [{ endpoint: 'http://evil.test' }, { endpoint: 'https://images.example.test/v1' }, { credentialEnv: 'RAW=SECRET' }, { token: 'secret' }]) {
    const config = configuration(); Object.assign(config.providers.imageDefault, patch); assert.throws(() => parseSkillBindings(config), /INVALID/)
  }
})
test('fee metadata changes do not alter binding digest/revision; no approval or charge step', async () => {
  const config = configuration(); const bindings = new SkillBindings({ load: () => config, credentialEnvironment: { IMAGE_TOKEN: 'fixture' } })
  const first = await bindings.resolve({ scope, alias: 'image' }); config.costInfoOverrides['image-edit@1.0.0'] = { amount: '9999' }
  const next = await bindings.resolve({ scope, alias: 'image' }); assert.equal(first.digest, next.digest); assert.equal(first.revision, next.revision)
})
test('shared costInfoOverrides accepts revisioned skill/version/binding metadata without changing readiness or binding digest', async () => {
  const config = configuration(), bindings = new SkillBindings({ load: () => config, credentialEnvironment: { IMAGE_TOKEN: 'fixture' } })
  const first = await bindings.resolve({ scope, alias: 'image' })
  config.costInfoOverrides['image-edit@1.0.0#imageDefault'] = { mode: 'METERED', amount: '1.25', currency: 'USD', unit: 'image', description: 'display only', source: 'operator', updatedAt: '2026-10-13T23:45:00+08:00', informationRevision: '7' }
  assert.equal(parseSkillBindings(config).costInfoOverrides['image-edit@1.0.0#imageDefault'].informationRevision, '7')
  for (const override of [config.costInfoOverrides['image-edit@1.0.0#imageDefault'], { informationRevision: '-1', mode: 'INVALID' }, null]) {
    config.costInfoOverrides['image-edit@1.0.0#imageDefault'] = override
    const next = await bindings.resolve({ scope, alias: 'image' }); assert.equal(next.ready, true); assert.equal(next.digest, first.digest); assert.equal(next.revision, first.revision)
  }
})


test('skill native carrier structurally decodes genuine PNG/WAV bytes and rejects forged media before model delivery', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'skill-material-bytes-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/mixed-material-api-wire-v3.json', import.meta.url)))
  const sources = fixture.inspection.payload.contextSnapshot.facts.typedInspection.manifest.sources
  for (const mimeType of ['image/png', 'audio/wav']) {
    const source = sources.find(source => source.mimeType === mimeType), bytes = Buffer.from(fixture.materials.find(item => item.sourceRefId === source.sourceRefId).bytesBase64, 'base64')
    const input = material(bytes, mimeType); input.path = resolve(root, mimeType.replace('/', '-')); writeFileSync(input.path, bytes, { mode: 0o400 })
    const config = { mediaKind: source.mediaKind, mimeType, carrier: source.carrier, carrierContractDigest: source.carrierContractDigest }
    const adapters = { localImage: { supportedMimeTypes: ['image/png'], toNativeInput: ({ path }) => ({ type: 'localImage', path }) },
      localAudio: { supportedMimeTypes: ['audio/wav'], toNativeInput: ({ path }) => ({ type: 'localAudio', path }) } }
    const request = { inputs: [input], supportedInputs: [config], adapters, authorizationId: 'pwe_1', snapshotDigest: 'b'.repeat(64) }
    const prepared = buildMaterialsInputs(request); assert.equal(prepared.nativeInputs.length, 1); assert.equal(prepared.inputReceipts[0].delivery, 'DELIVERED')
    const forged = material('not real image/audio bytes', mimeType); forged.path = input.path
    assert.throws(() => buildMaterialsInputs({ ...request, inputs: [forged] }), error => mimeType.startsWith('image/') ? ['IMAGE_FORMAT_UNSUPPORTED','IMAGE_MIME_MISMATCH','IMAGE_DECODE_FAILED'].includes(error.code) : error.code === 'MATERIALS_BYTES_INVALID' && error.cause.code.includes('DECODER_REJECTED'))
  }
})


test('missing/malformed price container never removes valid provider binding readiness', async () => {
  const config = configuration(), bindings = new SkillBindings({ load: () => config, credentialEnvironment: { IMAGE_TOKEN: 'fixture' } })
  const first = await bindings.resolve({ scope, alias: 'image' })
  for (const value of [undefined, null, 'malformed', [], 1]) {
    if (value === undefined) delete config.costInfoOverrides; else config.costInfoOverrides = value
    assert.deepEqual(parseSkillBindings(config).costInfoOverrides, {})
    const result = await bindings.resolve({ scope, alias: 'image' })
    assert.equal(result.ready, true); assert.equal(result.digest, first.digest); assert.equal(result.revision, first.revision)
  }
})
