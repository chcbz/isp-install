import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ImageMagick, MagickFormat } from '../vendor/magick.mjs'
import { run } from '../scripts/image.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmNgAAIAAAUAAQYUdaMAAAAASUVORK5CYII=', 'base64')
const env = { IMAGE_API_ENDPOINT: 'https://image.example.test', IMAGE_API_MODEL: 'model-a', IMAGE_API_KEY: 'fixture-credential-secret' }
const fixture = t => { const root = mkdtempSync(resolve(tmpdir(), 'native-image-skill-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
const answer = (url, bytes = png, opts = {}) => ({ status: 200, redirected: false, url: url.href, headers: { get: () => 'application/json' }, json: async () => ({ data: [{ b64_json: bytes.toString('base64') }] }), ...opts })
const spy = (bytes = png) => {
  const calls = []
  return { calls, fetchFn: async (url, init) => { calls.push({ url, init }); return answer(url, bytes) } }
}
const gen = output => ['generate', '--prompt', 'a blue bird', '--output', output]

test('generation uses the old protocol and creates a real draft without exposing secrets', async t => {
  const root = fixture(t), p = resolve(root, 'result.png'), mock = spy()
  const out = await run(gen(p), { env, fetchFn: mock.fetchFn })
  assert.deepEqual(readFileSync(p), png); assert.equal(out.path, p); assert.equal(out.byteLength, String(png.length))
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].url.pathname, '/v1/images/generations')
  assert.equal(mock.calls[0].init.redirect, 'error')
  assert.deepEqual(JSON.parse(mock.calls[0].init.body), { model: 'model-a', prompt: 'a blue bird', n: 1, output_format: 'png' })
  assert.equal(JSON.stringify(out).includes(env.IMAGE_API_KEY), false)
})

test('edit decodes actual BMP bytes, uses PNG derivatives and supports selected inputs', async t => {
  const root = fixture(t), input = resolve(root, 'input.bmp'), p = resolve(root, 'edit.png'), mock = spy()
  const bmp = ImageMagick.read(png, image => image.write(MagickFormat.Bmp, bytes => Buffer.from(bytes)))
  writeFileSync(input, bmp)
  await run(['edit', '--prompt', 'red', '--input', input, '--input', input, '--output', p], { env, fetchFn: mock.fetchFn })
  assert.equal(mock.calls[0].url.pathname, '/v1/images/edits')
  const images = JSON.parse(mock.calls[0].init.body).images
  assert.equal(images.length, 2); assert.match(images[0].image_url, /^data:image\/png;base64,/)
  ImageMagick.read(Buffer.from(images[0].image_url.split(',')[1], 'base64'), image => assert.equal(image.width, 1))
  assert.deepEqual(readFileSync(input), bmp)
})

test('sized generation preserves provider output before resizing and local resize is offline', async t => {
  const root = fixture(t), p = resolve(root, 'result.png'), p2 = resolve(root, 'local.png'), mock = spy()
  const out = await run([...gen(p), '--size', '7x5'], { env, fetchFn: mock.fetchFn })
  assert.equal(out.providerImagePath, `${p}.provider.png`); assert.deepEqual(readFileSync(out.providerImagePath), png)
  ImageMagick.read(readFileSync(p), image => { assert.equal(image.width, 7); assert.equal(image.height, 5) })
  await run(['resize', '--input', out.providerImagePath, '--output', p2, '--size', '3x2'], { env: {}, fetchFn: () => { throw Error('must not call') } })
  ImageMagick.read(readFileSync(p2), image => { assert.equal(image.width, 3); assert.equal(image.height, 2) })
  assert.equal(mock.calls.length, 1)
})

test('invalid arguments, configuration and output conflicts never call provider or overwrite files', async t => {
  const root = fixture(t), p = resolve(root, 'existing'), mock = spy(); writeFileSync(p, 'existing')
  for (const argv of [[...gen(resolve(root, 'a')), '--size', '0x5'], ['edit', '--prompt', 'x', '--output', resolve(root, 'b')], [...gen(resolve(root, 'c')), '--key', 'no']])
    await assert.rejects(run(argv, { env, fetchFn: mock.fetchFn }))
  await assert.rejects(run(gen(p), { env, fetchFn: mock.fetchFn }), { code: 'EEXIST' })
  await assert.rejects(run(gen(resolve(root, 'd')), { env: {}, fetchFn: mock.fetchFn }), { code: 'IMAGE_CONFIG_MISSING' })
  await assert.rejects(run(gen(resolve(root, 'e')), { env: { ...env, IMAGE_API_ENDPOINT: 'http://image.example.test' }, fetchFn: mock.fetchFn }), { code: 'IMAGE_CONFIG_INVALID' })
  const link = resolve(root, 'link'); symlinkSync(p, link)
  await assert.rejects(run(gen(link), { env, fetchFn: mock.fetchFn }), { code: 'EEXIST' })
  assert.equal(mock.calls.length, 0); assert.equal(readFileSync(p, 'utf8'), 'existing')
})

test('unknown transport outcome and invalid response perform one request and leave no draft', async t => {
  const root = fixture(t), p = resolve(root, 'unknown'), calls = []
  await assert.rejects(run(gen(p), { env, fetchFn: async () => { calls.push(1); throw new Error(env.IMAGE_API_KEY) } }), { code: 'IMAGE_OUTCOME_UNKNOWN', outcome: 'UNKNOWN' })
  assert.equal(calls.length, 1); assert.equal(existsSync(p), false)
  assert.equal(readFileSync(`${p}.request-started`, 'utf8'), 'REQUEST_STARTED\n')
  await assert.rejects(run(gen(p), { env, fetchFn: async () => { calls.push(1) } }), { code: 'IMAGE_REQUEST_EXISTS' })
  assert.equal(calls.length, 1)
  const p2 = resolve(root, 'invalid-response')
  await assert.rejects(run(gen(p2), { env, fetchFn: async url => { calls.push(1); return answer(url, png, { json: async () => ({ data: [{ url: 'https://bad.test' }] }) }) } }), { code: 'IMAGE_RESPONSE_INVALID', outcome: 'UNKNOWN' })
  assert.equal(calls.length, 2); assert.equal(existsSync(p2), false)
})

test('resize failure keeps the provider bytes without a second request', async t => {
  const root = fixture(t), p = resolve(root, 'out.png'), mock = spy(png.subarray(0, 8))
  await assert.rejects(run([...gen(p), '--size', '2x2'], { env, fetchFn: mock.fetchFn }), { code: 'SKILL_IMAGE_OUTPUT_RESIZE_FAILED', outcome: 'RESPONSE_RECEIVED', providerImagePath: `${p}.provider.png` })
  assert.deepEqual(readFileSync(`${p}.provider.png`), png.subarray(0, 8)); assert.equal(existsSync(p), false); assert.equal(mock.calls.length, 1)
})

test('CLI reports real HTTP status without exposing credential or provider body', async t => {
  const root = fixture(t), p = resolve(root, 'out.png'), secret = 'fixture-credential-secret', seen = []
  const key = resolve(root, 'key.pem'), cert = resolve(root, 'cert.pem')
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  assert.equal(openssl.status, 0)
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => { seen.push(req.headers.authorization); req.resume(); res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: secret })) })
  await new Promise(done => server.listen(0, '::', done)); t.after(() => new Promise(done => server.close(done)))
  const script = fileURLToPath(new URL('../scripts/image.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, ...gen(p)], { env: { ...process.env, ...env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NODE_EXTRA_CA_CERTS: cert, IMAGE_API_ENDPOINT: `https://localhost:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  assert.equal(code, 1); assert.equal(stdout, ''); assert.equal(stderr.includes(secret), false)
  assert.deepEqual(JSON.parse(stderr), { code: 'IMAGE_PROVIDER_REJECTED', message: 'Provider did not return a direct 200 response', outcome: 'UNKNOWN', httpStatus: 429 })
  assert.deepEqual(seen, [`Bearer ${secret}`]); assert.equal(existsSync(p), false)
})


test('private config overrides fallback and missing private config never falls back', async t => {
  const root = fixture(t), config = resolve(root, 'native-image.json'), mock = spy()
  writeFileSync(config, JSON.stringify({ endpoint: 'https://configured.example.test', model: 'configured-model', apiKey: 'configured-private-key' }))
  const out = await run([...gen(resolve(root, 'one.png')), '--config', config], { env, fetchFn: mock.fetchFn })
  assert.equal(mock.calls[0].url.hostname, 'configured.example.test')
  assert.equal(JSON.parse(mock.calls[0].init.body).model, 'configured-model')
  assert.equal(mock.calls[0].init.headers.Authorization, 'Bearer configured-private-key')
  assert.equal(JSON.stringify(out).includes('configured-private-key'), false)
  await run(gen(resolve(root, 'two.png')), { env: { ...env, CYF_SKILL_CONFIG_DIR: root }, fetchFn: mock.fetchFn })
  assert.equal(mock.calls.length, 2)
  await assert.rejects(run(gen(resolve(root, 'three.png')), { env: { ...env, CYF_SKILL_CONFIG_DIR: resolve(root, 'missing') }, fetchFn: mock.fetchFn }), { code: 'IMAGE_CONFIG_MISSING' })
  assert.equal(mock.calls.length, 2)
})

test('CLI uses CONNECT despite NO_PROXY and verifies TLS using configured CA', async t => {
  const root = fixture(t), key = resolve(root, 'key.pem'), cert = resolve(root, 'cert.pem')
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  assert.equal(openssl.status, 0)
  const target = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise(done => target.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => target.close(done)))
  const tunnels = [], sockets = new Set(), proxy = createServer()
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url); sockets.add(client); client.on('close', () => sockets.delete(client))
    const upstream = connect(target.address().port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client) })
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy())
  })
  await new Promise(done => proxy.listen(0, '127.0.0.1', done)); t.after(() => { for (const s of sockets) s.destroy(); return new Promise(done => proxy.close(done)) })
  const config = resolve(root, 'native-image.json')
  writeFileSync(config, JSON.stringify({ endpoint: `https://localhost:${target.address().port}`, model: 'fixture', apiKey: 'private-fixture-key' }))
  const script = fileURLToPath(new URL('../scripts/image.mjs', import.meta.url))
  async function cli(output, trust) {
    const childEnv = { ...process.env, CYF_SKILL_CONFIG_DIR: root, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, HTTP_PROXY: '', https_proxy: '', http_proxy: '', NO_PROXY: 'localhost', no_proxy: 'localhost' }
    delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED; delete childEnv.SSL_CERT_FILE
    if (trust) childEnv.NODE_EXTRA_CA_CERTS = cert; else delete childEnv.NODE_EXTRA_CA_CERTS
    const child = spawn(process.execPath, [script, ...gen(output)], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    return { code, stdout, stderr }
  }
  const success = await cli(resolve(root, 'trusted.png'), true)
  assert.equal(success.code, 0, success.stderr); assert.deepEqual(readFileSync(JSON.parse(success.stdout).path), png)
  assert.equal(success.stdout.includes('private-fixture-key'), false); assert.equal(success.stderr.includes('private-fixture-key'), false)
  const rejected = await cli(resolve(root, 'untrusted.png'), false)
  assert.equal(rejected.code, 1); assert.equal(JSON.parse(rejected.stderr).code, 'IMAGE_OUTCOME_UNKNOWN')
  assert.equal(JSON.parse(rejected.stderr).transportCode, 'DEPTH_ZERO_SELF_SIGNED_CERT')
  assert.equal(existsSync(resolve(root, 'untrusted.png')), false)
  assert.deepEqual(tunnels, [`localhost:${target.address().port}`, `localhost:${target.address().port}`])
})
