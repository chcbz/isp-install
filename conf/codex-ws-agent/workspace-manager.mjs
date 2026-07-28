import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const FORMAT_VERSION = 1
const DEFAULT_ROOT = '/home/isp/hosts/cyf/agent-workspaces'
const DEFAULT_ROLE = 'coder'
const DEFAULT_LOCK_TIMEOUT_MS = 10000
const DEFAULT_LOCK_RETRY_MS = 10
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,254}$/
const SAFE_REMOTE_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/
const VERIFICATION_TMP_PREFIX = '/tmp/codex-ws-agent-publish-'
const HARDENED_WORKTREE_GIT_CONFIG = Object.freeze([
  '-c', 'core.trustctime=true',
  '-c', 'core.filemode=true',
  '-c', 'core.checkStat=default',
  '-c', 'core.ignoreStat=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false'
])

const blockingSleep = milliseconds => {
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds)
}

const fsyncDirectory = directory => {
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const durableUnlink = path => {
  unlinkSync(path)
  fsyncDirectory(dirname(path))
}

const atomicWriteJson = (path, value, mode = 0o600) => {
  const directory = dirname(path)
  const temporary = resolve(directory, `.${path.split(sep).pop()}.${process.pid}.${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', mode)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
  chmodSync(path, mode)
  fsyncDirectory(directory)
}

const isInside = (parent, candidate) => {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

const assertNoSymlinkComponents = (targetPath, { allowMissing = true } = {}) => {
  const absolute = resolve(targetPath)
  const parts = absolute.split(sep).filter(Boolean)
  let current = sep
  for (const part of parts) {
    current = resolve(current, part)
    if (!existsSync(current)) {
      if (allowMissing) return
      throw new WorkspaceManagerError('WORKSPACE_PATH_MISSING', `Required path does not exist: ${current}`)
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new WorkspaceManagerError('WORKSPACE_SYMLINK_ESCAPE', `Symlink path component is forbidden: ${current}`)
    }
  }
}

const ensurePrivateDirectory = path => {
  assertNoSymlinkComponents(path)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertNoSymlinkComponents(path, { allowMissing: false })
  chmodSync(path, 0o700)
  fsyncDirectory(dirname(path))
}

export class WorkspaceManagerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkspaceManagerError'
    this.code = code
  }
}

export const safeWorkspaceComponent = (value, label) => {
  const component = String(value || '').trim()
  if (!SAFE_COMPONENT.test(component) || component === '.' || component === '..' || component.includes('..')) {
    throw new WorkspaceManagerError(
      'WORKSPACE_ID_INVALID',
      `${label} must be a 1-64 character safe slug using ASCII letters, digits, dot, underscore, or hyphen`
    )
  }
  return component
}

const canonicalizeResourcePath = path => {
  const absolute = resolve(path)
  assertNoSymlinkComponents(absolute)
  let existing = absolute
  const missing = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) {
      throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Cannot canonicalize trusted resource path: ${absolute}`)
    }
    missing.unshift(basename(existing))
    existing = parent
  }
  assertNoSymlinkComponents(existing, { allowMissing: false })
  return resolve(realpathSync(existing), ...missing)
}

const validateTrustedRemoteUrl = (value, policyId) => {
  const remoteUrl = String(value || '').trim()
  if (!remoteUrl || /[\u0000-\u0020\u007f]/.test(remoteUrl)) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace trustedRemoteUrl is missing or unsafe for policy ${policyId}`)
  }
  let parsed
  try { parsed = new URL(remoteUrl) } catch {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace trustedRemoteUrl must be an absolute HTTPS URL for policy ${policyId}`)
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace trustedRemoteUrl must be credential-free HTTPS for policy ${policyId}`)
  }
  return remoteUrl
}

const validateTrustedRemoteRef = (value, policyId) => {
  const remoteRef = String(value || '').trim()
  if (!SAFE_REMOTE_REF.test(remoteRef) || remoteRef.includes('..') || remoteRef.includes('//')
      || remoteRef.includes('@{') || remoteRef.endsWith('/') || remoteRef.endsWith('.') || remoteRef.endsWith('.lock')) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace trustedRemoteRef must be one fixed refs/heads/* ref for policy ${policyId}`)
  }
  return remoteRef
}

const validatePolicyShape = policy => {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', 'Workspace policy must be an object')
  }
  const policyId = String(policy.policyId || '').trim()
  if (!SAFE_POLICY_ID.test(policyId)) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', 'Workspace policyId is missing or unsafe')
  }
  const configuredRoot = String(policy.root || DEFAULT_ROOT)
  const configuredRepository = String(policy.repository || '')
  if (!isAbsolute(configuredRoot)) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace root must be absolute for policy ${policyId}`)
  }
  if (!configuredRepository || !isAbsolute(configuredRepository)) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace repository must be an absolute trusted path for policy ${policyId}`)
  }
  const root = canonicalizeResourcePath(configuredRoot)
  const repository = canonicalizeResourcePath(configuredRepository)
  if (isInside(repository, root) || isInside(root, repository)) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace root and repository overlap for policy ${policyId}`)
  }
  const baseRef = String(policy.baseRef || '').trim()
  if (!baseRef || !SAFE_REF.test(baseRef) || baseRef.startsWith('-') || baseRef.includes('..')) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace baseRef is missing or unsafe for policy ${policyId}`)
  }
  const trustedRemoteUrl = validateTrustedRemoteUrl(policy.trustedRemoteUrl, policyId)
  const trustedRemoteRef = validateTrustedRemoteRef(policy.trustedRemoteRef, policyId)
  return { policyId, root, repository, baseRef, trustedRemoteUrl, trustedRemoteRef }
}

const assertDistinctPolicyResources = policies => {
  const resources = []
  for (const policy of policies.values()) {
    for (const [kind, path] of [['repository', policy.repository], ['root', policy.root]]) {
      for (const existing of resources) {
        if (isInside(existing.path, path) || isInside(path, existing.path)) {
          throw new WorkspaceManagerError(
            'WORKSPACE_POLICY_INVALID',
            `Workspace policies ${existing.policyId} and ${policy.policyId} have duplicate or overlapping canonical ${existing.kind}/${kind} resources`
          )
        }
      }
      resources.push({ policyId: policy.policyId, kind, path })
    }
  }
}

export const runGitProcess = ({ gitBin = 'git', cwd, args, env = process.env, input }) => spawnSync(gitBin, args, {
  cwd,
  env,
  input,
  encoding: 'utf8',
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
})

const loadDotEnv = cwd => {
  const envPath = resolve(cwd, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

export const parseWorkspacePolicies = raw => {
  if (!raw || !String(raw).trim()) return new Map()
  let parsed
  try { parsed = JSON.parse(String(raw)) } catch (error) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace policies must be valid JSON: ${error.message}`)
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed).map(([policyId, value]) => ({ ...(value || {}), policyId }))
  const policies = new Map()
  for (const item of list) {
    const policy = validatePolicyShape(item)
    if (policies.has(policy.policyId)) {
      throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Duplicate workspace policyId: ${policy.policyId}`)
    }
    policies.set(policy.policyId, policy)
  }
  assertDistinctPolicyResources(policies)
  return policies
}

export const loadWorkspacePolicies = (env = process.env) => {
  const file = String(env.CODEX_WORKSPACE_POLICIES_FILE || '').trim()
  if (file) {
    if (!isAbsolute(file)) throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', 'CODEX_WORKSPACE_POLICIES_FILE must be absolute')
    assertNoSymlinkComponents(file, { allowMissing: false })
    return parseWorkspacePolicies(readFileSync(resolve(file), 'utf8'))
  }
  return parseWorkspacePolicies(env.CODEX_WORKSPACE_POLICIES || '')
}

const parseWorktreeList = output => {
  const records = []
  let current = null
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) {
      if (current) records.push(current)
      current = null
      continue
    }
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? true : line.slice(space + 1)
    if (key === 'worktree') current = { path: resolve(String(value)) }
    else if (current) current[key] = value
  }
  if (current) records.push(current)
  return records
}

export class GitWorkspaceManager {
  constructor({
    policy,
    agentId,
    role = DEFAULT_ROLE,
    gitBin = 'git',
    gitRunner = runGitProcess,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    lockRetryMs = DEFAULT_LOCK_RETRY_MS,
    sleepSync = blockingSleep,
    now = () => Date.now()
  }) {
    this.policy = validatePolicyShape(policy)
    this.agentId = safeWorkspaceComponent(agentId, 'agentId')
    this.role = safeWorkspaceComponent(role || DEFAULT_ROLE, 'role')
    this.gitBin = gitBin
    this.gitRunner = gitRunner
    this.lockTimeoutMs = lockTimeoutMs
    this.lockRetryMs = lockRetryMs
    this.sleepSync = sleepSync
    this.now = now
    this.initialized = false
  }

  initialize() {
    if (this.initialized) return this
    const { root, repository } = this.policy
    assertNoSymlinkComponents(repository, { allowMissing: false })
    if (!statSync(repository).isDirectory()) {
      throw new WorkspaceManagerError('WORKSPACE_REPOSITORY_INVALID', `Workspace repository is not a directory: ${repository}`)
    }
    this.repository = realpathSync(repository)
    if (this.repository !== repository) {
      throw new WorkspaceManagerError('WORKSPACE_SYMLINK_ESCAPE', `Workspace repository resolves through a symlink: ${repository}`)
    }
    this._git(['check-ref-format', this.policy.trustedRemoteRef], { cwd: this.repository })
    const bare = this._git(['rev-parse', '--is-bare-repository'], { cwd: this.repository }).trim() === 'true'
    if (!bare) {
      const topLevel = resolve(this._git(['rev-parse', '--show-toplevel'], { cwd: this.repository }).trim())
      if (topLevel !== this.repository) {
        throw new WorkspaceManagerError('WORKSPACE_REPOSITORY_INVALID', `Configured repository is not its Git top-level: ${repository}`)
      }
    }

    ensurePrivateDirectory(root)
    this.root = realpathSync(root)
    if (this.root !== root) {
      throw new WorkspaceManagerError('WORKSPACE_SYMLINK_ESCAPE', `Workspace root resolves through a symlink: ${root}`)
    }
    if (isInside(this.repository, this.root) || isInside(this.root, this.repository)) {
      throw new WorkspaceManagerError('WORKSPACE_PATH_ESCAPE', 'Workspace root and trusted repository must not overlap')
    }
    this.metadataRoot = resolve(this.root, '.metadata')
    this.locksRoot = resolve(this.root, '.locks')
    this.archiveQuarantineRoot = resolve(this.root, '.archive-quarantine')
    ensurePrivateDirectory(this.metadataRoot)
    ensurePrivateDirectory(this.locksRoot)
    ensurePrivateDirectory(this.archiveQuarantineRoot)
    this.initialized = true
    return this
  }

  describe(taskId) {
    this.initialize()
    const task = safeWorkspaceComponent(taskId, 'taskId')
    const agent = this.agentId
    const workspacePath = resolve(this.root, task, `agent-${agent}`)
    if (!isInside(this.root, workspacePath) || workspacePath === this.root) {
      throw new WorkspaceManagerError('WORKSPACE_PATH_ESCAPE', 'Resolved workspace escaped the configured root')
    }
    const branch = `codex/${task}/agent-${agent}-${this.role}`
    this._git(['check-ref-format', `refs/heads/${branch}`], { cwd: this.repository })
    const metadataDir = resolve(this.metadataRoot, task)
    const metadataPath = resolve(metadataDir, `agent-${agent}.json`)
    const lockKey = createHash('sha256')
      .update(`${this.repository}\0${this.root}\0${task}\0${agent}`)
      .digest('hex')
    return {
      policyId: this.policy.policyId,
      taskId: task,
      agentId: agent,
      role: this.role,
      workspacePath,
      branch,
      metadataDir,
      metadataPath,
      lockPath: resolve(this.locksRoot, `${lockKey}.lock`)
    }
  }

  ensureWorkspace(taskId) {
    const expected = this.describe(taskId)
    return this._withLock(expected, () => this._ensureLocked(expected), 'ensure')
  }

  acquireCommandWorkspace(message, options = {}) {
    this.initialize()
    const taskId = String(message?.taskId || '').trim()
    if (!taskId) {
      return {
        workspace: this._resolveUnmanagedCommandWorkspace(message, options),
        release: () => {}
      }
    }

    const expected = this.describe(taskId)
    this._acquireLock(expected, 'command-runner')
    let released = false
    const release = () => {
      if (released) return
      this._releaseLock(expected.lockPath)
      released = true
    }
    try {
      return {
        workspace: { ...this._ensureLocked(expected), managed: true },
        release
      }
    } catch (error) {
      try { release() } catch (releaseError) {
        throw new WorkspaceManagerError(
          'WORKSPACE_LOCK_ERROR',
          `${error.code || 'WORKSPACE_ERROR'}: ${error.message}; additionally failed to release command-runner lease: ${releaseError.message}`
        )
      }
      throw error
    }
  }

  resolveCommandWorkspace(message, options = {}) {
    this.initialize()
    const taskId = String(message?.taskId || '').trim()
    if (taskId) return { ...this.ensureWorkspace(taskId), managed: true }
    return this._resolveUnmanagedCommandWorkspace(message, options)
  }

  _resolveUnmanagedCommandWorkspace(message, {
    noTaskPolicy = 'reject',
    nonCodingCommandTypes = [],
    fallbackWorkdir = ''
  } = {}) {
    const commandType = String(message?.commandType || '').trim()
    const allowedTypes = new Set(
      (Array.isArray(nonCodingCommandTypes) ? nonCodingCommandTypes : String(nonCodingCommandTypes).split(','))
        .map(value => String(value).trim())
        .filter(Boolean)
    )
    if (noTaskPolicy !== 'dedicated-workdir' || !allowedTypes.has(commandType)) {
      throw new WorkspaceManagerError(
        'WORKSPACE_TASK_ID_REQUIRED',
        `command.dispatch ${commandType || '(missing commandType)'} requires taskId for an isolated Agent worktree`
      )
    }

    const configured = String(fallbackWorkdir || '').trim()
    if (!configured || !isAbsolute(configured)) {
      throw new WorkspaceManagerError('WORKSPACE_FALLBACK_INVALID', 'Explicit non-coding fallback workdir must be an absolute trusted path')
    }
    assertNoSymlinkComponents(configured, { allowMissing: false })
    const resolvedFallback = realpathSync(configured)
    if (resolvedFallback !== resolve(configured)
        || isInside(this.repository, resolvedFallback)
        || isInside(resolvedFallback, this.repository)
        || isInside(this.root, resolvedFallback)
        || isInside(resolvedFallback, this.root)) {
      throw new WorkspaceManagerError('WORKSPACE_FALLBACK_INVALID', 'Non-coding fallback workdir must not be a repository, worktree root, or symlink alias')
    }
    const gitProbe = this._gitResult(['rev-parse', '--is-inside-work-tree'], { cwd: resolvedFallback })
    if (gitProbe.status === 0 && gitProbe.stdout.trim() === 'true') {
      throw new WorkspaceManagerError('WORKSPACE_FALLBACK_INVALID', 'Non-coding fallback workdir must not be inside any Git worktree')
    }
    return {
      formatVersion: FORMAT_VERSION,
      state: 'compatibility',
      policyId: this.policy.policyId,
      taskId: '',
      agentId: this.agentId,
      role: this.role,
      workspacePath: resolvedFallback,
      managed: false
    }
  }

  inspectWorkspace(taskId) {
    const expected = this.describe(taskId)
    return this._withLock(expected, () => {
      const metadata = this._readMetadata(expected.metadataPath)
      if (!metadata) throw new WorkspaceManagerError('WORKSPACE_METADATA_MISSING', 'Durable workspace metadata is missing')
      this._validateMetadata(metadata, expected)
      if (metadata.state === 'creating') return this._recoverCreating(metadata, expected)
      if (metadata.state === 'archiving') {
        throw new WorkspaceManagerError(
          'WORKSPACE_ARCHIVE_RECOVERY_REQUIRED',
          'Interrupted archive metadata requires operator reconciliation before inspection'
        )
      }
      if (metadata.state !== 'active') {
        throw new WorkspaceManagerError('WORKSPACE_NOT_ACTIVE', `Workspace metadata state is ${metadata.state}`)
      }
      this._validateActive(metadata, expected)
      return metadata
    })
  }

  archiveWorkspace(taskId) {
    const expected = this.describe(taskId)
    return this._withLock(expected, () => this._archiveLocked(expected), 'archive')
  }

  _archiveLocked(expected) {
    const metadata = this._readMetadata(expected.metadataPath)
    if (!metadata) throw new WorkspaceManagerError('WORKSPACE_METADATA_MISSING', 'Durable workspace metadata is missing')
    this._validateMetadata(metadata, expected)
    if (metadata.state === 'archiving') {
      throw new WorkspaceManagerError(
        'WORKSPACE_ARCHIVE_RECOVERY_REQUIRED',
        'An interrupted workspace archive requires operator reconciliation before reuse or deletion'
      )
    }
    if (metadata.state !== 'active') {
      throw new WorkspaceManagerError('WORKSPACE_NOT_ACTIVE', `Only active workspaces can be archived; current state=${metadata.state}`)
    }

    this._validateActive(metadata, expected)
    this._assertNoVisibleWorkspaceChanges(expected)
    this._assertTrackedFilesMatchIndex(expected)
    const head = this._git(['rev-parse', 'HEAD'], { cwd: expected.workspacePath }).trim()
    if (!/^[0-9a-f]{40,64}$/.test(head)) {
      throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RACE', 'Workspace HEAD could not be fixed before quarantine')
    }

    ensurePrivateDirectory(this.archiveQuarantineRoot)
    const quarantinePath = resolve(
      this.archiveQuarantineRoot,
      `${expected.taskId}-agent-${expected.agentId}-${randomUUID()}`
    )
    if (!isInside(this.archiveQuarantineRoot, quarantinePath)
        || dirname(quarantinePath) !== this.archiveQuarantineRoot
        || existsSync(quarantinePath)
        || this._findWorktree(quarantinePath)) {
      throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_FAILED', 'Cannot allocate a private workspace archive quarantine path')
    }

    const archiving = {
      ...metadata,
      state: 'archiving',
      quarantinePath,
      archiveHead: head,
      archiveStartedAt: this.now(),
      updatedAt: this.now()
    }
    atomicWriteJson(expected.metadataPath, archiving)

    let branchRefLease = null
    try {
      this._git(['worktree', 'move', expected.workspacePath, quarantinePath], { cwd: this.repository })
      fsyncDirectory(dirname(expected.workspacePath))
      fsyncDirectory(this.archiveQuarantineRoot)
      if (existsSync(expected.workspacePath) || !existsSync(quarantinePath)) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_FAILED', 'Workspace quarantine move did not establish an exclusive path boundary')
      }

      const quarantinedExpected = { ...expected, workspacePath: quarantinePath }
      this._validateQuarantinedWorktree(quarantinedExpected, metadata)
      this._assertNoVisibleWorkspaceChanges(quarantinedExpected)
      const quarantinedHead = this._git(['rev-parse', 'HEAD'], { cwd: quarantinePath }).trim()
      if (quarantinedHead !== head) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RACE', 'Workspace HEAD changed before the quarantine boundary; archive refused')
      }
      if (quarantinedHead !== metadata.baseCommit) {
        this._assertHeadPublishedToTrustedRemote(quarantinedExpected, quarantinedHead)
      }

      branchRefLease = this._acquireBranchRefLease(expected, quarantinedHead)
      const leasedBranchHead = this._hardenedGit(
        ['rev-parse', '--verify', '--end-of-options', `refs/heads/${expected.branch}^{commit}`],
        { cwd: this.repository }
      ).trim()
      if (leasedBranchHead !== quarantinedHead) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RACE', 'Workspace branch changed before final hardened verification; archive refused')
      }

      // Do not trust repository/worktree stat-cache, fsmonitor, ignoreStat, or
      // untracked-cache settings at the deletion boundary. Refresh under the
      // ref lease, then independently verify every tracked object/type/mode.
      this._hardenedGit(['update-index', '--really-refresh'], { cwd: quarantinePath })
      this._assertNoVisibleWorkspaceChanges(quarantinedExpected, { hardened: true })
      this._assertTrackedFilesMatchIndex(quarantinedExpected, { hardened: true })
      this._assertNoVisibleWorkspaceChanges(quarantinedExpected, { hardened: true })
      const verifiedHead = this._hardenedGit(['rev-parse', 'HEAD'], { cwd: quarantinePath }).trim()
      const verifiedBranchHead = this._hardenedGit(
        ['rev-parse', '--verify', '--end-of-options', `refs/heads/${expected.branch}^{commit}`],
        { cwd: this.repository }
      ).trim()
      if (verifiedHead !== quarantinedHead || verifiedBranchHead !== verifiedHead) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RACE', 'Workspace HEAD changed during final hardened verification; archive refused')
      }
      if (existsSync(expected.workspacePath)) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RACE', 'Original workspace path reappeared after quarantine; archive refused')
      }

      // Archive is a non-destructive logical operation only. The Agent process must
      // never physically delete a worktree because the quarantine remains writable
      // by the Agent UID and therefore cannot establish a race-free delete boundary.
      // Persist the retained path so an interrupted/restarted process can always
      // locate the complete worktree. Any future physical deletion belongs to a
      // separately authorized root-owned GC, which is intentionally absent/disabled.
      const archived = {
        ...archiving,
        state: 'archived',
        quarantinePath,
        archivedHead: verifiedHead,
        archivedAt: this.now(),
        updatedAt: this.now()
      }
      atomicWriteJson(expected.metadataPath, archived)
      return archived
    } catch (error) {
      try {
        this._restoreArchiveAfterFailure(expected, metadata, quarantinePath)
      } catch (restoreError) {
        throw new WorkspaceManagerError(
          'WORKSPACE_ARCHIVE_RECOVERY_REQUIRED',
          `${error.code || 'WORKSPACE_ARCHIVE_FAILED'}: ${error.message}; automatic restore failed: ${restoreError.message}`
        )
      }
      throw error
    } finally {
      if (branchRefLease) branchRefLease.release()
    }
  }

  _acquireBranchRefLease(expected, expectedHead) {
    const commonDirOutput = this._git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: this.repository }
    ).trim()
    if (!isAbsolute(commonDirOutput)) {
      throw new WorkspaceManagerError('WORKSPACE_GIT_ERROR', 'Git common directory is not absolute')
    }
    assertNoSymlinkComponents(commonDirOutput, { allowMissing: false })
    const commonDir = realpathSync(commonDirOutput)
    const refsRoot = resolve(commonDir, 'refs', 'heads')
    const refPath = resolve(refsRoot, expected.branch)
    const lockPath = `${refPath}.lock`
    if (!isInside(refsRoot, refPath) || refPath === refsRoot || !isInside(commonDir, lockPath)) {
      throw new WorkspaceManagerError('WORKSPACE_PATH_ESCAPE', 'Workspace branch lock escaped the trusted Git common directory')
    }
    mkdirSync(dirname(refPath), { recursive: true, mode: 0o700 })
    assertNoSymlinkComponents(dirname(refPath), { allowMissing: false })
    let descriptor
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${expectedHead}\n`, 'utf8')
      fsyncSync(descriptor)
      fsyncDirectory(dirname(lockPath))
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch {}
        try { durableUnlink(lockPath) } catch {}
      }
      if (error?.code === 'EEXIST') {
        throw new WorkspaceManagerError('WORKSPACE_REF_LOCKED', 'Workspace branch is being updated; archive refused')
      }
      throw error instanceof WorkspaceManagerError
        ? error
        : new WorkspaceManagerError('WORKSPACE_LOCK_ERROR', `Cannot seal workspace branch ref: ${error.message}`)
    }
    let released = false
    return {
      release: () => {
        if (released) return
        closeSync(descriptor)
        durableUnlink(lockPath)
        released = true
      }
    }
  }

  _validateQuarantinedWorktree(expected, metadata) {
    assertNoSymlinkComponents(expected.workspacePath, { allowMissing: false })
    if (!isInside(this.archiveQuarantineRoot, expected.workspacePath)
        || dirname(expected.workspacePath) !== this.archiveQuarantineRoot
        || lstatSync(expected.workspacePath).isSymbolicLink()) {
      throw new WorkspaceManagerError('WORKSPACE_PATH_ESCAPE', 'Quarantined workspace escaped the private archive root')
    }
    this._validateWorktree(expected, metadata)
  }

  _restoreArchiveAfterFailure(expected, metadata, quarantinePath) {
    let originalExists = existsSync(expected.workspacePath)
    const quarantineExists = existsSync(quarantinePath)
    let recoveryConflictPath = ''
    if (originalExists && quarantineExists) {
      recoveryConflictPath = resolve(
        this.archiveQuarantineRoot,
        `${expected.taskId}-agent-${expected.agentId}-late-writer-${randomUUID()}`
      )
      if (existsSync(recoveryConflictPath) || dirname(recoveryConflictPath) !== this.archiveQuarantineRoot) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RECOVERY_REQUIRED', 'Cannot preserve a late writer path during archive recovery')
      }
      renameSync(expected.workspacePath, recoveryConflictPath)
      fsyncDirectory(dirname(expected.workspacePath))
      fsyncDirectory(this.archiveQuarantineRoot)
      originalExists = false
    }
    if (!originalExists && !quarantineExists) {
      throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RECOVERY_REQUIRED', 'Neither original nor quarantine workspace path exists')
    }
    if (quarantineExists) {
      this._git(['worktree', 'move', quarantinePath, expected.workspacePath], { cwd: this.repository })
      fsyncDirectory(this.archiveQuarantineRoot)
      fsyncDirectory(dirname(expected.workspacePath))
    }
    const restored = {
      ...metadata,
      state: 'active',
      ...(recoveryConflictPath ? { archiveRecoveryConflictPath: recoveryConflictPath } : {}),
      updatedAt: this.now()
    }
    this._validateActive(restored, expected)
    atomicWriteJson(expected.metadataPath, restored)
  }

  _assertNoVisibleWorkspaceChanges(expected, { hardened = false } = {}) {
    const runGit = (args, options) => hardened ? this._hardenedGit(args, options) : this._git(args, options)
    const unmerged = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: expected.workspacePath })
    if (unmerged.trim()) throw new WorkspaceManagerError('WORKSPACE_UNMERGED', 'Workspace has unmerged files; archive refused')
    const dirty = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: expected.workspacePath })
    if (dirty.trim()) throw new WorkspaceManagerError('WORKSPACE_DIRTY', 'Workspace has modified or untracked files; archive refused')
    const ignored = runGit(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--'],
      { cwd: expected.workspacePath }
    )
    if (ignored) throw new WorkspaceManagerError('WORKSPACE_DIRTY', 'Workspace has ignored untracked files; archive refused')
    const indexEntries = runGit(['ls-files', '-v', '-z', '--'], { cwd: expected.workspacePath })
      .split('\0')
      .filter(Boolean)
    if (indexEntries.some(entry => !entry.startsWith('H '))) {
      throw new WorkspaceManagerError(
        'WORKSPACE_INDEX_HIDDEN',
        'Workspace index contains skip-worktree, assume-unchanged, or another non-normal tracked-file flag; archive refused'
      )
    }
  }

  _assertTrackedFilesMatchIndex(expected, { hardened = false } = {}) {
    const runGit = (args, options) => hardened ? this._hardenedGit(args, options) : this._git(args, options)
    const entries = runGit(['ls-files', '--stage', '-z', '--'], { cwd: expected.workspacePath })
      .split('\0')
      .filter(Boolean)
    const seen = new Set()
    for (const entry of entries) {
      const tab = entry.indexOf('\t')
      const match = tab > 0 ? /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(entry.slice(0, tab)) : null
      const relativePath = tab > 0 ? entry.slice(tab + 1) : ''
      if (!match || !relativePath || relativePath.includes('\ufffd') || match[3] !== '0' || seen.has(relativePath)) {
        throw new WorkspaceManagerError('WORKSPACE_TRACKED_MISMATCH', 'Workspace index contains an invalid, unmerged, duplicate, or non-UTF-8 tracked entry')
      }
      seen.add(relativePath)
      const actualPath = resolve(expected.workspacePath, relativePath)
      if (!isInside(expected.workspacePath, actualPath) || actualPath === expected.workspacePath) {
        throw new WorkspaceManagerError('WORKSPACE_TRACKED_MISMATCH', `Tracked path escaped workspace: ${JSON.stringify(relativePath)}`)
      }
      const expectedMode = match[1]
      const expectedObject = match[2]
      let data
      let actualMode
      let finalSnapshot
      try {
        if (expectedMode === '120000') {
          const before = lstatSync(actualPath, { bigint: true })
          if (!before.isSymbolicLink()) throw new Error('expected a symbolic link')
          data = readlinkSync(actualPath, { encoding: 'buffer' })
          const after = lstatSync(actualPath, { bigint: true })
          if (!this._sameFileSnapshot(before, after)) throw new Error('symbolic link changed during verification')
          finalSnapshot = after
          actualMode = '120000'
        } else if (expectedMode === '100644' || expectedMode === '100755') {
          const before = lstatSync(actualPath, { bigint: true })
          if (!before.isFile()) throw new Error('expected a regular file')
          const descriptor = openSync(actualPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
          try {
            const opened = fstatSync(descriptor, { bigint: true })
            if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
              throw new Error('tracked file changed before open')
            }
            data = readFileSync(descriptor)
            const afterRead = fstatSync(descriptor, { bigint: true })
            if (!this._sameFileSnapshot(opened, afterRead)) throw new Error('tracked file changed during read')
            actualMode = (opened.mode & 0o111n) === 0n ? '100644' : '100755'
          } finally {
            closeSync(descriptor)
          }
          const afterPath = lstatSync(actualPath, { bigint: true })
          if (!this._sameFileSnapshot(before, afterPath)) throw new Error('tracked path changed during verification')
          finalSnapshot = afterPath
        } else {
          throw new Error(`unsupported tracked mode ${expectedMode}`)
        }
      } catch (error) {
        throw new WorkspaceManagerError(
          'WORKSPACE_TRACKED_MISMATCH',
          `Tracked path ${JSON.stringify(relativePath)} cannot be safely verified: ${error.message}`
        )
      }
      if (actualMode !== expectedMode) {
        throw new WorkspaceManagerError('WORKSPACE_TRACKED_MISMATCH', `Tracked mode differs from index for ${JSON.stringify(relativePath)}`)
      }
      const actualObject = runGit(['hash-object', '--stdin'], { cwd: expected.workspacePath, input: data }).trim()
      try {
        const afterHash = lstatSync(actualPath, { bigint: true })
        if (!this._sameFileSnapshot(finalSnapshot, afterHash)) {
          throw new Error('tracked path changed after its final content hash')
        }
      } catch (error) {
        throw new WorkspaceManagerError(
          'WORKSPACE_TRACKED_MISMATCH',
          `Tracked path ${JSON.stringify(relativePath)} changed at the final hash boundary: ${error.message}`
        )
      }
      if (actualObject !== expectedObject) {
        throw new WorkspaceManagerError('WORKSPACE_TRACKED_MISMATCH', `Tracked content differs from index for ${JSON.stringify(relativePath)}`)
      }
    }
  }

  _sameFileSnapshot(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
      && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
  }

  _verificationEnvironment(home) {
    return {
      PATH: '/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: resolve(home, 'xdg'),
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      SSH_ASKPASS: '/bin/false',
      GIT_SSH_COMMAND: '/bin/false',
      GCM_INTERACTIVE: 'Never',
      NO_PROXY: '*'
    }
  }

  _verificationGit(args, { cwd, env }) {
    return this._git([
      '-c', 'http.sslVerify=true',
      '-c', 'http.proxy=',
      '-c', 'credential.helper=',
      '-c', 'core.askPass=/bin/false',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
      ...args
    ], { cwd, env })
  }

  _assertHeadPublishedToTrustedRemote(_expected, head) {
    const temporaryRoot = mkdtempSync(VERIFICATION_TMP_PREFIX)
    try {
      chmodSync(temporaryRoot, 0o700)
      const home = resolve(temporaryRoot, 'home')
      const verificationRepository = resolve(temporaryRoot, 'repository.git')
      mkdirSync(home, { mode: 0o700 })
      mkdirSync(resolve(home, 'xdg'), { mode: 0o700 })
      const env = this._verificationEnvironment(home)
      const objectFormat = this._git(['rev-parse', '--show-object-format=storage'], { cwd: this.repository }).trim()
      if (!['sha1', 'sha256'].includes(objectFormat)) {
        throw new WorkspaceManagerError('WORKSPACE_GIT_ERROR', `Unsupported repository object format: ${objectFormat || '(missing)'}`)
      }
      this._verificationGit(['init', '--bare', `--object-format=${objectFormat}`, verificationRepository], { cwd: temporaryRoot, env })
      this._verificationGit([
        'fetch', '--no-tags', '--force', '--prune', '--no-write-fetch-head',
        this.policy.trustedRemoteUrl,
        `+${this.policy.trustedRemoteRef}:refs/remotes/trusted/published`
      ], { cwd: verificationRepository, env })
      const fetchedHead = 'refs/remotes/trusted/published'
      const object = this._gitResult(['cat-file', '-e', `${head}^{commit}`], { cwd: verificationRepository, env })
      if (object.status !== 0 || object.error) {
        throw new WorkspaceManagerError(
          'WORKSPACE_UNPUSHED',
          `Workspace HEAD was not fetched from trusted HTTPS ref ${this.policy.trustedRemoteRef}; archive refused`
        )
      }
      const containment = this._gitResult(['merge-base', '--is-ancestor', head, fetchedHead], { cwd: verificationRepository, env })
      if (containment.status === 0 && !containment.error) return
      if (containment.status === 1 && !containment.error) {
        throw new WorkspaceManagerError(
          'WORKSPACE_UNPUSHED',
          `Workspace HEAD is not contained by trusted HTTPS ref ${this.policy.trustedRemoteRef}; archive refused`
        )
      }
      const detail = containment.stderr.trim() || containment.error?.message || `exit ${containment.status}`
      throw new WorkspaceManagerError('WORKSPACE_GIT_ERROR', `isolated publication verification failed: ${detail}`)
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }

  _ensureLocked(expected) {
    this._revalidateTrustedPaths(expected)
    const metadata = this._readMetadata(expected.metadataPath)
    if (metadata) {
      this._validateMetadata(metadata, expected)
      if (metadata.state === 'active') {
        this._validateActive(metadata, expected)
        return metadata
      }
      if (metadata.state === 'creating') return this._recoverCreating(metadata, expected)
      if (metadata.state === 'archiving') {
        throw new WorkspaceManagerError(
          'WORKSPACE_ARCHIVE_RECOVERY_REQUIRED',
          'Interrupted archive metadata requires operator reconciliation before command execution'
        )
      }
      throw new WorkspaceManagerError('WORKSPACE_NOT_ACTIVE', `Workspace metadata state is ${metadata.state}; reuse is forbidden`)
    }

    if (existsSync(expected.workspacePath)) {
      throw new WorkspaceManagerError('WORKSPACE_CONFLICT', `Workspace path exists without durable metadata: ${expected.workspacePath}`)
    }
    if (this._findWorktree(expected.workspacePath)) {
      throw new WorkspaceManagerError('WORKSPACE_CONFLICT', 'Git worktree exists without matching durable metadata')
    }
    if (this._branchCommit(expected.branch)) {
      throw new WorkspaceManagerError('WORKSPACE_BRANCH_CONFLICT', `Deterministic branch already exists without durable metadata: ${expected.branch}`)
    }

    const baseCommit = this._git(
      ['rev-parse', '--verify', '--end-of-options', `${this.policy.baseRef}^{commit}`],
      { cwd: this.repository }
    ).trim()
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
      throw new WorkspaceManagerError('WORKSPACE_BASE_INVALID', `Trusted baseRef did not resolve to a commit: ${this.policy.baseRef}`)
    }
    ensurePrivateDirectory(expected.metadataDir)
    const intent = {
      formatVersion: FORMAT_VERSION,
      state: 'creating',
      policyId: this.policy.policyId,
      root: this.root,
      repository: this.repository,
      baseRef: this.policy.baseRef,
      trustedRemoteUrl: this.policy.trustedRemoteUrl,
      trustedRemoteRef: this.policy.trustedRemoteRef,
      baseCommit,
      taskId: expected.taskId,
      agentId: expected.agentId,
      role: expected.role,
      workspacePath: expected.workspacePath,
      branch: expected.branch,
      createdAt: this.now(),
      updatedAt: this.now()
    }
    atomicWriteJson(expected.metadataPath, intent)
    return this._recoverCreating(intent, expected)
  }

  _recoverCreating(metadata, expected) {
    this._revalidateTrustedPaths(expected)
    this._validateMetadata(metadata, expected)
    const existingWorktree = this._findWorktree(expected.workspacePath)
    if (existsSync(expected.workspacePath)) {
      if (lstatSync(expected.workspacePath).isSymbolicLink()) {
        throw new WorkspaceManagerError('WORKSPACE_SYMLINK_ESCAPE', 'Workspace path became a symlink during recovery')
      }
      if (!existingWorktree) {
        throw new WorkspaceManagerError('WORKSPACE_PARTIAL_CONFLICT', 'Workspace directory exists but is not the expected Git worktree')
      }
    } else if (existingWorktree) {
      throw new WorkspaceManagerError('WORKSPACE_PARTIAL_CONFLICT', 'Git worktree registration exists but workspace path is missing')
    }

    if (!existingWorktree) {
      ensurePrivateDirectory(dirname(expected.workspacePath))
      const branchCommit = this._branchCommit(expected.branch)
      if (branchCommit && branchCommit !== metadata.baseCommit) {
        throw new WorkspaceManagerError('WORKSPACE_BRANCH_CONFLICT', 'Partially-created deterministic branch moved away from the fixed baseline')
      }
      if (branchCommit) {
        this._git(['worktree', 'add', '--', expected.workspacePath, expected.branch], { cwd: this.repository })
      } else {
        this._git([
          'worktree', 'add', '-b', expected.branch, '--', expected.workspacePath, metadata.baseCommit
        ], { cwd: this.repository })
      }
    }

    this._validateWorktree(expected, metadata)
    const active = { ...metadata, state: 'active', activatedAt: metadata.activatedAt || this.now(), updatedAt: this.now() }
    atomicWriteJson(expected.metadataPath, active)
    return active
  }

  _validateActive(metadata, expected) {
    this._revalidateTrustedPaths(expected)
    if (!existsSync(expected.workspacePath) || lstatSync(expected.workspacePath).isSymbolicLink()) {
      throw new WorkspaceManagerError('WORKSPACE_CONFLICT', 'Active workspace path is missing or is a symlink')
    }
    this._validateWorktree(expected, metadata)
  }

  _validateWorktree(expected, metadata) {
    const entry = this._findWorktree(expected.workspacePath)
    if (!entry) throw new WorkspaceManagerError('WORKSPACE_CONFLICT', 'Expected Git worktree registration is missing')
    if (entry.branch !== `refs/heads/${expected.branch}`) {
      throw new WorkspaceManagerError('WORKSPACE_BRANCH_CONFLICT', `Worktree branch mismatch: ${entry.branch || 'detached'}`)
    }
    chmodSync(expected.workspacePath, 0o700)
    const topLevel = realpathSync(this._git(['rev-parse', '--show-toplevel'], { cwd: expected.workspacePath }).trim())
    if (topLevel !== expected.workspacePath) {
      throw new WorkspaceManagerError('WORKSPACE_PATH_ESCAPE', 'Git worktree top-level does not match durable workspace path')
    }
    this._git(['merge-base', '--is-ancestor', metadata.baseCommit, 'HEAD'], { cwd: expected.workspacePath })
  }

  _validateMetadata(metadata, expected) {
    const exact = {
      formatVersion: FORMAT_VERSION,
      policyId: this.policy.policyId,
      root: this.root,
      repository: this.repository,
      baseRef: this.policy.baseRef,
      trustedRemoteUrl: this.policy.trustedRemoteUrl,
      trustedRemoteRef: this.policy.trustedRemoteRef,
      taskId: expected.taskId,
      agentId: expected.agentId,
      role: expected.role,
      workspacePath: expected.workspacePath,
      branch: expected.branch
    }
    for (const [field, value] of Object.entries(exact)) {
      if (metadata?.[field] !== value) {
        throw new WorkspaceManagerError('WORKSPACE_METADATA_CONFLICT', `Durable workspace metadata mismatch for ${field}`)
      }
    }
    if (!/^[0-9a-f]{40,64}$/.test(String(metadata.baseCommit || ''))) {
      throw new WorkspaceManagerError('WORKSPACE_METADATA_CONFLICT', 'Durable workspace metadata has an invalid baseCommit')
    }
    if (!['creating', 'active', 'archiving', 'archived'].includes(metadata.state)) {
      throw new WorkspaceManagerError('WORKSPACE_METADATA_CONFLICT', `Durable workspace metadata has invalid state ${metadata.state}`)
    }
    if (metadata.state === 'archiving' || metadata.state === 'archived') {
      const quarantinePath = String(metadata.quarantinePath || '')
      const archiveHead = metadata.state === 'archived' ? metadata.archivedHead : metadata.archiveHead
      if (!quarantinePath
          || !isInside(this.archiveQuarantineRoot, quarantinePath)
          || dirname(quarantinePath) !== this.archiveQuarantineRoot
          || !/^[0-9a-f]{40,64}$/.test(String(archiveHead || ''))) {
        throw new WorkspaceManagerError(
          'WORKSPACE_METADATA_CONFLICT',
          `Durable ${metadata.state} metadata has an unsafe quarantine path or HEAD`
        )
      }
      if (existsSync(quarantinePath) && lstatSync(quarantinePath).isSymbolicLink()) {
        throw new WorkspaceManagerError('WORKSPACE_SYMLINK_ESCAPE', 'Durable archive quarantine path became a symlink')
      }
      if (metadata.state === 'archived' && !existsSync(quarantinePath)) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_RECOVERY_REQUIRED', 'Archived workspace quarantine path is missing; physical deletion is not permitted here')
      }
    }
  }

  _readMetadata(path) {
    if (!existsSync(path)) return null
    assertNoSymlinkComponents(path, { allowMissing: false })
    chmodSync(path, 0o600)
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      throw new WorkspaceManagerError('WORKSPACE_METADATA_CORRUPT', `Cannot read durable workspace metadata: ${error.message}`)
    }
  }

  _branchCommit(branch) {
    const result = this._gitResult(['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`], { cwd: this.repository })
    if (result.status !== 0) return ''
    return result.stdout.trim()
  }

  _findWorktree(path) {
    const output = this._git(['worktree', 'list', '--porcelain'], { cwd: this.repository })
    return parseWorktreeList(output).find(entry => entry.path === path) || null
  }

  _revalidateTrustedPaths(expected) {
    assertNoSymlinkComponents(this.root, { allowMissing: false })
    assertNoSymlinkComponents(this.repository, { allowMissing: false })
    assertNoSymlinkComponents(this.archiveQuarantineRoot, { allowMissing: false })
    assertNoSymlinkComponents(dirname(expected.workspacePath))
    if (existsSync(expected.workspacePath) && lstatSync(expected.workspacePath).isSymbolicLink()) {
      throw new WorkspaceManagerError('WORKSPACE_SYMLINK_ESCAPE', 'Workspace path symlinks are forbidden')
    }
    if (!isInside(this.root, expected.workspacePath) || !isInside(this.metadataRoot, expected.metadataPath)) {
      throw new WorkspaceManagerError('WORKSPACE_PATH_ESCAPE', 'Workspace or metadata path escaped the trusted root')
    }
  }

  _withLock(expected, callback, ownerKind = 'operation') {
    this._acquireLock(expected, ownerKind)
    let callbackError = null
    try { return callback() } catch (error) {
      callbackError = error
      throw error
    } finally {
      try { this._releaseLock(expected.lockPath) } catch (error) {
        if (!callbackError) throw error
      }
    }
  }

  _acquireLock(expected, ownerKind = 'operation') {
    ensurePrivateDirectory(this.locksRoot)
    const startedAt = Date.now()
    while (true) {
      let created = false
      try {
        mkdirSync(expected.lockPath, { mode: 0o700 })
        created = true
        chmodSync(expected.lockPath, 0o700)
        fsyncDirectory(this.locksRoot)
        atomicWriteJson(resolve(expected.lockPath, 'owner.json'), {
          formatVersion: FORMAT_VERSION,
          kind: ownerKind,
          pid: process.pid,
          hostname: hostname(),
          policyId: this.policy.policyId,
          taskId: expected.taskId,
          agentId: expected.agentId,
          acquiredAt: this.now()
        })
        return
      } catch (error) {
        if (created) {
          try { this._releaseLock(expected.lockPath) } catch {}
        }
        if (error?.code !== 'EEXIST') {
          throw error instanceof WorkspaceManagerError
            ? error
            : new WorkspaceManagerError('WORKSPACE_LOCK_ERROR', `Cannot acquire workspace lock: ${error.message}`)
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new WorkspaceManagerError('WORKSPACE_LOCK_TIMEOUT', 'Timed out waiting for workspace lock; stale locks are never stolen automatically')
        }
        this.sleepSync(Math.max(1, this.lockRetryMs))
      }
    }
  }

  _releaseLock(lockPath) {
    const owner = resolve(lockPath, 'owner.json')
    if (existsSync(owner)) durableUnlink(owner)
    const leftovers = readdirSync(lockPath)
    if (leftovers.length) throw new WorkspaceManagerError('WORKSPACE_LOCK_ERROR', 'Workspace lock contains unexpected files')
    rmdirSync(lockPath)
    fsyncDirectory(this.locksRoot)
  }

  _hardenedGit(args, options = {}) {
    return this._git([...HARDENED_WORKTREE_GIT_CONFIG, ...args], options)
  }

  _gitResult(args, { cwd, env, input } = {}) {
    const result = this.gitRunner({ gitBin: this.gitBin, cwd, args, env: env || process.env, input }) || {}
    return {
      status: Number.isInteger(result.status) ? result.status : (result.error ? 1 : 0),
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      error: result.error
    }
  }

  _git(args, { cwd, env, input } = {}) {
    const result = this._gitResult(args, { cwd, env, input })
    if (result.status !== 0 || result.error) {
      const detail = result.stderr.trim() || result.error?.message || `exit ${result.status}`
      throw new WorkspaceManagerError('WORKSPACE_GIT_ERROR', `git ${args.join(' ')} failed: ${detail}`)
    }
    return result.stdout
  }
}

const parseCli = argv => {
  const [action, ...rest] = argv
  const values = {}
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]
    if (!key.startsWith('--') || index + 1 >= rest.length) {
      throw new WorkspaceManagerError('WORKSPACE_CLI_INVALID', `Invalid argument: ${key}`)
    }
    values[key.slice(2)] = rest[index + 1]
    index += 1
  }
  return { action, values }
}

export const workspaceManagerCli = argv => {
  loadDotEnv(process.cwd())
  const { action, values } = parseCli(argv)
  const policies = loadWorkspacePolicies()
  if (action === 'validate-all') {
    for (const policy of policies.values()) {
      new GitWorkspaceManager({ policy, agentId: 'validation-agent', role: 'validator' }).initialize()
    }
    return { policies: policies.size }
  }
  const policy = policies.get(values.policy)
  if (!policy) throw new WorkspaceManagerError('WORKSPACE_POLICY_NOT_FOUND', `Unknown workspace policy: ${values.policy || ''}`)
  const manager = new GitWorkspaceManager({
    policy,
    agentId: values.agent,
    role: values.role || DEFAULT_ROLE
  })
  if (action === 'ensure') return manager.ensureWorkspace(values.task)
  if (action === 'inspect') return manager.inspectWorkspace(values.task)
  if (action === 'archive') return manager.archiveWorkspace(values.task)
  throw new WorkspaceManagerError('WORKSPACE_CLI_INVALID', 'Usage: workspace-manager.mjs {ensure|inspect|archive|validate-all} --policy ID --task ID --agent ID [--role ROLE]')
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    console.log(JSON.stringify(workspaceManagerCli(process.argv.slice(2))))
  } catch (error) {
    console.error(`${error.code || 'WORKSPACE_ERROR'}: ${error.message}`)
    process.exit(1)
  }
}
