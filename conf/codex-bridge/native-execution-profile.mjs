// RB-03/08/10: enforce the authorized filesystem view, not task orchestration.
// Toolchain files are explicitly pinned by the caller; never bind host /usr,
// /etc, a main HOME, or the trusted execution store into the engine namespace.
import { spawnSync } from 'node:child_process'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { canonicalSha256 } from './chat-runtime.mjs'
import { skillPackageTreeDigest } from './skill-manifest.mjs'
import { nativeSkillOrigins } from './native-skill-config.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`)
const overlaps = (a, b) => within(a, b) || within(b, a)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeDirectory = (path, privateOnly = true) => {
  if (typeof path !== 'string' || resolve(path) !== path || realpathSync(path) !== path) fail('NATIVE_EXECUTION_DIRECTORY_UNSAFE')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || (privateOnly ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)) fail('NATIVE_EXECUTION_DIRECTORY_UNSAFE')
  return path
}
const directoryIdentity = path => { const stat = lstatSync(path, { bigint: true }); return { path, dev: String(stat.dev), ino: String(stat.ino) } }
const fileDigest = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true }); const bytes = readFileSync(fd); const after = fstatSync(fd, { bigint: true }); const current = lstatSync(path, { bigint: true })
    if (![after, current].every(stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid'].every(key => stat[key] === before[key]))) fail('NATIVE_EXECUTION_TOOLCHAIN_DRIFT')
    return createHash('sha256').update(bytes).digest('hex')
  } finally { closeSync(fd) }
}
// Same integrity rule as the app-server executable: only a process-local,
// frozen, SHA-verified manifest can reuse hashes. Recheck files AND ancestors
// synchronously before every use; ctime prevents restored-mtime substitutions.
const verifiedToolchains = new WeakMap()
const toolchainState = toolchain => {
  const paths = new Set()
  for (const file of toolchain.files) {
    paths.add(file.sourcePath)
    for (let cursor = dirname(file.sourcePath); ; cursor = dirname(cursor)) {
      if (paths.has(cursor)) break
      paths.add(cursor)
      const stat = lstatSync(cursor)
      if (cursor === '/' || (stat.uid === process.geteuid() && (stat.mode & 0o077) === 0)) break
    }
  }
  return [...paths].sort().map(path => {
    const stat = lstatSync(path, { bigint: true })
    return [path, ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid'].map(key => String(stat[key]))]
  })
}
const sameState = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const freezeToolchain = value => Object.freeze({ shell: value.shell, files: Object.freeze(value.files.map(file => Object.freeze({ ...file }))) })

export const validateNativeExecutionToolchain = toolchain => {
  if (!object(toolchain) || !Array.isArray(toolchain.files) || !toolchain.files.length || !['/bin/bash', '/bin/sh'].includes(toolchain.shell)) fail('NATIVE_EXECUTION_TOOLCHAIN_REQUIRED')
  let before
  try { before = toolchainState(toolchain) } catch { /* Original validation below supplies the precise failure. */ }
  if (before && verifiedToolchains.has(toolchain) && sameState(verifiedToolchains.get(toolchain), before)) return toolchain
  const targets = new Set()
  const files = toolchain.files.map(file => {
    if (!object(file) || typeof file.sourcePath !== 'string' || resolve(file.sourcePath) !== file.sourcePath || realpathSync(file.sourcePath) !== file.sourcePath || !hash(file.sha256)
        || typeof file.sandboxPath !== 'string' || resolve(file.sandboxPath) !== file.sandboxPath
        || !/^\/(?:bin|usr\/bin|lib|lib64|usr\/lib|usr\/lib64)\/[A-Za-z0-9_+./-]+$/.test(file.sandboxPath)
        || targets.has(file.sandboxPath)) fail('NATIVE_EXECUTION_TOOLCHAIN_INVALID')
    const stat = lstatSync(file.sourcePath)
    if (!stat.isFile() || stat.isSymbolicLink() || ![0, process.geteuid()].includes(stat.uid) || stat.mode & 0o022 || stat.mode & 0o6000) fail('NATIVE_EXECUTION_TOOLCHAIN_UNSAFE')
    // A protected file under a replaceable directory is not a pinned tool.
    let cursor = dirname(file.sourcePath)
    while (true) {
      const parent = lstatSync(cursor)
      if (!parent.isDirectory() || ![0, process.geteuid()].includes(parent.uid) || parent.mode & 0o022) fail('NATIVE_EXECUTION_TOOLCHAIN_UNSAFE')
      if (parent.uid === process.geteuid() && (parent.mode & 0o077) === 0) break
      const next = dirname(cursor); if (next === cursor) break; cursor = next
    }
    if (fileDigest(file.sourcePath) !== file.sha256) fail('NATIVE_EXECUTION_TOOLCHAIN_DRIFT')
    targets.add(file.sandboxPath)
    return Object.freeze({ sourcePath: file.sourcePath, sandboxPath: file.sandboxPath, sha256: file.sha256 })
  }).sort((a, b) => a.sandboxPath.localeCompare(b.sandboxPath))
  if (![toolchain.shell, '/bin/sh'].every(path => targets.has(path))) fail('NATIVE_EXECUTION_TOOLCHAIN_SHELL_REQUIRED')
  for (const path of [toolchain.shell, '/bin/sh']) if (!(lstatSync(files.find(file => file.sandboxPath === path).sourcePath).mode & 0o111)) fail('NATIVE_EXECUTION_TOOLCHAIN_SHELL_REQUIRED')
  const result = Object.freeze({ shell: toolchain.shell, files: Object.freeze(files) })
  const after = toolchainState(result)
  if (!before || !sameState(before, after)) fail('NATIVE_EXECUTION_TOOLCHAIN_DRIFT')
  verifiedToolchains.set(result, after)
  return result
}

// One initial verification off the WS thread. The synchronous final metadata
// guard has no await gap before granting process-local reuse.
export const validateNativeExecutionToolchainAsync = toolchain => new Promise((resolveJob, reject) => {
  const worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { kind: 'native-toolchain-verify', toolchain } })
  let reply
  worker.once('message', value => { reply = value })
  worker.once('error', reject)
  worker.once('exit', () => {
    try {
      if (!reply?.toolchain) fail(reply?.code || 'NATIVE_EXECUTION_TOOLCHAIN_REQUIRED')
      const result = freezeToolchain(reply.toolchain)
      if (!sameState(reply.verification, toolchainState(result))) fail('NATIVE_EXECUTION_TOOLCHAIN_DRIFT')
      verifiedToolchains.set(result, reply.verification)
      resolveJob(result)
    } catch (error) { reject(error) }
  })
})
if (!isMainThread && workerData?.kind === 'native-toolchain-verify') {
  try {
    const toolchain = validateNativeExecutionToolchain(workerData.toolchain)
    parentPort.postMessage({ toolchain, verification: verifiedToolchains.get(toolchain) })
  } catch (error) { parentPort.postMessage({ code: error.code || 'NATIVE_EXECUTION_TOOLCHAIN_REQUIRED' }) }
}

// Explicit opt-in host measurement for the minimal Linux shell toolchain.
// Persist/use the returned manifest, not ldd output as a readiness declaration.
// No Python/Office/browser libraries or network clients are implicitly added.
export const measureMinimalNativeExecutionToolchain = ({ nodeBin } = {}) => {
  const pin = (sourcePath, sandboxPath) => { const source = realpathSync(sourcePath); return { sourcePath: source, sandboxPath, sha256: fileDigest(source) } }
  const files = [pin('/usr/bin/bash', '/bin/bash'), pin('/usr/bin/bash', '/bin/sh'), ...['cat', 'mkdir', 'env', 'cp', 'cmp'].map(name => pin(`/usr/bin/${name}`, `/usr/bin/${name}`))]
  const binaries = ['/usr/bin/bash', '/usr/bin/cat', '/usr/bin/mkdir', '/usr/bin/env', '/usr/bin/cp', '/usr/bin/cmp']
  if (nodeBin !== undefined) {
    // The caller supplies the running runtime's executable, not an arbitrary
    // package binary: ldd must never be applied to skill-controlled code.
    if (typeof nodeBin !== 'string' || resolve(nodeBin) !== nodeBin || realpathSync(nodeBin) !== realpathSync(process.execPath)) fail('NATIVE_EXECUTION_TOOLCHAIN_NODE_INVALID')
    const node = pin(nodeBin, '/usr/bin/node')
    if (!(lstatSync(node.sourcePath).mode & 0o111)) fail('NATIVE_EXECUTION_TOOLCHAIN_NODE_INVALID')
    files.push(node); binaries.push(node.sourcePath)
  }
  validateNativeExecutionToolchain({ shell: '/bin/bash', files })
  // ldd executes only these already-verified OS/runtime binaries, never a skill file.
  const ldd = realpathSync('/usr/bin/ldd')
  validateNativeExecutionToolchain({ shell: '/bin/bash', files: [...files, pin(ldd, '/usr/bin/ldd')] })
  for (const path of binaries) {
    const result = spawnSync(ldd, [path], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    if (result.status !== 0 || result.error || result.signal) fail('NATIVE_EXECUTION_TOOLCHAIN_DEPENDENCIES_UNVERIFIED')
    for (const library of result.stdout.match(/\/[^\s()]+/g) || []) if (!files.some(file => file.sandboxPath === library)) files.push(pin(library, library))
  }
  return validateNativeExecutionToolchain({ shell: '/bin/bash', files })
}

// Empty mount targets required by the pinned engine's nested workspace policy.
// They contain no configuration, repository or credential material.
export const NATIVE_NEUTRAL_MOUNT_TARGETS = Object.freeze(['.git', '.codex', '.agents', '.aws'])

export const prepareNativeExecutionLayout = ({ inputDirectory, scratchDirectory, draftsDirectory, skills = [], skillConfiguration = [], nativeExecution, toolchain, stateRoot, sourceHome }) => {
  if (!object(nativeExecution) || typeof nativeExecution.executionId !== 'string' || !nativeExecution.executionId.trim()
      || nativeExecution.executionId.trim() !== nativeExecution.executionId
      || typeof nativeExecution.checkActive !== 'function' || typeof nativeExecution.callTool !== 'function' || !Array.isArray(nativeExecution.tools)
      || nativeExecution.tools.some(tool => !object(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !tool.name.trim() || typeof tool.description !== 'string' || !object(tool.inputSchema))
      || new Set(nativeExecution.tools.map(tool => tool.name)).size !== nativeExecution.tools.length) fail('NATIVE_EXECUTION_BINDING_INVALID')
  nativeExecution.checkActive()
  const input = safeDirectory(inputDirectory); const scratch = safeDirectory(scratchDirectory); const drafts = safeDirectory(draftsDirectory)
  // The trusted store's outputs/ is never a writable mount source (design §5.1).
  if (basename(input) !== 'inputs' || basename(scratch) !== 'scratch' || basename(drafts) !== 'drafts'
      || dirname(input) !== dirname(scratch) || dirname(input) !== dirname(drafts)) fail('NATIVE_EXECUTION_DIRECTORY_MAPPING_INVALID')
  safeDirectory(dirname(input))
  for (const path of [input, scratch, drafts]) if ([stateRoot, sourceHome].some(root => overlaps(resolve(root), path))) fail('NATIVE_EXECUTION_DIRECTORY_OVERLAP')
  if (!Array.isArray(skills)) fail('NATIVE_EXECUTION_SKILLS_INVALID')
  const keys = new Set()
  const packages = skills.map(skill => {
    if (!object(skill) || typeof skill.skillKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill.skillKey)
        || keys.has(skill.skillKey) || !hash(skill.packageTreeDigest)) fail('NATIVE_EXECUTION_SKILLS_INVALID')
    const packageRoot = safeDirectory(skill.packageRoot, false)
    if ([input, scratch, drafts, stateRoot].some(root => overlaps(root, packageRoot))) fail('NATIVE_EXECUTION_DIRECTORY_OVERLAP')
    if (!lstatSync(resolve(packageRoot, 'SKILL.md')).isFile() || skillPackageTreeDigest(packageRoot) !== skill.packageTreeDigest) fail('NATIVE_EXECUTION_SKILL_PACKAGE_CHANGED')
    keys.add(skill.skillKey)
    return Object.freeze({ skillKey: skill.skillKey, packageRoot, packageTreeDigest: skill.packageTreeDigest })
  }).sort((a, b) => a.skillKey.localeCompare(b.skillKey))
  const fixedToolchain = validateNativeExecutionToolchain(toolchain)
  if (!Array.isArray(skillConfiguration)) fail('NATIVE_SKILL_CONFIG_INVALID')
  const configured = new Set()
  const configurations = skillConfiguration.map(item => {
    if (!object(item) || !keys.has(item.skillKey) || configured.has(item.skillKey) || !object(item.configuration)) fail('NATIVE_SKILL_CONFIG_BINDING_INVALID')
    configured.add(item.skillKey)
    const networkOrigins = nativeSkillOrigins(item.networkOrigins || [])
    return Object.freeze({ skillKey: item.skillKey, configuration: structuredClone(item.configuration), networkOrigins })
  }).sort((a, b) => a.skillKey.localeCompare(b.skillKey))
  const networkOrigins = nativeSkillOrigins(configurations.flatMap(item => item.networkOrigins))
  const networkAccess = nativeExecution.networkAccess === true
  if (networkAccess !== (networkOrigins.length > 0)) fail('NATIVE_SKILL_NETWORK_BINDING_INVALID')
  const binding = Object.freeze({ schemaVersion: 1, executionId: nativeExecution.executionId,
    sandboxUser: { uid: 65534, gid: 65534 }, neutralMountTargets: NATIVE_NEUTRAL_MOUNT_TARGETS,
    input: directoryIdentity(input), scratch: directoryIdentity(scratch), drafts: directoryIdentity(drafts),
    skills: packages, toolchain: fixedToolchain, tools: structuredClone(nativeExecution.tools), networkAccess, networkOrigins,
    skillConfiguration: configurations.map(item => ({ skillKey: item.skillKey, digest: canonicalSha256(item) })) })
  return Object.freeze({ inputDirectory: input, scratchDirectory: scratch, draftsDirectory: drafts,
    skills: Object.freeze(packages), skillConfiguration: Object.freeze(configurations), toolchain: fixedToolchain, binding, digest: canonicalSha256(binding) })
}

export const buildNativeExecutionCodexConfig = (readOnlyConfig, { networkAccess = false } = {}) => readOnlyConfig.replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"')
  + `\n[sandbox_workspace_write]\nwritable_roots = ["/workspace", "/outputs"]\nnetwork_access = ${networkAccess === true}\nexclude_slash_tmp = true\nexclude_tmpdir_env_var = true\n`

// Append to an unshare-all bwrap view. HOME is neutral/read-only; only the
// engine's request state is writable, with config and skill roots overmounted ro.
export const nativeExecutionMountArgs = ({ layout, engineState, neutralDirectory, skillsDirectory, skillConfigurationDirectory }) => {
  // A non-root identity inside the outer user namespace permits the engine's
  // nested tool sandbox to map its own UID without CAP_SETFCAP. The mapping
  // still resolves to this process's host UID; no host account is changed.
  const args = ['--uid', '65534', '--gid', '65534', '--cap-drop', 'ALL', '--dir', '/execution', '--ro-bind', neutralDirectory, '/execution',
    '--dir', '/state', '--dir', '/state/codex-home', '--bind', engineState.codexHome, '/state/codex-home',
    '--ro-bind', resolve(engineState.codexHome, 'config.toml'), '/state/codex-home/config.toml',
    '--dir', '/state/home', '--ro-bind', neutralDirectory, '/state/home',
    '--dir', '/state/codex-home/skills', '--ro-bind', skillsDirectory, '/state/codex-home/skills',
    '--dir', '/workspace', '--bind', layout.scratchDirectory, '/workspace',
    '--dir', '/outputs', '--bind', layout.draftsDirectory, '/outputs']
  if (layout.skillConfiguration.length) {
    if (!skillConfigurationDirectory || resolve(skillConfigurationDirectory) !== resolve(engineState.directory, 'skill-config')) fail('NATIVE_SKILL_CONFIG_BINDING_INVALID')
    args.push('--dir', '/skill-config', '--ro-bind', skillConfigurationDirectory, '/skill-config', '--setenv', 'CYF_SKILL_CONFIG_DIR', '/skill-config')
  }
  for (const skill of layout.skills) args.push('--ro-bind', skill.packageRoot, `/state/codex-home/skills/${skill.skillKey}`)
  const directories = new Set()
  for (const file of layout.toolchain.files) {
    const parents = []; let cursor = dirname(file.sandboxPath)
    while (cursor !== '/') { parents.unshift(cursor); cursor = dirname(cursor) }
    for (const path of parents) if (!directories.has(path)) { args.push('--dir', path); directories.add(path) }
    args.push('--ro-bind', file.sourcePath, file.sandboxPath)
  }
  if (layout.toolchain.files.some(file => file.sandboxPath === '/usr/bin/python3')) {
    args.push('--setenv', 'LD_LIBRARY_PATH', '/usr/lib:/usr/lib64:/lib:/lib64', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1', '--setenv', 'TMPDIR', '/workspace')
  }
  args.push('--setenv', 'PATH', '/runtime/bin:/usr/bin:/bin', '--setenv', 'SHELL', layout.toolchain.shell, '--remount-ro', '/')
  return args
}

export const verifyNativeExecutionConfig = (readback, { networkAccess = false } = {}) => {
  const config = readback?.config?.config
  const sandbox = config?.sandbox_workspace_write
  if (config?.sandbox_mode !== 'workspace-write' || config?.approval_policy !== 'never'
      || !Array.isArray(sandbox?.writable_roots) || JSON.stringify(sandbox.writable_roots) !== JSON.stringify(['/workspace', '/outputs'])
      || sandbox.network_access !== (networkAccess === true) || sandbox.exclude_slash_tmp !== true || sandbox.exclude_tmpdir_env_var !== true) fail('NATIVE_EXECUTION_CONFIG_READBACK_MISMATCH')
}

export const verifyNativeExecutionSkillCatalog = (result, layout) => {
  const rows = result?.data
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.cwd !== '/execution' || !Array.isArray(rows[0].skills) || !Array.isArray(rows[0].errors) || rows[0].errors.length) fail('NATIVE_EXECUTION_SKILL_DISCOVERY_UNVERIFIED')
  const expected = new Set(layout.skills.map(skill => `/state/codex-home/skills/${skill.skillKey}/SKILL.md`)); const seen = new Set()
  // No system-scope allowlist is implied by the inspection measurement. A
  // delivered engine exposing built-ins needs its own pinned inventory first.
  for (const skill of rows[0].skills) {
    if (!expected.has(skill.path) || skill.enabled !== true || seen.has(skill.path)) fail('NATIVE_EXECUTION_SKILL_DISCOVERY_OUTSIDE_AUTHORIZATION')
    seen.add(skill.path)
  }
  if (seen.size !== expected.size) fail('NATIVE_EXECUTION_SKILL_DISCOVERY_UNVERIFIED')
  return Object.freeze({ measured: true, cwd: '/execution', paths: Object.freeze([...seen].sort()) })
}
