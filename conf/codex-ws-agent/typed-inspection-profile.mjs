import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AppServerAdapter, measureCodexAppServerBinary, verifySpawnedAppServerExecutableTree
} from './app-server-adapter.mjs'
import { canonicalSha256 } from './chat-runtime.mjs'
import { RestrictedProviderEgress, restrictedProviderNetworkPolicy } from './typed-inspection-network.mjs'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonblank = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sha256File = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const digest = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024)
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count)) } finally { closeSync(fd) }
  return digest.digest('hex')
}
const fsyncDirectory = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
const ensurePrivateDirectory = path => {
  const absolute = resolve(path)
  if (!existsSync(absolute)) { mkdirSync(absolute, { recursive: true, mode: 0o700 }); chmodSync(absolute, 0o700); fsyncDirectory(dirname(absolute)) }
  const lexical = lstatSync(absolute, { bigint: true }); const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (lexical.isSymbolicLink() || !lexical.isDirectory() || (uid !== null && lexical.uid !== uid) || Number(lexical.mode & 0o777n) !== 0o700 || realpathSync(absolute) !== absolute) fail('TYPED_INSPECTION_PROFILE_DIRECTORY_UNSAFE')
  return absolute
}
const trustedPublicCaSource = profile => {
  const configured = profile.typedInspectionCaBundlePath
  const candidates = configured ? [configured] : DEFAULT_CA_BUNDLES
  for (const candidate of candidates) {
    if (!nonblank(candidate) || resolve(candidate) !== candidate || !existsSync(candidate)) continue
    const absolute = realpathSync(candidate); const lexical = lstatSync(absolute, { bigint: true })
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.uid !== 0n || (lexical.mode & 0o022n) !== 0n) fail('TYPED_INSPECTION_CA_SOURCE_UNSAFE')
    const bytes = readFileSync(absolute)
    if (!bytes.includes(Buffer.from('-----BEGIN CERTIFICATE-----'))) fail('TYPED_INSPECTION_CA_SOURCE_INVALID')
    const current = lstatSync(absolute, { bigint: true })
    if (current.dev !== lexical.dev || current.ino !== lexical.ino || current.size !== lexical.size) fail('TYPED_INSPECTION_CA_SOURCE_DRIFT')
    return Object.freeze({ sourcePath: candidate, resolvedSourcePath: absolute, bytes, sha256: `sha256:${sha256(bytes)}` })
  }
  fail('TYPED_INSPECTION_CA_SOURCE_REQUIRED')
}
const stageProviderCaTrust = (profile, stateRoot) => {
  const source = trustedPublicCaSource(profile); const resources = ensurePrivateDirectory(resolve(stateRoot, 'profile-resources'))
  const directory = ensurePrivateDirectory(mkdtempSync(resolve(resources, '.provider-ca-'))); const path = resolve(directory, 'ca-bundle.pem')
  writeFileSync(path, source.bytes, { mode: 0o400, flag: 'wx' }); chmodSync(path, 0o400)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) }; fsyncDirectory(directory)
  const lexical = lstatSync(path, { bigint: true })
  if (!lexical.isFile() || lexical.isSymbolicLink() || Number(lexical.mode & 0o777n) !== 0o400 || `sha256:${sha256File(path)}` !== source.sha256) fail('TYPED_INSPECTION_CA_STAGE_INVALID')
  return Object.freeze({ directory, path, sandboxPath: PROVIDER_CA_SANDBOX_PATH, sha256: source.sha256, sourcePath: source.sourcePath, resolvedSourcePath: source.resolvedSourcePath, dev: String(lexical.dev), ino: String(lexical.ino), size: String(lexical.size) })
}
const verifyStagedCaTrust = trust => {
  const lexical = lstatSync(trust.path, { bigint: true })
  if (!lexical.isFile() || lexical.isSymbolicLink() || Number(lexical.mode & 0o777n) !== 0o400 || String(lexical.dev) !== trust.dev || String(lexical.ino) !== trust.ino || String(lexical.size) !== trust.size || `sha256:${sha256File(trust.path)}` !== trust.sha256) fail('TYPED_INSPECTION_CA_STAGE_DRIFT')
}
const verifyProviderTrustView = (pid, trust) => {
  const path = resolve(`/proc/${pid}/root`, trust.sandboxPath.slice(1)); const lexical = lstatSync(path, { bigint: true })
  if (!lexical.isFile() || lexical.isSymbolicLink() || Number(lexical.mode & 0o777n) !== 0o400 || `sha256:${sha256File(path)}` !== trust.sha256) fail('TYPED_INSPECTION_CA_VIEW_INVALID')
  let writable = false; let fd = null
  try { fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW); writable = true } catch (error) { if (!['EROFS', 'EACCES', 'EPERM'].includes(error?.code)) throw error } finally { if (fd !== null) closeSync(fd) }
  if (writable) fail('TYPED_INSPECTION_CA_VIEW_WRITABLE')
  return Object.freeze({ sandboxPath: trust.sandboxPath, sha256: trust.sha256, readable: true, mountReadOnly: true, writeDenied: true })
}
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`)
const overlaps = (left, right) => within(left, right) || within(right, left)
const SANDBOX_MOUNTS = Object.freeze(['runtime:ro', 'request-inputs:ro', 'request-engine-state:rw', 'provider-ca-trust:ro', 'proc', 'dev', 'tmpfs:/tmp'])
const PROVIDER_CA_SANDBOX_PATH = '/trust/ca-bundle.pem'
const DEFAULT_CA_BUNDLES = Object.freeze(['/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/certs/ca-certificates.crt'])
const bwrapPolicy = identity => Object.freeze({ version: identity.version, sha256: identity.sha256 })
const exactSupportedInputs = value => {
  if (!Array.isArray(value) || value.length === 0) fail('TYPED_INSPECTION_SUPPORTED_INPUTS_REQUIRED')
  const result = []; const seen = new Set()
  for (const item of value) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'carrier,carrierContractDigest,mediaKind,mimeType' ||
        !nonblank(item.mediaKind) || !nonblank(item.mimeType) || !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT'].includes(item.carrier) || !DIGEST.test(item.carrierContractDigest)) fail('TYPED_INSPECTION_SUPPORTED_INPUT_INVALID')
    const key = [item.mediaKind, item.mimeType, item.carrier, item.carrierContractDigest].join('\u001f')
    if (seen.has(key)) fail('TYPED_INSPECTION_SUPPORTED_INPUT_DUPLICATE'); seen.add(key); result.push(Object.freeze({ ...item }))
  }
  return Object.freeze(result.sort((a, b) => [a.mediaKind, a.mimeType, a.carrier, a.carrierContractDigest].join('\u001f').localeCompare([b.mediaKind, b.mimeType, b.carrier, b.carrierContractDigest].join('\u001f'))))
}
const copyCredentialFile = (source, target) => {
  const lexical = lstatSync(source, { bigint: true }); const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (lexical.isSymbolicLink() || !lexical.isFile() || (uid !== null && lexical.uid !== uid) || (lexical.mode & 0o077n) !== 0n) fail('TYPED_INSPECTION_AUTH_SOURCE_UNSAFE')
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  copyFileSync(source, temporary, constants.COPYFILE_EXCL); chmodSync(temporary, 0o600)
  const temporaryFd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(temporaryFd) } finally { closeSync(temporaryFd) }
  renameSync(temporary, target); fsyncDirectory(dirname(target))
  const copied = lstatSync(target, { bigint: true }); if (!copied.isFile() || copied.isSymbolicLink() || Number(copied.mode & 0o777n) !== 0o600) fail('TYPED_INSPECTION_AUTH_COPY_UNSAFE')
  return `sha256:${sha256File(target)}`
}
const providerConfig = profile => {
  const id = String(profile.typedInspectionProviderId || '').trim(); const baseUrl = String(profile.typedInspectionProviderBaseUrl || '').trim(); const wireApi = String(profile.typedInspectionProviderWireApi || 'responses').trim()
  if (!id && !baseUrl) return ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || !['responses', 'chat'].includes(wireApi)) fail('TYPED_INSPECTION_PROVIDER_CONFIG_INVALID')
  let parsed; try { parsed = new URL(baseUrl) } catch { fail('TYPED_INSPECTION_PROVIDER_CONFIG_INVALID') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail('TYPED_INSPECTION_PROVIDER_CONFIG_INVALID')
  const escaped = value => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `model_provider = "${escaped(id)}"\npreferred_auth_method = "apikey"\n[model_providers."${escaped(id)}"]\nname = "Typed Inspection Provider"\nbase_url = "${escaped(parsed.toString().replace(/\/$/, ''))}"\nwire_api = "${wireApi}"\nrequires_openai_auth = true\n`
}
export const buildTypedInspectionCodexConfig = profile => {
  const systemProxy = profile?.typedInspectionProviderNetwork === 'restricted-proxy' ? '[features]\nrespect_system_proxy = true\n' : ''
  return `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n${providerConfig(profile)}${systemProxy}`
}
const stageCodexHome = (profile, stateRoot) => {
  const codexHome = ensurePrivateDirectory(resolve(stateRoot, 'codex-home')); ensurePrivateDirectory(resolve(stateRoot, 'home'))
  const sourceAuth = resolve(profile.codexHome || '', 'auth.json')
  if (!profile.codexHome || !existsSync(sourceAuth)) fail('TYPED_INSPECTION_AUTH_SOURCE_REQUIRED')
  const authDigest = copyCredentialFile(sourceAuth, resolve(codexHome, 'auth.json'))
  const config = buildTypedInspectionCodexConfig(profile)
  const configPath = resolve(codexHome, 'config.toml'); const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, config, { mode: 0o600, flag: 'wx' }); chmodSync(temporary, 0o600)
  const configFd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(configFd) } finally { closeSync(configFd) }
  renameSync(temporary, configPath); fsyncDirectory(codexHome)
  return { codexHome, authPath: resolve(codexHome, 'auth.json'), authDigest, configDigest: `sha256:${sha256(Buffer.from(config))}` }
}
const engineStateBinding = value => {
  const keys = ['schemaVersion', 'requestKey', 'authorizationId', 'manifestDigest', 'requestId', 'turnId', 'inputPolicyDigest']
  if (!object(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',') || value.schemaVersion !== 1 || keys.filter(key => key !== 'schemaVersion').some(key => !nonblank(value[key]))) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
  return Object.freeze({ schemaVersion: 1, requestKey: value.requestKey, authorizationId: value.authorizationId, manifestDigest: value.manifestDigest,
    requestId: value.requestId, turnId: value.turnId, inputPolicyDigest: value.inputPolicyDigest })
}
const stateMarker = (directory, binding) => {
  const path = resolve(directory, 'binding.json'); const serialized = `${JSON.stringify(binding)}\n`
  if (!existsSync(path)) {
    writeFileSync(path, serialized, { mode: 0o400, flag: 'wx' }); chmodSync(path, 0o400)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) }; fsyncDirectory(directory)
  }
  const lexical = lstatSync(path, { bigint: true })
  if (lexical.isSymbolicLink() || !lexical.isFile() || Number(lexical.mode & 0o777n) !== 0o400 || readFileSync(path, 'utf8') !== serialized) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
  return path
}
const sealCredential = (engineState, processPid) => {
  const lexical = lstatSync(engineState.authPath, { bigint: true })
  if (lexical.isSymbolicLink() || !lexical.isFile() || Number(lexical.mode & 0o777n) !== 0o600) fail('TYPED_INSPECTION_AUTH_COPY_UNSAFE')
  unlinkSync(engineState.authPath); fsyncDirectory(engineState.codexHome)
  if (existsSync(engineState.authPath) || existsSync(resolve(`/proc/${processPid}/root`, 'state', 'codex-home', 'auth.json'))) fail('TYPED_INSPECTION_AUTH_VISIBLE_AFTER_INITIALIZE')
  return Object.freeze({ bootstrapCredentialRemoved: true, modelPhaseCredentialPathAbsent: true })
}
const bwrapIdentity = path => {
  const absolute = realpathSync(path); const lexical = lstatSync(absolute, { bigint: true }); const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (!lexical.isFile() || lexical.isSymbolicLink() || (uid !== null && lexical.uid !== 0n && lexical.uid !== uid) || (lexical.mode & 0o022n) !== 0n) fail('TYPED_INSPECTION_BWRAP_UNTRUSTED')
  let cursor = dirname(absolute)
  while (true) { const parent = lstatSync(cursor, { bigint: true }); if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o002n) !== 0n) fail('TYPED_INSPECTION_BWRAP_UNTRUSTED'); const next = dirname(cursor); if (next === cursor) break; cursor = next }
  const version = spawnSync(absolute, ['--version'], { encoding: 'utf8', env: { PATH: '' } })
  if (version.status !== 0 || !/^bubblewrap [0-9]+\.[0-9]+\.[0-9]+\s*$/.test(version.stdout || '')) fail('TYPED_INSPECTION_BWRAP_UNTRUSTED')
  return Object.freeze({ path: absolute, version: String(version.stdout).trim(), sha256: `sha256:${sha256(readFileSync(absolute))}`, dev: String(lexical.dev), ino: String(lexical.ino), size: String(lexical.size) })
}
const verifyBwrapIdentity = identity => {
  const lexical = lstatSync(identity.path, { bigint: true })
  if (!lexical.isFile() || lexical.isSymbolicLink() || String(lexical.dev) !== identity.dev || String(lexical.ino) !== identity.ino || String(lexical.size) !== identity.size || `sha256:${sha256(readFileSync(identity.path))}` !== identity.sha256) fail('TYPED_INSPECTION_BWRAP_IDENTITY_DRIFT')
}
const snapshotDirectory = measurement => dirname(dirname(measurement.snapshotPath))
const sandboxArgs = ({ snapshot, stateRoot, inputDirectory, networkMode, proxyUrl = '', caTrust = null }) => {
  const args = ['--unshare-all']
  args.push('--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--ro-bind', snapshot, '/runtime', '--dir', '/state', '--bind', stateRoot, '/state',
    '--dir', '/inputs', '--ro-bind', inputDirectory, '/inputs')
  if (networkMode === 'provider-restricted') {
    if (!caTrust) fail('TYPED_INSPECTION_CA_SOURCE_REQUIRED')
    verifyStagedCaTrust(caTrust); args.push('--dir', '/trust', '--ro-bind', caTrust.directory, '/trust')
  }
  args.push('--setenv', 'HOME', '/state/home', '--setenv', 'CODEX_HOME', '/state/codex-home', '--setenv', 'PATH', '/runtime/bin')
  if (networkMode === 'provider-restricted') args.push('--setenv', 'HTTP_PROXY', proxyUrl, '--setenv', 'HTTPS_PROXY', proxyUrl, '--setenv', 'http_proxy', proxyUrl, '--setenv', 'https_proxy', proxyUrl, '--setenv', 'NO_PROXY', '', '--setenv', 'no_proxy', '', '--setenv', 'SSL_CERT_FILE', PROVIDER_CA_SANDBOX_PATH)
  else args.push('--unsetenv', 'HTTP_PROXY', '--unsetenv', 'HTTPS_PROXY', '--unsetenv', 'ALL_PROXY', '--unsetenv', 'http_proxy', '--unsetenv', 'https_proxy', '--unsetenv', 'all_proxy')
  args.push('--chdir', '/inputs', '/runtime/bin/codex')
  return args
}
const emptyMcpCatalog = tools => Array.isArray(tools?.data) && tools.data.length === 0 && (tools.nextCursor === null || tools.nextCursor === undefined)
const verifyProcessView = ({ pid, inputDirectory, stateRoot, sourceCodexHome, outsideCanary }) => {
  const root = `/proc/${pid}/root`; const inputName = '.cyf-inspection-profile-probe.txt'
  if (readFileSync(resolve(root, 'inputs', inputName), 'utf8') !== 'typed-inspection-profile-probe\n') fail('TYPED_INSPECTION_INPUT_VIEW_MISMATCH')
  if (existsSync(`${root}${outsideCanary}`) || existsSync(`${root}${sourceCodexHome}`) || existsSync(resolve(root, 'usr', 'bin', 'curl'))) fail('TYPED_INSPECTION_HOST_CANARY_VISIBLE')
  if (existsSync(resolve(root, 'state', 'codex-home', 'auth.json'))) fail('TYPED_INSPECTION_AUTH_VISIBLE_AFTER_INITIALIZE')
  if (!existsSync(resolve(root, 'state', 'codex-home', 'config.toml'))) fail('TYPED_INSPECTION_STATE_VIEW_MISSING')
  const parentNet = readlinkSync(`/proc/${process.pid}/ns/net`); const childNet = readlinkSync(`/proc/${pid}/ns/net`)
  if (parentNet === childNet) fail('TYPED_INSPECTION_NETWORK_NAMESPACE_SHARED')
  const routes = readFileSync(`/proc/${pid}/net/route`, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean)
  const interfaces = readFileSync(`/proc/${pid}/net/dev`, 'utf8').split(/\r?\n/).slice(2).map(line => line.split(':', 1)[0].trim()).filter(Boolean).sort()
  if (routes.length !== 0 || interfaces.some(name => name !== 'lo')) fail('TYPED_INSPECTION_NETWORK_NAMESPACE_ROUTABLE')
  const stateStat = statSync(stateRoot, { bigint: true }); const inputStat = statSync(inputDirectory, { bigint: true })
  return Object.freeze({ inputVisible: true, hostCanaryHidden: true, sourceHomeHidden: true, credentialPathAbsent: true, curlAbsent: true, networkNamespaceIsolated: true, defaultRouteAbsent: true, networkInterfaces: Object.freeze(interfaces), stateDev: String(stateStat.dev), inputDev: String(inputStat.dev) })
}
const stableExecutionNetworkAttestation = value => value ? Object.freeze({
  schemaVersion: value.schemaVersion, measured: value.measured === true, policy: value.policy,
  hostCanaryReachableControl: value.hostCanaryReachableControl === true, forbiddenConnectRejected: value.forbiddenConnectRejected === true,
  otherHostPortBlocked: value.otherHostPortBlocked === true, sandboxCanaryBlocked: value.sandboxCanaryBlocked === true,
  nftDefaultDropReadback: value.nftDefaultDropReadback === true, directInternetProbeBlocked: value.directInternetProbeBlocked === true,
  directInternetBlocked: value.directInternetBlocked === true,
  providerTls: value.providerTls ? Object.freeze({ measured: value.providerTls.measured === true, providerAuthority: value.providerTls.providerAuthority, tlsVerified: value.providerTls.tlsVerified === true, caBundleSha256: value.providerTls.caBundleSha256 }) : null
}) : null
export const buildTypedInspectionNativeAttestation = ({ schemaMeasurement, bwrap, view, isolatedConfigDigest, mcpCatalogCount, executionNetworkAttestation = null }) => Object.freeze({
  schemaVersion: 1,
  schema: Object.freeze({ contractId: schemaMeasurement.schemaContractId, bundleSha256: schemaMeasurement.bundleSha256, binaryIdentityDigest: schemaMeasurement.binaryIdentityDigest }),
  bwrap: bwrapPolicy(bwrap),
  mounts: SANDBOX_MOUNTS,
  network: Object.freeze({ measurementNamespace: 'isolated', parentNamespaceShared: false, execution: stableExecutionNetworkAttestation(executionNetworkAttestation) }),
  processView: Object.freeze({ inputVisible: view.inputVisible === true, hostCanaryHidden: view.hostCanaryHidden === true, sourceHomeHidden: view.sourceHomeHidden === true, credentialPathAbsent: view.credentialPathAbsent === true, curlAbsent: view.curlAbsent === true, networkNamespaceIsolated: view.networkNamespaceIsolated === true, defaultRouteAbsent: view.defaultRouteAbsent === true, networkInterfaces: view.networkInterfaces }),
  isolatedConfigDigest,
  mcpCatalogEmpty: mcpCatalogCount === 0
})

const HASH = /^[a-f0-9]{64}$/
const carrierEvidenceBytes = (path, expectedDigest) => {
  if (!nonblank(path) || resolve(path) !== path || !DIGEST.test(expectedDigest || '')) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INVALID')
  const absolute = path
  let resolved; try { resolved = realpathSync(absolute) } catch { fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INVALID') }
  if (resolved !== absolute) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_UNSAFE')
  const lexical = lstatSync(absolute, { bigint: true }); const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (lexical.isSymbolicLink() || !lexical.isFile() || (uid !== null && lexical.uid !== 0n && lexical.uid !== uid) || (lexical.mode & 0o022n) !== 0n) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_UNSAFE')
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true }); const bytes = readFileSync(fd); const after = fstatSync(fd, { bigint: true }); const current = lstatSync(absolute, { bigint: true })
    const stable = [after, current].every(value => value.dev === before.dev && value.ino === before.ino && value.size === before.size && value.uid === before.uid && value.mode === before.mode)
    if (!stable || !before.isFile() || `sha256:${sha256(bytes)}` !== expectedDigest) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_DRIFT')
    return Object.freeze({ absolute, bytes, digest: expectedDigest })
  } finally { closeSync(fd) }
}

export const loadTypedInspectionCarrierEvidence = ({ path, expectedDigest, binding, supportedInputs, nativeProbeDigest, providerId, providerModel } = {}) => {
  if (!path && !expectedDigest) return null
  if (!object(binding) || !Array.isArray(supportedInputs) || !DIGEST.test(nativeProbeDigest || '') || !nonblank(providerId) || !nonblank(providerModel)) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INVALID')
  const loaded = carrierEvidenceBytes(path, expectedDigest)
  let evidence; try { evidence = JSON.parse(loaded.bytes.toString('utf8')) } catch { fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INVALID') }
  const expectedKeys = ['schemaVersion', 'profile', 'nativeProbeDigest', 'providerId', 'providerModel', 'cases']
  if (!object(evidence) || Object.keys(evidence).sort().join(',') !== expectedKeys.sort().join(',') || evidence.schemaVersion !== 1 ||
      canonicalSha256(evidence.profile) !== canonicalSha256(binding) || evidence.nativeProbeDigest !== nativeProbeDigest ||
      evidence.providerId !== providerId || evidence.providerModel !== providerModel || !Array.isArray(evidence.cases)) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INVALID')
  const expected = new Set(supportedInputs.map(item => [item.mediaKind, item.mimeType, item.carrier, item.carrierContractDigest].join('\u001f')))
  const passed = new Set()
  const caseKeys = ['mediaKind', 'mimeType', 'carrier', 'carrierContractDigest', 'status', 'sourceSha256', 'inputDigest', 'resultDigest', 'terminalStatus', 'semanticPass']
  for (const item of evidence.cases) {
    if (!object(item) || Object.keys(item).sort().join(',') !== caseKeys.sort().join(',') || item.status !== 'PASS' || item.terminalStatus !== 'completed' || item.semanticPass !== true ||
        !nonblank(item.mediaKind) || !nonblank(item.mimeType) || !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT'].includes(item.carrier) ||
        !DIGEST.test(item.carrierContractDigest || '') || !HASH.test(item.sourceSha256 || '') || !DIGEST.test(item.inputDigest || '') || !DIGEST.test(item.resultDigest || '')) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INVALID')
    const key = [item.mediaKind, item.mimeType, item.carrier, item.carrierContractDigest].join('\u001f')
    if (passed.has(key)) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INVALID')
    passed.add(key)
  }
  if (expected.size !== passed.size || evidence.cases.length !== expected.size || [...expected].some(key => !passed.has(key))) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_INCOMPLETE')
  return Object.freeze({ path: loaded.absolute, digest: loaded.digest, providerId: evidence.providerId, providerModel: evidence.providerModel,
    cases: Object.freeze(evidence.cases.map(item => Object.freeze({ sourceSha256: item.sourceSha256, inputDigest: item.inputDigest, resultDigest: item.resultDigest,
      mediaKind: item.mediaKind, mimeType: item.mimeType, carrier: item.carrier, carrierContractDigest: item.carrierContractDigest }))) })
}

export class TypedInspectionProfileRuntime {
  constructor({ profile, materializerRoot, stateRoot, bwrapBin = '/usr/bin/bwrap', spawnFn = spawn, measureBinary = measureCodexAppServerBinary, forbidden = [], egressFactory = options => new RestrictedProviderEgress(options) } = {}) {
    if (!object(profile) || !nonblank(profile.agentId) || !nonblank(profile.profileId) || !nonblank(profile.codexBin) || !nonblank(profile.codexHome)) fail('TYPED_INSPECTION_PROFILE_CONFIG_INVALID')
    this.profile = profile; this.materializerRoot = ensurePrivateDirectory(materializerRoot); this.stateRoot = ensurePrivateDirectory(stateRoot)
    if (profile.typedInspectionProviderNetwork === 'restricted-proxy' && (!Number.isSafeInteger(profile.typedInspectionNetworkConnectTimeoutMs) || profile.typedInspectionNetworkConnectTimeoutMs <= 0)) fail('TYPED_INSPECTION_NETWORK_CONNECT_TIMEOUT_REQUIRED')
    if (overlaps(this.materializerRoot, this.stateRoot)) fail('TYPED_INSPECTION_PROFILE_ROOT_OVERLAP')
    for (const candidate of forbidden.filter(value => value && existsSync(resolve(value)))) if (overlaps(this.stateRoot, realpathSync(resolve(candidate)))) fail('TYPED_INSPECTION_PROFILE_ROOT_OVERLAP')
    this.providerCaTrust = profile.typedInspectionProviderNetwork === 'restricted-proxy' ? stageProviderCaTrust(profile, this.stateRoot) : null
    this.bwrap = bwrapIdentity(bwrapBin); this.spawnFn = spawnFn; this.measureBinary = measureBinary; this.egressFactory = egressFactory; this.measurement = null; this.contractReadback = null; this.nativeReadback = null; this.activeAdapters = new Map()
  }
  _prepareEphemeralState(label) {
    const root = ensurePrivateDirectory(resolve(this.stateRoot, 'measurement'))
    const directory = ensurePrivateDirectory(mkdtempSync(resolve(root, `.${label}-`)))
    return { directory, markerPath: null, created: true, bindingDigest: null, ...stageCodexHome(this.profile, directory) }
  }
  _prepareRequestState(rawBinding) {
    const binding = engineStateBinding(rawBinding); const root = ensurePrivateDirectory(resolve(this.stateRoot, 'requests'))
    const bindingDigest = canonicalSha256(binding); const directory = resolve(root, bindingDigest.slice('sha256:'.length)); const created = !existsSync(directory)
    if (created) { mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700); fsyncDirectory(root) }
    ensurePrivateDirectory(directory); const markerPath = stateMarker(directory, binding)
    return { directory, markerPath, created, bindingDigest, binding, ...stageCodexHome(this.profile, directory) }
  }
  _spawnAdapter({ inputDirectory, engineState, schemaMeasurement, networkMode = 'isolated', proxyUrl = '' }) {
    const input = realpathSync(inputDirectory); if (!within(this.materializerRoot, input)) fail('TYPED_INSPECTION_INPUT_DIRECTORY_OUTSIDE_ROOT')
    const lexical = lstatSync(input, { bigint: true }); if (lexical.isSymbolicLink() || !lexical.isDirectory() || Number(lexical.mode & 0o777n) !== 0o700) fail('TYPED_INSPECTION_INPUT_DIRECTORY_UNSAFE')
    if (!engineState?.directory || !within(this.stateRoot, engineState.directory) || realpathSync(engineState.directory) !== engineState.directory) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    const args = sandboxArgs({ snapshot: snapshotDirectory(schemaMeasurement), stateRoot: engineState.directory, inputDirectory: input, networkMode, proxyUrl, caTrust: this.providerCaTrust })
    const spawnWrapped = (_binary, commandArgs, options) => { verifyBwrapIdentity(this.bwrap); return this.spawnFn(this.bwrap.path, [...args, ...commandArgs], { ...options, cwd: '/', env: { LANG: 'C.UTF-8' } }) }
    const adapter = AppServerAdapter.spawn(this.profile, { cwd: '/inputs', schemaMeasurement, spawnFn: spawnWrapped, spawnedExecutableVerifier: verifySpawnedAppServerExecutableTree })
    adapter.typedInspectionEngineState = engineState; adapter.typedInspectionNetworkMode = networkMode; return adapter
  }
  async _initializeAndSeal(adapter) {
    const readback = await adapter.initialize(); const pid = readback?.processExecutable?.pid
    if (!Number.isInteger(pid) || pid <= 0) fail('TYPED_INSPECTION_SANDBOX_PROCESS_REQUIRED')
    const systemProxyEnabled = readback?.config?.config?.features?.respect_system_proxy === true
    if (adapter.typedInspectionNetworkMode === 'provider-restricted' && !systemProxyEnabled) fail('TYPED_INSPECTION_SYSTEM_PROXY_NOT_ENABLED')
    readback.providerSystemProxy = Object.freeze({ required: adapter.typedInspectionNetworkMode === 'provider-restricted', enabled: systemProxyEnabled })
    readback.providerCaTrust = adapter.typedInspectionNetworkMode === 'provider-restricted' ? verifyProviderTrustView(pid, this.providerCaTrust) : null
    readback.credentialIsolation = sealCredential(adapter.typedInspectionEngineState, pid)
    return readback
  }
  async measure() {
    if (this.measurement) return this.measurement
    const schemaMeasurement = this.measureBinary(this.profile)
    const probeDirectory = mkdtempSync(resolve(this.materializerRoot, '.profile-probe-')); chmodSync(probeDirectory, 0o700)
    const probePath = resolve(probeDirectory, '.cyf-inspection-profile-probe.txt'); writeFileSync(probePath, 'typed-inspection-profile-probe\n', { mode: 0o400 }); chmodSync(probePath, 0o400)
    const outsideCanary = resolve(tmpdir(), `.cyf-inspection-outside-${randomUUID()}`); writeFileSync(outsideCanary, 'must-not-be-visible\n', { mode: 0o600 })
    const isolatedState = this._prepareEphemeralState('isolated'); const adapter = this._spawnAdapter({ inputDirectory: probeDirectory, engineState: isolatedState, schemaMeasurement, networkMode: 'isolated' })
    try {
      const isolatedReadback = await this._initializeAndSeal(adapter)
      if (!emptyMcpCatalog(isolatedReadback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      const view = verifyProcessView({ pid: isolatedReadback.processExecutable.pid, inputDirectory: probeDirectory, stateRoot: isolatedState.directory, sourceCodexHome: realpathSync(this.profile.codexHome), outsideCanary })
      let executionReadback = null; let executionNetworkAttestation = null
      if (this.profile.typedInspectionProviderNetwork === 'restricted-proxy') {
        const egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs })
        const executionState = this._prepareEphemeralState('execution')
        await egress.start(); const executionAdapter = this._spawnAdapter({ inputDirectory: probeDirectory, engineState: executionState, schemaMeasurement, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
        try {
          await egress.bindOwner(executionAdapter.child, this.bwrap, schemaMeasurement.snapshotIdentity); executionNetworkAttestation = await egress.attach()
          executionReadback = await this._initializeAndSeal(executionAdapter)
          const providerTls = await egress.measureAllowedTls(executionReadback.providerCaTrust)
          executionNetworkAttestation = Object.freeze({ ...executionNetworkAttestation, providerTls })
          if (!emptyMcpCatalog(executionReadback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
        } finally { await executionAdapter.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress.dispose().catch(() => {}); rmSync(executionState.directory, { recursive: true, force: true }) }
      }
      const supportedInputs = exactSupportedInputs(this.profile.typedInspectionSupportedInputs)
      const profileId = String(this.profile.typedInspectionProfileId || `${this.profile.profileId}-typed-inspection-v1`)
      const engineContractId = String(this.profile.typedInspectionEngineContractId || `codex-app-server-${schemaMeasurement.schemaContractId}-typed-inspection-v1`)
      const networkPolicy = this.profile.typedInspectionProviderNetwork === 'restricted-proxy' ? restrictedProviderNetworkPolicy(this.profile.typedInspectionProviderBaseUrl, { connectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs }) : null
      const enginePolicyDigest = canonicalSha256({ schemaContractId: schemaMeasurement.schemaContractId, bundleSha256: schemaMeasurement.bundleSha256, binaryIdentityDigest: schemaMeasurement.binaryIdentityDigest, bwrap: bwrapPolicy(this.bwrap), mounts: SANDBOX_MOUNTS, networkPolicy, providerHttpRoute: 'respect_system_proxy=true/readback-required', providerCaTrustDigest: executionReadback?.providerCaTrust?.sha256 || null })
      const toolPolicyDigest = canonicalSha256({ policy: 'MANIFEST_READ_ONLY', mcpCatalogEmptyMeasured: true, mcpCatalogNotStrictNoToolsProof: true, webSearch: 'disabled', adapterDeniedRequests: 'command|file|permission|network|mcp|dynamic-tool|tool', bootstrapCredential: 'removed-before-model-turn', sandboxPolicy: { type: 'readOnly', networkAccess: false }, filesystem: SANDBOX_MOUNTS })
      const inputPolicyDigest = canonicalSha256({ sourcesStrictlyOrdered: true, requestDirectoryReadOnly: true, supportedInputs })
      const binding = Object.freeze({ profileId, engineContractId, enginePolicyDigest, toolPolicyDigest, inputPolicyDigest })
      const nativeProbe = { schemaVersion: 1, schemaContractId: schemaMeasurement.schemaContractId, processExecutable: isolatedReadback.processExecutable, bwrap: this.bwrap, view, authSourceDigest: isolatedState.authDigest, isolatedConfigDigest: isolatedState.configDigest, credentialIsolation: isolatedReadback.credentialIsolation, executionNetworkReadback: executionNetworkAttestation, providerSystemProxyEnabled: executionReadback?.providerSystemProxy?.enabled === true, providerCaTrust: executionReadback?.providerCaTrust || null, modelCount: Array.isArray(isolatedReadback.models?.data) ? isolatedReadback.models.data.length : null, mcpCatalogCount: isolatedReadback.tools.data.length }
      const nativeAttestation = buildTypedInspectionNativeAttestation({ schemaMeasurement, bwrap: this.bwrap, view, isolatedConfigDigest: isolatedState.configDigest, mcpCatalogCount: isolatedReadback.tools.data.length, executionNetworkAttestation })
      const nativeAttestationDigest = canonicalSha256(nativeAttestation)
      const providerModel = String(this.profile.chatModel || this.profile.codexModel || '')
      const carrierEvidence = loadTypedInspectionCarrierEvidence({ path: this.profile.typedInspectionCarrierEvidencePath,
        expectedDigest: this.profile.typedInspectionCarrierEvidenceDigest, binding, supportedInputs, nativeProbeDigest: nativeAttestationDigest,
        providerId: this.profile.typedInspectionProviderId, providerModel })
      this.nativeReadback = executionReadback
      this.contractReadback = carrierEvidence && executionReadback && executionNetworkAttestation ? Object.freeze({ schemaVersion: 1, measured: true, ...binding, toolPolicy: 'MANIFEST_READ_ONLY', recovery: 'durable-inbox-turn-readback-v1', supportedInputs }) : null
      this.measurement = Object.freeze({ schemaVersion: 1, measured: true, binding, supportedInputs, nativeProbe: Object.freeze(nativeProbe), nativeAttestation, nativeAttestationDigest, nativeProbeDigest: nativeAttestationDigest, carrierEvidence, providerExecutionNetwork: executionNetworkAttestation ? 'restricted-proxy-measured-no-paid-turn' : 'isolated-measurement-only', providerExecutionNetworkAttestation: executionNetworkAttestation, providerSystemProxyEnabled: nativeProbe.providerSystemProxyEnabled, providerCaTrustDigest: nativeProbe.providerCaTrust?.sha256 || null, contractReady: Boolean(this.contractReadback) })
      return this.measurement
    } finally {
      await adapter.shutdown({ timeoutMs: 1000 }).catch(() => {})
      rmSync(isolatedState.directory, { recursive: true, force: true }); rmSync(probeDirectory, { recursive: true, force: true }); try { rmSync(outsideCanary, { force: true }) } catch {}
    }
  }
  async openAdapter(inputDirectory, requestKey = '', requestBinding = null) {
    const measurement = await this.measure(); if (!measurement.contractReady) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_REQUIRED')
    if (this.profile.typedInspectionProviderNetwork !== 'restricted-proxy') fail('TYPED_INSPECTION_PROVIDER_NETWORK_NOT_CONFIGURED')
    if (!nonblank(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    const binding = engineStateBinding(requestBinding); const bindingDigest = canonicalSha256(binding)
    if (requestKey && this.activeAdapters.has(requestKey)) {
      const active = this.activeAdapters.get(requestKey)
      if (!active.adapter.closed && active.inputDirectory === realpathSync(inputDirectory) && active.engineState.bindingDigest === bindingDigest) return active.adapter
      fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    }
    const engineState = this._prepareRequestState(binding)
    const egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs }); await egress.start()
    const adapter = this._spawnAdapter({ inputDirectory, engineState, schemaMeasurement: this.nativeReadback.schema, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
    try {
      await egress.bindOwner(adapter.child, this.bwrap, this.nativeReadback.schema.snapshotIdentity); await egress.attach(); await this._initializeAndSeal(adapter)
      if (!emptyMcpCatalog(adapter.readback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      this.activeAdapters.set(requestKey, { adapter, egress, engineState, inputDirectory: realpathSync(inputDirectory) }); adapter.once('exit', () => { if (this.activeAdapters.get(requestKey)?.adapter === adapter) this.activeAdapters.delete(requestKey); void egress.dispose() })
      return adapter
    } catch (error) { await adapter.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress.dispose().catch(() => {}); if (engineState.created) rmSync(engineState.directory, { recursive: true, force: true }); throw error }
  }
  async releaseAdapter(requestKey) {
    const active = this.activeAdapters.get(requestKey); if (!active) return false
    this.activeAdapters.delete(requestKey); await active.adapter.shutdown({ timeoutMs: 1000 }).catch(() => {}); await active.egress?.dispose().catch(() => {}); rmSync(active.engineState.directory, { recursive: true, force: true }); return true
  }
  async dispose() {
    const active = [...this.activeAdapters.values()]; this.activeAdapters.clear()
    await Promise.all(active.map(async item => { await item.adapter.shutdown({ timeoutMs: 1000 }).catch(() => {}); await item.egress?.dispose().catch(() => {}) }))
    if (this.providerCaTrust?.directory) rmSync(this.providerCaTrust.directory, { recursive: true, force: true })
  }
  mapInputPath(hostPath, inputDirectory) {
    const root = realpathSync(inputDirectory); const path = realpathSync(hostPath); if (!within(root, path)) fail('TYPED_INSPECTION_INPUT_PATH_OUTSIDE_REQUEST')
    return resolve('/inputs', path.slice(root.length + 1))
  }
  declaration() {
    if (!this.contractReadback) return null
    return Object.freeze({ schemaVersion: 1, contract: 'juyiting-typed-inspection-v1', enabled: true, profileId: this.contractReadback.profileId,
      engineContractId: this.contractReadback.engineContractId, enginePolicyDigest: this.contractReadback.enginePolicyDigest,
      toolPolicyDigest: this.contractReadback.toolPolicyDigest, inputPolicyDigest: this.contractReadback.inputPolicyDigest,
      toolPolicy: this.contractReadback.toolPolicy, recovery: this.contractReadback.recovery, supportedInputs: this.contractReadback.supportedInputs })
  }
}
