// Target-only integration: no model turn, production session, or public writes.
// The synthetic site's CA is trusted only in this fixture's private NSS DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { measureMinimalNativeExecutionToolchain } from '../native-execution-profile.mjs'
import { measureNativeBrowserToolchain } from '../native-browser-toolchain.mjs'
import { skillPackageTreeDigest } from '../skill-manifest.mjs'

const enabled = Boolean(process.env.CYF_NATIVE_BROWSER_PROFILE_PROBE_ROOT)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const mkdir = path => { mkdirSync(path, { mode: 0o700, recursive: true }); return path }
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('real app-server ordinary browser script preserves TLS, origins and read-only engine state', { skip: !enabled }, async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-browser-network-'))
  const inputs = mkdir(resolve(root, 'inputs')), scratch = mkdir(resolve(root, 'scratch')), drafts = mkdir(resolve(root, 'drafts'))
  const stateRoot = mkdir(resolve(root, 'state')), sourceHome = mkdir(resolve(root, 'home'))
  const materializerRoot = mkdir(resolve(root, 'materializer')), scriptsRoot = mkdir(resolve(root, 'scripts'))
  let runtime
  const sockets = new Set(), servers = []
  t.after(async () => {
    await runtime?.dispose()
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(done => server.close(done))))
    rmSync(root, { recursive: true, force: true })
  })
  const cert = resolve(root, 'cert.pem'), key = resolve(root, 'key.pem')
  run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'])
  const database = mkdir(resolve(scratch, 'fixture-home/.local/share/pki/nssdb'))
  run('/usr/bin/certutil', ['-N', '--empty-password', '-d', `sql:${database}`])
  run('/usr/bin/certutil', ['-A', '-d', `sql:${database}`, '-n', 'synthetic-browser-site', '-t', 'C,,', '-i', cert])
  const moduleConfig = resolve(database, 'pkcs11.txt')
  writeFileSync(moduleConfig, readFileSync(moduleConfig, 'utf8').replaceAll(database, '/workspace/fixture-home/.local/share/pki/nssdb'))
  writeFileSync(resolve(inputs, 'readonly.txt'), 'original-input', {mode:0o600})
  const calls = { allowed: [], denied: [] }
  const serve = async handler => {
    const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, handler)
    servers.push(server)
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '::', done) })
    return `https://localhost:${server.address().port}`
  }
  const forbidden = await serve((req, res) => { calls.denied.push(req.url); res.end('must-not-be-reached') })
  const origin = await serve((req, res) => {
    calls.allowed.push(req.url)
    if (req.url === '/redirect') { res.writeHead(302, { location: `${forbidden}/redirect-target` }); res.end(); return }
    if (req.url === '/ok.js') { res.setHeader('content-type', 'application/javascript'); res.end('window.allowedResource = true'); return }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>Authorized fixture</title><input id="name"><button onclick="document.querySelector('output').textContent=document.querySelector('#name').value">Apply</button><output></output><script src="/ok.js"></script><script src="${forbidden}/denied.js"></script>`)
  })
  for (const name of ['browser-session.mjs', 'browser-probe.mjs', 'browser-fonts.conf']) copyFileSync(new URL(`../toolchain/${name}`, import.meta.url), resolve(scriptsRoot, name))
  mkdir(resolve(scriptsRoot, 'browser'))
  copyFileSync(new URL('../toolchain/browser/README.md', import.meta.url), resolve(scriptsRoot, 'browser/README.md'))
  const toolchainRoot = process.env.CYF_NATIVE_BROWSER_PROFILE_PROBE_ROOT
  const base = measureMinimalNativeExecutionToolchain({ nodeBin: process.execPath })
  const nativeToolchain = measureNativeBrowserToolchain({ base, scriptsRoot,
    browserRoot: resolve(toolchainRoot, 'chromium'), playwrightRoot: resolve(toolchainRoot, 'node_modules/playwright-core'), fontsRoot: resolve(toolchainRoot, 'fonts') })
  console.log('diagnostic: browser dependency measurement complete')
  const packageRoot = mkdir(resolve(root, 'browser-fixture'))
  writeFileSync(resolve(packageRoot, 'SKILL.md'), '---\nname: browser-fixture\ndescription: Synthetic browser network test only.\n---\nUse the configured synthetic site.\n', { mode: 0o600 })
  writeFileSync(resolve(sourceHome, 'auth.json'), '{"OPENAI_API_KEY":"nonfunctional-isolation-fixture"}', { mode: 0o600 })
  runtime = new TypedInspectionProfileRuntime({ profile: { profileId: 'native-browser-probe', agentId: 'native-browser-probe-agent', codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: sourceHome,
    typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionProviderId: 'isolation-probe', typedInspectionProviderBaseUrl: 'https://provider.invalid/v1', typedInspectionNetworkConnectTimeoutMs: 10000 }, materializerRoot, stateRoot, nativeToolchain })
  // Existing profile fixture mechanism: trust only this synthetic CA. Do not
  // measure this as production root-owned CA source attestation.
  const trust = runtime.providerCaTrust
  chmodSync(trust.path, 0o600); writeFileSync(trust.path, readFileSync(cert)); chmodSync(trust.path, 0o400)
  const st = lstatSync(trust.path, { bigint: true })
  runtime.providerCaTrust = Object.freeze({ ...trust, sha256: `sha256:${digest(readFileSync(cert))}`, dev: String(st.dev), ino: String(st.ino), size: String(st.size) })
  const binding = { schemaVersion: 1, requestKey: 'browser-network-probe', authorizationId: 'auth-1', manifestDigest: 'manifest-1', requestId: 'req-1', turnId: 'turn-1', inputPolicyDigest: 'policy-1' }
  console.log('diagnostic: opening synthetic app-server')
  const adapter = await runtime.openNativeExecutionAdapter(inputs, binding.requestKey, binding, { inputDirectory: inputs, scratchDirectory: scratch, draftsDirectory: drafts,
    skills: [{ skillKey: 'browser-fixture', packageRoot, packageTreeDigest: skillPackageTreeDigest(packageRoot) }],
    skillConfiguration: [{ skillKey: 'browser-fixture', configuration: { origin }, networkOrigins: [origin] }],
    nativeExecution: { executionId: 'exec-browser-probe', tools: [], networkAccess: true, checkActive() {}, callTool() { assert.fail('no model tool expected') } } })
  assert.equal(adapter.nativeExecutionIsolation.network.directInternetBlocked, true)
  assert.equal(adapter.nativeExecutionIsolation.network.nftDefaultDropReadback, true)
  console.log('diagnostic: isolated app-server ready')
  const code = `import assert from 'node:assert/strict';
import {existsSync,writeFileSync,readdirSync,readFileSync,unlinkSync} from 'node:fs';
console.error('proc mounts:',readFileSync('/proc/self/mountinfo','utf8').split('\\n').filter(line=>line.includes(' /proc ')).join(' | '));
assert.throws(()=>writeFileSync('/state/codex-home/writable-probe','bad'), /EROFS|EACCES|EPERM/);
assert.throws(()=>writeFileSync('/inputs/readonly.txt','changed'), /EROFS|EACCES|EPERM/);
for (const pid of readdirSync('/proc').filter(name=>/^[0-9]+$/.test(name))) {
 const path = '/proc/'+pid+'/root/state/codex-home/proc-alias-write-probe';
 let writable = false;
 try {writeFileSync(path,'synthetic probe'); writable=true; unlinkSync(path)} catch {}
 assert.equal(writable,false,'engine state writable via proc alias '+pid);
}

import {withBrowser} from '/usr/lib/cyf-browser/browser-session.mjs';
process.env.DEBUG = 'pw:browser';
process.env.HOME = '/workspace/fixture-home'; process.env.TMPDIR = '/workspace';
await withBrowser(async ({page}) => {
 const failed = [];
 page.on('requestfailed', request => failed.push(request.url()));
 const response = await page.goto(${JSON.stringify(origin)}, {waitUntil:'load'});
 assert.equal(response.status(),200);
 assert.equal(await page.title(),'Authorized fixture');
 assert.equal(await page.evaluate(() => window.allowedResource),true);
 assert.ok(failed.includes(${JSON.stringify(forbidden + '/denied.js')}));
 await page.locator('#name').fill('浏览器网络核验');
 await page.locator('button').click();
 assert.equal(await page.locator('output').innerText(),'浏览器网络核验');
 await page.screenshot({path:'/outputs/browser-network.png'});
 await assert.rejects(page.goto(${JSON.stringify(forbidden)}), /ERR_TUNNEL_CONNECTION_FAILED/);
 await assert.rejects(page.goto(${JSON.stringify(origin + '/redirect')}), /ERR_TUNNEL_CONNECTION_FAILED/);
});
// Same authorized origin without the fixture CA must still fail TLS.
process.env.HOME = '/workspace/untrusted-home';
await withBrowser(async ({page}) => { await assert.rejects(page.goto(${JSON.stringify(origin)}), /ERR_CERT_AUTHORITY_INVALID/); });
console.log('native-browser-network-ready');`
  // The model-side command still uses the unmodified workspace-write policy.
  const written = await adapter.request('command/exec', {command:['/usr/bin/node', '-e', "require('node:fs').writeFileSync('/workspace/probe.mjs',process.argv[1])", code], cwd:'/execution',
    sandboxPolicy:{type:'workspaceWrite',writableRoots:['/workspace','/outputs'],networkAccess:true,excludeSlashTmp:true,excludeTmpdirEnvVar:true}})
  assert.equal(written.exitCode, 0, written.stderr)
  const logPaths = {stdout:resolve(root,'browser.stdout'),stderr:resolve(root,'browser.stderr')}
  console.log('diagnostic: executing with named filesystem profile (proc writable)')
  const response = await adapter.request('command/exec', { command: ['/usr/bin/node', '/workspace/probe.mjs'], cwd: '/execution', timeoutMs: 120000,
    permissionProfile: 'native-execution' }, 150000)
  writeFileSync(logPaths.stdout, response.stdout || '')
  writeFileSync(logPaths.stderr, response.stderr || '')
  assert.equal(response.exitCode, 0, readFileSync(logPaths.stderr,'utf8'))
  assert.equal(readFileSync(logPaths.stdout,'utf8').trim(), 'native-browser-network-ready')
  assert.equal(readFileSync(resolve(inputs,'readonly.txt'),'utf8'),'original-input')
  assert.deepEqual(calls.denied, [])
  assert.ok(calls.allowed.includes('/ok.js'))
  assert.ok(calls.allowed.includes('/redirect'))
  assert.equal(readFileSync(resolve(drafts, 'browser-network.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  console.log('real app-server + browser + exact-origin CONNECT + TLS + blocked subresources/redirect: PASS; no model or production business execution')
  // Exercise the ordinary shell process tree, not a browser-specific cancellation
  // handler. Only processes carrying this fixture's unique argv are inspected.
  const marker = `cyf-browser-cancel-${process.pid}-${Date.now()}`
  writeFileSync(resolve(scratch, 'cancel-probe.mjs'), `
import { writeFileSync } from 'node:fs';
import { withBrowser } from '/usr/lib/cyf-browser/browser-session.mjs';
await withBrowser(async ({page}) => {
  await page.setContent('<title>Cancellation fixture</title>');
  writeFileSync('/workspace/cancel-ready', 'ready');
  await new Promise(() => {});
});`)
  let settled = false, commandOutcome
  const pending = adapter.request('command/exec', { command: ['/usr/bin/node', '/workspace/cancel-probe.mjs', marker],
    cwd: '/execution', timeoutMs: 120000, permissionProfile: 'native-execution' }, 150000)
    .then(value => { settled = true; commandOutcome = value }, error => { settled = true; commandOutcome = { error: error.message } })
  const waitUntil = async predicate => {
    const deadline = Date.now() + 20000
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'synthetic cancellation fixture timed out')
      await new Promise(done => setTimeout(done, 100))
    }
  }
  await waitUntil(() => {
    assert.equal(settled, false, JSON.stringify(commandOutcome))
    try { return readFileSync(resolve(scratch, 'cancel-ready'), 'utf8') === 'ready' } catch { return false }
  })
  const owned = new Map()
  const snapshot = pid => {
    if (owned.has(pid)) return
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
      owned.set(pid, stat[19]) // original starttime prevents PID-reuse confusion
      for (const child of readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) snapshot(child)
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
  }
  for (const pid of readdirSync('/proc').filter(name => /^[0-9]+$/.test(name))) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(marker)) snapshot(pid) }
    catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error }
  }
  assert.ok(owned.size > 1, 'capture the actual browser descendants, not just a shell')
  await runtime.dispose()
  await pending
  assert.equal(settled, true)
  await waitUntil(() => [...owned].every(([pid, start]) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
      return stat[19] !== start || stat[0] === 'Z'
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return true; throw error }
  }))
  console.log(`ordinary engine disposal stops owned browser process tree: PASS (${owned.size} processes)`)

})
