import { NATIVE_PERMISSION_PROFILE } from './native-execution-profile.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { createExecutableInspector, fileStamp } from './executable-integrity.mjs'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

const id = value => typeof value === 'string' && value.length > 0
const deniedMethods = /(?:command|file|permission|network|mcp|dynamic.?tool|tool)/i
const terminalMethods = new Set(['turn/failed', 'turn/cancelled', 'turn/interrupted'])
const binaryMeasurementCache = new Map()
const verifiedBinaryStates = new WeakMap()
const inspectExecutable = createExecutableInspector({ cacheResults: false })
const snapshotReclamationTimers = new Map()
const failTrust = message => { const error = new Error(message); error.code = 'APP_SERVER_BINARY_UNTRUSTED'; error.trustReason = message; return error }
const trustCause = error => error?.trustReason || (error?.code === 'APP_SERVER_BINARY_UNTRUSTED' ? error?.message : error?.code) || 'UNKNOWN'
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
  const configured = realpathSync(configuredPath); const fd = openSync(configured, constants.O_RDONLY)
  let textPrefix
  try { const prefix = Buffer.allocUnsafe(8192); const length = readSync(fd, prefix, 0, prefix.length, 0); textPrefix = prefix.subarray(0, length).toString('utf8') } finally { closeSync(fd) }
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
// Codex resolves companion executables next to its native binary. Preserve the
// installed distribution's codex-* siblings, without requiring them on older CLIs.
const companionManifest = executable => readdirSync(dirname(executable)).sort()
  .filter(name => /^codex-[A-Za-z0-9_.-]+$/.test(name) && !lstatSync(resolve(dirname(executable), name)).isDirectory())
  // The configured launcher may itself be a codex-* symlink to this binary.
  // It is already bound by configuredIdentity, not a companion executable.
  .filter(name => realpathSync(resolve(dirname(executable), name)) !== executable)
  .map(name => {
    const path = resolve(dirname(executable), name); const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw failTrust('CODEX_APP_SERVER_COMPANION_TYPE_UNSAFE')
    return { relativePath: name, path, size: String(stat.size), sha256: hashFile(path) }
  })
const manifestDigest = entries => createHash('sha256').update(JSON.stringify(entries.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 })))).digest('hex')
const resourceTelemetry = entries => ({ fileCount: entries.length, totalBytes: entries.reduce((total, entry) => total + BigInt(entry.size), 0n).toString() })
const fsyncDirectory = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
const safeSnapshotRoot = snapshotRoot => {
  const root = realpathSync(snapshotRoot); const lexicalRoot = lstatSync(root); const rootStat = statSync(root, { bigint: true })
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (lexicalRoot.isSymbolicLink() || !rootStat.isDirectory() || (uid !== null && rootStat.uid !== uid)) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_ROOT_UNSAFE')
  protectedAncestorPolicy(resolve(root, '.snapshot-probe')); return root
}
export function reclaimStaleCodexAppServerSnapshots(snapshotRoot, { graceMs = 5 * 60 * 1000, onDeferred = () => {} } = {}) {
  const root = safeSnapshotRoot(snapshotRoot); const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null; let removed = 0
  for (const name of readdirSync(root).filter(value => /^\.cyf-app-server-bin-[A-Za-z0-9]{6}$/.test(value))) {
    const directory = resolve(root, name); let lexical; let stat
    try { lexical = lstatSync(directory); stat = statSync(directory, { bigint: true }) } catch { continue }
    if (lexical.isSymbolicLink() || !lexical.isDirectory() || (uid !== null && stat.uid !== uid) || Number(stat.mode & 0o777n) !== 0o700) continue
    const age = Date.now() - Number(stat.mtimeMs)
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
    if (age < graceMs) { onDeferred(Math.max(1, graceMs - age)); continue }
    // A missing or malformed owner is recoverable only after the private-directory age gate and
    // only when neither a recoverable live owner identity nor live executable uses it.
    rmSync(directory, { recursive: true, force: true }); fsyncDirectory(root); removed++
  }
  return removed
}
// The measurement cache is intentionally shared across profiles: measured code,
// never HOME/auth/session state. A cache hit must still sweep that profile's own
// root, otherwise every restart strands the other profiles' previous snapshots.
const reclaimProfileSnapshots = snapshotRoot => {
  const root = safeSnapshotRoot(snapshotRoot)
  let deferred = null
  reclaimStaleCodexAppServerSnapshots(root, { onDeferred: delay => { deferred = deferred === null ? delay : Math.min(deferred, delay) } })
  if (deferred === null || snapshotReclamationTimers.has(root)) return
  const timer = setTimeout(() => {
    snapshotReclamationTimers.delete(root)
    // Maintenance must not crash an otherwise serving worker. A subsequent
    // measurement retries with the same filesystem/owner/live-process guards.
    try { reclaimProfileSnapshots(root) } catch {}
  }, deferred)
  timer.unref(); snapshotReclamationTimers.set(root, timer)
}
// Compatibility entrypoint: no system executable is owned/deleted by Runtime.
export function cleanupCodexAppServerSnapshots() {
  for (const timer of snapshotReclamationTimers.values()) clearTimeout(timer)
  snapshotReclamationTimers.clear()
  binaryMeasurementCache.clear()
}

// Direct execution no longer has a private immutable copy. Restrict the source
// and helpers/resources to protected regular files and recheck exact identities
// before spawn; /proc executable checks bind the process actually launched.
const verifySystemExecutablePolicy = executable => {
  protectedAncestorPolicy(executable)
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  for (const entry of [{ path: executable, executable: true }, ...companionManifest(executable).map(entry => ({ ...entry, executable: true })), ...resourceManifest(executableResources(executable))]) {
    const stat = lstatSync(entry.path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n
        || (entry.executable && (stat.mode & 0o111n) === 0n)
        || (uid !== null && stat.uid !== 0n && stat.uid !== uid)) throw failTrust('CODEX_APP_SERVER_SYSTEM_FILE_UNSAFE')
    protectedAncestorPolicy(entry.path)
  }
}

const binaryIntegrityState = (profile, measurement) => {
  const paths = new Set([realpathSync(profile.codexBin), measurement.executableIdentity.realpath, measurement.snapshotPath])
  const visit = path => {
    if (!existsSync(path)) return
    paths.add(path); const stat = lstatSync(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of readdirSync(path).sort()) visit(resolve(path, name))
  }
  visit(executableResources(measurement.executableIdentity.realpath)); visit(executableResources(measurement.snapshotPath))
  for (const executable of [measurement.executableIdentity.realpath, measurement.snapshotPath]) {
    // Stat-only cached rechecks: don't hash helper binaries on the main thread.
    for (const name of readdirSync(dirname(executable)).filter(name => /^codex-[A-Za-z0-9_.-]+$/.test(name) && !lstatSync(resolve(dirname(executable), name)).isDirectory())) visit(resolve(dirname(executable), name))
  }
  const contentPaths = new Set(paths)
  for (const path of [...paths]) { let parent = dirname(path); while (true) { paths.add(parent); const next = dirname(parent); if (next === parent) break; parent = next } }
  return [...paths].sort().map(path => { const stat = lstatSync(path, { bigint: true }); return [path, contentPaths.has(path) ? fileStamp(stat) : ['dev', 'ino', 'mode', 'uid', 'gid'].map(key => String(stat[key])).join(':')] })
}
export const binaryVerificationState = measurement => verifiedBinaryStates.get(measurement)
const sameVerificationState = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export function verifyCodexAppServerBinaryIdentity(profile, measurement) {
  try {
    if (!measurement?.measured || !id(measurement.snapshotPath) || process.platform !== 'linux') throw failTrust('CODEX_APP_SERVER_MEASUREMENT_REQUIRED')
    const before = binaryIntegrityState(profile, measurement)
    const resolved = resolveExecutable(profile.codexBin)
    const configuredIdentity = statIdentity(resolved.configured)
    configuredIdentity.sha256 = hashFile(resolved.configured)
    if (!sameIdentity(configuredIdentity, measurement.configuredIdentity) || configuredIdentity.sha256 !== measurement.configuredIdentity.sha256) throw failTrust('CODEX_APP_SERVER_CONFIGURED_EXECUTABLE_DRIFT')
    if (resolved.executable !== measurement.executableIdentity.realpath) throw failTrust('CODEX_APP_SERVER_EXECUTABLE_TARGET_DRIFT')
    const executableIdentity = statIdentity(resolved.executable)
    executableIdentity.sha256 = resolved.executable === resolved.configured ? configuredIdentity.sha256 : hashFile(resolved.executable)
    if (!sameIdentity(executableIdentity, measurement.executableIdentity) || executableIdentity.sha256 !== measurement.executableIdentity.sha256) throw failTrust('CODEX_APP_SERVER_EXECUTABLE_IDENTITY_DRIFT')
    const executableResourceManifest = resourceManifest(executableResources(resolved.executable)); const executableResourceTelemetry = resourceTelemetry(executableResourceManifest)
    if (manifestDigest(executableResourceManifest) !== measurement.resourceDigest || executableResourceTelemetry.fileCount !== measurement.resourceFileCount || executableResourceTelemetry.totalBytes !== measurement.resourceBytes) throw failTrust('CODEX_APP_SERVER_RESOURCE_DRIFT')
    if (manifestDigest(companionManifest(resolved.executable)) !== measurement.companionDigest || manifestDigest(companionManifest(measurement.snapshotPath)) !== measurement.companionDigest) throw failTrust('CODEX_APP_SERVER_COMPANION_DRIFT')
    const lexicalSnapshot = lstatSync(measurement.snapshotPath)
    if (lexicalSnapshot.isSymbolicLink() || !lexicalSnapshot.isFile()) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_UNSAFE')
    const snapshotIdentity = statIdentity(measurement.snapshotPath)
    snapshotIdentity.sha256 = hashFile(measurement.snapshotPath)
    if (!sameIdentity(snapshotIdentity, measurement.snapshotIdentity) || snapshotIdentity.sha256 !== measurement.snapshotIdentity.sha256) throw failTrust('CODEX_APP_SERVER_SNAPSHOT_DRIFT')
    if (measurement.snapshotKind !== 'system' || measurement.snapshotPath !== resolved.executable
        || snapshotIdentity.dev !== executableIdentity.dev || snapshotIdentity.ino !== executableIdentity.ino
        || snapshotIdentity.sha256 !== executableIdentity.sha256) throw failTrust('CODEX_APP_SERVER_SYSTEM_EXECUTABLE_MISMATCH')
    verifySystemExecutablePolicy(resolved.executable)
    if (resolved.configured !== resolved.executable) verifySystemExecutablePolicy(resolved.configured)
    if (!sameVerificationState(before, binaryIntegrityState(profile, measurement))) throw failTrust('CODEX_APP_SERVER_IDENTITY_CHANGED_DURING_RECHECK')
    verifiedBinaryStates.set(measurement, Object.freeze(before.map(row => Object.freeze(row))))
    return true
  } catch (error) {
    if (error.code === 'APP_SERVER_BINARY_UNTRUSTED') throw error
    throw failTrust(`CODEX_APP_SERVER_IDENTITY_RECHECK_FAILED:${error.code || error.message}`)
  }
}

const processChildren = pid => {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(value => /^[1-9][0-9]*$/.test(value)).map(Number) } catch { return [] }
}
const processTree = (rootPid, maxDepth = 4) => {
  const result = []; const queue = [{ pid: rootPid, depth: 0 }]; const seen = new Set()
  while (queue.length) {
    const item = queue.shift(); if (seen.has(item.pid)) continue; seen.add(item.pid); result.push(item)
    if (item.depth < maxDepth) for (const pid of processChildren(item.pid)) queue.push({ pid, depth: item.depth + 1 })
  }
  return result
}
const matchingSpawnedExecutable = async (pid, measurement) => {
  try {
    const path = `/proc/${pid}/exe`; const stat = statSync(path, { bigint: true })
    if (String(stat.dev) !== measurement.snapshotIdentity.dev || String(stat.ino) !== measurement.snapshotIdentity.ino || String(stat.size) !== measurement.snapshotIdentity.size) return null
    const inspected = await inspectExecutable(path); const digest = inspected.sha256.slice('sha256:'.length)
    if (['dev', 'ino', 'size'].some(key => inspected[key] !== measurement.snapshotIdentity[key]) || fileStamp(statSync(path, { bigint: true })) !== inspected.stamp || digest !== measurement.snapshotIdentity.sha256) return null
    return { measured: true, pid, dev: measurement.snapshotIdentity.dev, ino: measurement.snapshotIdentity.ino, size: measurement.snapshotIdentity.size, sha256: digest }
  } catch { return null }
}

export async function verifySpawnedAppServerExecutableTree(child, measurement, { signal = null, maxDepth = 4 } = {}) {
  const reject = message => {
    try { if (child?.exitCode === null && !child?.killed) child.kill('SIGKILL') } catch {}
    throw failTrust(message)
  }
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || !measurement?.snapshotIdentity || !id(measurement.snapshotPath)) return reject('CODEX_APP_SERVER_CHILD_IDENTITY_REQUIRED')
  while (child.exitCode === null && !signal?.aborted) {
    for (const item of processTree(child.pid, maxDepth)) {
      const matched = await matchingSpawnedExecutable(item.pid, measurement)
      if (matched && child.exitCode === null && !signal?.aborted) return { ...matched, wrapperPid: child.pid, depth: item.depth }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  return reject(signal?.aborted ? 'CODEX_APP_SERVER_CHILD_IDENTITY_CANCELLED' : 'CODEX_APP_SERVER_CHILD_EXECUTABLE_MISMATCH')
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
  try {
    const inspected = await inspectExecutable(procExe)
    if (child.exitCode !== null || ['dev', 'ino', 'size'].some(key => inspected[key] !== measurement.snapshotIdentity[key]) || fileStamp(statSync(procExe, { bigint: true })) !== inspected.stamp) return reject('CODEX_APP_SERVER_CHILD_EXECUTABLE_MISMATCH')
    digest = inspected.sha256.slice('sha256:'.length)
  } catch (error) { return reject(`CODEX_APP_SERVER_CHILD_EXECUTABLE_PROBE_FAILED:${error.code || error.message}`) }
  if (digest !== measurement.snapshotIdentity.sha256) return reject('CODEX_APP_SERVER_CHILD_EXECUTABLE_HASH_MISMATCH')
  return { measured: true, pid: child.pid, dev: measurement.snapshotIdentity.dev, ino: measurement.snapshotIdentity.ino, size: measurement.snapshotIdentity.size, sha256: digest }
}

export function measureCodexAppServerBinary(profile, {
  spawnSyncFn = spawnSync, cache = binaryMeasurementCache, temporaryRoot = tmpdir(), snapshotRoot = profile.codexHome || temporaryRoot
} = {}) {
  if (process.platform !== 'linux') throw failTrust('CODEX_APP_SERVER_EXECUTABLE_MEASUREMENT_UNSUPPORTED')
  reclaimProfileSnapshots(snapshotRoot)
  let resolved; let configuredIdentity; let executableIdentity
  try {
    resolved = resolveExecutable(profile.codexBin)
    // A previously verified system executable measurement needs no new full-file read
    // while the executable, resources and protected ancestors are exact.
    // ctime is included in the verification state, so restoring size/mtime is not
    // sufficient to reuse trust. Keep the original content-bound cache key/wire.
    const configuredNow = statIdentity(resolved.configured); const executableNow = statIdentity(resolved.executable)
    for (const candidate of cache.values()) {
      if (!sameIdentity(configuredNow, candidate.configuredIdentity) || !sameIdentity(executableNow, candidate.executableIdentity) || !verifiedBinaryStates.has(candidate)) continue
      try { if (sameVerificationState(verifiedBinaryStates.get(candidate), binaryIntegrityState(profile, candidate))) return candidate } catch {}
    }
    configuredIdentity = statIdentity(resolved.configured); configuredIdentity.sha256 = hashFile(resolved.configured)
    executableIdentity = statIdentity(resolved.executable); executableIdentity.sha256 = resolved.executable === resolved.configured ? configuredIdentity.sha256 : hashFile(resolved.executable)
    configuredIdentity.ancestorPolicy = protectedAncestorPolicy(resolved.configured)
    executableIdentity.ancestorPolicy = protectedAncestorPolicy(resolved.executable)
  } catch (error) { if (error.code === 'APP_SERVER_BINARY_UNTRUSTED') throw error; throw failTrust(`CODEX_APP_SERVER_BINARY_MEASUREMENT_FAILED:${error.code || error.message}`) }
  const cacheKey = createHash('sha256').update(JSON.stringify({ configuredIdentity, executableIdentity })).digest('hex')
  const cached = cache.get(cacheKey)
  if (cached) { verifyCodexAppServerBinaryIdentity(profile, cached); return cached }
  verifySystemExecutablePolicy(resolved.executable)
  // snapshotPath/Identity remain internal compatibility field names consumed by
  // the adapter and read-only inspection mount. They refer to the system binary,
  // not to a copied file; no program bytes are written into Agent state.
  if (resolved.configured !== resolved.executable) verifySystemExecutablePolicy(resolved.configured)
  const snapshot = { path: resolved.executable, snapshotKind: 'system' }
  const snapshotIdentity = statIdentity(snapshot.path); snapshotIdentity.sha256 = hashFile(snapshot.path); snapshotIdentity.ancestorPolicy = protectedAncestorPolicy(snapshot.path)
  try {
    // Version is diagnostic only. Neither its value nor schema generation is a
    // prerequisite to use the actual App Server RPCs. Integrity remains binding.
    let versionOutput = ''; let versionProbeError = null
    try {
      const version = spawnSyncFn(snapshot.path, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome || '' } })
      if (version.error || version.status !== 0 || version.signal) versionProbeError = version.error?.code || version.signal || `EXIT_${version.status}`
      else versionOutput = String(version.stdout || '').trim()
    } catch (error) { versionProbeError = error.code || 'VERSION_PROBE_FAILED' }
    const cliVersion = /^codex-cli\s+(\S+)$/.exec(versionOutput)?.[1] || null
    const resources = resourceManifest(executableResources(resolved.executable)); const telemetry = resourceTelemetry(resources)
    const measurement = {
      measured: true, schemaContractId: null, cliVersion, versionOutput, versionProbeError, bundleSha256: null, snapshotKind: snapshot.snapshotKind,
      binarySha256: executableIdentity.sha256, binaryIdentityDigest: cacheKey, resourceDigest: manifestDigest(resources),
      resourceFileCount: telemetry.fileCount, resourceBytes: telemetry.totalBytes, companionDigest: manifestDigest(companionManifest(resolved.executable)),
      configuredIdentity: Object.freeze(configuredIdentity), executableIdentity: Object.freeze(executableIdentity), snapshotIdentity: Object.freeze(snapshotIdentity)
    }
    Object.defineProperty(measurement, 'snapshotPath', { value: snapshot.path, enumerable: false })
    Object.freeze(measurement); verifyCodexAppServerBinaryIdentity(profile, measurement); cache.set(cacheKey, measurement); return measurement
  } catch (error) {
    if (error.code === 'APP_SERVER_BINARY_UNTRUSTED') throw error
    throw failTrust(`CODEX_APP_SERVER_BINARY_MEASUREMENT_FAILED:${error.code || error.message}`)
  }
}

let integrityWorker = null; let integritySequence = 0
const integrityPending = new Map()
const runBinaryIntegrity = (operation, profile, measurement = null, environment = undefined) => new Promise((resolveJob, reject) => {
  if (!integrityWorker) {
    const worker = new Worker(new URL('./app-server-integrity-worker.mjs', import.meta.url), { execArgv: [] }); integrityWorker = worker
    const failed = error => {
      if (integrityWorker !== worker) return
      integrityWorker = null
      for (const job of integrityPending.values()) job.reject(error)
      integrityPending.clear()
    }
    worker.on('error', failed); worker.on('exit', code => failed(failTrust(`CODEX_APP_SERVER_INTEGRITY_WORKER_EXIT:${code}`)))
    worker.on('message', reply => {
      const job = integrityPending.get(reply.id); if (!job) return
      integrityPending.delete(reply.id)
      if (!integrityPending.size) worker.unref()
      if (reply.error) { job.reject(Object.assign(new Error(reply.error.message), reply.error)); return }
      const result = reply.result; const snapshotPath = result.snapshotPath; delete result.snapshotPath
      Object.defineProperty(result, 'snapshotPath', { value: snapshotPath, enumerable: false })
      for (const key of ['configuredIdentity', 'executableIdentity', 'snapshotIdentity']) Object.freeze(result[key])
      Object.freeze(result); verifiedBinaryStates.set(result, Object.freeze(reply.verification.map(row => Object.freeze(row)))); job.resolve(result)
    })
  }
  const id = ++integritySequence; integrityPending.set(id, { resolve: resolveJob, reject }); integrityWorker.ref()
  try { integrityWorker.postMessage({ id, operation, profile: { codexBin: profile.codexBin, codexHome: profile.codexHome }, measurement: measurement ? { ...measurement, snapshotPath: measurement.snapshotPath } : null, environment }) }
  catch (error) { integrityPending.delete(id); if (!integrityPending.size) integrityWorker.unref(); reject(error) }
})
export const measureCodexAppServerBinaryAsync = (profile, { environment } = {}) => runBinaryIntegrity('measure', profile, null, environment)

export class AppServerAdapter extends EventEmitter {
  static async spawnAsync(profile, options = {}) {
    let measurement = options.schemaMeasurement
    const current = () => { try { return sameVerificationState(verifiedBinaryStates.get(measurement), binaryIntegrityState(profile, measurement)) } catch { return false } }
    // Reuse only this process's successful measurement while metadata is exact.
    // No TTL/path-only trust and no async gap between final stat guard and spawn.
    if (!measurement?.measured) throw failTrust('CODEX_APP_SERVER_MEASUREMENT_REQUIRED')
    if (!verifiedBinaryStates.has(measurement) || !current()) measurement = await runBinaryIntegrity('verify', profile, measurement)
    if (!current()) throw failTrust('CODEX_APP_SERVER_IDENTITY_CHANGED_BEFORE_SPAWN')
    if (options.shouldSpawn && !options.shouldSpawn()) throw Object.assign(new Error('APP_SERVER_START_CANCELLED'), { code: 'APP_SERVER_START_CANCELLED' })
    return AppServerAdapter.#spawnVerified(profile, { ...options, schemaMeasurement: measurement })
  }
  static spawn(profile, { spawnFn = spawn, cwd, requestTimeoutMs = 15000, schemaMeasurement = null, spawnedExecutableVerifier = verifySpawnedAppServerExecutable } = {}) {
    verifyCodexAppServerBinaryIdentity(profile, schemaMeasurement)
    return AppServerAdapter.#spawnVerified(profile, { spawnFn, cwd, requestTimeoutMs, schemaMeasurement, spawnedExecutableVerifier })
  }
  static #spawnVerified(profile, { spawnFn = spawn, cwd, requestTimeoutMs = 15000, schemaMeasurement, spawnedExecutableVerifier = verifySpawnedAppServerExecutable, nativeExecution = null }) {
    const child = spawnFn(schemaMeasurement.snapshotPath, ['app-server'], {
      cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CODEX_HOME: profile.codexHome, NO_PROXY: '*', no_proxy: '*' }
    })
    return new AppServerAdapter({ child, requestTimeoutMs, schemaMeasurement, spawnedExecutableVerifier, nativeExecution })
  }
  async verifySpawnedExecutable(options = {}) {
    const probe = await this.spawnedExecutableVerifier(this.child, this.readback.schema, options)
    this.readback.processExecutable = probe; return probe
  }
  constructor({ child, send = null, now = Date.now, requestTimeoutMs = 15000, maxStderrBytes = 1024 * 1024, schemaMeasurement = null, spawnedExecutableVerifier = verifySpawnedAppServerExecutable, nativeExecution = null } = {}) {
    super(); if (!child) throw new Error('APP_SERVER_CHILD_REQUIRED')
    // Only the trusted execution owner can opt in. A turn/model policy cannot
    // upgrade the CHAT adapter. Outer mount/egress isolation remains mandatory.
    if (nativeExecution && (!id(nativeExecution.executionId) || typeof nativeExecution.checkActive !== 'function'
        || typeof nativeExecution.callTool !== 'function' || !Array.isArray(nativeExecution.tools)
        || nativeExecution.tools.some(tool => tool.type !== 'function' || !id(tool.name))
        || new Set(nativeExecution.tools.map(tool => tool.name)).size !== nativeExecution.tools.length)) throw new Error('NATIVE_EXECUTION_BINDING_INVALID')
    this.nativeExecution = nativeExecution ? Object.freeze({ ...nativeExecution, tools: structuredClone(nativeExecution.tools) }) : null
    this.child = child; this.now = now; this.requestTimeoutMs = requestTimeoutMs; this.maxStderrBytes = maxStderrBytes; this.spawnedExecutableVerifier = spawnedExecutableVerifier
    this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.stderrBytes = 0; this.closed = false
    this.turns = new Map(); this.readback = { initialize: null, account: null, models: null, config: null, tools: null, eventMethods: [], schema: schemaMeasurement || { measured: false } }
    this.send = send || (frame => child.stdin.write(`${JSON.stringify(frame)}\n`))
    child.stdout.on('data', chunk => this._onData(chunk.toString('utf8')))
    child.stderr?.on('data', chunk => { this.stderrBytes += chunk.length; if (this.stderrBytes > this.maxStderrBytes) this.close(new Error('APP_SERVER_STDERR_LIMIT')) })
    // A service stop can close the child's pipe before its exit event. Stream errors
    // do not bubble to ChildProcess; settle pending RPCs instead of crashing the host.
    child.stdin?.on('error', error => this.close(error))
    child.on('error', error => this.close(error)); child.on('exit', () => this.close(new Error('APP_SERVER_EXITED')))
  }
  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('APP_SERVER_CLOSED'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      // Explicit null is for owned local readiness commands: wait for their result
      // or existing pipe/process/owner shutdown, not an arbitrary RPC deadline.
      const timer = timeoutMs === null ? null : setTimeout(() => { this.pending.delete(requestId); const error = new Error(`APP_SERVER_RPC_TIMEOUT:${method}`); error.code = 'APP_SERVER_RPC_TIMEOUT'; reject(error) }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, method, timer }); this.send({ id: requestId, method, params })
    })
  }
  notify(method, params = {}) { if (!this.closed) this.send({ method, params }) }
  async initialize() {
    if (this.readback.schema?.measured === true && !this.readback.processExecutable) await this.verifySpawnedExecutable()
    this.readback.initialize = await this.request('initialize', { clientInfo: { name: 'cyf-juyiting-runtime', version: '2' }, ...(this.nativeExecution ? { capabilities: { experimentalApi: true } } : {}) })
    this.notify('initialized', {})
    this.readback.account = await this.request('account/read', { refreshToken: false })
    this.readback.models = await this.request('model/list', {})
    this.readback.config = await this.request('config/read', {})
    this.readback.tools = await this.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }).catch(error => ({ unavailable: true, reason: error.code || error.message }))
    return this.readback
  }
  async startOrResumeThread(binding, policy) {
    const params = { cwd: policy.cwd, model: policy.model || undefined, approvalPolicy: 'never', sandbox: 'read-only', config: { ...(policy.config || {}), network: false }, developerInstructions: policy.developerInstructions || policy.instructions || '', ...(policy.baseInstructions ? { baseInstructions: policy.baseInstructions } : {}) }
    if (this.nativeExecution) {
      this.nativeExecution.checkActive()
      if (policy.cwd !== '/execution') throw new Error('NATIVE_EXECUTION_CWD_INVALID')
      delete params.sandbox
      params.permissions = NATIVE_PERMISSION_PROFILE
      // Dynamic tools are persisted with the thread by the engine. Resume does
      // not accept a replacement catalog; local dispatch still checks our set.
      if (!binding?.threadId) params.dynamicTools = this.nativeExecution.tools
    }
    const result = binding?.threadId ? await this.request('thread/resume', { threadId: binding.threadId, ...params }) : await this.request('thread/start', params)
    const threadId = result?.thread?.id || result?.threadId
    if (!id(threadId)) throw new Error('APP_SERVER_THREAD_ID_MISSING')
    return { ...(binding || {}), threadId, state: 'HOT', updatedAt: this.now() }
  }
  async runTurn({ threadId, clientUserMessageId, input, policy = {}, onAccepted = () => {}, onDelta = () => {}, onClarification = () => {}, onToolEvent = () => {} }) {
    if (!id(threadId) || !id(clientUserMessageId)) throw new Error('TURN_BINDING_REQUIRED')
    if (this.nativeExecution) {
      this.nativeExecution.checkActive()
      if (policy.cwd !== '/execution') throw new Error('NATIVE_EXECUTION_CWD_INVALID')
      if ([...this.turns.values()].some(turn => turn.threadId === threadId)) throw new Error('TURN_ALREADY_ACTIVE')
    }
    const provisional = `${threadId}:${clientUserMessageId}`
    if (this.turns.has(provisional)) throw new Error('TURN_ALREADY_ACTIVE')
    const turn = { threadId, clientUserMessageId, state: 'STARTING', startedAt: this.now(), turnId: null }
    this.turns.set(provisional, turn)

    let finalContent = ''; let settled = false; let terminalSeen = false; const buffered = []; const toolCalls = new Map()
    let resolveTerminal; let rejectTerminal
    const terminalPromise = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject })
    void terminalPromise.catch(() => {})
    const cleanup = () => {
      this.off('delta', delta); this.off('final', final); this.off('terminal', terminal)
      this.off('native_tool_call', toolCall); this.off('tool', toolEvent)
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
      else if (kind === 'tool') { try { onToolEvent(event) } catch (error) { settle(error); void this.interrupt(threadId, turn.turnId).catch(() => {}) } }
      else if (kind === 'toolCall') dispatchTool(event)
      else if (kind === 'violation') settle(Object.assign(new Error(event.code), { code: event.code }))
      else if (kind === 'terminal') {
        terminalSeen = true
        if (event.status === 'completed') {
          // Completion cannot overtake a still-running trusted tool callback.
          void Promise.all([...toolCalls.values()].map(call => call.promise)).then(() => {
            this.nativeExecution?.checkActive()
            settle(null, { turnId: turn.turnId, threadId, content: finalContent, finishReason: 'completed' })
          }).catch(error => settle(error))
        }
        else settle(Object.assign(new Error(`TURN_${event.status.toUpperCase()}`), { code: `TURN_${event.status.toUpperCase()}` }))
      }
    }
    const dispatchTool = event => {
      const { frame, callId, tool, arguments: args } = event
      if (!id(callId) || !this.nativeExecution?.tools.some(spec => spec.name === tool) || event.namespace) {
        this._denyServerRequest(frame); return
      }
      const signature = JSON.stringify([tool, args]); let call = toolCalls.get(callId)
      if (call && call.signature !== signature) { this._denyServerRequest(frame); return }
      if (!call && terminalSeen) { this._denyServerRequest(frame); return }
      if (!call) {
        const promise = Promise.resolve().then(async () => {
          if (settled || this.closed) throw new Error('NATIVE_EXECUTION_INACTIVE')
          this.nativeExecution.checkActive()
          try {
            const result = await this.nativeExecution.callTool({ executionId: this.nativeExecution.executionId, threadId, turnId: turn.turnId, callId, tool, arguments: args })
            return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
          } catch (error) {
            if (error.recoverableToolError === true && typeof error.code === 'string') return { success: false, contentItems: [{ type: 'inputText', text: error.code }] }
            throw error
          }
        })
        call = { signature, promise }; toolCalls.set(callId, call)
      }
      void call.promise.then(result => {
        if (!this.closed) this.send({ id: frame.id, result })
      }).catch(error => {
        // Do not forward exception messages, filesystem paths or credentials.
        if (!this.closed) this.send({ id: frame.id, result: { success: false, contentItems: [{ type: 'inputText', text: error.code || 'NATIVE_TOOL_FAILED' }] } })
        settle(error)
      })
    }
    const toolCall = event => consume('toolCall', event)
    const toolEvent = event => consume('tool', event)
    const delta = event => consume('delta', event)
    const final = event => consume('final', event)
    const terminal = event => consume('terminal', event)
    const clarification = event => consume('clarification', event)
    const violation = event => consume('violation', event)
    const exited = () => { if (turn.turnId) settle(Object.assign(new Error('APP_SERVER_EXITED_DURING_TURN'), { code: 'TURN_ACCEPTANCE_UNKNOWN', turn: { ...turn } })) }
    this.on('delta', delta); this.on('final', final); this.on('terminal', terminal)
    this.on('native_tool_call', toolCall); this.on('tool', toolEvent)
    this.on('clarification', clarification); this.on('policy_violation', violation); this.on('exit', exited)

    let response
    try {
      const userInput = Array.isArray(input) ? input : [{ type: 'text', text: String(input) }]
      response = await this.request('turn/start', { threadId, clientUserMessageId, input: userInput, cwd: policy.cwd, model: policy.model || undefined, effort: policy.effort || undefined, approvalPolicy: 'never', ...(this.nativeExecution ? { permissions: NATIVE_PERMISSION_PROFILE } : { sandboxPolicy: { type: 'readOnly', networkAccess: false } }), ...(policy.outputSchema ? { outputSchema: policy.outputSchema } : {}) })
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
    turn.turnId = turnId; turn.state = 'RUNNING'; this.turns.set(`${threadId}:${turnId}`, turn)
    try { onAccepted({ threadId, turnId }) } catch (error) { settle(error); void this.interrupt(threadId, turnId).catch(() => {}); return terminalPromise }
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
    if (this.nativeExecution && frame.method === 'item/tool/call' && frame.id != null) {
      const params = frame.params || {}
      if (![...this.turns.values()].some(turn => turn.threadId === params.threadId && (!turn.turnId || turn.turnId === params.turnId))) { this._denyServerRequest(frame); return }
      this.emit('native_tool_call', { ...params, frame }); return
    }
    const toolNotification = this.nativeExecution && frame.id == null && [
      'item/started', 'item/completed', 'item/commandExecution/outputDelta',
      'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress'
    ].includes(frame.method)
    if (toolNotification) {
      const p = frame.params || {}; const item = p.item || {}
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) || frame.method !== 'item/started' && frame.method !== 'item/completed') {
        // Progress is not an execution receipt. Do not expose raw command output.
        this.emit('tool', { threadId: p.threadId, turnId: p.turnId, itemId: item.id || p.itemId, method: frame.method, type: item.type, status: item.status })
      }
    }
    if (frame.id != null || deniedMethods.test(frame.method) && !toolNotification) { this._denyServerRequest(frame); return }
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
    else this.emit('policy_violation', { threadId, turnId, request: frame.method, code: this.nativeExecution ? 'NATIVE_EXECUTION_TOOL_POLICY_VIOLATION' : 'FAST_CHAT_TOOL_POLICY_VIOLATION' })
    if (frame.id != null) this.send({ id: frame.id, error: { code: -32001, message: clarification ? 'Clarification only; it cannot authorize execution' : this.nativeExecution ? 'Tool or permission request is outside the bound execution policy' : 'Denied by read-only-constrained CHAT policy' } })
    if (!clarification && id(threadId) && id(turnId)) void this.interrupt(threadId, turnId).catch(() => {})
  }
}
