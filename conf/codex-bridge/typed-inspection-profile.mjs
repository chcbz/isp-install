import { BROWSER_PROBE } from './native-browser-toolchain.mjs'
import { DOCUMENT_MIMES, DOCUMENT_PROBE, PDF_PROBE } from './native-document-toolchain.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { skillPackageTreeDigest } from './skill-manifest.mjs'
import {
  AppServerAdapter, measureCodexAppServerBinaryAsync, verifySpawnedAppServerExecutableTree
} from './app-server-adapter.mjs'
import { canonicalSha256 } from './chat-runtime.mjs'
import { RestrictedProviderEgress, restrictedProviderNetworkPolicy } from './typed-inspection-network.mjs'

import { NATIVE_NEUTRAL_MOUNT_TARGETS, NATIVE_PERMISSION_PROFILE, buildNativeExecutionCodexConfig, nativeExecutionMountArgs, prepareNativeExecutionLayout, validateNativeExecutionToolchain, verifyNativeExecutionConfig, verifyNativeExecutionSkillCatalog } from './native-execution-profile.mjs'

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
const stageCodexHome = (profile, stateRoot, { nativeExecution = false } = {}) => {
  const codexHome = ensurePrivateDirectory(resolve(stateRoot, 'codex-home')); ensurePrivateDirectory(resolve(stateRoot, 'home'))
  const sourceAuth = resolve(profile.codexHome || '', 'auth.json')
  if (!profile.codexHome || !existsSync(sourceAuth)) fail('TYPED_INSPECTION_AUTH_SOURCE_REQUIRED')
  const authDigest = copyCredentialFile(sourceAuth, resolve(codexHome, 'auth.json'))
  const readOnlyConfig = buildTypedInspectionCodexConfig(profile)
  const config = nativeExecution ? buildNativeExecutionCodexConfig(readOnlyConfig) : readOnlyConfig
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
const stateMarker = (directory, binding, filename = 'binding.json') => {
  const path = resolve(directory, filename); const serialized = `${JSON.stringify(binding)}\n`
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
const sandboxArgs = ({ snapshot, stateRoot, inputDirectory, networkMode, proxyUrl = '', caTrust = null, nativeView = null }) => {
  const args = ['--unshare-all']
  args.push('--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--ro-bind', snapshot, '/runtime', '--dir', '/inputs', '--ro-bind', inputDirectory, '/inputs')
  if (!nativeView) args.push('--dir', '/state', '--bind', stateRoot, '/state')
  if (networkMode === 'provider-restricted') {
    if (!caTrust) fail('TYPED_INSPECTION_CA_SOURCE_REQUIRED')
    verifyStagedCaTrust(caTrust); args.push('--dir', '/trust', '--ro-bind', caTrust.directory, '/trust')
  }
  if (nativeView) args.push(...nativeExecutionMountArgs(nativeView))
  args.push('--setenv', 'HOME', '/state/home', '--setenv', 'CODEX_HOME', '/state/codex-home', '--setenv', 'PATH', nativeView ? '/runtime/bin:/usr/bin:/bin' : '/runtime/bin')
  if (networkMode === 'provider-restricted') args.push('--setenv', 'HTTP_PROXY', proxyUrl, '--setenv', 'HTTPS_PROXY', proxyUrl, '--setenv', 'http_proxy', proxyUrl, '--setenv', 'https_proxy', proxyUrl, '--setenv', 'NO_PROXY', '', '--setenv', 'no_proxy', '', '--setenv', 'SSL_CERT_FILE', PROVIDER_CA_SANDBOX_PATH, '--setenv', 'NODE_EXTRA_CA_CERTS', PROVIDER_CA_SANDBOX_PATH)
  else args.push('--unsetenv', 'HTTP_PROXY', '--unsetenv', 'HTTPS_PROXY', '--unsetenv', 'ALL_PROXY', '--unsetenv', 'http_proxy', '--unsetenv', 'https_proxy', '--unsetenv', 'all_proxy')
  args.push('--chdir', nativeView ? '/execution' : '/inputs', '/runtime/bin/codex')
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

// A synthetic package and config exercise exactly the request-scoped script
// view. The host canary is an explicitly allowed additional origin, not a paid
// endpoint; the script never receives a real user credential.
const measureNativeSkillScript = async runtime => {
  runtime.nativeScriptMeasurementFailure = null
  if (!runtime.nativeToolchain?.files?.some(file => file.sandboxPath === '/usr/bin/node')) { runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_NODE_REQUIRED' }; return false }
  const id = `native-script-measurement-${randomUUID()}`
  const binding = { schemaVersion: 1, requestKey: id, authorizationId: id, manifestDigest: id, requestId: id, turnId: id, inputPolicyDigest: id }
  let directory, server, ready = false, stage = 'fixture'
  try {
    directory = ensurePrivateDirectory(mkdtempSync(resolve(runtime.materializerRoot, '.native-script-measurement-')))
    const inputs = ensurePrivateDirectory(resolve(directory, 'inputs'))
    const scratchDirectory = ensurePrivateDirectory(resolve(directory, 'scratch'))
    const draftsDirectory = ensurePrivateDirectory(resolve(directory, 'drafts'))
    const packageRoot = ensurePrivateDirectory(resolve(directory, 'package'))
    writeFileSync(resolve(inputs, 'probe.txt'), 'script-input', { mode: 0o600 })
    writeFileSync(resolve(packageRoot, 'SKILL.md'), '---\nname: probe-skill\ndescription: Synthetic isolated script probe.\n---\nProbe only.\n', { mode: 0o600 })
    const script = `import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
const configPath = process.env.CYF_SKILL_CONFIG_DIR + '/probe-skill.json'
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (config.marker !== 'synthetic-config' || readFileSync('/inputs/probe.txt', 'utf8') !== 'script-input') throw Error('view')
for (const path of [configPath, '/state/codex-home/skills/probe-skill/SKILL.md']) {
  let denied = false; try { writeFileSync(path, 'bad') } catch (e) { denied = ['EROFS', 'EACCES', 'EPERM'].includes(e.code) }
  if (!denied) throw Error('writable')
}
const proxy = new URL(process.env.HTTPS_PROXY)
async function tunnel(authority, expected, marker) {
  await new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname); let data = ''
    socket.setTimeout(config.timeoutMs, () => socket.destroy(Error('timeout')))
    socket.on('connect', () => socket.write('CONNECT ' + authority + ' HTTP/1.1\\r\\nHost: ' + authority + '\\r\\n\\r\\n'))
    socket.on('data', chunk => { data += chunk.toString(); if (data.includes('\\r\\n\\r\\n') && (!marker || data.includes(marker))) { socket.destroy(); if (!data.startsWith('HTTP/1.1 ' + expected + ' ')) reject(Error('status')); else resolve() } })
    socket.on('error', reject); socket.on('end', () => reject(Error('early-close')))
  })
}
await tunnel(config.authority, '200', 'cyf-script-canary')
await tunnel('forbidden.invalid:443', '403', '')
writeFileSync('/outputs/script-probe.txt', 'script-ok')
console.log('script-ok')
`
    writeFileSync(resolve(packageRoot, 'probe.mjs'), script, { mode: 0o600 })
    server = createServer(socket => socket.end('cyf-script-canary'))
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen() }) })
    const authority = `127.0.0.1:${server.address().port}`
    const skills = [{ skillKey: 'probe-skill', packageRoot, packageTreeDigest: skillPackageTreeDigest(packageRoot) }]
    const skillConfiguration = [{ skillKey: 'probe-skill', configuration: { marker: 'synthetic-config', authority, timeoutMs: runtime.profile.typedInspectionNetworkConnectTimeoutMs }, networkOrigins: [`https://${authority}`] }]
    const nativeExecution = { executionId: id, tools: [], networkAccess: true,
      checkActive: () => { if (runtime.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED') }, callTool: async () => { fail('NATIVE_EXECUTION_TOOL_UNAVAILABLE') } }
    stage = 'engine-open'
    const adapter = await runtime.openNativeExecutionAdapter(inputs, id, binding, { scratchDirectory, draftsDirectory, skills, skillConfiguration, nativeExecution })
    const network = adapter.nativeExecutionIsolation?.network
    if (network?.measured !== true || network.nftDefaultDropReadback !== true || network.directInternetBlocked !== true) fail('NATIVE_SCRIPT_NETWORK_UNVERIFIED')
    stage = 'script-exec'
    const result = await adapter.request('command/exec', { command: ['/usr/bin/node', '/state/codex-home/skills/probe-skill/probe.mjs'], cwd: '/execution', disableTimeout: true,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }, null)
    if (result?.exitCode !== 0 || result.stdout?.trim() !== 'script-ok' || readFileSync(resolve(draftsDirectory, 'script-probe.txt'), 'utf8') !== 'script-ok'
        || readFileSync(resolve(inputs, 'probe.txt'), 'utf8') !== 'script-input') fail('NATIVE_SCRIPT_PROBE_FAILED')
    validateNativeExecutionToolchain(runtime.nativeToolchain)
    ready = !runtime.disposed
  } catch (error) { runtime.nativeScriptMeasurementFailure = { stage, code: error.code || 'NATIVE_SCRIPT_MEASUREMENT_FAILED' } }
  finally {
    try { await runtime.releaseAdapter(id, { requestBinding: binding }) } catch { ready = false; runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_CLEANUP_FAILED' } }
    try { if (server?.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())) } catch { ready = false; runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_CLEANUP_FAILED' } }
    try { if (directory) rmSync(directory, { recursive: true, force: true }) } catch { ready = false; runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_CLEANUP_FAILED' } }
  }
  if (ready) runtime.nativeScriptMeasurementFailure = null
  return ready && !runtime.disposed
}

export class TypedInspectionProfileRuntime {
  constructor({ profile, materializerRoot, stateRoot, bwrapBin = '/usr/bin/bwrap', spawnFn = spawn, measureBinary = measureCodexAppServerBinaryAsync, forbidden = [], egressFactory = options => new RestrictedProviderEgress(options), nativeToolchain = null } = {}) {
    if (!object(profile) || !nonblank(profile.agentId) || !nonblank(profile.profileId) || !nonblank(profile.codexBin) || !nonblank(profile.codexHome)) fail('TYPED_INSPECTION_PROFILE_CONFIG_INVALID')
    this.profile = profile; this.materializerRoot = ensurePrivateDirectory(materializerRoot); this.stateRoot = ensurePrivateDirectory(stateRoot)
    if (profile.typedInspectionProviderNetwork === 'restricted-proxy' && (!Number.isSafeInteger(profile.typedInspectionNetworkConnectTimeoutMs) || profile.typedInspectionNetworkConnectTimeoutMs <= 0)) fail('TYPED_INSPECTION_NETWORK_CONNECT_TIMEOUT_REQUIRED')
    if (overlaps(this.materializerRoot, this.stateRoot)) fail('TYPED_INSPECTION_PROFILE_ROOT_OVERLAP')
    for (const candidate of forbidden.filter(value => value && existsSync(resolve(value)))) if (overlaps(this.stateRoot, realpathSync(resolve(candidate)))) fail('TYPED_INSPECTION_PROFILE_ROOT_OVERLAP')
    this.providerCaTrust = profile.typedInspectionProviderNetwork === 'restricted-proxy' ? stageProviderCaTrust(profile, this.stateRoot) : null
    this.nativeToolchain = nativeToolchain; this.nativeExecutionReadback = null; this.nativeExecutionMeasurementPending = null; this.pendingNativeAdapters = new Map(); this.pendingInspectionKeys = new Set(); this.closingAdapters = new Map()
    this.bwrap = bwrapIdentity(bwrapBin); this.spawnFn = spawnFn; this.measureBinary = measureBinary; this.egressFactory = egressFactory; this.measurement = null; this.contractReadback = null; this.nativeReadback = null; this.activeAdapters = new Map(); this.disposed = false
  }
  _prepareEphemeralState(label) {
    const root = ensurePrivateDirectory(resolve(this.stateRoot, 'measurement'))
    const directory = ensurePrivateDirectory(mkdtempSync(resolve(root, `.${label}-`)))
    return { directory, markerPath: null, created: true, bindingDigest: null, ...stageCodexHome(this.profile, directory) }
  }
  _prepareRequestState(rawBinding, { requireExistingState = false, nativeExecution = false, nativeBinding = null } = {}) {
    const binding = engineStateBinding(rawBinding); const rootPath = resolve(this.stateRoot, 'requests')
    const bindingDigest = canonicalSha256(binding); const directory = resolve(rootPath, bindingDigest.slice('sha256:'.length))
    if (requireExistingState && (!existsSync(directory) || !existsSync(resolve(directory, 'binding.json'))))
      fail('TYPED_INSPECTION_RECOVERY_STATE_MISSING')
    const root = ensurePrivateDirectory(rootPath); const created = !existsSync(directory)
    if (created) { mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700); fsyncDirectory(root) }
    ensurePrivateDirectory(directory)
    if (!nativeExecution && existsSync(resolve(directory, 'native-binding.json'))) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    const markerPath = stateMarker(directory, binding)
    if (nativeExecution) {
      if (!created && !existsSync(resolve(directory, 'native-binding.json'))) fail('NATIVE_EXECUTION_RECOVERY_MAPPING_MISSING')
      stateMarker(directory, nativeBinding, 'native-binding.json')
    }
    return { directory, markerPath, created, bindingDigest, binding, ...stageCodexHome(this.profile, directory, { nativeExecution }) }
  }
  async _spawnAdapter({ inputDirectory, engineState, schemaMeasurement, networkMode = 'isolated', proxyUrl = '', nativeView = null, nativeExecution = null }) {
    if (Boolean(nativeView) !== Boolean(nativeExecution)) fail('NATIVE_EXECUTION_BINDING_INVALID')
    const input = realpathSync(inputDirectory); if (!nativeView && !within(this.materializerRoot, input)) fail('TYPED_INSPECTION_INPUT_DIRECTORY_OUTSIDE_ROOT')
    const lexical = lstatSync(input, { bigint: true }); if (lexical.isSymbolicLink() || !lexical.isDirectory() || Number(lexical.mode & 0o777n) !== 0o700) fail('TYPED_INSPECTION_INPUT_DIRECTORY_UNSAFE')
    if (!engineState?.directory || !within(this.stateRoot, engineState.directory) || realpathSync(engineState.directory) !== engineState.directory) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    const args = sandboxArgs({ snapshot: snapshotDirectory(schemaMeasurement), stateRoot: engineState.directory, inputDirectory: input, networkMode, proxyUrl, caTrust: this.providerCaTrust, nativeView })
    const spawnWrapped = (_binary, commandArgs, options) => {
      verifyBwrapIdentity(this.bwrap)
      if (nativeView) {
        nativeExecution.checkActive()
        const current = prepareNativeExecutionLayout({ ...nativeView.layout, nativeExecution, toolchain: this.nativeToolchain, stateRoot: this.stateRoot, sourceHome: this.profile.codexHome })
        if (current.digest !== nativeView.layout.digest) fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
      }
      return this.spawnFn(this.bwrap.path, [...args, ...commandArgs], { ...options, cwd: '/', env: { LANG: 'C.UTF-8' } }) }
    const adapter = await AppServerAdapter.spawnAsync(this.profile, { cwd: nativeView ? '/execution' : '/inputs', nativeExecution, schemaMeasurement, spawnFn: spawnWrapped, shouldSpawn: () => !this.disposed, spawnedExecutableVerifier: verifySpawnedAppServerExecutableTree })
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
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    if (this.measurement) return this.measurement
    const schemaMeasurement = await this.measureBinary(this.profile)
    const probeDirectory = mkdtempSync(resolve(this.materializerRoot, '.profile-probe-')); chmodSync(probeDirectory, 0o700)
    const probePath = resolve(probeDirectory, '.cyf-inspection-profile-probe.txt'); writeFileSync(probePath, 'typed-inspection-profile-probe\n', { mode: 0o400 }); chmodSync(probePath, 0o400)
    const outsideCanary = resolve(tmpdir(), `.cyf-inspection-outside-${randomUUID()}`); writeFileSync(outsideCanary, 'must-not-be-visible\n', { mode: 0o600 })
    const isolatedState = this._prepareEphemeralState('isolated'); let adapter
    try {
      adapter = await this._spawnAdapter({ inputDirectory: probeDirectory, engineState: isolatedState, schemaMeasurement, networkMode: 'isolated' })
      const isolatedReadback = await this._initializeAndSeal(adapter)
      if (!emptyMcpCatalog(isolatedReadback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      const view = verifyProcessView({ pid: isolatedReadback.processExecutable.pid, inputDirectory: probeDirectory, stateRoot: isolatedState.directory, sourceCodexHome: realpathSync(this.profile.codexHome), outsideCanary })
      let executionReadback = null; let executionNetworkAttestation = null
      if (this.profile.typedInspectionProviderNetwork === 'restricted-proxy') {
        const egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs })
        const executionState = this._prepareEphemeralState('execution')
        let executionAdapter
        try {
          await egress.start()
          executionAdapter = await this._spawnAdapter({ inputDirectory: probeDirectory, engineState: executionState, schemaMeasurement, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
          await egress.bindOwner(executionAdapter.child, this.bwrap, schemaMeasurement.snapshotIdentity); executionNetworkAttestation = await egress.attach()
          executionReadback = await this._initializeAndSeal(executionAdapter)
          const providerTls = await egress.measureAllowedTls(executionReadback.providerCaTrust)
          executionNetworkAttestation = Object.freeze({ ...executionNetworkAttestation, providerTls })
          if (!emptyMcpCatalog(executionReadback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
        } finally { await executionAdapter?.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress.dispose().catch(() => {}); rmSync(executionState.directory, { recursive: true, force: true }) }
      }
      const supportedInputs = exactSupportedInputs(this.profile.typedInspectionSupportedInputs)
      const profileId = String(this.profile.typedInspectionProfileId || `${this.profile.profileId}-typed-inspection-v1`)
      const engineContractId = String(this.profile.typedInspectionEngineContractId || 'codex-app-server-typed-inspection-v1')
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
      await adapter?.shutdown({ timeoutMs: 1000 }).catch(() => {})
      rmSync(isolatedState.directory, { recursive: true, force: true }); rmSync(probeDirectory, { recursive: true, force: true }); try { rmSync(outsideCanary, { force: true }) } catch {}
    }
  }
  async openAdapter(inputDirectory, requestKey = '', requestBinding = null, options = {}) {
    this.pendingInspectionKeys ||= new Set()
    if (this.closingAdapters?.has(requestKey)) fail('NATIVE_EXECUTION_ADAPTER_CLOSING')
    if (this.pendingInspectionKeys.has(requestKey) || this.pendingNativeAdapters?.has(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    this.pendingInspectionKeys.add(requestKey)
    try { return await this._openInspectionAdapter(inputDirectory, requestKey, requestBinding, options) }
    finally { this.pendingInspectionKeys.delete(requestKey) }
  }
  async _openInspectionAdapter(inputDirectory, requestKey = '', requestBinding = null, { requireExistingState = false } = {}) {
    const measurement = await this.measure(); if (!measurement.contractReady) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_REQUIRED')
    if (this.profile.typedInspectionProviderNetwork !== 'restricted-proxy') fail('TYPED_INSPECTION_PROVIDER_NETWORK_NOT_CONFIGURED')
    if (!nonblank(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    if (this.pendingNativeAdapters?.has(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    const binding = engineStateBinding(requestBinding); const bindingDigest = canonicalSha256(binding)
    if (requestKey && this.activeAdapters.has(requestKey)) {
      const active = this.activeAdapters.get(requestKey)
      if (!active.nativeLayout && !active.adapter.closed && active.inputDirectory === realpathSync(inputDirectory) && active.engineState.bindingDigest === bindingDigest) return active.adapter
      fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    }
    const engineState = this._prepareRequestState(binding, { requireExistingState })
    const egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs })
    let adapter
    try {
      await egress.start()
      adapter = await this._spawnAdapter({ inputDirectory, engineState, schemaMeasurement: this.nativeReadback.schema, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
      await egress.bindOwner(adapter.child, this.bwrap, this.nativeReadback.schema.snapshotIdentity); await egress.attach(); await this._initializeAndSeal(adapter)
      if (!emptyMcpCatalog(adapter.readback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      this.activeAdapters.set(requestKey, { adapter, egress, engineState, inputDirectory: realpathSync(inputDirectory) }); adapter.once('exit', () => { if (this.activeAdapters.get(requestKey)?.adapter === adapter) this.activeAdapters.delete(requestKey); void egress.dispose() })
      return adapter
    } catch (error) { await adapter?.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress.dispose().catch(() => {}); if (engineState.created) rmSync(engineState.directory, { recursive: true, force: true }); throw error }
  }
  // Native execution is NOT authorized by the read-only carrier evidence.
  // The caller supplies an API-authorized execution/tool binding and pinned
  // package/toolchain bytes; this path measures its own actual engine view.
  openNativeExecutionAdapter(inputDirectory, requestKey, requestBinding, { scratchDirectory, draftsDirectory, skills = [], skillConfiguration = [], nativeExecution, requireExistingState = false } = {}) {
    if (nativeExecution) nativeExecution = Object.freeze({ ...nativeExecution, tools: structuredClone(nativeExecution.tools) })
    if (this.disposed) return Promise.reject(Object.assign(new Error('TYPED_INSPECTION_PROFILE_DISPOSED'), { code: 'TYPED_INSPECTION_PROFILE_DISPOSED' }))
    const binding = engineStateBinding(requestBinding)
    if (!nonblank(requestKey) || binding.requestKey !== requestKey) fail('NATIVE_EXECUTION_BINDING_INVALID')
    const layout = prepareNativeExecutionLayout({ inputDirectory, scratchDirectory, draftsDirectory, skills, skillConfiguration, nativeExecution,
      toolchain: this.nativeToolchain, stateRoot: this.stateRoot, sourceHome: this.profile.codexHome })
    const bindingDigest = canonicalSha256(binding)
    const matches = active => active.nativeLayout?.digest === layout.digest && active.engineState.bindingDigest === bindingDigest
      && active.nativeExecution.checkActive === nativeExecution.checkActive && active.nativeExecution.callTool === nativeExecution.callTool
    if (this.closingAdapters?.has(requestKey)) fail('NATIVE_EXECUTION_ADAPTER_CLOSING')
    if (this.pendingInspectionKeys?.has(requestKey)) fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
    const pending = this.pendingNativeAdapters.get(requestKey)
    if (pending) { if (matches(pending)) return pending.promise; fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT') }
    const active = this.activeAdapters.get(requestKey)
    if (active) {
      if (!active.adapter.closed && matches(active)) return Promise.resolve(active.adapter)
      fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
    }
    const slot = { nativeLayout: layout, engineState: { bindingDigest }, nativeExecution, cancelled: false }
    this.pendingNativeAdapters.set(requestKey, slot)
    slot.promise = this._openNativeExecutionAdapter(binding, layout, nativeExecution, requireExistingState, slot)
      .finally(() => { if (this.pendingNativeAdapters.get(requestKey) === slot) this.pendingNativeAdapters.delete(requestKey) })
    return slot.promise
  }
  async _openNativeExecutionAdapter(binding, layout, nativeExecution, requireExistingState, slot) {
    let engineState, adapter, egress
    const checkActive = () => { if (this.disposed || slot.cancelled) fail('NATIVE_EXECUTION_START_CANCELLED'); nativeExecution.checkActive() }
    try {
      checkActive()
      if (this.profile.typedInspectionProviderNetwork !== 'restricted-proxy') fail('TYPED_INSPECTION_PROVIDER_NETWORK_NOT_CONFIGURED')
      const schema = await this.measureBinary(this.profile); checkActive()
      engineState = this._prepareRequestState(binding, { requireExistingState, nativeExecution: true, nativeBinding: layout.binding })
      slot.engineState = engineState
      const skillConfigurationDirectory = ensurePrivateDirectory(resolve(engineState.directory, 'skill-config'))
      for (const item of layout.skillConfiguration) stateMarker(skillConfigurationDirectory, item.configuration, `${item.skillKey}.json`)
      const neutralDirectory = ensurePrivateDirectory(resolve(engineState.directory, 'neutral'))
      const skillsDirectory = ensurePrivateDirectory(resolve(engineState.directory, 'skill-view'))
      if (readdirSync(neutralDirectory).some(name => !NATIVE_NEUTRAL_MOUNT_TARGETS.includes(name)) || readdirSync(skillsDirectory).some(key => key !== '.system' && !layout.skills.some(skill => skill.skillKey === key))) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      for (const name of NATIVE_NEUTRAL_MOUNT_TARGETS) {
        const target = ensurePrivateDirectory(resolve(neutralDirectory, name))
        if (readdirSync(target).length) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      }
      const systemMask = ensurePrivateDirectory(resolve(skillsDirectory, '.system'))
      if (readdirSync(systemMask).length) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      for (const skill of layout.skills) {
        const mountpoint = ensurePrivateDirectory(resolve(skillsDirectory, skill.skillKey))
        if (readdirSync(mountpoint).length) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      }
      egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs, additionalOrigins: layout.binding.networkOrigins })
      await egress.start(); checkActive()
      // Recheck bytes/identities after asynchronous setup, immediately before bind.
      const current = prepareNativeExecutionLayout({ ...layout, nativeExecution, toolchain: this.nativeToolchain, stateRoot: this.stateRoot, sourceHome: this.profile.codexHome })
      if (current.digest !== layout.digest) fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
      adapter = await this._spawnAdapter({ inputDirectory: layout.inputDirectory, engineState, schemaMeasurement: schema,
        networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl,
        nativeView: { layout, engineState, neutralDirectory, skillsDirectory, skillConfigurationDirectory }, nativeExecution: { ...nativeExecution, checkActive } })
      checkActive(); await egress.bindOwner(adapter.child, this.bwrap, schema.snapshotIdentity)
      const network = await egress.attach(); checkActive()
      const readback = await this._initializeAndSeal(adapter); checkActive(); verifyNativeExecutionConfig(readback)
      if (!emptyMcpCatalog(adapter.readback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      adapter.verifyNativeExecutionSkills = async () => {
        checkActive()
        const discovery = verifyNativeExecutionSkillCatalog(await adapter.request('skills/list', { cwds: ['/execution'], forceReload: true }), layout)
        checkActive(); return discovery
      }
      const discovery = await adapter.verifyNativeExecutionSkills()
      // Recheck actual engine discovery at both new/resumed thread and turn
      // boundaries; a cached startup inventory is not refresh/resume evidence.
      for (const method of ['startOrResumeThread', 'runTurn']) {
        const call = adapter[method].bind(adapter)
        adapter[method] = async (...args) => { await adapter.verifyNativeExecutionSkills(); return call(...args) }
      }
      checkActive()
      adapter.nativeExecutionIsolation = Object.freeze({ schemaVersion: 1, layoutDigest: layout.digest, cwd: '/execution',
        writableRoots: Object.freeze(['/workspace', '/outputs']), skills: discovery, network, modelTurnMeasured: false })
      this.suspendedNativeStates?.delete(binding.requestKey)
      this.activeAdapters.set(binding.requestKey, { adapter, egress, engineState, inputDirectory: layout.inputDirectory, nativeLayout: layout, nativeExecution, slot })
      adapter.once('exit', () => {
        // Keep the closed entry until per-execution suspend/release joins
        // egress cleanup; never race a new lease against a dying process.
        this.suspendedNativeStates ||= new Map(); this.suspendedNativeStates.set(binding.requestKey, engineState.directory)
        rmSync(resolve(engineState.directory, 'skill-config'), { recursive: true, force: true })
        void egress.dispose().catch(() => {})
      })
      return adapter
    } catch (error) {
      await adapter?.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress?.dispose().catch(() => {})
      if (engineState?.authPath) rmSync(engineState.authPath, { force: true })
      if (engineState?.directory) rmSync(resolve(engineState.directory, 'skill-config'), { recursive: true, force: true })
      if (engineState?.created && !slot.preserveState) rmSync(engineState.directory, { recursive: true, force: true })
      if (engineState && slot.preserveState) { this.suspendedNativeStates ||= new Map(); this.suspendedNativeStates.set(binding.requestKey, engineState.directory) }
      throw error
    }
  }
  suspendAdapter(requestKey) { return this.releaseAdapter(requestKey, { preserveState: true }) }
  async releaseAdapter(requestKey, { preserveState = false, requestBinding = null } = {}) {
    let retainedDirectory = null, expectedDirectory = null, expectedBindingDigest = null
    if (requestBinding !== null) {
      const binding = engineStateBinding(requestBinding)
      if (requestKey !== binding.requestKey) fail('NATIVE_EXECUTION_BINDING_INVALID')
      expectedBindingDigest = canonicalSha256(binding)
      const requests = resolve(this.stateRoot, 'requests')
      const directory = resolve(requests, expectedBindingDigest.slice('sha256:'.length)); expectedDirectory = directory
      if (existsSync(directory)) {
        ensurePrivateDirectory(requests); ensurePrivateDirectory(directory)
        // Read-only exact lookup after restart: never scan directories, create
        // a marker, restage auth, or invoke the engine to retire a committed Home.
        for (const name of ['binding.json', 'native-binding.json']) {
          const path = resolve(directory, name)
          if (!existsSync(path)) fail('NATIVE_EXECUTION_RECOVERY_MAPPING_MISSING')
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o400) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
        }
        if (readFileSync(resolve(directory, 'binding.json'), 'utf8') !== `${JSON.stringify(binding)}\n`) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
        let mapping; try { mapping = JSON.parse(readFileSync(resolve(directory, 'native-binding.json'), 'utf8')) } catch { fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT') }
        if (mapping?.schemaVersion !== 1 || !nonblank(mapping.executionId)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
        retainedDirectory = directory
      }
    }
    this.closingAdapters ||= new Map()
    const closing = this.closingAdapters.get(requestKey)
    if (closing) {
      await closing
      // A commit-time release following a concurrent suspension still removes
      // the retained Home, without racing a replacement adapter's startup.
      if (!preserveState) return this.releaseAdapter(requestKey, { requestBinding })
      return true
    }
    const pending = this.pendingNativeAdapters?.get(requestKey)
    const active = this.activeAdapters.get(requestKey)
    if (expectedBindingDigest && ((pending && pending.engineState.bindingDigest !== expectedBindingDigest)
        || (active && active.engineState.bindingDigest !== expectedBindingDigest))) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    if (!pending && !active) {
      const suspended = this.suspendedNativeStates?.get(requestKey) || retainedDirectory
      if (expectedDirectory && suspended && suspended !== expectedDirectory) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
      if (suspended && !preserveState) { rmSync(suspended, { recursive: true, force: true }); this.suspendedNativeStates?.delete(requestKey); return true }
      return Boolean(suspended)
    }
    const close = (async () => {
      if (pending) {
        pending.preserveState = preserveState; pending.cancelled = true; await pending.promise.catch(() => {})
        const directory = pending.engineState.directory || this.suspendedNativeStates?.get(requestKey)
        if (!preserveState && directory) { rmSync(directory, { recursive: true, force: true }); this.suspendedNativeStates?.delete(requestKey) }
        return true
      }
      if (active.slot) active.slot.cancelled = true
      try { await active.adapter.shutdown({ timeoutMs: 1000 }) } finally { await active.egress?.dispose() }
      if (this.activeAdapters.get(requestKey) === active) this.activeAdapters.delete(requestKey)
      if (active.nativeLayout) rmSync(resolve(active.engineState.directory, 'skill-config'), { recursive: true, force: true })
      if (!preserveState) { rmSync(active.engineState.directory, { recursive: true, force: true }); this.suspendedNativeStates?.delete(requestKey) }
      else {
        this.suspendedNativeStates ||= new Map()
        this.suspendedNativeStates.set(requestKey, active.engineState.directory)
      }
      return true
    })()
    this.closingAdapters.set(requestKey, close)
    try { return await close } finally { if (this.closingAdapters.get(requestKey) === close) this.closingAdapters.delete(requestKey) }
  }
  async dispose() {
    this.disposed = true
    await Promise.all([...(this.closingAdapters?.values() || [])].map(promise => promise.catch(() => {})))
    await Promise.all([...(this.pendingNativeAdapters?.values() || [])].map(slot => slot.promise.catch(() => {})))
    const active = [...this.activeAdapters.values()]; this.activeAdapters.clear()
    await Promise.all(active.map(async item => { await item.adapter.shutdown({ timeoutMs: 1000 }).catch(() => {}); await item.egress?.dispose().catch(() => {}); if (item.nativeLayout) rmSync(resolve(item.engineState.directory, 'skill-config'), { recursive: true, force: true }) }))
    if (this.providerCaTrust?.directory) rmSync(this.providerCaTrust.directory, { recursive: true, force: true })
  }
  mapInputPath(hostPath, inputDirectory) {
    const root = realpathSync(inputDirectory); const path = realpathSync(hostPath); if (!within(root, path)) fail('TYPED_INSPECTION_INPUT_PATH_OUTSIDE_REQUEST')
    return resolve('/inputs', path.slice(root.length + 1))
  }
  // Capability measurement, not an execution authorization. Each call uses an
  // isolated disposable request and never starts a model turn.
  nativeExecutionDeclaration() { return this.disposed ? null : this.nativeExecutionReadback || null }
  measureNativeExecution() {
    if (this.disposed) return Promise.resolve(null)
    if (this.nativeExecutionMeasurementPending) return this.nativeExecutionMeasurementPending
    this.nativeExecutionReadback = null
    this.nativeExecutionMeasurementFailure = null
    const pending = this._measureNativeExecution().then(result => {
      this.nativeExecutionReadback = this.disposed ? null : result
      return this.nativeExecutionReadback
    }, () => { this.nativeExecutionReadback = null; return null }).finally(() => {
      if (this.nativeExecutionMeasurementPending === pending) this.nativeExecutionMeasurementPending = null
    })
    this.nativeExecutionMeasurementPending = pending
    return pending
  }
  async _measureNativeExecution() {
    if (this.disposed || !this.nativeToolchain || this.profile.typedInspectionProviderNetwork !== 'restricted-proxy') return null
    const id = `native-declaration-${randomUUID()}`
    const binding = { schemaVersion: 1, requestKey: id, authorizationId: id, manifestDigest: id,
      requestId: id, turnId: id, inputPolicyDigest: id }
    this.nativeBrowserReady = false
    let directory, ready = false, scriptReady = false, documentReady = false, browserReady = false, pdfReady = false, stage = 'toolchain'
    try {
      validateNativeExecutionToolchain(this.nativeToolchain)
      directory = ensurePrivateDirectory(mkdtempSync(resolve(this.materializerRoot, '.native-declaration-')))
      const inputs = ensurePrivateDirectory(resolve(directory, 'inputs'))
      const scratchDirectory = ensurePrivateDirectory(resolve(directory, 'scratch'))
      const draftsDirectory = ensurePrivateDirectory(resolve(directory, 'drafts'))
      writeFileSync(resolve(inputs, 'probe.txt'), 'native-declaration-probe', { mode: 0o600 })
      const nativeExecution = { executionId: id, tools: [], checkActive: () => { if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED') },
        callTool: async () => { fail('NATIVE_EXECUTION_TOOL_UNAVAILABLE') } }
      stage = 'engine-open'
      const adapter = await this.openNativeExecutionAdapter(inputs, id, binding, { scratchDirectory, draftsDirectory, skills: [], nativeExecution })
      const network = adapter.nativeExecutionIsolation?.network
      if (network?.measured !== true || network.nftDefaultDropReadback !== true || network.directInternetBlocked !== true) fail('NATIVE_EXECUTION_NETWORK_UNVERIFIED')
      const egress = this.activeAdapters.get(id)?.egress
      stage = 'provider-tls'
      const tls = await egress.measureAllowedTls(adapter.readback.providerCaTrust)
      if (tls?.measured !== true || tls.tlsVerified !== true) fail('NATIVE_EXECUTION_PROVIDER_TLS_UNVERIFIED')
      stage = 'shell'
      const result = await adapter.request('command/exec', { command: [this.nativeToolchain.shell, '-c',
        'set -e; cat /inputs/probe.txt > /workspace/probe.txt; cat /workspace/probe.txt > /outputs/probe.txt; ! (echo bad > /inputs/probe.txt) 2>/dev/null; ! (echo bad > /state/codex-home/probe.txt) 2>/dev/null; cat /outputs/probe.txt'],
        cwd: '/execution', disableTimeout: true, sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }, null)
      if (result?.exitCode !== 0 || result.stdout !== 'native-declaration-probe'
          || readFileSync(resolve(draftsDirectory, 'probe.txt'), 'utf8') !== 'native-declaration-probe'
          || readFileSync(resolve(inputs, 'probe.txt'), 'utf8') !== 'native-declaration-probe') fail('NATIVE_EXECUTION_SHELL_UNVERIFIED')
      validateNativeExecutionToolchain(this.nativeToolchain)
      if (this.nativeToolchain.files.some(file => file.sandboxPath === DOCUMENT_PROBE)) {
        this.nativeDocumentMeasurementFailure = null
        try {
          const probe = await adapter.request('command/exec', { command: ['/usr/bin/python3', '-I', '-B', DOCUMENT_PROBE],
            cwd: '/execution', disableTimeout: true, sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }, null)
          documentReady = probe?.exitCode === 0 && probe.stdout.trim() === 'native-documents-ready'
          if (!documentReady) this.nativeDocumentMeasurementFailure = { stage: 'document-probe', code: 'NATIVE_DOCUMENT_PROBE_FAILED' }
        } catch { this.nativeDocumentMeasurementFailure = { stage: 'document-probe', code: 'NATIVE_DOCUMENT_PROBE_FAILED' } }
      }
      const browserProbe = this.nativeToolchain.files.find(file => file.sandboxPath === BROWSER_PROBE)
      if (browserProbe) {
        this.nativeBrowserMeasurementFailure = null
        try {
          const probe = await adapter.request('command/exec', { command: ['/usr/bin/node', BROWSER_PROBE], cwd: '/execution', disableTimeout: true, permissionProfile: NATIVE_PERMISSION_PROFILE }, null)
          browserReady = probe.exitCode === 0 && probe.stdout.trim() === 'native-browser-ready'
          if (!browserReady) this.nativeBrowserMeasurementFailure = { stage: 'browser-probe', code: 'NATIVE_BROWSER_PROBE_FAILED' }
        } catch { this.nativeBrowserMeasurementFailure = { stage: 'browser-probe', code: 'NATIVE_BROWSER_PROBE_FAILED' } }
      }
      if (documentReady && browserReady && this.nativeToolchain.files.some(file => file.sandboxPath === PDF_PROBE)) {
        this.nativePdfMeasurementFailure = null
        try {
          const probe = await adapter.request('command/exec', { command: ['/usr/bin/node', PDF_PROBE], cwd: '/execution', disableTimeout: true, permissionProfile: NATIVE_PERMISSION_PROFILE }, null)
          pdfReady = probe?.exitCode === 0 && probe.stdout.trim() === 'native-pdf-ready'
          if (!pdfReady) this.nativePdfMeasurementFailure = { stage: 'pdf-probe', code: 'NATIVE_PDF_PROBE_FAILED' }
        } catch { this.nativePdfMeasurementFailure = { stage: 'pdf-probe', code: 'NATIVE_PDF_PROBE_FAILED' } }
      }
      ready = !this.disposed
      if (ready) { try { scriptReady = await this._measureNativeSkillScript() } catch { this.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_MEASUREMENT_FAILED' } } }
    } catch (error) { ready = false; this.nativeExecutionMeasurementFailure = { stage, code: error.code || 'NATIVE_EXECUTION_MEASUREMENT_FAILED' } }
    finally {
      try { await this.releaseAdapter(id, { requestBinding: binding }) } catch { ready = false; this.nativeExecutionMeasurementFailure ||= { stage: 'cleanup', code: 'NATIVE_EXECUTION_CLEANUP_FAILED' } }
      try { if (directory) rmSync(directory, { recursive: true, force: true }) } catch { ready = false; this.nativeExecutionMeasurementFailure ||= { stage: 'cleanup', code: 'NATIVE_EXECUTION_CLEANUP_FAILED' } }
    }
    this.nativeBrowserReady = ready && !this.disposed && browserReady
    return ready && !this.disposed ? Object.freeze({ schemaVersion: 1, executionProtocolVersion: 5,
      toolPolicyRef: 'NATIVE_LOCAL_FILES_V1', outputMimeTypes: Object.freeze(['text/plain', 'text/markdown', 'text/html', 'application/json', ...(scriptReady || browserReady ? ['image/png'] : []), ...(documentReady ? DOCUMENT_MIMES : []), ...(pdfReady ? ['application/pdf'] : [])]),
      ...(scriptReady ? { supportedToolPolicyRefs: Object.freeze(['NATIVE_SKILL_SCRIPT_V1']) } : {}) }) : null
  }
  async _measureNativeSkillScript() {
    return measureNativeSkillScript(this)
  }
  declaration() {
    if (!this.contractReadback) return null
    return Object.freeze({ schemaVersion: 1, contract: 'juyiting-typed-inspection-v1', enabled: true, profileId: this.contractReadback.profileId,
      engineContractId: this.contractReadback.engineContractId, enginePolicyDigest: this.contractReadback.enginePolicyDigest,
      toolPolicyDigest: this.contractReadback.toolPolicyDigest, inputPolicyDigest: this.contractReadback.inputPolicyDigest,
      toolPolicy: this.contractReadback.toolPolicy, recovery: this.contractReadback.recovery, supportedInputs: this.contractReadback.supportedInputs })
  }
}
