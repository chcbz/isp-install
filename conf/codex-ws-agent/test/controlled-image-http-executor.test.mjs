import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ControlledImageHttpExecutor } from '../controlled-image-http-executor.mjs'
import { ControlledImageHttpLedger } from '../controlled-image-http-ledger.mjs'

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(32, 3)])
const jpeg = Buffer.concat([Buffer.from([255,216,255]), Buffer.alloc(32, 4)])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const config = root => Object.freeze({ enabled: true, endpoint: 'https://images.example.test', apiKeyEnv: 'IMAGE_KEY',
  modelId: 'operator-model', bindingId: 'binding-1', bindingEpoch: '1', maxInputItems: 16,
  maxOutboundRequestAttempts: 1, precallFenceVersion: 1, ledgerRoot: resolve(root, 'ledger'),
  providerLane: 'CONTROLLED_IMAGE_HTTP_V1' })
const command = id => Object.freeze({ taskId: 'task-1', runId: 'run-1', commandId: id,
  instruction: '生成一幅山水画', outputId: 'output_1', outputContentMimeType: 'image/png' })
const response = (url, payload = { data: [{ b64_json: png.toString('base64') }] }, status = 200) => ({
  status, redirected: false, url: url.href, headers: { get: key => key === 'content-type' ? 'application/json' : null },
  json: async () => payload
})
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-executor-test-'))
  const runDirectory = resolve(root, 'run')
  for (const part of ['inputs', 'outputs', 'scratch']) mkdirSync(resolve(runDirectory, part), { recursive: true, mode: 0o700 })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ledger = new ControlledImageHttpLedger({ rootDir: resolve(root, 'ledger'), profileId: 'profile-a', agentId: 'agent-a' })
  return { root, runDirectory, ledger }
}
const make = (f, fetchFn) => new ControlledImageHttpExecutor({ profile: { profileId: 'profile-a', agentId: 'agent-a' },
  config: config(f.root), credential: 'provider-secret', fetchFn, ledger: f.ledger })

test('no-reference generation durably claims before one exact JSON request and accepts one canonical PNG', async t => {
  const f = fixture(t)
  let calls = 0
  const executor = make(f, async (url, options) => {
    calls++
    const claimFiles = []
    const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name); if (entry.isDirectory()) walk(child); else claimFiles.push(child)
    } }
    walk(resolve(f.root, 'ledger'))
    assert.equal(claimFiles.some(path => path.endsWith('.json')), true)
    assert.equal(url.href, 'https://images.example.test/v1/images/generations')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer provider-secret')
    const body = JSON.parse(options.body)
    assert.deepEqual(body, { model: 'operator-model', prompt: '生成一幅山水画', n: 1, output_format: 'png' })
    assert.equal('response_format' in body, false)
    return response(url)
  })
  const output = await executor.execute({ command: command('command-1'), runDirectory: f.runDirectory, inputs: [] })
  assert.equal(calls, 1)
  assert.deepEqual(output, { outputId: 'output_1', contentType: 'image/png', bytes: png })
})

test('restart, second executor, and concurrent calls never issue a second Provider request', async t => {
  const f = fixture(t)
  let calls = 0
  let release
  const pending = new Promise(resolvePromise => { release = resolvePromise })
  const fetchFn = async url => { calls++; await pending; return response(url) }
  const first = make(f, fetchFn)
  const second = make(f, fetchFn)
  const running = first.execute({ command: command('command-2'), runDirectory: f.runDirectory, inputs: [] })
  await assert.rejects(second.execute({ command: command('command-2'), runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  release()
  await running
  const restartedLedger = new ControlledImageHttpLedger({ rootDir: resolve(f.root, 'ledger'), profileId: 'profile-a', agentId: 'agent-a' })
  const restarted = new ControlledImageHttpExecutor({ profile: { profileId: 'profile-a', agentId: 'agent-a' },
    config: config(f.root), credential: 'provider-secret', fetchFn, ledger: restartedLedger })
  await assert.rejects(restarted.execute({ command: command('command-2'), runDirectory: f.runDirectory, inputs: [] }),
    error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  assert.equal(calls, 1)
})

test('network unknown, redirect, 429, URL output, invalid base64, and multiple results retain claim without retry', async t => {
  const f = fixture(t)
  const cases = [
    async () => { throw new Error('socket lost') },
    async url => ({ ...response(url), redirected: true }),
    async url => response(url, { error: 'rate limited' }, 429),
    async url => response(url, { data: [{ url: 'https://remote.example/output.png' }] }),
    async url => response(url, { data: [{ b64_json: 'not base64!' }] }),
    async url => response(url, { data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] })
  ]
  for (let index = 0; index < cases.length; index++) {
    let calls = 0
    const executor = make(f, async (...args) => { calls++; return cases[index](...args) })
    const selected = command(`failure-${index}`)
    await assert.rejects(executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] }))
    await assert.rejects(executor.execute({ command: selected, runDirectory: f.runDirectory, inputs: [] }),
      error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
    assert.equal(calls, 1)
  }
})

test('reference edits send up to 16 verified data URLs in one JSON request without file IDs or external URLs', async t => {
  const f = fixture(t)
  let calls = 0
  const executor = make(f, async (url, options) => {
    calls++
    assert.equal(url.href, 'https://images.example.test/v1/images/edits')
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'operator-model')
    assert.equal(body.n, 1)
    assert.equal(body.output_format, 'png')
    assert.equal('response_format' in body, false)
    assert.equal(body.images.length, 16)
    assert.ok(body.images.every(item => Object.keys(item).join(',') === 'image_url'
      && /^data:image\/(?:png|jpeg);base64,/.test(item.image_url)))
    assert.equal(JSON.stringify(body).includes('file_id'), false)
    assert.equal(JSON.stringify(body).includes('https://'), false)
    return response(url)
  })
  const inputs = []
  for (let index = 0; index < 16; index++) {
    const bytes = index % 2 ? jpeg : png
    const ext = index % 2 ? 'jpg' : 'png'
    const path = resolve(f.runDirectory, `inputs/input_${index + 1}.${ext}`)
    writeFileSync(path, bytes, { mode: 0o600 })
    inputs.push({ relativePath: `inputs/input_${index + 1}.${ext}`,
      contentType: index % 2 ? 'image/jpeg' : 'image/png', byteLength: bytes.length, sha256: sha(bytes) })
  }
  const output = await executor.execute({ command: command('edit-16'), runDirectory: f.runDirectory, inputs })
  assert.deepEqual(output.bytes, png)
  assert.equal(calls, 1)
  await assert.rejects(executor.execute({ command: command('edit-17'), runDirectory: f.runDirectory,
    inputs: [...inputs, inputs[0]] }), error => error.code === 'CONTROLLED_IMAGE_COMMAND_INVALID')
  const misconfigured = new ControlledImageHttpExecutor({
    profile: { profileId: 'profile-a', agentId: 'agent-a' },
    config: { ...config(f.root), maxInputItems: 32 }, credential: 'provider-secret',
    fetchFn: async () => { calls++; throw new Error('must not fetch') }, ledger: f.ledger
  })
  await assert.rejects(misconfigured.execute({ command: command('edit-hard-limit'), runDirectory: f.runDirectory,
    inputs: [...inputs, inputs[0]] }), error => error.code === 'CONTROLLED_IMAGE_COMMAND_INVALID')
  assert.equal(calls, 1)
})

test('symlinked or MIME-mismatched references fail before claim and before Provider fetch', async t => {
  const f = fixture(t)
  let calls = 0
  const executor = make(f, async () => { calls++; throw new Error('must not fetch') })
  const external = resolve(f.root, 'external.png')
  writeFileSync(external, png, { mode: 0o600 })
  const linked = resolve(f.runDirectory, 'inputs/input_1.png')
  symlinkSync(external, linked)
  const metadata = [{ relativePath: 'inputs/input_1.png', contentType: 'image/png',
    byteLength: png.length, sha256: sha(png) }]
  await assert.rejects(executor.execute({ command: command('symlink-input'), runDirectory: f.runDirectory,
    inputs: metadata }), error => error.code === 'CONTROLLED_IMAGE_INPUT_INVALID')
  assert.equal(calls, 0)
  assert.equal(readdirSync(resolve(f.root, 'ledger'), { recursive: true })
    .some(value => String(value).endsWith('.json')), false)

  rmSync(linked)
  writeFileSync(linked, jpeg, { mode: 0o600 })
  await assert.rejects(executor.execute({ command: command('mime-input'), runDirectory: f.runDirectory,
    inputs: [{ ...metadata[0], byteLength: jpeg.length, sha256: sha(jpeg) }] }),
  error => error.code === 'CONTROLLED_IMAGE_INPUT_INVALID')
  assert.equal(calls, 0)
})
