import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { buildProviderTlsProbe, buildRestrictedNetworkProbe, isolatedSlirpCommand, RestrictedProviderEgress, restrictedProviderNetworkPolicy, verifyRestrictedNftReadback } from '../typed-inspection-network.mjs'

const hostNs = Object.freeze({ dev: '1', ino: '10', link: 'net:[10]' })
const privateNs = Object.freeze({ dev: '1', ino: '20', link: 'net:[20]' })
const wrapperExecutable = Object.freeze({ dev: '8', ino: '9', size: '10', sha256: `sha256:${'a'.repeat(64)}` })
// App-server snapshot identities use bare hex while /proc measurements use the typed prefix.
const sandboxExecutable = Object.freeze({ dev: '8', ino: '19', size: '20', sha256: 'b'.repeat(64) })
const measuredSandboxExecutable = Object.freeze({ ...sandboxExecutable, sha256: `sha256:${sandboxExecutable.sha256}` })
const helperExecutable = Object.freeze({ dev: '8', ino: '29', size: '30', sha256: `sha256:${'c'.repeat(64)}` })

const inspector = ({ wrapperStart = '30', holderStart = '31', holderNamespace = privateNs, foreign = false, duplicateHolder = false } = {}) => {
  const stats = new Map([
    [100, { ppid: 1, startticks: '10' }],
    [200, { ppid: 100, startticks: wrapperStart }],
    [201, { ppid: 200, startticks: holderStart }],
    [202, { ppid: 201, startticks: '32' }],
    [203, { ppid: 200, startticks: '33' }],
    [999, { ppid: 1, startticks: '99' }]
  ])
  const executables = new Map([[200, wrapperExecutable], [201, measuredSandboxExecutable], [202, helperExecutable], [203, measuredSandboxExecutable], [999, helperExecutable]])
  const namespaces = new Map([[100, hostNs], [200, hostNs], [201, holderNamespace], [202, holderNamespace], [203, privateNs], [999, privateNs]])
  const descendants = new Set([200, 201, 202, ...(duplicateHolder ? [203] : [])])
  return {
    currentPid: () => 100,
    stat: pid => stats.get(pid),
    namespace: pid => namespaces.get(pid) || hostNs,
    executable: pid => executables.get(pid) || helperExecutable,
    pids: () => [100, 200, 201, 202, ...(duplicateHolder ? [203] : []), ...(foreign ? [999] : [])],
    descendantOf: (pid, root) => root === 200 && descendants.has(pid),
    stats,
    executables,
    namespaces
  }
}
const egressFor = processInspector => new RestrictedProviderEgress({
  providerBaseUrl: 'https://provider.example', networkConnectTimeoutMs: 250, processInspector,
  spawnFn: () => { throw new Error('network command must not start during owner guard tests') }
})
const child = () => ({ pid: 200, exitCode: null })

test('generated provider TLS probe preserves escaped CRLF and parses as Python before any network execution', () => {
  const probe = buildProviderTlsProbe({ timeoutSeconds: 15, proxyPort: 43210, authority: 'provider.example:443', host: 'provider.example', caPath: '/proc/123/root/trust/ca-bundle.pem' })
  assert.match(probe, /\\r\\nHost:/)
  assert.equal(probe.includes("HTTP/1.1\r\nHost:"), false)
  const parsed = spawnSync('/usr/bin/python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: probe, encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
})

test('restricted provider policy binds one exact HTTPS authority and explicit transport timeout', () => {
  assert.deepEqual(restrictedProviderNetworkPolicy('https://provider.example:8443/v1', { connectTimeoutMs: 250 }), {
    schemaVersion: 1, providerOrigin: 'https://provider.example:8443', providerAuthority: 'provider.example:8443',
    transport: 'fixed-connect-proxy-v1', connectTimeoutMs: '250', namespace: 'private-slirp4netns-v1', slirpMountIsolation: 'unshare-mount-recursive-private-v1', slirpTarget: 'exact-owner-netns-path-v1', directEgress: 'nft-default-drop-readback-v1',
    hostLoopback: 'proxy-port-only', dns: 'proxy-side-only'
  })
  for (const invalid of ['http://provider.example', 'https://u:p@provider.example', 'not-a-url']) {
    assert.throws(() => restrictedProviderNetworkPolicy(invalid, { connectTimeoutMs: 250 }), error => error.code === 'TYPED_INSPECTION_PROVIDER_ORIGIN_REQUIRED')
  }
  assert.throws(() => restrictedProviderNetworkPolicy('https://provider.example'), error => error.code === 'TYPED_INSPECTION_NETWORK_CONNECT_TIMEOUT_REQUIRED')
})

test('nft readback requires default-drop chains and only loopback, established traffic, and the exact proxy port', () => {
  const readback = `table inet cyf_typed_inspection {\n chain input {\n  type filter hook input priority filter; policy drop;\n  ct state established,related accept\n  iifname "lo" accept\n }\n chain output {\n  type filter hook output priority filter; policy drop;\n  ct state established,related accept\n  oifname "lo" accept\n  ip daddr 10.0.2.2 tcp dport 46211 accept\n }\n}\n`
  assert.match(verifyRestrictedNftReadback(readback, 46211, 46212).digest, /^sha256:[a-f0-9]{64}$/)
  assert.throws(() => verifyRestrictedNftReadback(readback.replace('oifname "lo" accept', 'oifname "lo" accept\n  tcp dport 46212 accept'), 46211, 46212), error => error.code === 'TYPED_INSPECTION_EGRESS_NFT_READBACK_MISMATCH' && error.message.includes('46212') && error.message.includes('nft exact readback'))
})

test('network owner binds a direct bwrap child in the host namespace to one immutable private descendant holder', async () => {
  const processInspector = inspector(); const egress = egressFor(processInspector)
  const bound = await egress.bindOwner(child(), wrapperExecutable, sandboxExecutable)
  assert.deepEqual(bound, { rootPid: 200, rootStartticks: '30', pid: 201, startticks: '31', namespace: privateNs })
})

test('network owner rejects a sandbox executable still in the host namespace and ambiguous or foreign private holders before network commands', async () => {
  await assert.rejects(() => egressFor(inspector({ holderNamespace: hostNs })).bindOwner(child(), wrapperExecutable, sandboxExecutable), error => error.code === 'TYPED_INSPECTION_EGRESS_SANDBOX_NAMESPACE_SHARED')
  await assert.rejects(() => egressFor(inspector({ duplicateHolder: true })).bindOwner(child(), wrapperExecutable, sandboxExecutable), error => error.code === 'TYPED_INSPECTION_EGRESS_OWNER_AMBIGUOUS')
  await assert.rejects(() => egressFor(inspector({ foreign: true })).bindOwner(child(), wrapperExecutable, sandboxExecutable), error => error.code === 'TYPED_INSPECTION_EGRESS_NAMESPACE_FOREIGN_PROCESS')
})

test('network owner cancellation replaces an arbitrary bind deadline when no sandbox holder has appeared', async () => {
  const processInspector = inspector(); processInspector.executables.set(201, helperExecutable)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => egressFor(processInspector).bindOwner(child(), wrapperExecutable, sandboxExecutable, { signal: controller.signal }), error => error.code === 'TYPED_INSPECTION_EGRESS_CANCELLED')
})

test('root and holder startticks plus both executable identities are revalidated before any network command', async () => {
  for (const drift of ['root-start', 'holder-start', 'root-executable', 'holder-executable']) {
    const processInspector = inspector(); const egress = egressFor(processInspector); const ownedChild = child()
    await egress.bindOwner(ownedChild, wrapperExecutable, sandboxExecutable)
    if (drift === 'root-start') processInspector.stats.set(200, { ppid: 100, startticks: 'changed' })
    if (drift === 'holder-start') processInspector.stats.set(201, { ppid: 200, startticks: 'changed' })
    if (drift === 'root-executable') processInspector.executables.set(200, helperExecutable)
    if (drift === 'holder-executable') processInspector.executables.set(201, helperExecutable)
    await egress.start()
    try { await assert.rejects(() => egress.attach(), error => error.code === 'TYPED_INSPECTION_EGRESS_OWNER_DRIFT') }
    finally { await egress.dispose() }
  }
})


test('slirp sandbox runs only after recursive private mount isolation and preserves restrictions/ready fd', () => {
  assert.deepEqual(isolatedSlirpCommand('/usr/bin/slirp4netns', 201), {
    executable: '/usr/bin/unshare',
    args: ['--mount', '--propagation', 'private', '--', '/usr/bin/slirp4netns',
      '--configure', '--mtu=65520', '--disable-dns', '--enable-sandbox',
      '--enable-seccomp', '--ready-fd=3', '--netns-type=path', '/proc/201/ns/net', 'tap0']
  })
})

test('mount isolation failure fails closed without a direct-slirp retry', async () => {
  const { EventEmitter } = await import('node:events')
  const calls = []; const egress = egressFor(inspector())
  await egress.bindOwner(child(), wrapperExecutable, sandboxExecutable)
  await egress.start()
  const readback = `table inet cyf_typed_inspection {
 chain input {
  policy drop;
  ct state established,related accept
  iifname "lo" accept
 }
 chain output {
  policy drop;
  ct state established,related accept
  oifname "lo" accept
  ip daddr 10.0.2.2 tcp dport ${egress.port} accept
 }
}`
  egress._nsenter = async () => ({ status: 0, stdout: readback })
  egress.spawnFn = (bin, args, options) => {
    calls.push({ bin, args, options })
    const process = new EventEmitter(); process.exitCode = null
    process.stderr = new EventEmitter(); process.stdio = [null, null, process.stderr, new EventEmitter()]
    process.kill = () => { process.exitCode = 1 }
    queueMicrotask(() => { process.stderr.emit('data', Buffer.from('unshare: mount namespace denied')); process.exitCode = 1; process.emit('exit', 1); process.emit('close', 1) })
    return process
  }
  try {
    await assert.rejects(() => egress.attach(), error => error.code === 'TYPED_INSPECTION_EGRESS_SLIRP_FAILED' && error.message.includes('mount namespace denied'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].bin, '/usr/bin/unshare')
    assert.deepEqual(calls[0].options, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: '' } })
    assert.equal(egress.attestation, null)
  } finally { await egress.dispose() }
})

test('namespace command drains stdout and stderr through close after process exit', async () => {
  const { EventEmitter } = await import('node:events')
  const egress = egressFor(inspector())
  await egress.bindOwner(child(), wrapperExecutable, sandboxExecutable)
  egress.spawnFn = () => {
    const process = new EventEmitter(); process.exitCode = null
    process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.stdin = { end() {} }
    queueMicrotask(() => {
      process.exitCode = 0; process.emit('exit', 0, null)
      process.stdout.emit('data', Buffer.from('complete nft readback'))
      process.stderr.emit('data', Buffer.from('complete local diagnostic'))
      process.emit('close', 0, null)
    })
    return process
  }
  try {
    assert.deepEqual(await egress._nsenter(201, ['/usr/sbin/nft', 'list', 'table', 'inet', 'cyf_typed_inspection']), {
      status: 0, signal: null, stdout: 'complete nft readback', stderr: 'complete local diagnostic'
    })
  } finally { await egress.dispose() }
})

test('owner PID drift while async executable measurement yields fails before namespace command', async () => {
  const processInspector = inspector(); const egress = egressFor(processInspector)
  await egress.bindOwner(child(), wrapperExecutable, sandboxExecutable)
  const executable = processInspector.executable
  processInspector.executable = async pid => {
    if (pid === 201) { await new Promise(resolve => setImmediate(resolve)); processInspector.stats.set(200, { ppid: 100, startticks: 'reused' }) }
    return executable(pid)
  }
  try { await assert.rejects(egress._nsenter(201, ['must-not-run']), error => error.code === 'TYPED_INSPECTION_EGRESS_OWNER_DRIFT') }
  finally { await egress.dispose() }
})

test('cancellation during async owner check never launches namespace command', async () => {
  const processInspector = inspector(); const egress = egressFor(processInspector); const controller = new AbortController()
  await egress.bindOwner(child(), wrapperExecutable, sandboxExecutable)
  const executable = processInspector.executable
  processInspector.executable = async pid => { await new Promise(resolve => setImmediate(resolve)); controller.abort(); return executable(pid) }
  try { await assert.rejects(egress._nsenter(201, ['must-not-run'], { signal: controller.signal }), error => error.code === 'TYPED_INSPECTION_EGRESS_CANCELLED') }
  finally { await egress.dispose() }
})


test('negative probe records socket failure phase and accumulates a fragmented HTTP status line', () => {
  const probe = buildRestrictedNetworkProbe({ timeoutSeconds: 15, proxyPort: 43210, canaryPort: 43211 })
  assert.match(probe, /phase=recv error=/)
  assert.match(probe, /while True:/)
  const parsed = spawnSync('/usr/bin/python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: probe, encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
})

test('skill egress extends only an explicitly configured exact origin set, preserving model-only defaults', () => {
  const local = restrictedProviderNetworkPolicy('https://model.invalid/v1', { connectTimeoutMs: 1000 })
  assert.equal(Object.hasOwn(local, 'additionalOrigins'), false)
  const skill = restrictedProviderNetworkPolicy('https://model.invalid/v1', { connectTimeoutMs: 1000, additionalOrigins: ['https://images.invalid', 'https://images.invalid'] })
  assert.deepEqual(skill.additionalOrigins, ['https://images.invalid'])
  for (const origin of ['http://images.invalid', 'https://images.invalid/secret', 'https://key:secret@images.invalid', '*'])
    assert.throws(() => restrictedProviderNetworkPolicy('https://model.invalid', { connectTimeoutMs: 1000, additionalOrigins: [origin] }), /ORIGINS_INVALID/)
})
test('CONNECT proxy accepts configured skill destination and refuses an unconfigured destination', async () => {
  const { createServer, connect } = await import('node:net')
  const upstream = createServer(socket => socket.end('authorized-synthetic-endpoint'))
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${upstream.address().port}`
  const egress = new RestrictedProviderEgress({ providerBaseUrl: 'https://model.invalid/v1', networkConnectTimeoutMs: 1000, additionalOrigins: [origin] })
  const request = authority => new Promise((resolve, reject) => {
    const socket = connect(egress.port, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    let result = ''; socket.on('data', chunk => { result += chunk.toString() }); socket.on('end', () => { socket.end(); resolve(result) }); socket.on('error', reject)
  })
  try {
    await egress.start()
    assert.match(await request(`127.0.0.1:${upstream.address().port}`), /200 Connection Established[\s\S]*authorized-synthetic-endpoint/)
    assert.match(await request('unconfigured.invalid:443'), /403 Forbidden/)
  } finally { await egress.dispose(); await new Promise(resolve => upstream.close(resolve)) }
})
