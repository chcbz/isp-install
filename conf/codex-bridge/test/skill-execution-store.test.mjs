import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SkillExecutionStore, SkillEffects } from '../skill-execution-store.mjs'
import { skillHash } from '../skill-executor.mjs'
const command = { executionId: 'pwe_1', snapshotDigest: 'a'.repeat(64), inputRefs: [] }
const descriptor = { manifest: { outputs: { dataSchema: null, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: true } } }
const setup = t => {
  const rootDirectory = mkdtempSync(resolve(tmpdir(), 'skill-store-')); t.after(() => rmSync(rootDirectory, { recursive: true, force: true }))
  const options = { rootDirectory, scope: { ownerJiacn: 'owner', agentId: 'agent', tenantId: 'tenant', clientId: 'client' }, command }
  return { options, store: new SkillExecutionStore(options) }
}
const effect = (store, overrides = {}) => new SkillEffects({ store, bindingRevision: '1', checkLease() {},
  start: async () => ({ schemaVersion: 1, disposition: 'NEW', status: 'START_RECORDED', providerRequestId: null, resultDigest: null }),
  report: async (_id, body) => ({ schemaVersion: 1, disposition: 'KNOWN', status: body.status, providerRequestId: body.providerRequestId, resultDigest: body.resultDigest }), ...overrides })
test('result bytes and immutable manifest persist across reconstruction; mismatch/empty fake files rejected', t => {
  const { store, options } = setup(t)
  const bytes = Buffer.from('实际文本内容')
  const result = { data: null, artifacts: [{ outputId: 'output_1', contentMimeType: 'text/plain', bytes }], inputReceipts: [] }
  const manifest = store.persistResult(descriptor, result)
  assert.equal(manifest.result.artifacts[0].sha256, skillHash(bytes))
  assert.deepEqual(new SkillExecutionStore(options).loadResult(), manifest)
  assert.throws(() => store.persistResult(descriptor, { ...result, artifacts: [] }), /ARTIFACTS_INVALID/)
  assert.throws(() => new SkillExecutionStore({ ...options, command: { ...command, snapshotDigest: 'b'.repeat(64) } }), /IDENTITY_CONFLICT/)
  writeFileSync(resolve(store.directory, 'outputs/output_1'), '篡改', { mode: 0o600 })
  assert.throws(() => store.loadResult(), /BYTES_CHANGED/)
})
test('effect START is on disk before request; real result bytes saved before remote report', async t => {
  const { store } = setup(t); let calls = 0
  const effects = effect(store, { report: async (_id, body) => { assert.equal(body.status, 'SUCCEEDED'); assert.ok(store.read('effect-generate-5f5') === null); return { schemaVersion: 1, disposition: 'KNOWN', status: body.status, providerRequestId: body.providerRequestId, resultDigest: body.resultDigest } } })
  const output = await effects.invoke('generate', { prompt: 'x' }, async () => {
    calls++; assert.match(readFileSync(resolve(store.directory, 'effect-generate-' + skillHash('generate').slice(0, 12) + '.json'), 'utf8'), /START_RECORDED/)
    return { bytes: Buffer.from('result'), providerRequestId: 'provider_1' }
  })
  assert.equal(output.bytes.toString(), 'result'); assert.equal(calls, 1)
})
test('report response loss recovers existing result; never repeats provider invocation', async t => {
  const { store, options } = setup(t); let calls = 0, reports = 0
  const invoke = async () => { calls++; return { bytes: Buffer.from('real'), providerRequestId: 'p1' } }
  await assert.rejects(effect(store, { report: async () => { throw new Error('ECONNRESET') } }).invoke('generate', { prompt: 'x' }, invoke), /ECONNRESET/)
  const recovered = await effect(new SkillExecutionStore(options), { start: async () => { throw new Error('MUST_NOT_START') }, report: async (_id, body) => { reports++; return { schemaVersion: 1, disposition: 'KNOWN', status: body.status, providerRequestId: body.providerRequestId, resultDigest: body.resultDigest } } }).invoke('generate', { prompt: 'x' }, invoke)
  assert.equal(recovered.bytes.toString(), 'real'); assert.equal(calls, 1); assert.equal(reports, 1)
})
test('uncertain network effect is UNKNOWN forever until real query, never resent', async t => {
  const { store } = setup(t); let calls = 0
  const invoke = async () => { calls++; throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) }
  await assert.rejects(effect(store).invoke('generate', { prompt: 'x' }, invoke), error => error.code === 'SKILL_RESULT_UNKNOWN' && error.cause.code === 'ECONNRESET')
  await assert.rejects(effect(store, { start: async () => ({ schemaVersion: 1, disposition: 'UNKNOWN' }) }).invoke('generate', { prompt: 'x' }, invoke), /SKILL_RESULT_UNKNOWN/)
  assert.equal(calls, 1)
})
test('lost START reply and competing claimant cannot emit side effects', async t => {
  const { store } = setup(t); let calls = 0
  const invoke = async () => { calls++; return {} }
  await assert.rejects(effect(store, { start: async () => { throw new Error('START_ACK_LOST') } }).invoke('generate', {}, invoke), /START_ACK_LOST/)
  for (const disposition of ['RECORDED', 'KNOWN', 'UNKNOWN']) {
    await assert.rejects(effect(store, { start: async () => ({ schemaVersion: 1, disposition }) }).invoke('generate', {}, invoke), /SKILL_RESULT_UNKNOWN/)
  }
  assert.equal(calls, 0)
})
test('effect request/binding changes do not reuse old effect; symlink/private-mode stores rejected', async t => {
  const { store, options } = setup(t)
  await effect(store).invoke('generate', { prompt: 'x' }, async () => ({}))
  await assert.rejects(effect(store).invoke('generate', { prompt: 'different' }, async () => ({})), /CONFLICT/)
  await assert.rejects(effect(store, { bindingRevision: '2' }).invoke('generate', { prompt: 'x' }, async () => ({})), /CONFLICT/)
  chmodSync(store.directory, 0o755); assert.throws(() => store.read('identity'), /UNSAFE/)
  chmodSync(store.directory, 0o700)
  const linked = resolve(options.rootDirectory, 'alias'); symlinkSync(store.directory, linked)
  assert.throws(() => new SkillExecutionStore({ ...options, rootDirectory: linked }), /UNSAFE/)
})

test('effect result ACK must exactly confirm actual local digest/request id; no second invocation', async t => {
  const { store } = setup(t); let calls = 0
  const invoke = async () => { calls++; return { bytes: Buffer.from('real'), providerRequestId: 'p1' } }
  await assert.rejects(effect(store, { report: async () => ({ schemaVersion: 1, disposition: 'KNOWN', status: 'SUCCEEDED', resultDigest: 'a'.repeat(64), providerRequestId: 'p1' }) }).invoke('generate', {}, invoke), /REPORT_UNCONFIRMED/)
  await effect(store).invoke('generate', {}, invoke); assert.equal(calls, 1)
})
test('resume RECOVER_LOCAL_RESULT cannot start any unrecorded effect', async t => {
  const { store } = setup(t); let starts = 0
  await assert.rejects(effect(store, { mayStart: () => false, start: async () => { starts++ } }).invoke('generate', {}, async () => ({})), /RESULT_UNKNOWN/)
  assert.equal(starts, 0)
})

test('all frozen inputs require exact host-delivered receipts with real matching SHA, not model assertions', t => {
  const { options } = setup(t)
  const store = new SkillExecutionStore({ ...options, command: { ...command, executionId: 'pwe_materials', inputRefs: ['input_1'] } })
  store.write('inputs-snapshot', { inputs: [{ inputRef: 'input_1', sha256: 'a'.repeat(64) }] })
  const result = { data: null, artifacts: [{ outputId: 'output_1', contentMimeType: 'text/plain', bytes: Buffer.from('真实正文') }], inputReceipts: [] }
  assert.throws(() => store.persistResult(descriptor, result), /INPUT_RECEIPT_INVALID/)
  const receipt = { inputRef: 'input_1', sha256: 'a'.repeat(64), carrier: 'native-text', delivery: 'DELIVERED' }
  for (const patch of [{ sha256: 'b'.repeat(64) }, { carrier: 'imaginary-vision' }, { understood: true }, { delivery: 'ASSUMED' }])
    assert.throws(() => store.persistResult(descriptor, { ...result, inputReceipts: [{ ...receipt, ...patch }] }), /INPUT_RECEIPT_INVALID/)
  assert.deepEqual(store.persistResult(descriptor, { ...result, inputReceipts: [receipt] }).result.inputReceipts, [receipt])
})
test('result data is schema-validated JSON, including scalar/array/null without reparsing a string', t => {
  const { options } = setup(t)
  for (const [index, data] of ['actual result string', [1, 'x'], null].entries()) {
    const store = new SkillExecutionStore({ ...options, command: { ...command, executionId: `pwe_data_${index}` } })
    const spec = { manifest: { outputs: { dataSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: ['string', 'array', 'null'] }, mimeTypes: [], multiple: false, artifactsRequired: false } } }
    assert.deepEqual(store.persistResult(spec, { data, artifacts: [], inputReceipts: [] }).result.data, data)
  }
})

test('native inputs stream into immutable files, including empty bytes, and verified cache avoids downloading again', async t => {
  const { options } = setup(t)
  const store = new SkillExecutionStore({ ...options, command: { ...command, executionId: 'native_inputs', executionProtocolVersion: 5, inputRefs: ['input1', 'empty'] } })
  let downloads = 0
  const input = { inputRef: 'input1', sha256: skillHash('original'), byteLength: '8', contentMimeType: 'text/plain' }
  const open = async function * () { downloads++; yield Buffer.from('ori'); yield Buffer.from('ginal') }
  const actual = await store.materializeInput(input, open, () => {})
  assert.equal(readFileSync(actual.path, 'utf8'), 'original'); assert.equal(Object.hasOwn(actual, 'bytes'), false)
  assert.deepEqual(await store.materializeInput(input, open, () => {}), actual); assert.equal(downloads, 1)
  const empty = await store.materializeInput({ ...input, inputRef: 'empty', sha256: skillHash(''), byteLength: '0' }, async function * () {}, () => {})
  assert.equal(readFileSync(empty.path).length, 0)
  chmodSync(actual.path, 0o600); writeFileSync(actual.path, 'modified')
  await assert.rejects(store.materializeInput(input, open, () => {}), /BYTES_CHANGED/)
  assert.equal(downloads, 1)
})
test('interrupted, oversized or corrupt native input downloads never publish partial files', async t => {
  const { options } = setup(t)
  const store = new SkillExecutionStore({ ...options, command: { ...command, executionId: 'native_inputs', executionProtocolVersion: 5, inputRefs: ['input1'] } })
  const input = { inputRef: 'input1', sha256: skillHash('ok'), byteLength: '2' }
  for (const source of [async function * () { yield Buffer.from('o'); throw new Error('connection lost') }, async function * () { yield Buffer.from('oversize') }, async function * () { yield Buffer.from('xx') }]) {
    await assert.rejects(store.materializeInput(input, source, () => {}))
    assert.throws(() => readFileSync(resolve(store.directory, 'inputs/input1')), { code: 'ENOENT' })
  }
  const actual = await store.materializeInput(input, async function * () { yield Buffer.from('ok') }, () => {})
  assert.equal(readFileSync(actual.path, 'utf8'), 'ok')
})
