import test from 'node:test'
import assert from 'node:assert/strict'
import { SkillBindings, parseSkillBindings } from '../skill-bindings.mjs'
import { createImageProviderRunner } from '../skill-runners/image-provider.mjs'
import { createNativeModelRunner } from '../skill-runners/native-model.mjs'
import { buildMaterialsInputs } from '../materials-input.mjs'
import { skillHash } from '../skill-executor.mjs'
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
test('generic image broker reuses exact codec and controlled endpoint without consent', async () => {
  const bindings = bindingFixture(), current = await bindings.resolve({ scope, alias: 'image' }); let calls = 0
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,0])
  const runner = createImageProviderRunner({ bindings, scope, fetchFn: async (url, opts) => {
    calls++; assert.equal(url.href, 'https://images.example.test/v1/images/generations'); assert.equal(opts.redirect, 'error')
    assert.equal(JSON.parse(opts.body).prompt, 'real request'); assert.equal(JSON.parse(opts.body).n, 1)
    return { status: 200, url: url.href, redirected: false, headers: new Headers({ 'content-type': 'application/json', 'x-request-id': 'provider1' }), json: async () => ({ data: [{ b64_json: bytes.toString('base64') }] }) }
  } })
  const result = await runner.run({ descriptor: descriptor('image-http.generate'), binding: current, inputs: [], instruction: 'real request', parameters: {}, effects: effect })
  assert.deepEqual(result.artifacts[0].bytes, bytes); assert.equal(calls, 1)
  assert.equal((await runner.probe({ entrypoint: 'unknown-runner' })).ready, false)
})
test('image edits actually transmit verified reference bytes; real errors/redirects are not faked', async () => {
  const bindings = bindingFixture(), current = await bindings.resolve({ scope, alias: 'image' }); const input = material(Buffer.from([137,80,78,71,13,10,26,10]), 'image/png')
  let calls = 0; const cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
  const runner = createImageProviderRunner({ bindings, scope, fetchFn: async (url, opts) => { calls++; assert.equal(url.pathname, '/v1/images/edits'); assert.match(JSON.parse(opts.body).images[0].image_url, /^data:image\/png;base64,/); throw cause } })
  await assert.rejects(runner.run({ descriptor: descriptor('image-http.edit'), binding: current, inputs: [input], instruction: 'edit', parameters: {}, effects: effect }), error => error === cause)
  assert.equal(calls, 1)
  await assert.rejects(runner.run({ descriptor: descriptor('image-http.edit'), binding: { ...current, revision: '2' }, inputs: [input], instruction: 'edit', parameters: {}, effects: effect }), /BINDING_CHANGED/)
})
test('native text file contains actual model result and can use authorized input material', async () => {
  const input = material('实际资料：甲乙丙')
  const runner = createNativeModelRunner({ probeModel: async () => ({ ready: true, digest: 'a'.repeat(64) }), runModel: async request => {
    const prepared = buildMaterialsInputs({ inputs: request.inputs, authorizationId: 'pwe_1', snapshotDigest: 'b'.repeat(64) })
    assert.match(prepared.nativeInputs[0].text, /实际资料/); assert.match(prepared.nativeInputs[0].text, /UNTRUSTED/)
    return { data: { text: '由实际资料整理的模型正文' }, inputReceipts: prepared.inputReceipts }
  } })
  assert.equal((await runner.probe({ entrypoint: 'native-model.text-file' })).ready, true)
  const result = await runner.run({ descriptor: descriptor('native-model.text-file'), inputs: [input], instruction: '整理', parameters: {}, effects: effect })
  assert.equal(result.artifacts[0].bytes.toString(), '由实际资料整理的模型正文'); assert.equal(result.inputReceipts[0].delivery, 'DELIVERED')
})
test('missing native carrier is unavailable, never imaginary image understanding', () => {
  assert.throws(() => buildMaterialsInputs({ inputs: [material('not an image', 'image/png')] }), /CARRIER_UNAVAILABLE/)
  const bad = material('text'); bad.sha256 = '0'.repeat(64); assert.throws(() => buildMaterialsInputs({ inputs: [bad] }), /BYTES_INVALID/)
})
