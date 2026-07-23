import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test, { afterEach } from 'node:test'

import { runCodex } from '../agent-client.mjs'
import {
  GitWorkspaceManager,
  parseWorkspacePolicies,
  runGitProcess
} from '../workspace-manager.mjs'

const temporaryDirectories = []
afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

const temporaryDirectory = () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'codex-ws-agent-a07-'))
  temporaryDirectories.push(directory)
  return directory
}

const git = (cwd, args, options = {}) => {
  const result = runGitProcess({ cwd, args })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return String(result.stdout || '').trim()
}

const createRepository = () => {
  const root = temporaryDirectory()
  const repository = resolve(root, 'repository')
  mkdirSync(repository)
  git(repository, ['init', '-b', 'master'])
  git(repository, ['config', 'user.email', 'a07@example.test'])
  git(repository, ['config', 'user.name', 'A07 Test'])
  writeFileSync(resolve(repository, 'tracked.txt'), 'baseline\n')
  git(repository, ['add', 'tracked.txt'])
  git(repository, ['commit', '-m', 'baseline'])
  git(repository, ['remote', 'add', 'origin', 'https://trusted.example/a07.git'])
  git(repository, ['update-ref', 'refs/remotes/origin/master', 'refs/heads/master'])
  return {
    root,
    repository,
    workspaces: resolve(root, 'agent-workspaces'),
    policy: {
      policyId: 'test-repository',
      root: resolve(root, 'agent-workspaces'),
      repository,
      baseRef: 'refs/heads/master',
      remote: {
        name: 'origin',
        url: 'https://trusted.example/a07.git'
      }
    }
  }
}

const noNetworkFetchRunner = input => {
  if (input.args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' }
  return runGitProcess(input)
}

const manager = (fixture, agentId = 'agent-a', options = {}) => new GitWorkspaceManager({
  policy: fixture.policy,
  agentId,
  role: options.role || 'coder',
  gitRunner: noNetworkFetchRunner,
  ...options
})

const runChildEnsure = (fixture, agentId, taskId) => new Promise((resolvePromise, rejectPromise) => {
  const moduleUrl = new URL('../workspace-manager.mjs', import.meta.url).href
  const script = `
    import { GitWorkspaceManager } from ${JSON.stringify(moduleUrl)};
    const policy = JSON.parse(process.env.A07_POLICY);
    const result = new GitWorkspaceManager({ policy, agentId: process.env.A07_AGENT, role: 'coder' })
      .ensureWorkspace(process.env.A07_TASK);
    console.log(JSON.stringify(result));
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      A07_POLICY: JSON.stringify(fixture.policy),
      A07_AGENT: agentId,
      A07_TASK: taskId
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', rejectPromise)
  child.on('close', code => {
    if (code !== 0) rejectPromise(new Error(stderr || `child exited ${code}`))
    else resolvePromise(JSON.parse(stdout.trim()))
  })
})

test('concurrent processes idempotently create one task-agent worktree', async () => {
  const fixture = createRepository()
  const [left, right] = await Promise.all([
    runChildEnsure(fixture, 'agent-a', 'task-concurrent'),
    runChildEnsure(fixture, 'agent-a', 'task-concurrent')
  ])

  assert.equal(left.workspacePath, right.workspacePath)
  assert.equal(left.branch, right.branch)
  assert.equal(left.baseCommit, right.baseCommit)
  assert.equal(left.state, 'active')
  const listed = git(fixture.repository, ['worktree', 'list', '--porcelain'])
  assert.equal(listed.split('\n').filter(line => line === `worktree ${left.workspacePath}`).length, 1)
})

test('same task uses isolated directories and branches for different canonical agents', () => {
  const fixture = createRepository()
  const left = manager(fixture, 'agent-a').ensureWorkspace('task-shared')
  const right = manager(fixture, 'agent-b').ensureWorkspace('task-shared')

  assert.notEqual(left.workspacePath, right.workspacePath)
  assert.notEqual(left.branch, right.branch)
  assert.match(left.workspacePath, /task-shared\/agent-agent-a$/)
  assert.match(right.workspacePath, /task-shared\/agent-agent-b$/)
})

test('restart reuses fixed baseline metadata and rejects tampering', () => {
  const fixture = createRepository()
  const first = manager(fixture).ensureWorkspace('task-restart')
  const restarted = manager(fixture).ensureWorkspace('task-restart')
  assert.equal(restarted.workspacePath, first.workspacePath)
  assert.equal(restarted.baseCommit, first.baseCommit)

  const descriptor = manager(fixture).describe('task-restart')
  assert.equal(statSync(fixture.workspaces).mode & 0o777, 0o700)
  assert.equal(statSync(first.workspacePath).mode & 0o777, 0o700)
  assert.equal(statSync(descriptor.metadataPath).mode & 0o777, 0o600)
  const metadata = JSON.parse(readFileSync(descriptor.metadataPath, 'utf8'))
  writeFileSync(descriptor.metadataPath, `${JSON.stringify({ ...metadata, repository: fixture.workspaces })}\n`)
  assert.throws(
    () => manager(fixture).ensureWorkspace('task-restart'),
    error => error.code === 'WORKSPACE_METADATA_CONFLICT'
  )
})

test('archive is explicit and refuses untracked, unmerged, and unpushed work', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-archive')

  writeFileSync(resolve(active.workspacePath, 'untracked.txt'), 'do not delete\n')
  assert.throws(
    () => manager(fixture).archiveWorkspace('task-archive'),
    error => error.code === 'WORKSPACE_DIRTY'
  )
  unlinkSync(resolve(active.workspacePath, 'untracked.txt'))

  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'agent commit\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'agent commit'])
  assert.throws(
    () => manager(fixture).archiveWorkspace('task-archive'),
    error => error.code === 'WORKSPACE_UNPUSHED'
  )

  const baseCommit = active.baseCommit
  git(active.workspacePath, ['checkout', '-b', 'conflict-side', baseCommit])
  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'side\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'side'])
  git(active.workspacePath, ['checkout', active.branch])
  git(active.workspacePath, ['merge', 'conflict-side'], { allowFailure: true })
  assert.throws(
    () => manager(fixture).archiveWorkspace('task-archive'),
    error => error.code === 'WORKSPACE_UNMERGED'
  )
  assert.equal(Boolean(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8')), true)
})

test('archive refuses tracked modifications hidden by assume-unchanged or skip-worktree', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const fixture = createRepository()
    const taskId = `task-hidden-${flag.slice(2)}`
    const active = manager(fixture).ensureWorkspace(taskId)
    git(active.workspacePath, ['update-index', flag, 'tracked.txt'])
    writeFileSync(resolve(active.workspacePath, 'tracked.txt'), `${flag} hidden modification\n`)
    assert.equal(git(active.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')
    assert.throws(
      () => manager(fixture).archiveWorkspace(taskId),
      error => error.code === 'WORKSPACE_INDEX_HIDDEN'
    )
    assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), `${flag} hidden modification\n`)
  }
})

test('archive ignores local upstreams and requires freshly fetched trusted remote containment', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-remote-proof')
  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'agent commit\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'agent commit'])
  git(fixture.repository, ['branch', 'published-local-only', 'HEAD'])
  git(fixture.repository, ['config', `branch.${active.branch}.remote`, '.'])
  git(fixture.repository, ['config', `branch.${active.branch}.merge`, 'refs/heads/published-local-only'])

  assert.throws(
    () => manager(fixture).archiveWorkspace('task-remote-proof'),
    error => error.code === 'WORKSPACE_UNPUSHED'
  )

  git(fixture.repository, ['update-ref', 'refs/remotes/origin/master', git(active.workspacePath, ['rev-parse', 'HEAD'])])
  let fetched = 0
  const publishedManager = manager(fixture, 'agent-a', {
    gitRunner: input => {
      if (input.args[0] === 'fetch') {
        fetched += 1
        assert.deepEqual(input.args, [
          'fetch', '--prune', '--no-tags', 'origin',
          '+refs/heads/*:refs/remotes/origin/*'
        ])
        return { status: 0, stdout: '', stderr: '' }
      }
      return runGitProcess(input)
    }
  })
  const archived = publishedManager.archiveWorkspace('task-remote-proof')
  assert.equal(fetched, 1)
  assert.equal(archived.state, 'archived')
})

test('archive rejects a local fake remote even when its tracking ref contains HEAD', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-fake-remote')
  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'agent commit\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'agent commit'])
  git(fixture.repository, ['update-ref', 'refs/remotes/origin/master', git(active.workspacePath, ['rev-parse', 'HEAD'])])
  git(fixture.repository, ['remote', 'set-url', 'origin', fixture.repository])

  assert.throws(
    () => manager(fixture).archiveWorkspace('task-fake-remote'),
    error => error.code === 'WORKSPACE_REMOTE_UNTRUSTED'
  )
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'agent commit\n')
})

test('archive fails closed when the trusted remote fetch fails', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-fetch-failure')
  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'agent commit\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'agent commit'])
  let fetches = 0
  const failing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      if (input.args[0] === 'fetch') {
        fetches += 1
        return { status: 1, stdout: '', stderr: 'injected fetch failure' }
      }
      return runGitProcess(input)
    }
  })
  assert.throws(
    () => failing.archiveWorkspace('task-fetch-failure'),
    error => error.code === 'WORKSPACE_GIT_ERROR' && /injected fetch failure/.test(error.message)
  )
  assert.equal(fetches, 1)
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'agent commit\n')
})

test('workspace policies reject local remote URLs and canonical resource overlap across policy IDs', () => {
  const fixture = createRepository()
  assert.throws(
    () => new GitWorkspaceManager({
      policy: { ...fixture.policy, remote: { name: 'origin', url: fixture.repository } },
      agentId: 'agent-a'
    }),
    error => error.code === 'WORKSPACE_POLICY_INVALID'
  )

  const duplicate = {
    first: { ...fixture.policy },
    second: {
      ...fixture.policy,
      root: resolve(fixture.workspaces, '..', 'agent-workspaces'),
      repository: resolve(fixture.repository, '..', 'repository')
    }
  }
  assert.throws(
    () => parseWorkspacePolicies(JSON.stringify(duplicate)),
    error => error.code === 'WORKSPACE_POLICY_INVALID' && /duplicate or overlapping canonical/.test(error.message)
  )

  const first = manager(fixture, 'agent-a')
  const aliasPolicy = { ...fixture.policy, policyId: 'alias-policy' }
  const second = new GitWorkspaceManager({ policy: aliasPolicy, agentId: 'agent-a', gitRunner: noNetworkFetchRunner })
  assert.equal(first.describe('task-lock-identity').lockPath, second.describe('task-lock-identity').lockPath)
})

test('task traversal and symlink workspace escapes fail closed', () => {
  const fixture = createRepository()
  assert.throws(
    () => manager(fixture).ensureWorkspace('../escape'),
    error => error.code === 'WORKSPACE_ID_INVALID'
  )

  const symlinkRoot = resolve(fixture.root, 'symlink-root')
  const outside = resolve(fixture.root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, symlinkRoot, 'dir')
  assert.throws(
    () => new GitWorkspaceManager({
      policy: { ...fixture.policy, policyId: 'symlink-policy', root: symlinkRoot },
      agentId: 'agent-a'
    }).initialize(),
    error => error.code === 'WORKSPACE_SYMLINK_ESCAPE'
  )

  const initialized = manager(fixture).initialize()
  symlinkSync(outside, resolve(fixture.workspaces, 'task-symlink'), 'dir')
  assert.throws(
    () => initialized.ensureWorkspace('task-symlink'),
    error => error.code === 'WORKSPACE_SYMLINK_ESCAPE'
  )
})

test('pre-existing deterministic branch or unowned workspace path is rejected', () => {
  const fixture = createRepository()
  const branchManager = manager(fixture)
  const branchDescriptor = branchManager.describe('task-branch-conflict')
  git(fixture.repository, ['branch', branchDescriptor.branch, fixture.policy.baseRef])
  assert.throws(
    () => branchManager.ensureWorkspace('task-branch-conflict'),
    error => error.code === 'WORKSPACE_BRANCH_CONFLICT'
  )

  const pathManager = manager(fixture, 'agent-b')
  const pathDescriptor = pathManager.describe('task-path-conflict')
  mkdirSync(pathDescriptor.workspacePath, { recursive: true })
  assert.throws(
    () => pathManager.ensureWorkspace('task-path-conflict'),
    error => error.code === 'WORKSPACE_CONFLICT'
  )
})

test('durable creating intent recovers after git reports failure following partial creation', () => {
  const fixture = createRepository()
  let injected = false
  const flakyRunner = input => {
    const result = runGitProcess(input)
    if (!injected && input.args[0] === 'worktree' && input.args[1] === 'add') {
      injected = true
      return { ...result, status: 1, stderr: 'injected post-create failure' }
    }
    return result
  }
  const flaky = manager(fixture, 'agent-a', { gitRunner: flakyRunner })
  assert.throws(
    () => flaky.ensureWorkspace('task-partial'),
    error => error.code === 'WORKSPACE_GIT_ERROR'
  )
  const descriptor = flaky.describe('task-partial')
  assert.equal(JSON.parse(readFileSync(descriptor.metadataPath, 'utf8')).state, 'creating')

  const recovered = manager(fixture).ensureWorkspace('task-partial')
  assert.equal(recovered.state, 'active')
  assert.equal(recovered.workspacePath, descriptor.workspacePath)
})

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.exitCode = null
    this.killed = false
  }
  kill() { this.killed = true }
}

const runtimeProfile = fixture => ({
  profileId: 'profile-a',
  agentId: 'agent-a',
  agentName: 'Agent A',
  personaName: 'Agent A',
  codexBin: '/bin/true',
  codexHome: '',
  codexWorkdir: fixture.root,
  codexSandbox: 'workspace-write',
  codexApproval: 'never',
  codexSessionMode: 'resume',
  codexTimeoutMs: 1000,
  workspacePolicyId: fixture.policy.policyId,
  workspaceRole: 'coder',
  workspaceNoTaskPolicy: 'reject',
  workspaceNonCodingCommandTypes: [],
  workspaceFallbackWorkdir: ''
})

const dispatch = (taskId = 'task-runtime') => ({
  schemaVersion: 1,
  messageType: 'command.dispatch',
  messageId: `message-${taskId || 'none'}`,
  commandId: `command-${taskId || 'none'}`,
  commandType: 'TASK_EXECUTE',
  targetAgentId: 'agent-a',
  taskId,
  content: 'implement the task',
  payload: {
    instruction: 'implement the task',
    workspaceRoot: '/tmp/payload-escape',
    repository: '/tmp/payload-repository',
    baseRef: 'refs/heads/payload-controlled'
  }
})

test('client command execution passes the managed worktree as spawn cwd and --cd', async () => {
  const fixture = createRepository()
  const workspaceManager = manager(fixture)
  const child = new FakeChild()
  let invocation
  const resultPromise = runCodex(runtimeProfile(fixture), dispatch(), 'command', {
    workspaceManager,
    requireWorkspace: true,
    spawnFn: (binary, args, options) => {
      invocation = { binary, args, options }
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`)
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0)
      })
      return child
    },
    sendLegacyFn: () => true,
    sendStatusFn: () => true
  })
  const result = await resultPromise
  const expected = workspaceManager.describe('task-runtime').workspacePath

  assert.equal(result.status, 'completed')
  assert.equal(result.workspacePath, expected)
  assert.equal(invocation.options.cwd, expected)
  assert.equal(invocation.args[invocation.args.indexOf('--cd') + 1], expected)
  assert.equal(invocation.args.includes('resume'), false, 'managed command must not resume a session from another worktree')
})

test('dedicated fallback rejects overlap in both containment directions', () => {
  const fixture = createRepository()
  const workspaceManager = manager(fixture)
  const options = {
    noTaskPolicy: 'dedicated-workdir',
    nonCodingCommandTypes: ['STATUS_QUERY']
  }
  assert.throws(
    () => workspaceManager.resolveCommandWorkspace(
      { taskId: '', commandType: 'STATUS_QUERY' },
      { ...options, fallbackWorkdir: fixture.workspaces }
    ),
    error => error.code === 'WORKSPACE_FALLBACK_INVALID'
  )
  assert.throws(
    () => workspaceManager.resolveCommandWorkspace(
      { taskId: '', commandType: 'STATUS_QUERY' },
      { ...options, fallbackWorkdir: fixture.root }
    ),
    error => error.code === 'WORKSPACE_FALLBACK_INVALID'
  )
})

test('no-task command requires an explicit non-coding dedicated-workdir policy', async () => {
  const fixture = createRepository()
  const workspaceManager = manager(fixture)
  const rejected = await runCodex(runtimeProfile(fixture), { ...dispatch(''), taskId: '', commandType: 'STATUS_QUERY' }, 'command', {
    workspaceManager,
    requireWorkspace: true,
    spawnFn: () => { throw new Error('must not spawn') },
    sendLegacyFn: () => true,
    sendStatusFn: () => true
  })
  assert.equal(rejected.workspaceErrorCode, 'WORKSPACE_TASK_ID_REQUIRED')

  const fallback = resolve(fixture.root, 'non-code-fallback')
  mkdirSync(fallback)
  const profile = {
    ...runtimeProfile(fixture),
    workspaceNoTaskPolicy: 'dedicated-workdir',
    workspaceNonCodingCommandTypes: ['STATUS_QUERY'],
    workspaceFallbackWorkdir: fallback
  }
  const child = new FakeChild()
  let cwd = ''
  const acceptedPromise = runCodex(profile, { ...dispatch(''), taskId: '', commandType: 'STATUS_QUERY' }, 'command', {
    workspaceManager,
    requireWorkspace: true,
    spawnFn: (_binary, _args, options) => {
      cwd = options.cwd
      queueMicrotask(() => {
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0)
      })
      return child
    },
    sendLegacyFn: () => true,
    sendStatusFn: () => true
  })
  const accepted = await acceptedPromise
  assert.equal(accepted.status, 'completed', JSON.stringify(accepted))
  assert.equal(cwd, fallback)
})
