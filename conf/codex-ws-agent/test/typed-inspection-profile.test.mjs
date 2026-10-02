import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { canonicalSha256 } from '../chat-runtime.mjs'
import { buildTypedInspectionCodexConfig, buildTypedInspectionNativeAttestation, TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { RestrictedProviderEgress } from '../typed-inspection-network.mjs'

const enabled = process.env.CYF_TYPED_INSPECTION_NATIVE_PROBE === '1'



test('restricted profile explicitly enables Codex system proxy routing without embedding proxy endpoints or credentials', () => {
  const config = buildTypedInspectionCodexConfig({
    typedInspectionProviderId: 'gpt', typedInspectionProviderBaseUrl: 'https://provider.example/v1',
    typedInspectionProviderWireApi: 'responses', typedInspectionProviderNetwork: 'restricted-proxy'
  })
  assert.equal(config.endsWith('[features]\nrespect_system_proxy = true\n'), true)
  assert.match(config, /\[model_providers\."gpt"\]/)
  assert.doesNotMatch(config, /HTTP_PROXY|HTTPS_PROXY|10\.0\.2\.2|bearer|api[_-]?key\s*=/i)
  assert.doesNotMatch(buildTypedInspectionCodexConfig({}), /respect_system_proxy/)
})

test('restricted profile resolves an absolute public CA symlink into private fixed bytes instead of exposing its host target tree', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'typed-inspection-ca-stage-')); chmodSync(root, 0o700)
  const materializerRoot = resolve(root, 'inputs'); const stateRoot = resolve(root, 'state'); const sourceRoot = resolve(root, 'source'); const targetRoot = resolve(root, 'target')
  for (const directory of [materializerRoot, stateRoot, sourceRoot, targetRoot]) { mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700) }
  const target = resolve(targetRoot, 'public-ca.pem'); const link = resolve(sourceRoot, 'ca-bundle.crt')
  const bytes = Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB-public-test-only\n-----END CERTIFICATE-----\n')
  writeFileSync(target, bytes, { mode: 0o444 }); chmodSync(target, 0o444); symlinkSync(target, link)
  const runtime = new TypedInspectionProfileRuntime({
    profile: { profileId: 'ca-stage', agentId: 'ca-stage-agent', codexBin: '/usr/local/bin/codex', codexHome: '/root/.codex',
      typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionProviderBaseUrl: 'https://provider.example/v1', typedInspectionNetworkConnectTimeoutMs: 1000,
      typedInspectionCaBundlePath: link },
    materializerRoot, stateRoot
  })
  try {
    assert.equal(runtime.providerCaTrust.sourcePath, link)
    assert.equal(runtime.providerCaTrust.resolvedSourcePath, target)
    assert.deepEqual(readFileSync(runtime.providerCaTrust.path), bytes)
    assert.equal(statSync(runtime.providerCaTrust.path).mode & 0o777, 0o400)
    assert.equal(runtime.providerCaTrust.path.startsWith(`${stateRoot}/profile-resources/`), true)
    assert.equal(runtime.providerCaTrust.path.startsWith(sourceRoot), false)
  } finally { await runtime.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('provider-restricted initialization fails closed when native config readback does not enable system proxy routing', async () => {
  const runtime = Object.create(TypedInspectionProfileRuntime.prototype)
  const adapter = {
    typedInspectionNetworkMode: 'provider-restricted',
    initialize: async () => ({ processExecutable: { pid: process.pid }, config: { config: { features: { respect_system_proxy: false } } } })
  }
  await assert.rejects(() => runtime._initializeAndSeal(adapter), error => error.code === 'TYPED_INSPECTION_SYSTEM_PROXY_NOT_ENABLED')
})

test('native attestation digest excludes process and filesystem instance telemetry but changes with trusted policy', () => {
  const base = {
    schemaMeasurement: { schemaContractId: 'codex-cli-0.159.2', bundleSha256: 'bundle', binaryIdentityDigest: 'sha256:' + '1'.repeat(64) },
    bwrap: { path: '/usr/bin/bwrap', version: 'bubblewrap 0.8.0', sha256: 'sha256:' + '2'.repeat(64), dev: '1', ino: '2', size: '3' },
    view: { inputVisible: true, hostCanaryHidden: true, sourceHomeHidden: true, credentialPathAbsent: true, curlAbsent: true, networkNamespaceIsolated: true, defaultRouteAbsent: true, networkInterfaces: ['lo'], stateDev: '9', inputDev: '10' },
    isolatedConfigDigest: 'sha256:' + '3'.repeat(64), mcpCatalogCount: 0
  }
  const first = canonicalSha256(buildTypedInspectionNativeAttestation(base))
  const remeasured = canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, bwrap: { ...base.bwrap, dev: '99', ino: '100' }, view: { ...base.view, stateDev: '101', inputDev: '102' } }))
  assert.equal(remeasured, first)
  const network = { schemaVersion: 1, measured: true, policy: { transport: 'fixed-connect-proxy-v1' }, hostCanaryReachableControl: true,
    forbiddenConnectRejected: true, otherHostPortBlocked: true, sandboxCanaryBlocked: true, nftDefaultDropReadback: true,
    nftRulesDigest: `sha256:${'6'.repeat(64)}`, directInternetProbeBlocked: true, directInternetBlocked: true }
  assert.equal(canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, executionNetworkAttestation: { ...network, nftRulesDigest: `sha256:${'7'.repeat(64)}` } })), canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, executionNetworkAttestation: network })))
  const providerTls = { measured: true, providerAuthority: 'provider.example:443', tlsVerified: true, protocol: 'TLSv1.3', peerCertificateSha256: `sha256:${'8'.repeat(64)}`, caBundleSha256: `sha256:${'9'.repeat(64)}` }
  const withTls = canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, executionNetworkAttestation: { ...network, providerTls } }))
  assert.equal(withTls, canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, executionNetworkAttestation: { ...network, providerTls: { ...providerTls, protocol: 'TLSv1.2', peerCertificateSha256: `sha256:${'a'.repeat(64)}` } } })))
  assert.notEqual(withTls, canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, executionNetworkAttestation: { ...network, providerTls: { ...providerTls, caBundleSha256: `sha256:${'b'.repeat(64)}` } } })))
  assert.notEqual(canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, isolatedConfigDigest: 'sha256:' + '4'.repeat(64) })), first)
  assert.notEqual(canonicalSha256(buildTypedInspectionNativeAttestation({ ...base, bwrap: { ...base.bwrap, sha256: 'sha256:' + '5'.repeat(64) } })), first)
})

test('real bwrap profile performs a non-paid native app-server handshake with private filesystem and isolated network', { skip: !enabled }, async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'typed-inspection-native-profile-')); chmodSync(root, 0o700)
  const inputs = resolve(root, 'inputs'); const state = resolve(root, 'state')
  const profile = {
    profileId: 'native-probe', agentId: 'native-probe-agent', codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex',
    codexHome: process.env.CYF_CODEX_HOME || '/root/.codex', appServerSchemaContractId: 'codex-cli-0.159.2',
    typedInspectionSupportedInputs: [{ mediaKind: 'text', mimeType: 'text/plain', carrier: 'DIRECT_TEXT', carrierContractDigest: `sha256:${'1'.repeat(64)}` }],
    typedInspectionProviderId: 'typed-inspection-probe', typedInspectionProviderBaseUrl: 'https://provider.invalid/v1',
    typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionNetworkConnectTimeoutMs: 1000
  }
  const secondInputs = resolve(root, 'inputs-second'); const secondState = resolve(root, 'state-second')
  const runtime = new TypedInspectionProfileRuntime({ profile, materializerRoot: inputs, stateRoot: state })
  const secondRuntime = new TypedInspectionProfileRuntime({ profile, materializerRoot: secondInputs, stateRoot: secondState })
  try {
    const measured = await runtime.measure(); const remeasured = await secondRuntime.measure()
    assert.equal(measured.measured, true); assert.equal(measured.contractReady, false)
    assert.equal(measured.nativeProbe.view.inputVisible, true)
    assert.equal(measured.nativeProbe.view.hostCanaryHidden, true)
    assert.equal(measured.nativeProbe.view.sourceHomeHidden, true)
    assert.equal(measured.nativeProbe.view.credentialPathAbsent, true)
    assert.equal(measured.nativeProbe.credentialIsolation.bootstrapCredentialRemoved, true)
    assert.equal(measured.nativeProbe.credentialIsolation.modelPhaseCredentialPathAbsent, true)
    assert.equal(measured.nativeProbe.view.curlAbsent, true)
    assert.equal(measured.nativeProbe.view.networkNamespaceIsolated, true)
    assert.equal(measured.nativeProbe.view.defaultRouteAbsent, true)
    assert.deepEqual(measured.nativeProbe.view.networkInterfaces, ['lo'])
    assert.equal(measured.nativeProbe.mcpCatalogCount, 0)
    assert.equal(measured.nativeProbe.providerSystemProxyEnabled, true)
    assert.equal(measured.providerSystemProxyEnabled, true)
    assert.equal(measured.nativeProbe.providerCaTrust.readable, true)
    assert.equal(measured.nativeProbe.providerCaTrust.mountReadOnly, true)
    assert.equal(measured.nativeProbe.providerCaTrust.writeDenied, true)
    assert.match(measured.providerCaTrustDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(measured.providerCaTrustDigest, measured.nativeProbe.providerCaTrust.sha256)
    assert.equal(measured.nativeAttestation.network.execution.measured, true)
    assert.equal(measured.nativeAttestation.network.execution.forbiddenConnectRejected, true)
    assert.equal(measured.nativeAttestation.network.execution.otherHostPortBlocked, true)
    assert.equal(measured.nativeAttestation.network.execution.hostCanaryReachableControl, true)
    assert.equal(measured.nativeAttestation.network.execution.sandboxCanaryBlocked, true)
    assert.equal(measured.nativeAttestation.network.execution.nftDefaultDropReadback, true)
    assert.match(measured.providerExecutionNetworkAttestation.nftRulesDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(measured.nativeAttestation.network.execution.directInternetBlocked, true)
    assert.match(measured.nativeAttestationDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(remeasured.nativeAttestationDigest, measured.nativeAttestationDigest)
    assert.notEqual(remeasured.nativeProbe.processExecutable.pid, measured.nativeProbe.processExecutable.pid)
    assert.equal(runtime.contractReadback, null)
    await assert.rejects(() => runtime.openAdapter(inputs), error => error.code === 'TYPED_INSPECTION_CARRIER_EVIDENCE_REQUIRED')

    const requestAInputs = resolve(inputs, 'request-a'); const requestBInputs = resolve(inputs, 'request-b')
    for (const directory of [requestAInputs, requestBInputs]) { mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700) }
    const binding = suffix => ({ schemaVersion: 1, requestKey: `request-${suffix}`, authorizationId: `inspection_${suffix.repeat(40)}`,
      manifestDigest: `sha256:${suffix.repeat(64)}`, requestId: `request-${suffix}`, turnId: `turn-${suffix}`, inputPolicyDigest: `sha256:${suffix.repeat(64)}` })
    const stateA = runtime._prepareRequestState(binding('a')); const stateACanary = resolve(stateA.directory, 'codex-home', 'request-a-sensitive-history')
    writeFileSync(stateACanary, 'request-a-sensitive-history\n', { mode: 0o600 })
    const adapterA = runtime._spawnAdapter({ inputDirectory: requestAInputs, engineState: stateA, schemaMeasurement: runtime.nativeReadback.schema, networkMode: 'isolated' })
    try {
      const readbackA = await runtime._initializeAndSeal(adapterA); const rootA = `/proc/${readbackA.processExecutable.pid}/root`
      assert.equal(readFileSync(resolve(rootA, 'state', 'codex-home', 'request-a-sensitive-history'), 'utf8'), 'request-a-sensitive-history\n')
      assert.equal(existsSync(resolve(rootA, 'state', 'codex-home', 'auth.json')), false)
    } finally { await adapterA.shutdown({ timeoutMs: 1000 }).catch(() => {}) }
    const stateB = runtime._prepareRequestState(binding('b')); const adapterB = runtime._spawnAdapter({ inputDirectory: requestBInputs, engineState: stateB, schemaMeasurement: runtime.nativeReadback.schema, networkMode: 'isolated' })
    try {
      const readbackB = await runtime._initializeAndSeal(adapterB); const rootB = `/proc/${readbackB.processExecutable.pid}/root`
      assert.equal(existsSync(stateACanary), true)
      assert.equal(existsSync(resolve(rootB, 'state', 'codex-home', 'request-a-sensitive-history')), false)
      assert.equal(existsSync(resolve(rootB, 'state', 'codex-home', 'auth.json')), false)
    } finally { await adapterB.shutdown({ timeoutMs: 1000 }).catch(() => {}); rmSync(stateA.directory, { recursive: true, force: true }); rmSync(stateB.directory, { recursive: true, force: true }) }

    const target = createServer(socket => socket.end('local-provider-probe'))
    await new Promise((resolveListen, rejectListen) => { target.once('error', rejectListen); target.listen(0, '127.0.0.1', () => { target.off('error', rejectListen); resolveListen() }) })
    const allowedDirectory = resolve(inputs, 'allowed-connect-probe'); mkdirSync(allowedDirectory, { mode: 0o700 }); chmodSync(allowedDirectory, 0o700)
    const egress = new RestrictedProviderEgress({ providerBaseUrl: `https://127.0.0.1:${target.address().port}`, networkConnectTimeoutMs: profile.typedInspectionNetworkConnectTimeoutMs }); await egress.start()
    const allowedState = runtime._prepareEphemeralState('allowed-connect')
    const allowedAdapter = runtime._spawnAdapter({ inputDirectory: allowedDirectory, engineState: allowedState, schemaMeasurement: runtime.nativeReadback.schema, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
    try { await egress.bindOwner(allowedAdapter.child, runtime.bwrap, runtime.nativeReadback.schema.snapshotIdentity); await egress.attach(); await runtime._initializeAndSeal(allowedAdapter); const allowed = await egress.measureAllowedConnect(); assert.equal(allowed.connectEstablished, true) }
    finally { await allowedAdapter.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress.dispose(); rmSync(allowedState.directory, { recursive: true, force: true }); await new Promise(resolveClose => target.close(() => resolveClose())) }
  } finally { await runtime.dispose(); await secondRuntime.dispose(); rmSync(root, { recursive: true, force: true }) }
})
