import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

const id = value => typeof value === 'string' && value.length > 0
const deniedMethods = /(?:command|file|permission|network|mcp|dynamic.?tool|tool)/i
const terminalMethods = new Set(['turn/failed', 'turn/cancelled', 'turn/interrupted'])
export const CODEX_APP_SERVER_SCHEMA = Object.freeze({ cliVersion: '0.153.4', bundleSha256: 'b06f77062369d481a59cc70720c12b89cb9dd49c385863923262102d3ad6c978' })
export const DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID = 'codex-cli-0.153.4'
export const CODEX_APP_SERVER_SCHEMA_CONTRACTS = Object.freeze({
  [DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID]: Object.freeze({
    contractId: DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID,
    ...CODEX_APP_SERVER_SCHEMA
  }),
  'codex-cli-0.159.2': Object.freeze({
    contractId: 'codex-cli-0.159.2',
    cliVersion: '0.159.2',
    bundleSha256: '7243ba241962af92ca60581f1a81808ebda4212a800f8b205f54703bcfd508c5'
  })
})

const binaryMeasurementCache = new Map()
const binarySnapshotDirectories = new Set()
const failTrust = message => { const error = new Error(message); error.code = 'APP_SERVER_BINARY_UNTRUSTED'; error.trustReason = message; return error }
const trustCause = error => error?.trustReason || (error?.code === 'APP_SERVER_BINARY_UNTRUSTED' ? error?.message : error?.code) || 'UNKNOWN'
export const resolveCodexAppServerSchemaContract = profile => {
  const selected = typeof profile?.appServerSchemaContractId === 'string' && profile.appServerSchemaContractId.trim()
    ? profile.appServerSchemaContractId.trim()
    : DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID
  if (!Object.hasOwn(CODEX_APP_SERVER_SCHEMA_CONTRACTS, selected)) throw failTrust(`CODEX_APP_SERVER_SCHEMA_CONTRACT_UNKNOWN:${selected}`)
  return CODEX_APP_SERVER_SCHEMA_CONTRACTS[selected]
}
const hashOpenedFile = (fd, size = fstatSync(fd, { bigint: true }).size) => {
  const digest = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0n
  while (offset < size) {
    const length = Number(size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : size - offset)
    const count = readSync(fd, buffer, 0, length, Number(offset)); if (count <= 0) throw failTrust('CODEX_APP_SERVER_FILE_READ_TRUNCATED')
    digest.update(buffer.subarray(0, count)); offset += BigInt(count)
  }
  return digest.digest('hex')
}
const hashFile = path => { const fd = openSync(path, constants.O_RDONLY); try { return hashOpenedFile(fd) } finally { closeSync(fd) } }
const statIdentity = (path, stat = statSync(path, { bigint: true })) => ({
  realpath: realpathSync(path), dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
  mtimeNs: String(stat.mtimeNs), mode: Number(stat.mode & 0o777n), uid: String(stat.uid), gid: String(stat.gid)
})
const sameIdentity = (left, right) => left && right && ['realpath', 'dev', 'ino', 'size', 'mtimeNs', 'mode', 'uid', 'gid'].every(field => left[field] === right[field])
const targetPlatform = () => {
  const key = `${process.platform}:${process.arch}`
  return {
    'linux:x64': ['x86_64-unknown-linux-musl', 'codex-linux-x64'],
    'linux:arm64': ['aarch64-unknown-linux-musl', 'codex-linux-arm64'],
    'darwin:x64': ['x86_64-apple-darwin', 'codex-darwin-x64'],
    'darwin:arm64': ['aarch64-apple-darwin', 'codex-darwin-arm64'],
    'win32:x64': ['x86_64-pc-windows-msvc', 'codex-win32-x64'],
    'win32:arm64': ['aarch64-pc-windows-msvc', 'codex-win32-arm64']
  }[key]
}
const protectedAncestorPolicy = path => {
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  const chain = []; let cursor = dirname(path)
  while (true) {
    const lexical = lstatSync(cursor); if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw failTrust('CODEX_APP_SERVER_EXECUTABLE_ANCESTOR_UNSAFE')
    const stat = statSync(cursor, { bigint: true }); chain.push({ path: cursor, uid: stat.uid, mode: stat.mode & 0o777n })
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent
  }
  const privateAt = chain.findIndex(entry => uid !== null && entry.uid === uid && (entry.mode & 0o077n) === 0n)
  const protectedChain = privateAt >= 0 ? chain.slice(0, privateAt + 1) : chain
  for (const entry of protectedChain) {
    if ((entry.mode & 0o002n) !== 0n || (uid !== null && entry.uid !== 0n && entry.uid !== uid)) throw failTrust('CODEX_APP_SERVER_EXECUTABLE_ANCESTOR_UNSAFE')
  }
  return privateAt >= 0 ? 'owner-private-ancestor' : 'non-world-writable-chain'
}
const resolveExecutable = configuredPath => {
  const configured = realpathSync(configuredPath); const bytes = readFileSync(configured)
  const textPrefix = bytes.subarray(0, Math.min(bytes.length, 8192)).toString('utf8')
  const isCodexNodeLauncher = /^#!.*\bnode\b/m.test(textPrefix) && textPrefix.includes('PLATFORM_PACKAGE_BY_TARGET') && textPrefix.includes('@openai/codex-')
  if (!isCodexNodeLauncher) return { configured, executable: configured, launcher: null }
  const target = targetPlatform(); if (!target) throw failTrust('CODEX_APP_SERVER_PLATFORM_UNSUPPORTED')
  const [triple, packageName] = target; const packageRoot = resolve(dirname(configured), '..'); const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates = [
    resolve(packageRoot, 'node_modules', '@openai', packageName, 'vendor', triple, 'bin', executableName),
    resolve(dirname(packageRoot), packageName, 'vendor', triple, 'bin', executableName),
    resolve(packageRoot, 'vendor', triple, 'bin', executableName)
  ]
  for (const candidate of candidates) {
    try { const executable = realpathSync(candidate); if (statSync(executable).isFile()) return { configured, executable, launcher: configured } } catch {}
  }
  throw failTrust('CODEX_APP_SERVER_NATIVE_EXECUTABLE_MISSING')
}
const executableResources = executable => resolve(dirname(executable), '..', 'codex-resources')
const SNAPSHOT_PREFIX = '.cyf-app-server-bin-'
const SNAPSHOT_OWNER_FILE = 'owner.json'
const processStartTime = pid => {
  try { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); return raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/)[19] || '' } catch { return '' }
}
const liveProcessUsesSnapshot = directory => {
  if (process.platform !== 'linux') return false
  for (const name of readdirSync('/proc').filter(value => /^[0-9]+$/.test(value))) {
    try {
      const executable = realpathSync(`/proc/${name}/exe`)
      if (executable === directory || executable.startsWith(`${directory}/`)) return true
    } catch {}
  }
  return false
}
const resourceManifest = root => {
  if (!existsSync(root)) return []
  const rootLexical = lstatSync(root, { bigint: true }); if (rootLexical.isSymbolicLink() || !rootLexical.isDirectory()) throw failTrust('CODEX_APP_SERVER_RESOURCE_ROOT_UNSAFE')
  const entries = []
  const visit = (directory, relativePrefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name); const relativePath = relativePrefix ? `${relativePrefix}/${name}` : name; const lexical = lstatSync(path, { bigint: true })
      if (lexical.isSymbolicLink()) throw failTrust('CODEX_APP_SERVER_RESOURCE_SYMLINK')
      if (lexical.isDirectory()) { visit(path, relativePath); continue }
      if (!lexical.isFile()) throw failTrust('CODEX_APP_SERVER_RESOURCE_TYPE_UNSAFE')
      entries.push({
        relativePath, path, size: String(lexical.size), mode: Number(lexical.mode & 0o777n), sha256: hashFile(path),
        sourceIdentity: { dev: String(lexical.dev), ino: String(lexical.ino), size: String(lexical.size), mtimeNs: String(lexical.mtimeNs), mode: String(lexical.mode), uid: String(lexical.uid), gid: String(lexical.gid) }
      })
    }
  }
  visit(root); return entries
}
const manifestDigest = entries => createHash('sha256').update(JSON.stringify(entries.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 })))).digest('hex')
const resourceTelemetry = entries => ({ fileCount: entries.length, totalBytes: entries.reduce((total, entry) => total + BigInt(entry.size), 0n).toString() })
const fsyncFile = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
const fsyncDirectory = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
const fdStable = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'mode', 'uid', 'gid'].every(field => left[field] === right[field])
const copyOpenedFile = (sourceFd, target, mode) => {
  const before = fstatSync(sourceFd, { bigint: true }); if (!before.isFile()) throw failTrust('CODEX_APP_SERVER_COPY_SOURCE_NOT_REGULAR')
  const targetFd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0n
    while (offset < before.size) {
      const length = Number(before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset)
      const count = readSync(sourceFd, buffer, 0, length, Number(offset)); if (count <= 0) throw failTrust('CODEX_APP_SERVER_COPY_SOURCE_TRUNCATED')
      let written = 0
      while (written < count) { const countWritten = writeSync(targetFd, buffer, written, count - written); if (countWritten <= 0) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_WRITE_STALLED'); written += countWritten }
      offset += BigInt(count)
    }
    fsyncSync(targetFd)
  } finally { closeSync(targetFd) }
  chmodSync(target, mode); fsyncFile(target)
  const after = fstatSync(sourceFd, { bigint: true }); const targetStat = statSync(target, { bigint: true })
  if (!fdStable(before, after)) throw failTrust('CODEX_APP_SERVER_COPY_SOURCE_DRIFT')
  if (before.dev === targetStat.dev && before.ino === targetStat.ino) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_NOT_NEW_INODE')
  const sourceHash = hashOpenedFile(sourceFd, before.size); const targetHash = hashFile(target)
  if (before.size !== targetStat.size || sourceHash !== targetHash) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_COPY_MISMATCH')
  return { sha256: targetHash, size: String(targetStat.size) }
}
const writeSnapshotOwner = directory => {
  const owner = { schemaVersion: 1, pid: process.pid, startTime: processStartTime(process.pid), nonce: randomUUID() }
  const path = resolve(directory, SNAPSHOT_OWNER_FILE); const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(owner)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  chmodSync(path, 0o600); fsyncDirectory(directory); return owner
}
const safeSnapshotRoot = snapshotRoot => {
  const root = realpathSync(snapshotRoot); const lexicalRoot = lstatSync(root); const rootStat = statSync(root, { bigint: true })
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (lexicalRoot.isSymbolicLink() || !rootStat.isDirectory() || (uid !== null && rootStat.uid !== uid)) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_ROOT_UNSAFE')
  protectedAncestorPolicy(resolve(root, '.snapshot-probe')); return root
}
export function reclaimStaleCodexAppServerSnapshots(snapshotRoot, { graceMs = 5 * 60 * 1000 } = {}) {
  const root = safeSnapshotRoot(snapshotRoot); const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null; let removed = 0
  for (const name of readdirSync(root).filter(value => /^\.cyf-app-server-bin-[A-Za-z0-9]{6}$/.test(value))) {
    const directory = resolve(root, name); let lexical; let stat
    try { lexical = lstatSync(directory); stat = statSync(directory, { bigint: true }) } catch { continue }
    if (lexical.isSymbolicLink() || !lexical.isDirectory() || (uid !== null && stat.uid !== uid) || Number(stat.mode & 0o777n) !== 0o700) continue
    const age = Date.now() - Number(stat.mtimeMs); if (age < graceMs || binarySnapshotDirectories.has(directory)) continue
    const ownerPath = resolve(directory, SNAPSHOT_OWNER_FILE); let owner = null; let ownerRaw = ''
    try {
      const ownerLexical = lstatSync(ownerPath); const ownerStat = statSync(ownerPath, { bigint: true })
      // Unsafe owner-file metadata is not treated as a stale malformed record; fail closed.
      if (ownerLexical.isSymbolicLink() || !ownerLexical.isFile() || (uid !== null && ownerStat.uid !== uid) || Number(ownerStat.mode & 0o777n) !== 0o600 || ownerStat.size > 4096n) continue
      ownerRaw = readFileSync(ownerPath, 'utf8')
      try { owner = JSON.parse(ownerRaw) } catch {
        const pid = ownerRaw.match(/\"pid\"\s*:\s*([1-9][0-9]*)/); const startTime = ownerRaw.match(/\"startTime\"\s*:\s*\"([0-9]+)\"/)
        if (pid && startTime && Number.isSafeInteger(Number(pid[1]))) owner = { pid: Number(pid[1]), startTime: startTime[1] }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') continue
      ownerRaw = ''
    }
    const hasProcessIdentity = Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.startTime === 'string' && owner.startTime.length > 0
    if ((hasProcessIdentity && processStartTime(owner.pid) === owner.startTime) || liveProcessUsesSnapshot(directory)) continue
    // A missing or malformed owner is recoverable only after the private-directory age gate and
    // only when neither a locally tracked snapshot, recoverable owner identity, nor live executable uses it.
    rmSync(directory, { recursive: true, force: true }); fsyncDirectory(root); binarySnapshotDirectories.delete(directory); removed++
  }
  return removed
}
const ensureSnapshotDirectory = (root, target) => {
  const missing = []; let cursor = target
  while (cursor !== root && !existsSync(cursor)) { missing.push(cursor); const parent = dirname(cursor); if (parent === cursor) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_DIRECTORY_ESCAPE'); cursor = parent }
  if (cursor !== root && !cursor.startsWith(`${root}/`)) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_DIRECTORY_ESCAPE')
  for (const directory of missing.reverse()) { const parent = dirname(directory); mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700); fsyncDirectory(directory); fsyncDirectory(parent) }
  const lexical = lstatSync(target); if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_DIRECTORY_UNSAFE')
}
const snapshotExecutable = (sourceFd, sourceExecutable, snapshotRoot) => {
  const root = safeSnapshotRoot(snapshotRoot); reclaimStaleCodexAppServerSnapshots(root)
  const directory = mkdtempSync(resolve(root, SNAPSHOT_PREFIX)); chmodSync(directory, 0o700); fsyncDirectory(root); writeSnapshotOwner(directory)
  const binDirectory = resolve(directory, 'bin'); mkdirSync(binDirectory, { mode: 0o700 }); fsyncDirectory(directory)
  const path = resolve(binDirectory, 'codex')
  try {
    copyOpenedFile(sourceFd, path, 0o500); fsyncDirectory(binDirectory)
    const sourceResourceRoot = executableResources(sourceExecutable)
    if (existsSync(sourceResourceRoot)) {
      const targetResourceRoot = resolve(directory, 'codex-resources'); mkdirSync(targetResourceRoot, { mode: 0o700 }); fsyncDirectory(directory)
      for (const entry of resourceManifest(sourceResourceRoot)) {
        const target = resolve(targetResourceRoot, entry.relativePath); ensureSnapshotDirectory(targetResourceRoot, dirname(target))
        const resourceFd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const opened = fstatSync(resourceFd, { bigint: true })
          const openedIdentity = { dev: String(opened.dev), ino: String(opened.ino), size: String(opened.size), mtimeNs: String(opened.mtimeNs), mode: String(opened.mode), uid: String(opened.uid), gid: String(opened.gid) }
          if (!opened.isFile() || JSON.stringify(openedIdentity) !== JSON.stringify(entry.sourceIdentity)) throw failTrust('CODEX_APP_SERVER_RESOURCE_OPEN_DRIFT')
          const copied = copyOpenedFile(resourceFd, target, (entry.mode & 0o111) ? 0o500 : 0o400)
          if (copied.sha256 !== entry.sha256 || copied.size !== entry.size) throw failTrust('CODEX_APP_SERVER_RESOURCE_COPY_MISMATCH')
        } finally { closeSync(resourceFd) }
        fsyncDirectory(dirname(target))
      }
      fsyncDirectory(targetResourceRoot)
    }
    fsyncDirectory(directory)
    binarySnapshotDirectories.add(directory)
    return { directory, path, snapshotKind: 'copy' }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); fsyncDirectory(root); throw error }
}

export function cleanupCodexAppServerSnapshots() {
  for (const directory of [...binarySnapshotDirectories]) {
    try { rmSync(directory, { recursive: true, force: true }); binarySnapshotDirectories.delete(directory) } catch {}
  }
  binaryMeasurementCache.clear()
}

export function verifyCodexAppServerBinaryIdentity(profile, measurement) {
  try {
    if (!measurement?.measured || !id(measurement.snapshotPath) || process.platform !== 'linux') throw failTrust('CODEX_APP_SERVER_MEASUREMENT_REQUIRED')
    const resolved = resolveExecutable(profile.codexBin)
    const configuredIdentity = statIdentity(resolved.configured)
    configuredIdentity.sha256 = hashFile(resolved.configured)
    if (!sameIdentity(configuredIdentity, measurement.configuredIdentity) || configuredIdentity.sha256 !== measurement.configuredIdentity.sha256) throw failTrust('CODEX_APP_SERVER_CONFIGURED_EXECUTABLE_DRIFT')
    if (resolved.executable !== measurement.executableIdentity.realpath) throw failTrust('CODEX_APP_SERVER_EXECUTABLE_TARGET_DRIFT')
    const executableIdentity = statIdentity(resolved.executable)
    executableIdentity.sha256 = hashFile(resolved.executable)
    if (!sameIdentity(executableIdentity, measurement.executableIdentity) || executableIdentity.sha256 !== measurement.executableIdentity.sha256) throw failTrust('CODEX_APP_SERVER_EXECUTABLE_IDENTITY_DRIFT')
    const executableResourceManifest = resourceManifest(executableResources(resolved.executable)); const executableResourceTelemetry = resourceTelemetry(executableResourceManifest)
    if (manifestDigest(executableResourceManifest) !== measurement.resourceDigest || executableResourceTelemetry.fileCount !== measurement.resourceFileCount || executableResourceTelemetry.totalBytes !== measurement.resourceBytes) throw failTrust('CODEX_APP_SERVER_RESOURCE_DRIFT')
    const lexicalSnapshot = lstatSync(measurement.snapshotPath)
    if (lexicalSnapshot.isSymbolicLink() || !lexicalSnapshot.isFile()) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_UNSAFE')
    const snapshotIdentity = statIdentity(measurement.snapshotPath)
    snapshotIdentity.sha256 = hashFile(measurement.snapshotPath)
    if (!sameIdentity(snapshotIdentity, measurement.snapshotIdentity) || snapshotIdentity.sha256 !== measurement.snapshotIdentity.sha256) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_DRIFT')
    if (measurement.snapshotKind !== 'copy' || (snapshotIdentity.dev === executableIdentity.dev && snapshotIdentity.ino === executableIdentity.ino)) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_NOT_ISOLATED')
    const snapshotResources = resourceManifest(executableResources(measurement.snapshotPath))
    if (snapshotResources.some(entry => ![0o400, 0o500].includes(entry.mode))) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_RESOURCE_MODE_UNSAFE')
    const snapshotResourceTelemetry = resourceTelemetry(snapshotResources)
    if (snapshotIdentity.mode !== 0o500 || snapshotIdentity.sha256 !== executableIdentity.sha256 || manifestDigest(snapshotResources) !== measurement.resourceDigest || snapshotResourceTelemetry.fileCount !== measurement.resourceFileCount || snapshotResourceTelemetry.totalBytes !== measurement.resourceBytes) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_CONTENT_DRIFT')
    return true
  } catch (error) {
    if (error.code === 'APP_SERVER_BINARY_UNTRUSTED') throw error
    throw failTrust(`CODEX_APP_SERVER_IDENTITY_RECHECK_FAILED:${error.code || error.message}`)
  }
}

export async function verifySpawnedAppServerExecutable(child, measurement, { timeoutMs = 1500 } = {}) {
  const reject = message => {
    try { if (child?.exitCode === null && !child?.killed) child.kill('SIGKILL') } catch {}
    throw failTrust(message)
  }
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || !measurement?.snapshotIdentity || !id(measurement.snapshotPath)) return reject('CODEX_APP_SERVER_CHILD_IDENTITY_REQUIRED')
  const deadline = Date.now() + timeoutMs; const procExe = `/proc/${child.pid}/exe`; let matched = false
  while (Date.now() <= deadline && child.exitCode === null) {
    try {
      const stat = statSync(procExe, { bigint: true })
      if (String(stat.dev) === measurement.snapshotIdentity.dev && String(stat.ino) === measurement.snapshotIdentity.ino && String(stat.size) === measurement.snapshotIdentity.size) { matched = true; break }
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  if (!matched) return reject('CODEX_APP_SERVER_CHILD_EXECUTABLE_MISMATCH')
  let digest
  try { digest = hashFile(procExe) } catch (error) { return reject(`CODEX_APP_SERVER_CHILD_EXECUTABLE_PROBE_FAILED:${error.code || error.message}`) }
  if (digest !== measurement.snapshotIdentity.sha256) return reject('CODEX_APP_SERVER_CHILD_EXECUTABLE_HASH_MISMATCH')
  return { measured: true, pid: child.pid, dev: measurement.snapshotIdentity.dev, ino: measurement.snapshotIdentity.ino, size: measurement.snapshotIdentity.size, sha256: digest }
}

export function measureCodexAppServerBinary(profile, {
  expected = resolveCodexAppServerSchemaContract(profile), spawnSyncFn = spawnSync, cache = binaryMeasurementCache, temporaryRoot = tmpdir(), snapshotRoot = profile.codexHome || temporaryRoot
} = {}) {
  if (process.platform !== 'linux') throw failTrust('CODEX_APP_SERVER_IMMUTABLE_SNAPSHOT_UNSUPPORTED')
  let resolved; let configuredIdentity; let executableIdentity; let sourceFd
  try {
    resolved = resolveExecutable(profile.codexBin)
    configuredIdentity = statIdentity(resolved.configured); configuredIdentity.sha256 = hashFile(resolved.configured)
    executableIdentity = statIdentity(resolved.executable); executableIdentity.sha256 = hashFile(resolved.executable)
    configuredIdentity.ancestorPolicy = protectedAncestorPolicy(resolved.configured)
    executableIdentity.ancestorPolicy = protectedAncestorPolicy(resolved.executable)
  } catch (error) { if (error.code === 'APP_SERVER_BINARY_UNTRUSTED') throw error; throw failTrust(`CODEX_APP_SERVER_BINARY_MEASUREMENT_FAILED:${error.code || error.message}`) }
  const cacheKey = createHash('sha256').update(JSON.stringify({ configuredIdentity, executableIdentity, expected })).digest('hex')
  const cached = cache.get(cacheKey)
  if (cached) { verifyCodexAppServerBinaryIdentity(profile, cached); return cached }
  try { sourceFd = openSync(resolved.executable, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { throw failTrust(`CODEX_APP_SERVER_EXECUTABLE_OPEN_FAILED:${error.code || error.message}`) }
  let snapshot
  try {
    snapshot = snapshotExecutable(sourceFd, resolved.executable, snapshotRoot)
  } catch (error) {
    closeSync(sourceFd); throw failTrust(`CODEX_APP_SERVER_SNAPSHOT_FAILED:${trustCause(error)}`)
  }
  closeSync(sourceFd)
  const snapshotIdentity = statIdentity(snapshot.path); snapshotIdentity.sha256 = hashFile(snapshot.path); snapshotIdentity.ancestorPolicy = protectedAncestorPolicy(snapshot.path)
  const version = spawnSyncFn(snapshot.path, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome || '' } })
  if (version.error || version.status !== 0 || version.signal) { binarySnapshotDirectories.delete(snapshot.directory); rmSync(snapshot.directory, { recursive: true, force: true }); throw failTrust('CODEX_APP_SERVER_VERSION_MEASUREMENT_FAILED') }
  const versionOutput = String(version.stdout || '').trim()
  if (versionOutput !== `codex-cli ${expected.cliVersion}`) { binarySnapshotDirectories.delete(snapshot.directory); rmSync(snapshot.directory, { recursive: true, force: true }); throw failTrust(`CODEX_APP_SERVER_VERSION_MISMATCH:${versionOutput}`) }
  const generated = mkdtempSync(resolve(temporaryRoot, 'codex-app-server-schema-'))
  try {
    const schema = spawnSyncFn(snapshot.path, ['app-server', 'generate-json-schema', '--experimental', '--out', generated], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome || '' }
    })
    if (schema.error || schema.status !== 0 || schema.signal) throw failTrust('CODEX_APP_SERVER_SCHEMA_MEASUREMENT_FAILED')
    const bundle = readFileSync(resolve(generated, 'codex_app_server_protocol.schemas.json'))
    const bundleSha256 = createHash('sha256').update(bundle).digest('hex')
    if (bundleSha256 !== expected.bundleSha256) throw failTrust(`CODEX_APP_SERVER_SCHEMA_MISMATCH:${bundleSha256}`)
    const resources = resourceManifest(executableResources(resolved.executable)); const telemetry = resourceTelemetry(resources)
    const measurement = {
      measured: true, schemaContractId: expected.contractId || null, cliVersion: expected.cliVersion, versionOutput, bundleSha256, snapshotKind: snapshot.snapshotKind,
      binarySha256: executableIdentity.sha256, binaryIdentityDigest: cacheKey, resourceDigest: manifestDigest(resources),
      resourceFileCount: telemetry.fileCount, resourceBytes: telemetry.totalBytes,
      configuredIdentity: Object.freeze(configuredIdentity), executableIdentity: Object.freeze(executableIdentity), snapshotIdentity: Object.freeze(snapshotIdentity)
    }
    Object.defineProperty(measurement, 'snapshotPath', { value: snapshot.path, enumerable: false })
    Object.freeze(measurement); verifyCodexAppServerBinaryIdentity(profile, measurement); cache.set(cacheKey, measurement); return measurement
  } catch (error) {
    binarySnapshotDirectories.delete(snapshot.directory); rmSync(snapshot.directory, { recursive: true, force: true })
    if (error.code === 'APP_SERVER_BINARY_UNTRUSTED') throw error
    throw failTrust(`CODEX_APP_SERVER_SCHEMA_MEASUREMENT_FAILED:${error.code || error.message}`)
  } finally { rmSync(generated, { recursive: true, force: true }) }
}

export class AppServerAdapter extends EventEmitter {
  static spawn(profile, { spawnFn = spawn, cwd, requestTimeoutMs = 15000, schemaMeasurement = null } = {}) {
    verifyCodexAppServerBinaryIdentity(profile, schemaMeasurement)
    const child = spawnFn(schemaMeasurement.snapshotPath, ['app-server'], {
      cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome, NO_PROXY: '*', no_proxy: '*' }
    })
    return new AppServerAdapter({ child, requestTimeoutMs, schemaMeasurement })
  }
  async verifySpawnedExecutable(options = {}) {
    const probe = await verifySpawnedAppServerExecutable(this.child, this.readback.schema, options)
    this.readback.processExecutable = probe; return probe
  }
  constructor({ child, send = null, now = Date.now, requestTimeoutMs = 15000, maxStderrBytes = 1024 * 1024, schemaMeasurement = null } = {}) {
    super(); if (!child) throw new Error('APP_SERVER_CHILD_REQUIRED')
    this.child = child; this.now = now; this.requestTimeoutMs = requestTimeoutMs; this.maxStderrBytes = maxStderrBytes
    this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.stderrBytes = 0; this.closed = false
    this.turns = new Map(); this.readback = { initialize: null, account: null, models: null, config: null, tools: null, eventMethods: [], schema: schemaMeasurement || { ...CODEX_APP_SERVER_SCHEMA, measured: false } }
    this.send = send || (frame => child.stdin.write(`${JSON.stringify(frame)}\n`))
    child.stdout.on('data', chunk => this._onData(chunk.toString('utf8')))
    child.stderr?.on('data', chunk => { this.stderrBytes += chunk.length; if (this.stderrBytes > this.maxStderrBytes) this.close(new Error('APP_SERVER_STDERR_LIMIT')) })
    child.on('error', error => this.close(error)); child.on('exit', () => this.close(new Error('APP_SERVER_EXITED')))
  }
  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('APP_SERVER_CLOSED'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); const error = new Error(`APP_SERVER_RPC_TIMEOUT:${method}`); error.code = 'APP_SERVER_RPC_TIMEOUT'; reject(error) }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, method, timer }); this.send({ id: requestId, method, params })
    })
  }
  notify(method, params = {}) { if (!this.closed) this.send({ method, params }) }
  async initialize() {
    if (this.readback.schema?.measured === true && !this.readback.processExecutable) await this.verifySpawnedExecutable()
    this.readback.initialize = await this.request('initialize', { clientInfo: { name: 'cyf-juyiting-runtime', version: '2' } })
    this.notify('initialized', {})
    this.readback.account = await this.request('account/read', { refreshToken: false })
    this.readback.models = await this.request('model/list', {})
    this.readback.config = await this.request('config/read', {})
    this.readback.tools = await this.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }).catch(error => ({ unavailable: true, reason: error.code || error.message }))
    return this.readback
  }
  async startOrResumeThread(binding, policy) {
    const params = { cwd: policy.cwd, model: policy.model || undefined, approvalPolicy: 'never', sandbox: 'read-only', config: { ...(policy.config || {}), network: false }, developerInstructions: policy.developerInstructions || policy.instructions || '', ...(policy.baseInstructions ? { baseInstructions: policy.baseInstructions } : {}) }
    const result = binding?.threadId ? await this.request('thread/resume', { threadId: binding.threadId, ...params }) : await this.request('thread/start', params)
    const threadId = result?.thread?.id || result?.threadId
    if (!id(threadId)) throw new Error('APP_SERVER_THREAD_ID_MISSING')
    return { ...(binding || {}), threadId, state: 'HOT', updatedAt: this.now() }
  }
  async runTurn({ threadId, clientUserMessageId, input, policy = {}, onAccepted = () => {}, onDelta = () => {}, onClarification = () => {} }) {
    if (!id(threadId) || !id(clientUserMessageId)) throw new Error('TURN_BINDING_REQUIRED')
    const provisional = `${threadId}:${clientUserMessageId}`
    if (this.turns.has(provisional)) throw new Error('TURN_ALREADY_ACTIVE')
    const turn = { threadId, clientUserMessageId, state: 'STARTING', startedAt: this.now(), turnId: null }
    this.turns.set(provisional, turn)

    let finalContent = ''; let settled = false; const buffered = []
    let resolveTerminal; let rejectTerminal
    const terminalPromise = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject })
    const cleanup = () => {
      this.off('delta', delta); this.off('final', final); this.off('terminal', terminal)
      this.off('clarification', clarification); this.off('policy_violation', violation); this.off('exit', exited)
      this.turns.delete(provisional)
      if (turn.turnId) this.turns.delete(`${threadId}:${turn.turnId}`)
    }
    const matches = event => event.threadId === threadId && event.turnId === turn.turnId
    const settle = (error, value) => {
      if (settled) return
      settled = true; cleanup()
      if (error) rejectTerminal(error); else resolveTerminal(value)
    }
    const consume = (kind, event) => {
      if (event.threadId !== threadId) return
      if (!turn.turnId) { buffered.push([kind, event]); return }
      if (!matches(event)) return
      if (kind === 'delta') onDelta(event)
      else if (kind === 'final') finalContent = event.content
      else if (kind === 'clarification') onClarification(event)
      else if (kind === 'violation') settle(Object.assign(new Error(event.code), { code: event.code }))
      else if (kind === 'terminal') {
        if (event.status === 'completed') settle(null, { turnId: turn.turnId, threadId, content: finalContent, finishReason: 'completed' })
        else settle(Object.assign(new Error(`TURN_${event.status.toUpperCase()}`), { code: `TURN_${event.status.toUpperCase()}` }))
      }
    }
    const delta = event => consume('delta', event)
    const final = event => consume('final', event)
    const terminal = event => consume('terminal', event)
    const clarification = event => consume('clarification', event)
    const violation = event => consume('violation', event)
    const exited = () => { if (turn.turnId) settle(Object.assign(new Error('APP_SERVER_EXITED_DURING_TURN'), { code: 'TURN_ACCEPTANCE_UNKNOWN', turn: { ...turn } })) }
    this.on('delta', delta); this.on('final', final); this.on('terminal', terminal)
    this.on('clarification', clarification); this.on('policy_violation', violation); this.on('exit', exited)

    let response
    try {
      const userInput = Array.isArray(input) ? input : [{ type: 'text', text: String(input) }]
      response = await this.request('turn/start', { threadId, clientUserMessageId, input: userInput, cwd: policy.cwd, model: policy.model || undefined, effort: policy.effort || undefined, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, ...(policy.outputSchema ? { outputSchema: policy.outputSchema } : {}) })
    } catch (cause) {
      cleanup(); turn.state = 'ACCEPTANCE_UNKNOWN'; turn.error = cause.message
      const reconciliation = await this.reconcileTurn(turn).catch(() => ({ status: 'RECOVERY_REQUIRED' }))
      const error = Object.assign(cause, { code: 'TURN_ACCEPTANCE_UNKNOWN', turn: { ...turn }, reconciliation })
      this.emit('recovery_required', { ...turn, reconciliation }); throw error
    }
    const turnId = response?.turn?.id || response?.turnId
    if (!id(turnId)) {
      cleanup(); turn.state = 'ACCEPTANCE_UNKNOWN'
      const reconciliation = await this.reconcileTurn(turn).catch(() => ({ status: 'RECOVERY_REQUIRED' }))
      this.emit('recovery_required', { ...turn, reason: 'TURN_START_RESPONSE_MISSING_ID', reconciliation })
      throw Object.assign(new Error('TURN_START_RESPONSE_MISSING_ID'), { code: 'TURN_ACCEPTANCE_UNKNOWN', turn: { ...turn }, reconciliation })
    }
    turn.turnId = turnId; turn.state = 'RUNNING'; this.turns.set(`${threadId}:${turnId}`, turn); onAccepted({ threadId, turnId })
    for (const [kind, event] of buffered.splice(0)) consume(kind, event)
    return terminalPromise
  }
  async reconcileTurn({ threadId, turnId = null, clientUserMessageId = null }) {
    try {
      const result = await this.request('thread/read', { threadId, includeTurns: true })
      const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : []
      const matched = turns.find(candidate => candidate?.id === turnId || (clientUserMessageId && candidate?.items?.some(item => item?.type === 'userMessage' && item?.clientId === clientUserMessageId)))
      if (!matched) return { status: 'ABSENT', result, turnId, clientUserMessageId }
      if (matched.status === 'inProgress') return { status: 'ACCEPTED', result, turn: matched, turnId: matched.id, clientUserMessageId }
      if (['completed', 'failed', 'interrupted'].includes(matched.status)) return { status: 'TERMINAL', terminalStatus: matched.status, error: matched.error || null, result, turn: matched, turnId: matched.id, clientUserMessageId }
      return { status: 'RECOVERY_REQUIRED', result, turn: matched, turnId: matched.id, clientUserMessageId }
    } catch {
      return { status: 'RECOVERY_REQUIRED', turnId, clientUserMessageId }
    }
  }
  interrupt(threadId, turnId) { return this.request('turn/interrupt', { threadId, turnId }) }
  unsubscribe(threadId) { return this.request('thread/unsubscribe', { threadId }) }
  compact(threadId) { return this.request('thread/compact/start', { threadId }) }
  archive(threadId) { return this.request('thread/archive', { threadId }) }
  close(reason = new Error('APP_SERVER_CLOSED')) {
    if (this.closed) return; this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason) } this.pending.clear()
    try { if (this.child.exitCode === null && !this.child.killed) this.child.kill('SIGTERM') } catch {}
    this.emit('exit', reason)
  }
  async shutdown({ timeoutMs = 5000 } = {}) {
    const child = this.child
    this.close(new Error('APP_SERVER_DISPOSED'))
    if (child.exitCode !== null) return
    await new Promise(resolveShutdown => {
      let settled = false
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); child.off('exit', finish); resolveShutdown() }
      child.once('exit', finish)
      const timer = setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL') } catch {}
        setTimeout(finish, 100).unref?.()
      }, timeoutMs)
      timer.unref?.()
    })
  }
  _onData(data) {
    this.buffer += data
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) { this.close(new Error('APP_SERVER_FRAME_LIMIT')); return }
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); if (!line.trim()) continue; let frame; try { frame = JSON.parse(line) } catch { this.emit('protocol_error', new Error('APP_SERVER_INVALID_JSON')); continue } this._frame(frame) }
  }
  _frame(frame) {
    if (frame.id != null && (frame.result !== undefined || frame.error !== undefined)) { const pending = this.pending.get(frame.id); if (!pending) return; this.pending.delete(frame.id); clearTimeout(pending.timer); if (frame.error) pending.reject(Object.assign(new Error(frame.error.message || 'APP_SERVER_RPC_ERROR'), { code: frame.error.code })); else pending.resolve(frame.result); return }
    if (!frame.method) return
    if (!this.readback.eventMethods.includes(frame.method)) this.readback.eventMethods.push(frame.method)
    if (frame.id != null || deniedMethods.test(frame.method)) { this._denyServerRequest(frame); return }
    const params = frame.params || {}; const threadId = params.threadId || params.thread_id; const turnId = params.turnId || params.turn_id || params.turn?.id
    if (frame.method === 'item/agentMessage/delta') { const content = params.delta || params.text || params.content; if (typeof content === 'string' && content) this.emit('delta', { threadId, turnId, content }); return }
    if (frame.method === 'item/agentMessage') { const content = params.text || params.content || params.item?.text; if (typeof content === 'string') this.emit('final', { threadId, turnId, content }); return }
    if (frame.method === 'item/completed') { const item = params.item || {}; if (['agentMessage', 'agent_message'].includes(item.type) && typeof item.text === 'string') this.emit('final', { threadId, turnId, content: item.text }); return }
    if (frame.method === 'turn/completed') {
      const turn = params.turn
      const status = turn?.status; const completedTurnId = turn?.id
      if (!id(completedTurnId) || !['completed', 'interrupted', 'failed', 'inProgress'].includes(status)) { this.emit('protocol_error', new Error('APP_SERVER_INVALID_TURN_COMPLETED')); return }
      if (status !== 'inProgress') this.emit('terminal', { threadId, turnId: completedTurnId, status, error: turn.error || null })
      else this.emit('event', frame)
      return
    }
    if (terminalMethods.has(frame.method)) { this.emit('terminal', { threadId, turnId, status: frame.method === 'turn/cancelled' ? 'interrupted' : frame.method.slice(5), error: params.error || null }); return }
    this.emit('event', frame)
  }
  _denyServerRequest(frame) {
    const params = frame.params || {}; const threadId = params.threadId || params.thread_id; const turnId = params.turnId || params.turn_id
    const clarification = /user.?input/i.test(frame.method)
    if (clarification) this.emit('clarification', { threadId, turnId, request: frame.method })
    else this.emit('policy_violation', { threadId, turnId, request: frame.method, code: 'FAST_CHAT_TOOL_POLICY_VIOLATION' })
    if (frame.id != null) this.send({ id: frame.id, error: { code: -32001, message: clarification ? 'Clarification only; it cannot authorize execution' : 'Denied by read-only-constrained CHAT policy' } })
    if (!clarification && id(threadId) && id(turnId)) void this.interrupt(threadId, turnId).catch(() => {})
  }
}
