import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SkillExecutionStore, SkillEffects } from '../skill-execution-store.mjs'
import { skillHash } from '../skill-executor.mjs'
const command = { executionId: 'pwe_1', snapshotDigest: 'a'.repeat(64), inputRefs: ['input_1'] }
const descriptor = { manifest: { outputs: { dataSchema: null, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: true } } }
const setup = t => {
  const rootDirectory = mkdtempSync(resolve(tmpdir(), 'skill-store-')); t.after(() => rmSync(rootDirectory, { recursive: true, force: true }))
  const options = { rootDirectory, scope: { ownerJiacn: 'owner', agentId: 'agent', tenantId: 'tenant', clientId: 'client' }, command }
  return { options, store: new SkillExecutionStore(options) }
}
const effect = (store, overrides = {}) => new SkillEffects({ store, bindingRevision: '1', checkLease() {},
  start: async () => ({ schemaVersion: 1, disposition: 'NEW', status: 'START_RECORDED', providerRequestId: null, resultDigest: null }),
  report: async () => {}, ...overrides })
test('result bytes and immutable manifest persist across reconstruction; mismatch/empty fake files rejected', t => {
  const { store, options } = setup(t)
  const bytes = Buffer.from('实际文本内容')
  const result = { data: {}, artifacts: [{ outputId: 'output_1', contentMimeType: 'text/plain', bytes }], inputReceipts: [] }
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
  const effects = effect(store, { report: async (_id, body) => { assert.equal(body.status, 'SUCCEEDED'); assert.ok(store.read('effect-generate-5f5') === null) } })
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
  const recovered = await effect(new SkillExecutionStore(options), { start: async () => { throw new Error('MUST_NOT_START') }, report: async () => { reports++ } }).invoke('generate', { prompt: 'x' }, invoke)
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
