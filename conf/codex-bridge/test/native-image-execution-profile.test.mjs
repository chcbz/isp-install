// Opt-in integration fixture: real profile/app-server/CONNECT, synthetic HTTPS
// image provider and synthetic CA/key. No model turn, paid call or API commit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { measureMinimalNativeExecutionToolchain } from '../native-execution-profile.mjs'
import { skillPackageTreeDigest } from '../skill-manifest.mjs'
import { snapshotNativeArtifact } from '../native-artifact-snapshot.mjs'

const enabled = process.env.CYF_NATIVE_IMAGE_PROFILE_PROBE === '1'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmNgAAIAAAUAAQYUdaMAAAAASUVORK5CYII=', 'base64')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const mkdir = path => { mkdirSync(path, { mode: 0o700 }); return path }

test('real app-server runs native-image against synthetic HTTPS via restricted CONNECT and snapshots drafts', { skip: !enabled }, async () => {
  console.log(`probe uid=${process.getuid()}; Node executable=${process.execPath}; separate production toolchain attestation required`)
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-native-image-profile-'))
  const execution = mkdir(resolve(root, 'execution'))
  const inputs = mkdir(resolve(execution, 'inputs')), scratch = mkdir(resolve(execution, 'scratch')), drafts = mkdir(resolve(execution, 'drafts'))
  const snapshots = mkdir(resolve(execution, 'snapshots')), stateRoot = mkdir(resolve(root, 'state')), sourceHome = mkdir(resolve(root, 'home'))
  const materializerRoot = mkdir(resolve(root, 'materializer'))
  writeFileSync(resolve(sourceHome, 'auth.json'), '{"OPENAI_API_KEY":"nonfunctional-isolation-fixture"}', { mode: 0o600 })
  writeFileSync(resolve(inputs, 'reference.png'), png, { mode: 0o600 })
  const cert = resolve(root, 'cert.pem'), key = resolve(root, 'key.pem')
  const openssl = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  assert.equal(openssl.status, 0, 'fixture certificate generation failed')
  const calls = [], sockets = new Set(); let tlsProbes = 0
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.method === 'GET' && req.url === '/fixture-tls') { tlsProbes++; res.writeHead(200); res.end('fixture-tls-ok'); return }
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk }); req.on('end', () => {
      try {
        const data = JSON.parse(body)
        calls.push({ path: req.url, authorized: req.headers.authorization === 'Bearer fixture-only-key', model: data.model, hasImage: Array.isArray(data.images) && data.images[0]?.image_url?.startsWith('data:image/png;base64,') })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
      } catch { res.writeHead(400); res.end() }
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  let runtime
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '::', done) })
    const origin = `https://localhost:${server.address().port}`
    const packageRoot = realpathSync(fileURLToPath(new URL('../../skills/native-image/', import.meta.url)))
    const nativeToolchain = measureMinimalNativeExecutionToolchain({ nodeBin: process.execPath })
    runtime = new TypedInspectionProfileRuntime({ profile: { profileId: 'native-image-probe', agentId: 'native-image-probe-agent', codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: sourceHome,
      typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionProviderId: 'isolation-probe', typedInspectionProviderBaseUrl: 'https://provider.invalid/v1', typedInspectionNetworkConnectTimeoutMs: 10000 }, materializerRoot, stateRoot, nativeToolchain })
    // Test-only CA fixture: production's root-owned source validation is not
    // measured here. Preserve actual read-only staging/mount/readback checks.
    const trust = runtime.providerCaTrust
    chmodSync(trust.path, 0o600); writeFileSync(trust.path, readFileSync(cert)); chmodSync(trust.path, 0o400)
    const st = lstatSync(trust.path, { bigint: true })
    runtime.providerCaTrust = Object.freeze({ ...trust, sha256: `sha256:${digest(readFileSync(cert))}`, dev: String(st.dev), ino: String(st.ino), size: String(st.size) })
    const binding = { schemaVersion: 1, requestKey: 'native-image-probe', authorizationId: 'auth-1', manifestDigest: 'manifest-1', requestId: 'req-1', turnId: 'turn-1', inputPolicyDigest: 'policy-1' }
    const nativeExecution = { executionId: 'exec-image-probe', tools: [], networkAccess: true, checkActive() {}, async callTool() { assert.fail('no model tool call expected') } }
    const adapter = await runtime.openNativeExecutionAdapter(inputs, binding.requestKey, binding, { inputDirectory: inputs, scratchDirectory: scratch, draftsDirectory: drafts, stateRoot, sourceHome, toolchain: nativeToolchain,
      skills: [{ skillKey: 'native-image', packageRoot, packageTreeDigest: skillPackageTreeDigest(packageRoot) }], nativeExecution,
      skillConfiguration: [{ skillKey: 'native-image', configuration: { endpoint: origin, model: 'fixture-model', apiKey: 'fixture-only-key' }, networkOrigins: [origin] }] })
    const isolation = adapter.nativeExecutionIsolation
    assert.equal(isolation.network.measured, true); assert.equal(isolation.network.nftDefaultDropReadback, true); assert.equal(isolation.network.directInternetBlocked, true)
    assert.equal(adapter.readback.providerCaTrust.mountReadOnly, true)
    const script = '/state/codex-home/skills/native-image/scripts/image.mjs'
    const policy = { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true }
    const exec = async (label, command, extra = {}) => {
      const start = Date.now()
      const response = await adapter.request('command/exec', { command, cwd: '/execution', sandboxPolicy: policy, ...extra }, 120000)
      console.log(`stage=${label} elapsedMs=${Date.now() - start} exit=${response.exitCode} stdout=${JSON.stringify(response.stdout)} stderr=${JSON.stringify(response.stderr)} providerRequests=${calls.length} tlsProbes=${tlsProbes}`)
      return response
    }
    // Measure omitted/default timeout separately from explicit fixture timeout.
    const plain = await exec('node-default', ['/usr/bin/node', '-e', "console.log('node-ok')"])
    assert.equal(plain.exitCode, 0)
    const moduleCommand = ['/usr/bin/node', '--input-type=module', '-e', `await import('${script}'); console.log('module-ok')`]
    const defaultModule = await exec('module-default', moduleCommand)
    const longModule = await exec('module-long', moduleCommand, { timeoutMs: 90000 })
    assert.equal(longModule.exitCode, 0)
    console.log(`module-default-completed=${defaultModule.exitCode === 0}; no inference about timeout cause without elapsed/result evidence`)
    const tlsCode = `import * as h from 'node:http'; import {readFileSync} from 'node:fs'; const c=JSON.parse(readFileSync('/skill-config/native-image.json')); h.setGlobalProxyFromEnv({https_proxy:process.env.HTTPS_PROXY,no_proxy:' '}); const r=await fetch(new URL('/fixture-tls',c.endpoint)); console.log(r.status,await r.text())`
    const tls = await exec('proxy-tls', ['/usr/bin/node', '--input-type=module', '-e', tlsCode], { timeoutMs: 90000 })
    assert.equal(tls.exitCode, 0); assert.equal(tlsProbes, 1); assert.match(tls.stdout, /200 fixture-tls-ok/)
    for (const [op, args] of [['generate', []], ['edit', ['--input', '/inputs/reference.png']]]) {
      const path = `/outputs/${op}.png`
      const response = await exec(op, ['/usr/bin/node', script, op, '--prompt', 'fixture', ...args, '--output', path], { timeoutMs: 90000 })
      assert.equal(response.exitCode, 0, `${op} command/exec exit=${response.exitCode}; synthetic provider requests=${calls.length}; stderr=${response.stderr}`); assert.equal(response.stdout.includes('fixture-only-key'), false); assert.equal(response.stderr.includes('fixture-only-key'), false)
      assert.equal(JSON.parse(response.stdout).path, path)
      const snapshot = snapshotNativeArtifact({ draftsDirectory: drafts, snapshotDirectory: snapshots, path })
      assert.deepEqual(readFileSync(snapshot.path), png); assert.equal(snapshot.sha256, digest(png)); assert.equal(snapshot.byteLength, String(png.length))
    }
    assert.deepEqual(calls.map(c => c.path), ['/v1/images/generations', '/v1/images/edits'])
    assert.ok(calls.every(c => c.authorized && c.model === 'fixture-model')); assert.equal(calls[1].hasImage, true)
    console.log('real app-server command/exec + restricted CONNECT + fixture TLS + generate/edit PNG snapshot: PASS; synthetic provider; model turn/stage/API commit: NOT RUN')
  } finally {
    await runtime?.dispose().catch(() => {})
    for (const socket of sockets) socket.destroy()
    await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true })
  }
})
