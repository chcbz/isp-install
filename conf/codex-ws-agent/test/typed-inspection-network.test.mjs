import test from 'node:test'
import assert from 'node:assert/strict'
import { RestrictedProviderEgress, restrictedProviderNetworkPolicy, verifyRestrictedNftReadback } from '../typed-inspection-network.mjs'

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

test('restricted provider policy binds one exact HTTPS authority and explicit transport timeout', () => {
  assert.deepEqual(restrictedProviderNetworkPolicy('https://provider.example:8443/v1', { connectTimeoutMs: 250 }), {
    schemaVersion: 1, providerOrigin: 'https://provider.example:8443', providerAuthority: 'provider.example:8443',
    transport: 'fixed-connect-proxy-v1', connectTimeoutMs: '250', namespace: 'private-slirp4netns-v1', directEgress: 'nft-default-drop-readback-v1',
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
  assert.throws(() => verifyRestrictedNftReadback(readback.replace('oifname "lo" accept', 'oifname "lo" accept\n  tcp dport 46212 accept'), 46211, 46212), error => error.code === 'TYPED_INSPECTION_EGRESS_NFT_READBACK_MISMATCH')
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
