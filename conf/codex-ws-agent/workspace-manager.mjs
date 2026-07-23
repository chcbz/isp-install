import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace remote URL is missing or unsafe for policy ${policyId}`)
  }
  let parsed
  try { parsed = new URL(remoteUrl) } catch {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace remote URL must be an absolute HTTPS or SSH URL for policy ${policyId}`)
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace remote URL must use HTTPS or SSH and cannot be a local/file URL for policy ${policyId}`)
  }
  return remoteUrl
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
  const remote = policy.remote
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace trusted remote is required for policy ${policyId}`)
  }
  const remoteName = String(remote.name || '').trim()
  if (!SAFE_REMOTE_NAME.test(remoteName) || remoteName === '.' || remoteName === '..') {
    throw new WorkspaceManagerError('WORKSPACE_POLICY_INVALID', `Workspace remote name is missing or unsafe for policy ${policyId}`)
  }
  const remoteUrl = validateTrustedRemoteUrl(remote.url, policyId)
  return { policyId, root, repository, baseRef, remote: { name: remoteName, url: remoteUrl } }
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

export const runGitProcess = ({ gitBin = 'git', cwd, args }) => spawnSync(gitBin, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
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
    ensurePrivateDirectory(this.metadataRoot)
    ensurePrivateDirectory(this.locksRoot)
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
    return this._withLock(expected, () => this._ensureLocked(expected))
  }

  resolveCommandWorkspace(message, {
    noTaskPolicy = 'reject',
    nonCodingCommandTypes = [],
    fallbackWorkdir = ''
  } = {}) {
    this.initialize()
    const taskId = String(message?.taskId || '').trim()
    if (taskId) return { ...this.ensureWorkspace(taskId), managed: true }

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
      if (metadata.state !== 'active') {
        throw new WorkspaceManagerError('WORKSPACE_NOT_ACTIVE', `Workspace metadata state is ${metadata.state}`)
      }
      this._validateActive(metadata, expected)
      return metadata
    })
  }

  archiveWorkspace(taskId) {
    const expected = this.describe(taskId)
    return this._withLock(expected, () => {
      const metadata = this._readMetadata(expected.metadataPath)
      if (!metadata) throw new WorkspaceManagerError('WORKSPACE_METADATA_MISSING', 'Durable workspace metadata is missing')
      this._validateMetadata(metadata, expected)
      if (metadata.state !== 'active') {
        throw new WorkspaceManagerError('WORKSPACE_NOT_ACTIVE', `Only active workspaces can be archived; current state=${metadata.state}`)
      }
      this._validateActive(metadata, expected)
      const unmerged = this._git(['diff', '--name-only', '--diff-filter=U'], { cwd: expected.workspacePath })
      if (unmerged.trim()) throw new WorkspaceManagerError('WORKSPACE_UNMERGED', 'Workspace has unmerged files; archive refused')
      const dirty = this._git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: expected.workspacePath })
      if (dirty.trim()) throw new WorkspaceManagerError('WORKSPACE_DIRTY', 'Workspace has modified or untracked files; archive refused')
      const ignored = this._git(
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--'],
        { cwd: expected.workspacePath }
      )
      if (ignored) throw new WorkspaceManagerError('WORKSPACE_DIRTY', 'Workspace has ignored untracked files; archive refused')
      const indexEntries = this._git(['ls-files', '-v', '-z', '--'], { cwd: expected.workspacePath })
        .split('\0')
        .filter(Boolean)
      const hiddenEntries = indexEntries.filter(entry => !entry.startsWith('H '))
      if (hiddenEntries.length) {
        throw new WorkspaceManagerError(
          'WORKSPACE_INDEX_HIDDEN',
          'Workspace index contains skip-worktree, assume-unchanged, or another non-normal tracked-file flag; archive refused'
        )
      }
      const head = this._git(['rev-parse', 'HEAD'], { cwd: expected.workspacePath }).trim()
      if (head !== metadata.baseCommit) this._assertHeadPublishedToTrustedRemote(expected, head)
      this._git(['worktree', 'remove', '--', expected.workspacePath], { cwd: this.repository })
      if (existsSync(expected.workspacePath)) {
        throw new WorkspaceManagerError('WORKSPACE_ARCHIVE_FAILED', 'Git reported success but workspace path still exists')
      }
      const archived = { ...metadata, state: 'archived', archivedAt: this.now(), updatedAt: this.now() }
      atomicWriteJson(expected.metadataPath, archived)
      return archived
    })
  }

  _assertHeadPublishedToTrustedRemote(expected, head) {
    const { name, url } = this.policy.remote
    const configuredUrls = this._git(['remote', 'get-url', '--all', name], { cwd: this.repository })
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean)
    if (configuredUrls.length !== 1 || configuredUrls[0] !== url) {
      throw new WorkspaceManagerError(
        'WORKSPACE_REMOTE_UNTRUSTED',
        `Trusted remote ${name} URL does not exactly match workspace policy; archive refused`
      )
    }
    this._git([
      'fetch', '--prune', '--no-tags', name,
      `+refs/heads/*:refs/remotes/${name}/*`
    ], { cwd: this.repository })
    const prefix = `refs/remotes/${name}/`
    const remoteRefs = this._git(['for-each-ref', '--format=%(refname)', prefix], { cwd: this.repository })
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(value => value.startsWith(prefix) && value !== `${prefix}HEAD`)
    for (const remoteRef of remoteRefs) {
      const containment = this._gitResult(['merge-base', '--is-ancestor', head, remoteRef], { cwd: expected.workspacePath })
      if (containment.status === 0 && !containment.error) return
      if (containment.status > 1 || containment.error) {
        const detail = containment.stderr.trim() || containment.error?.message || `exit ${containment.status}`
        throw new WorkspaceManagerError('WORKSPACE_GIT_ERROR', `git merge-base publication check failed: ${detail}`)
      }
    }
    throw new WorkspaceManagerError(
      'WORKSPACE_UNPUSHED',
      `Workspace HEAD is not contained by any freshly fetched ${name} remote-tracking branch; archive refused`
    )
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
      remoteName: this.policy.remote.name,
      remoteUrl: this.policy.remote.url,
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
      remoteName: this.policy.remote.name,
      remoteUrl: this.policy.remote.url,
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
    if (!['creating', 'active', 'archived'].includes(metadata.state)) {
      throw new WorkspaceManagerError('WORKSPACE_METADATA_CONFLICT', `Durable workspace metadata has invalid state ${metadata.state}`)
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
    assertNoSymlinkComponents(dirname(expected.workspacePath))
    if (existsSync(expected.workspacePath) && lstatSync(expected.workspacePath).isSymbolicLink()) {
      throw new WorkspaceManagerError('WORKSPACE_SYMLINK_ESCAPE', 'Workspace path symlinks are forbidden')
    }
    if (!isInside(this.root, expected.workspacePath) || !isInside(this.metadataRoot, expected.metadataPath)) {
      throw new WorkspaceManagerError('WORKSPACE_PATH_ESCAPE', 'Workspace or metadata path escaped the trusted root')
    }
  }

  _withLock(expected, callback) {
    ensurePrivateDirectory(this.locksRoot)
    const startedAt = Date.now()
    while (true) {
      try {
        mkdirSync(expected.lockPath, { mode: 0o700 })
        chmodSync(expected.lockPath, 0o700)
        fsyncDirectory(this.locksRoot)
        atomicWriteJson(resolve(expected.lockPath, 'owner.json'), {
          formatVersion: FORMAT_VERSION,
          pid: process.pid,
          hostname: hostname(),
          policyId: this.policy.policyId,
          taskId: expected.taskId,
          agentId: expected.agentId,
          acquiredAt: this.now()
        })
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          if (existsSync(expected.lockPath)) {
            try { this._releaseLock(expected.lockPath) } catch {}
          }
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

  _releaseLock(lockPath) {
    const owner = resolve(lockPath, 'owner.json')
    if (existsSync(owner)) durableUnlink(owner)
    const leftovers = readdirSync(lockPath)
    if (leftovers.length) throw new WorkspaceManagerError('WORKSPACE_LOCK_ERROR', 'Workspace lock contains unexpected files')
    rmdirSync(lockPath)
    fsyncDirectory(this.locksRoot)
  }

  _gitResult(args, { cwd }) {
    const result = this.gitRunner({ gitBin: this.gitBin, cwd, args }) || {}
    return {
      status: Number.isInteger(result.status) ? result.status : (result.error ? 1 : 0),
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      error: result.error
    }
  }

  _git(args, { cwd }) {
    const result = this._gitResult(args, { cwd })
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
