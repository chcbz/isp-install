import { observeSandboxStartup } from './sandbox-startup.mjs'

import { initializeNativeToolchain } from './native-document-toolchain.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

import { AppServerAdapter, measureCodexAppServerBinaryAsync, verifySpawnedAppServerExecutableTree } from './app-server-adapter.mjs'
import { canonicalSha256 } from './chat-runtime.mjs'
import { RestrictedProviderEgress } from './typed-inspection-network.mjs'

import { CHAT_FILE_PERMISSION_PROFILE, buildChatFileCodexConfig, nativeToolchainMountArgs, buildNativeExecutionCodexConfig, loadNativeModelCatalog, nativeExecutionMountArgs, prepareNativeExecutionLayout, validateNativeExecutionToolchain } from './native-execution-profile.mjs'

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
const CHAT_FILE_MOUNTS = Object.freeze([...SANDBOX_MOUNTS, 'pinned-toolchain:ro'])
// Startup-only probe through the same Codex permission profile used by CHAT.
// It performs no provider/model request and creates no business execution.
export const measureChatFileTools = async (adapter, state) => {
  const script = `import os, tempfile
from pathlib import Path
from docx import Document
from openpyxl import Workbook, load_workbook
from pypdf import PdfReader, PdfWriter
assert Path('/inputs/.cyf-inspection-profile-probe.txt').read_text() == 'typed-inspection-profile-probe\\n'
assert not Path(os.environ['CODEX_HOME'], 'auth.json').exists()
assert not any(Path(p).exists() for p in ['/outputs', '/workspace', '/execution', '/skill-config'])
with tempfile.TemporaryDirectory() as d:
    p = Path(d)
    doc = Document(); doc.add_paragraph('chat-file-probe'); doc.save(p / 'a.docx')
    assert Document(p / 'a.docx').paragraphs[0].text == 'chat-file-probe'
    book = Workbook(); book.active['A1'] = 'chat-file-probe'; book.save(p / 'a.xlsx'); book.close()
    book = load_workbook(p / 'a.xlsx', read_only=True); assert book.active['A1'].value == 'chat-file-probe'; book.close()
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
    with open(p / 'a.pdf', 'wb') as f: writer.write(f)
    assert len(PdfReader(p / 'a.pdf').pages) == 1
for target in ['/inputs/.cyf-inspection-profile-probe.txt', os.environ['CODEX_HOME'] + '/chat-write-probe']:
    try:
        with open(target, 'a') as f: f.write('forbidden')
    except PermissionError: pass
    except OSError as e:
        if e.errno != 30: raise
    else: raise AssertionError('write unexpectedly allowed: ' + target)
print('chat-files-ready')
`
  const result = await adapter.request('command/exec', { command: ['/usr/bin/python3', '-I', '-B', '-c', script],
    cwd: state.chatWorkdir, disableTimeout: true, permissionProfile: CHAT_FILE_PERMISSION_PROFILE }, null)
  if (result?.exitCode !== 0 || result.stdout?.trim() !== 'chat-files-ready') fail('CHAT_FILE_TOOLS_UNVERIFIED')
  return Object.freeze({ permissionProfile: CHAT_FILE_PERMISSION_PROFILE, probeDigest: canonicalSha256(script),
    inputReadable: true, inputWriteDenied: true, homeWriteDenied: true, tempWritable: true, documentToolsReady: true })
}
const PROVIDER_CA_SANDBOX_PATH = '/trust/ca-bundle.pem'
const DEFAULT_CA_BUNDLES = Object.freeze(['/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/certs/ca-certificates.crt'])
const bwrapPolicy = identity => Object.freeze({ version: identity.version, sha256: identity.sha256 })
const exactSupportedInputs = value => {
  if (!Array.isArray(value) || value.length === 0) fail('TYPED_INSPECTION_SUPPORTED_INPUTS_REQUIRED')
  const result = []; const seen = new Set()
  for (const item of value) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'carrier,carrierContractDigest,mediaKind,mimeType' ||
        !nonblank(item.mediaKind) || !nonblank(item.mimeType) || !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT', 'LOCAL_FILE'].includes(item.carrier) || !DIGEST.test(item.carrierContractDigest)) fail('TYPED_INSPECTION_SUPPORTED_INPUT_INVALID')
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
const usesChatFiles = profile => profile?.typedInspectionSupportedInputs?.some(input => input.carrier === 'LOCAL_FILE') === true
export const buildTypedInspectionCodexConfig = profile => {
  const systemProxy = profile?.typedInspectionProviderNetwork === 'restricted-proxy' ? '[features]\nrespect_system_proxy = true\n' : ''
  const config = `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n${providerConfig(profile)}${systemProxy}`
  return usesChatFiles(profile) ? buildChatFileCodexConfig(config) : config
}
const stageCodexHome = (profile, stateRoot, { nativeExecution = false, webSearch = 'disabled', modelCatalog = null } = {}) => {
  const codexHome = ensurePrivateDirectory(resolve(stateRoot, 'codex-home')); ensurePrivateDirectory(resolve(stateRoot, 'home'))
  const sourceAuth = resolve(profile.codexHome || '', 'auth.json')
  if (!profile.codexHome || !existsSync(sourceAuth)) fail('TYPED_INSPECTION_AUTH_SOURCE_REQUIRED')
  const authDigest = copyCredentialFile(sourceAuth, resolve(codexHome, 'auth.json'))
  const modelCatalogPath = nativeExecution && modelCatalog ? stateMarker(codexHome, JSON.parse(modelCatalog.text), 'model-catalog.json') : null
  const readOnlyConfig = (modelCatalogPath ? 'model_catalog_json = "/state/codex-home/model-catalog.json"\n' : '') + buildTypedInspectionCodexConfig(nativeExecution ? { ...profile, typedInspectionSupportedInputs: [] } : profile)
  const config = nativeExecution ? buildNativeExecutionCodexConfig(readOnlyConfig, { webSearch }) : readOnlyConfig
  const configPath = resolve(codexHome, 'config.toml'); const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, config, { mode: 0o600, flag: 'wx' }); chmodSync(temporary, 0o600)
  const configFd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(configFd) } finally { closeSync(configFd) }
  renameSync(temporary, configPath); fsyncDirectory(codexHome)
  return { codexHome, modelCatalogPath, authPath: resolve(codexHome, 'auth.json'), authDigest, configDigest: `sha256:${sha256(Buffer.from(config))}` }
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
  if (lexical.isSymbolicLink() || !lexical.isFile() || Number(lexical.mode & 0o777n) !== 0o400) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
  if (readFileSync(path, 'utf8') !== serialized) fail(filename === 'native-binding.json' ? 'NATIVE_EXECUTION_RECOVERY_ENVIRONMENT_CHANGED' : 'TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
  return path
}
const sealCredential = (engineState, processPid) => {
  const lexical = lstatSync(engineState.authPath, { bigint: true })
  if (lexical.isSymbolicLink() || !lexical.isFile() || Number(lexical.mode & 0o777n) !== 0o600) fail('TYPED_INSPECTION_AUTH_COPY_UNSAFE')
  unlinkSync(engineState.authPath); fsyncDirectory(engineState.codexHome)
  if (existsSync(engineState.authPath) || existsSync(`/proc/${processPid}/root${engineState.sandboxStatePath || '/state'}/codex-home/auth.json`)) fail('TYPED_INSPECTION_AUTH_VISIBLE_AFTER_INITIALIZE')
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
const sandboxArgs = ({ snapshot, stateRoot, stateMountPath = '/state', chatWorkdir = '/inputs', inputDirectory, networkMode, proxyUrl = '', caTrust = null, nativeView = null, chatToolchain = null }) => {
  const args = ['--unshare-all']
  args.push('--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--ro-bind', snapshot, '/runtime', '--dir', '/inputs', '--ro-bind', inputDirectory, '/inputs')
  if (!nativeView) args.push('--dir', stateMountPath, '--bind', stateRoot, stateMountPath)
  if (networkMode === 'provider-restricted') {
    if (!caTrust) fail('TYPED_INSPECTION_CA_SOURCE_REQUIRED')
    verifyStagedCaTrust(caTrust); args.push('--dir', '/trust', '--ro-bind', caTrust.directory, '/trust')
  }
  if (nativeView) args.push(...nativeExecutionMountArgs(nativeView))
  if (chatToolchain) {
    args.push('--uid', '65534', '--gid', '65534', '--cap-drop', 'ALL', ...nativeToolchainMountArgs(chatToolchain),
      '--setenv', 'LD_LIBRARY_PATH', '/usr/lib:/usr/lib64:/lib:/lib64', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
      '--dir', '/tmp/chat-files', '--setenv', 'TMPDIR', '/tmp/chat-files', '--setenv', 'SHELL', chatToolchain.shell, '--remount-ro', '/')
  }
  args.push('--setenv', 'HOME', `${stateMountPath}/home`, '--setenv', 'CODEX_HOME', `${stateMountPath}/codex-home`, '--setenv', 'PATH', nativeView || chatToolchain ? '/runtime/bin:/usr/bin:/bin' : '/runtime/bin')
  if (networkMode === 'provider-restricted') args.push('--setenv', 'HTTP_PROXY', proxyUrl, '--setenv', 'HTTPS_PROXY', proxyUrl, '--setenv', 'http_proxy', proxyUrl, '--setenv', 'https_proxy', proxyUrl, '--setenv', 'NO_PROXY', '', '--setenv', 'no_proxy', '', '--setenv', 'SSL_CERT_FILE', PROVIDER_CA_SANDBOX_PATH, '--setenv', 'NODE_EXTRA_CA_CERTS', PROVIDER_CA_SANDBOX_PATH)
  else args.push('--unsetenv', 'HTTP_PROXY', '--unsetenv', 'HTTPS_PROXY', '--unsetenv', 'ALL_PROXY', '--unsetenv', 'http_proxy', '--unsetenv', 'https_proxy', '--unsetenv', 'all_proxy')
  args.push('--chdir', nativeView ? '/execution' : chatWorkdir, '/runtime/bin/codex')
  return args
}
const emptyMcpCatalog = tools => Array.isArray(tools?.data) && tools.data.length === 0 && (tools.nextCursor === null || tools.nextCursor === undefined)
const verifyProcessView = ({ pid, inputDirectory, stateRoot, sandboxStatePath = '/state', sourceCodexHome, outsideCanary }) => {
  const root = `/proc/${pid}/root`; const inputName = '.cyf-inspection-profile-probe.txt'
  if (readFileSync(resolve(root, 'inputs', inputName), 'utf8') !== 'typed-inspection-profile-probe\n') fail('TYPED_INSPECTION_INPUT_VIEW_MISMATCH')
  if (existsSync(`${root}${outsideCanary}`) || existsSync(`${root}${sourceCodexHome}`) || existsSync(resolve(root, 'usr', 'bin', 'curl'))) fail('TYPED_INSPECTION_HOST_CANARY_VISIBLE')
  if (existsSync(`${root}${sandboxStatePath}/codex-home/auth.json`)) fail('TYPED_INSPECTION_AUTH_VISIBLE_AFTER_INITIALIZE')
  if (!existsSync(`${root}${sandboxStatePath}/codex-home/config.toml`)) fail('TYPED_INSPECTION_STATE_VIEW_MISSING')
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
export const buildTypedInspectionNativeAttestation = ({ schemaMeasurement, bwrap, view, isolatedConfigDigest, mcpCatalogCount, executionNetworkAttestation = null, chatFileTools = null, toolchainDigest = null }) => Object.freeze({
  schemaVersion: 1,
  schema: Object.freeze({ contractId: schemaMeasurement.schemaContractId, bundleSha256: schemaMeasurement.bundleSha256, binaryIdentityDigest: schemaMeasurement.binaryIdentityDigest }),
  bwrap: bwrapPolicy(bwrap),
  mounts: chatFileTools ? CHAT_FILE_MOUNTS : SANDBOX_MOUNTS,
  ...(chatFileTools ? { chatFileTools, toolchainDigest } : {}),
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
        !nonblank(item.mediaKind) || !nonblank(item.mimeType) || !['DIRECT_TEXT', 'LOCAL_IMAGE', 'LOCAL_AUDIO', 'PARSED_TEXT', 'LOCAL_FILE'].includes(item.carrier) ||
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

// Shared process/file/network isolation; capability-specific measurement lives in its owner.
export class IsolatedEngineProfileRuntime {
  constructor({ profile, materializerRoot, stateRoot, bwrapBin = '/usr/bin/bwrap', spawnFn = spawn, measureBinary = measureCodexAppServerBinaryAsync, forbidden = [], egressFactory = options => new RestrictedProviderEgress(options), nativeToolchain = null, initializeToolchain = initializeNativeToolchain } = {}) {
    if (!object(profile) || !nonblank(profile.agentId) || !nonblank(profile.profileId) || !nonblank(profile.codexBin) || !nonblank(profile.codexHome)) fail('TYPED_INSPECTION_PROFILE_CONFIG_INVALID')
    this.profile = profile; this.materializerRoot = ensurePrivateDirectory(materializerRoot); this.stateRoot = ensurePrivateDirectory(stateRoot)
    if (profile.typedInspectionProviderNetwork === 'restricted-proxy' && (!Number.isSafeInteger(profile.typedInspectionNetworkConnectTimeoutMs) || profile.typedInspectionNetworkConnectTimeoutMs <= 0)) fail('TYPED_INSPECTION_NETWORK_CONNECT_TIMEOUT_REQUIRED')
    if (overlaps(this.materializerRoot, this.stateRoot)) fail('TYPED_INSPECTION_PROFILE_ROOT_OVERLAP')
    for (const candidate of forbidden.filter(value => value && existsSync(resolve(value)))) if (overlaps(this.stateRoot, realpathSync(resolve(candidate)))) fail('TYPED_INSPECTION_PROFILE_ROOT_OVERLAP')
    this.providerCaTrust = profile.typedInspectionProviderNetwork === 'restricted-proxy' ? stageProviderCaTrust(profile, this.stateRoot) : null
    this.nativeModelCatalog = loadNativeModelCatalog(profile.nativeModelCatalogPath)
    this.initializeToolchain = initializeToolchain; this.nativeToolchain = nativeToolchain; this.nativeExecutionReadback = null; this.nativeExecutionMeasurementPending = null; this.pendingNativeAdapters = new Map(); this.pendingInspectionKeys = new Set(); this.closingAdapters = new Map()
    this.bwrap = bwrapIdentity(bwrapBin); this.spawnFn = spawnFn; this.measureBinary = measureBinary; this.egressFactory = egressFactory; this.measurement = null; this.contractReadback = null; this.nativeReadback = null; this.activeAdapters = new Map(); this.disposed = false
  }
  _prepareEphemeralState(label) {
    const root = ensurePrivateDirectory(resolve(this.stateRoot, 'measurement'))
    const directory = ensurePrivateDirectory(mkdtempSync(resolve(root, `.${label}-`)))
    return { directory, sandboxStatePath: directory, chatWorkdir: ensurePrivateDirectory(resolve(directory, 'chat')),
      markerPath: null, created: true, bindingDigest: null, ...stageCodexHome(this.profile, directory) }
  }
  _prepareRequestState(rawBinding, { requireExistingState = false, nativeExecution = false, nativeBinding = null, conversationKey = null } = {}) {
    if (conversationKey !== null && (nativeExecution || !/^sha256:[a-f0-9]{64}$/.test(conversationKey))) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
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
    let conversationState = null
    if (conversationKey !== null) {
      if (requireExistingState && !existsSync(resolve(directory, 'conversation-binding.json'))) fail('TYPED_INSPECTION_RECOVERY_STATE_MISSING')
      const mapping = { schemaVersion: 1, conversationKey }
      stateMarker(directory, mapping, 'conversation-binding.json')
      conversationState = this._prepareConversationState(conversationKey, { requireExistingState })
    } else if (existsSync(resolve(directory, 'conversation-binding.json'))) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    // Request receipts own directory; the separately owned Home survives ACK cleanup.
    return { ...(conversationState || { conversationDirectory: null, sandboxStatePath: '/state', chatWorkdir: '/inputs',
      ...stageCodexHome(this.profile, directory, { nativeExecution, webSearch: nativeBinding?.webSearch, modelCatalog: nativeExecution ? this.nativeModelCatalog : null }) }),
      directory, markerPath, created, bindingDigest, binding, conversationKey }
  }

  async _spawnAdapter({ inputDirectory, engineState, schemaMeasurement, networkMode = 'isolated', proxyUrl = '', nativeView = null, nativeExecution = null }) {
    if (Boolean(nativeView) !== Boolean(nativeExecution)) fail('NATIVE_EXECUTION_BINDING_INVALID')
    if (!nativeView && usesChatFiles(this.profile)) this.nativeToolchain = validateNativeExecutionToolchain(this.nativeToolchain)
    const input = realpathSync(inputDirectory); if (!nativeView && !within(this.materializerRoot, input)) fail('TYPED_INSPECTION_INPUT_DIRECTORY_OUTSIDE_ROOT')
    const lexical = lstatSync(input, { bigint: true }); if (lexical.isSymbolicLink() || !lexical.isDirectory() || Number(lexical.mode & 0o777n) !== 0o700) fail('TYPED_INSPECTION_INPUT_DIRECTORY_UNSAFE')
    if (!engineState?.directory || !within(this.stateRoot, engineState.directory) || realpathSync(engineState.directory) !== engineState.directory) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    const stateDirectory = engineState.conversationDirectory || engineState.directory
    if (!within(this.stateRoot, stateDirectory) || realpathSync(stateDirectory) !== stateDirectory) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    const args = sandboxArgs({ snapshot: snapshotDirectory(schemaMeasurement), stateRoot: stateDirectory,
      stateMountPath: engineState.sandboxStatePath || '/state', chatWorkdir: engineState.chatWorkdir || '/inputs', inputDirectory: input, networkMode, proxyUrl, caTrust: this.providerCaTrust, nativeView, chatToolchain: !nativeView && usesChatFiles(this.profile) ? this.nativeToolchain : null })
    const spawnWrapped = (_binary, commandArgs, options) => {
      verifyBwrapIdentity(this.bwrap)
      if (nativeView) {
        nativeExecution.checkActive()
        const current = prepareNativeExecutionLayout({ ...nativeView.layout, nativeExecution, toolchain: this.nativeToolchain, stateRoot: this.stateRoot, sourceHome: this.profile.codexHome })
        if (current.digest !== nativeView.layout.digest) fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
      }
      return observeSandboxStartup(this.spawnFn(this.bwrap.path, ['--info-fd', '3', ...args, ...commandArgs], { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], cwd: '/', env: { LANG: 'C.UTF-8' } })) }
    const adapter = await AppServerAdapter.spawnAsync(this.profile, { cwd: nativeView ? '/execution' : engineState.chatWorkdir || '/inputs', nativeExecution, schemaMeasurement, spawnFn: spawnWrapped, shouldSpawn: () => !this.disposed, spawnedExecutableVerifier: verifySpawnedAppServerExecutableTree })
    adapter.chatFileTools = !nativeView && usesChatFiles(this.profile)
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
  suspendAdapter(requestKey) { return this.releaseAdapter(requestKey, { preserveState: true }) }
  async releaseAdapter(requestKey, { preserveState = false, requestBinding = null, conversationKey = null } = {}) {
    const inspectionStart = this.pendingInspectionAdapters?.get(requestKey)
    if (inspectionStart) await inspectionStart.catch(() => {})
    if (conversationKey !== null && (!/^sha256:[a-f0-9]{64}$/.test(conversationKey) || !requestBinding)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
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
        const mappingName = conversationKey ? 'conversation-binding.json' : 'native-binding.json'
        for (const name of ['binding.json', mappingName]) {
          const path = resolve(directory, name)
          if (!existsSync(path)) fail('NATIVE_EXECUTION_RECOVERY_MAPPING_MISSING')
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o400) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
        }
        if (readFileSync(resolve(directory, 'binding.json'), 'utf8') !== `${JSON.stringify(binding)}\n`) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
        let mapping; try { mapping = JSON.parse(readFileSync(resolve(directory, mappingName), 'utf8')) } catch { fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT') }
        if (mapping?.schemaVersion !== 1 || (conversationKey ? mapping.conversationKey !== conversationKey : !nonblank(mapping.executionId))) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
        retainedDirectory = directory
      }
    }
    this.closingAdapters ||= new Map()
    const closing = this.closingAdapters.get(requestKey)
    if (closing) {
      await closing
      // A commit-time release following a concurrent suspension still removes
      // the retained Home, without racing a replacement adapter's startup.
      if (!preserveState) return this.releaseAdapter(requestKey, { requestBinding, conversationKey })
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
      if (active.engineState.conversationKey) this.chatAdapterLifecycle?.closing(active.adapter)
      try { await active.adapter.shutdown({ timeoutMs: 1000 }) } finally { await active.egress?.dispose() }
      if (this.activeAdapters.get(requestKey) === active) this.activeAdapters.delete(requestKey)
      const conversationKey = active.engineState.conversationKey
      if (conversationKey && this.conversationOwners?.get(conversationKey) === requestKey) this.conversationOwners.delete(conversationKey)
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
    await this.nativeExecutionMeasurementPending?.catch(() => {})
    const failures = []
    const collect = results => { for (const result of results) if (result.status === 'rejected') failures.push(result.reason) }
    await Promise.all([...(this.pendingWarmChats?.values() || [])].map(promise => promise.catch(() => {})))
    collect(await Promise.allSettled([...(this.warmChatAdapters?.entries() || [])].map(async ([key, item]) => {
      if (item.closing) await item.closing
      else { try { await item.adapter.shutdown({ timeoutMs: 1000 }) } finally { await item.egress?.dispose() } }
      if (item.emptyInputs) rmSync(item.emptyInputs, { recursive: true, force: true })
      if (this.warmChatAdapters.get(key) === item) this.warmChatAdapters.delete(key)
      if (this.conversationOwners?.get(key) === item.owner) this.conversationOwners.delete(key)
      if (this.idleWarmChatKey === key) this.idleWarmChatKey = null
    })))
    await Promise.all([...(this.pendingInspectionAdapters?.values() || [])].map(promise => promise.catch(() => {})))
    collect(await Promise.allSettled([...(this.closingAdapters?.values() || [])]))
    await Promise.all([...(this.pendingNativeAdapters?.values() || [])].map(slot => slot.promise.catch(() => {})))
    collect(await Promise.allSettled([...this.activeAdapters.entries()].map(async ([key, item]) => {
      try { await item.adapter.shutdown({ timeoutMs: 1000 }) } finally { await item.egress?.dispose() }
      if (item.nativeLayout) rmSync(resolve(item.engineState.directory, 'skill-config'), { recursive: true, force: true })
      if (this.activeAdapters.get(key) === item) this.activeAdapters.delete(key)
      const conversationKey = item.engineState.conversationKey
      if (conversationKey && this.conversationOwners?.get(conversationKey) === key) this.conversationOwners.delete(conversationKey)
    })))
    // Failed closes retain their ownership/resource references. The RuntimeHost
    // must not publish QUIESCED, remove private state or release its writer lock.
    if (failures.length) fail('TYPED_INSPECTION_SHUTDOWN_UNCONFIRMED')
    this.conversationOwners?.clear()
    if (this.providerCaTrust?.directory) rmSync(this.providerCaTrust.directory, { recursive: true, force: true })
  }

}

export { DIGEST, object, nonblank, fail, sha256, ensurePrivateDirectory, within, SANDBOX_MOUNTS, CHAT_FILE_MOUNTS, bwrapPolicy, exactSupportedInputs, usesChatFiles, stageCodexHome, engineStateBinding, stateMarker, sealCredential, emptyMcpCatalog, verifyProcessView }
