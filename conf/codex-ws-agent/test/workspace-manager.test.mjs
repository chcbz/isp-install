import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  cpSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  const publisher = resolve(root, 'publisher.git')
  git(root, ['clone', '--bare', repository, publisher])
  const trustedRemoteUrl = 'https://trusted.example/a07.git'
  const trustedRemoteRef = 'refs/heads/master'
  return {
    root,
    repository,
    publisher,
    workspaces: resolve(root, 'agent-workspaces'),
    policy: {
      policyId: 'test-repository',
      root: resolve(root, 'agent-workspaces'),
      repository,
      baseRef: 'refs/heads/master',
      trustedRemoteUrl,
      trustedRemoteRef
    }
  }
}

const verificationFetchIndex = args => args.indexOf('fetch')

const gitCommandArgs = args => {
  let index = 0
  while (args[index] === '-c' && index + 1 < args.length) index += 2
  return args.slice(index)
}

const assertHardenedWorktreeGit = args => {
  for (const setting of [
    'core.trustctime=true',
    'core.filemode=true',
    'core.checkStat=default',
    'core.ignoreStat=false',
    'core.fsmonitor=false',
    'core.untrackedCache=false'
  ]) {
    assert.equal(args.some((value, index) => value === '-c' && args[index + 1] === setting), true, `missing ${setting}`)
  }
}

const httpsVerificationRunner = (fixture, onFetch = () => {}) => input => {
  const fetchIndex = verificationFetchIndex(input.args)
  if (fetchIndex >= 0) {
    onFetch(input)
    return runGitProcess({
      ...input,
      args: [
        '-c', 'protocol.file.allow=always',
        'fetch', '--no-tags', '--force', '--prune', '--no-write-fetch-head',
        fixture.publisher,
        input.args.at(-1)
      ]
    })
  }
  return runGitProcess(input)
}

const manager = (fixture, agentId = 'agent-a', options = {}) => new GitWorkspaceManager({
  policy: fixture.policy,
  agentId,
  role: options.role || 'coder',
  gitRunner: httpsVerificationRunner(fixture),
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

const runChildWorkspaceProbe = (fixture, taskId, action = 'inspect') => {
  const moduleUrl = new URL('../workspace-manager.mjs', import.meta.url).href
  const script = `
    import { GitWorkspaceManager } from ${JSON.stringify(moduleUrl)};
    const manager = new GitWorkspaceManager({
      policy: JSON.parse(process.env.A07_POLICY),
      agentId: process.env.A07_AGENT,
      role: 'coder'
    });
    try {
      const value = process.env.A07_ACTION === 'ensure'
        ? manager.ensureWorkspace(process.env.A07_TASK)
        : manager.inspectWorkspace(process.env.A07_TASK);
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code || '', message: error.message }));
    }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      A07_POLICY: JSON.stringify(fixture.policy),
      A07_AGENT: 'agent-a',
      A07_TASK: taskId,
      A07_ACTION: action
    },
    encoding: 'utf8'
  })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout.trim())
}

const archiveBaselineWorkspace = taskId => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace(taskId)
  const archived = manager(fixture).archiveWorkspace(taskId)
  const metadataPath = manager(fixture).describe(taskId).metadataPath
  return { fixture, active, archived, metadataPath }
}

const assertArchivedRestartRecoveryRequired = (fixture, taskId, messagePattern) => {
  for (const action of ['inspect', 'ensure']) {
    const probe = runChildWorkspaceProbe(fixture, taskId, action)
    assert.equal(probe.ok, false)
    assert.equal(probe.code, 'WORKSPACE_ARCHIVE_RECOVERY_REQUIRED')
    if (messagePattern) assert.match(probe.message, messagePattern)
  }
}

const createAlternateCommit = (fixture, parent) => {
  const tree = git(fixture.repository, ['rev-parse', `${parent}^{tree}`])
  return git(fixture.repository, ['commit-tree', tree, '-p', parent, '-m', 'alternate retained state'])
}

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

test('archive hashes tracked files instead of trusting a clean stat cache', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-stat-cache')
  const trackedPath = resolve(active.workspacePath, 'tracked.txt')
  const timestamp = Math.floor(Date.now() / 1000) - 60
  utimesSync(trackedPath, timestamp, timestamp)
  git(active.workspacePath, ['update-index', '--refresh'])
  git(active.workspacePath, ['config', 'core.trustctime', 'false'])

  writeFileSync(trackedPath, 'tampered\n')
  utimesSync(trackedPath, timestamp, timestamp)
  assert.equal(readFileSync(trackedPath, 'utf8').length, 'baseline\n'.length)
  assert.equal(git(active.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')

  assert.throws(
    () => manager(fixture).archiveWorkspace('task-stat-cache'),
    error => error.code === 'WORKSPACE_TRACKED_MISMATCH'
  )
  assert.equal(readFileSync(trackedPath, 'utf8'), 'tampered\n')
})

test('archive verifies actual executable mode even when core.filemode hides it', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-mode-cache')
  const trackedPath = resolve(active.workspacePath, 'tracked.txt')
  git(active.workspacePath, ['config', 'core.filemode', 'false'])
  chmodSync(trackedPath, 0o755)
  assert.equal(git(active.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')

  assert.throws(
    () => manager(fixture).archiveWorkspace('task-mode-cache'),
    error => error.code === 'WORKSPACE_TRACKED_MISMATCH'
  )
  assert.equal(statSync(trackedPath).mode & 0o111, 0o111)
})

test('archive hashes tracked symlink targets instead of trusting cached metadata', () => {
  const fixture = createRepository()
  const sourceLink = resolve(fixture.repository, 'tracked-link')
  symlinkSync('tracked.txt', sourceLink)
  git(fixture.repository, ['add', 'tracked-link'])
  git(fixture.repository, ['commit', '-m', 'add tracked symlink'])
  const active = manager(fixture).ensureWorkspace('task-symlink-cache')
  const trackedLink = resolve(active.workspacePath, 'tracked-link')
  const timestamp = Math.floor(Date.now() / 1000) - 60
  lutimesSync(trackedLink, timestamp, timestamp)
  git(active.workspacePath, ['update-index', '--refresh'])
  git(active.workspacePath, ['config', 'core.trustctime', 'false'])

  unlinkSync(trackedLink)
  symlinkSync('missing.txt', trackedLink)
  lutimesSync(trackedLink, timestamp, timestamp)
  assert.equal('missing.txt'.length, 'tracked.txt'.length)
  const delegated = httpsVerificationRunner(fixture)
  const cacheBlindManager = manager(fixture, 'agent-a', {
    gitRunner: input => input.args[0] === 'status'
      ? { status: 0, stdout: '', stderr: '' }
      : delegated(input)
  })
  assert.throws(
    () => cacheBlindManager.archiveWorkspace('task-symlink-cache'),
    error => error.code === 'WORKSPACE_TRACKED_MISMATCH'
  )
  assert.equal(readlinkSync(trackedLink), 'missing.txt')
})

test('archive quarantines then catches stat-cache-hidden content injected after the original final hash', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-quarantine-hidden-race')
  const trackedPath = resolve(active.workspacePath, 'tracked.txt')
  const timestamp = Math.floor(Date.now() / 1000) - 120
  utimesSync(trackedPath, timestamp, timestamp)
  git(active.workspacePath, ['update-index', '--refresh'])
  git(active.workspacePath, ['config', 'core.trustctime', 'false'])

  const delegated = httpsVerificationRunner(fixture)
  let injected = false
  const racing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      if (!injected && input.cwd === active.workspacePath
          && input.args[0] === 'hash-object' && input.args[1] === '--stdin') {
        injected = true
        writeFileSync(trackedPath, 'tampered\n')
        utimesSync(trackedPath, timestamp, timestamp)
      }
      return result
    }
  })

  assert.throws(
    () => racing.archiveWorkspace('task-quarantine-hidden-race'),
    error => error.code === 'WORKSPACE_TRACKED_MISMATCH'
  )
  assert.equal(injected, true)
  assert.equal(existsSync(active.workspacePath), true)
  assert.equal(readFileSync(trackedPath, 'utf8'), 'tampered\n')
  assert.equal(JSON.parse(readFileSync(racing.describe('task-quarantine-hidden-race').metadataPath, 'utf8')).state, 'active')
  assert.deepEqual([...new Set(git(fixture.repository, ['worktree', 'list', '--porcelain'])
    .split('\n').filter(line => line.startsWith('worktree ')))].filter(line => line.includes('.archive-quarantine')), [])
})

test('archive quarantines then catches a new commit injected after the original final HEAD check', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-quarantine-head-race')
  const delegated = httpsVerificationRunner(fixture)
  let injectedHead = ''
  const racing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      if (!injectedHead && input.cwd === active.workspacePath
          && input.args.length === 2 && input.args[0] === 'rev-parse' && input.args[1] === 'HEAD') {
        writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'new commit survives\n')
        git(active.workspacePath, ['add', 'tracked.txt'])
        git(active.workspacePath, ['commit', '-m', 'injected after final head'])
        injectedHead = git(active.workspacePath, ['rev-parse', 'HEAD'])
      }
      return result
    }
  })

  assert.throws(
    () => racing.archiveWorkspace('task-quarantine-head-race'),
    error => error.code === 'WORKSPACE_ARCHIVE_RACE'
  )
  assert.match(injectedHead, /^[0-9a-f]{40}$/)
  assert.equal(existsSync(active.workspacePath), true)
  assert.equal(git(active.workspacePath, ['rev-parse', 'HEAD']), injectedHead)
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'new commit survives\n')
  assert.equal(JSON.parse(readFileSync(racing.describe('task-quarantine-head-race').metadataPath, 'utf8')).state, 'active')
})

test('archive rejects hidden dirty injected after the quarantined final hash and restores the data', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-final-hash-race')
  const timestamp = Math.floor(Date.now() / 1000) - 180
  const delegated = httpsVerificationRunner(fixture)
  let injected = false
  const racing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      const command = gitCommandArgs(input.args)
      if (!injected && input.cwd.includes('.archive-quarantine')
          && command[0] === 'hash-object' && command[1] === '--stdin') {
        const trackedPath = resolve(input.cwd, 'tracked.txt')
        utimesSync(trackedPath, timestamp, timestamp)
        git(input.cwd, ['update-index', '--refresh'])
        git(input.cwd, ['config', 'core.trustctime', 'false'])
        writeFileSync(trackedPath, 'tampered\n')
        utimesSync(trackedPath, timestamp, timestamp)
        injected = true
      }
      return result
    }
  })

  assert.throws(
    () => racing.archiveWorkspace('task-final-hash-race'),
    error => error.code === 'WORKSPACE_TRACKED_MISMATCH'
  )
  assert.equal(injected, true)
  assert.equal(existsSync(active.workspacePath), true)
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'tampered\n')
  assert.equal(JSON.parse(readFileSync(racing.describe('task-final-hash-race').metadataPath, 'utf8')).state, 'active')
})

test('archive branch lease rejects a commit attempted after the quarantined final HEAD and restores its data', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-final-head-race')
  const originalHead = git(active.workspacePath, ['rev-parse', 'HEAD'])
  const delegated = httpsVerificationRunner(fixture)
  let quarantineHeadChecks = 0
  let attempted = false
  const racing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      const command = gitCommandArgs(input.args)
      if (input.cwd.includes('.archive-quarantine')
          && command.length === 2 && command[0] === 'rev-parse' && command[1] === 'HEAD') {
        quarantineHeadChecks += 1
        if (quarantineHeadChecks === 2) {
          attempted = true
          writeFileSync(resolve(input.cwd, 'tracked.txt'), 'late unpushed commit\n')
          git(input.cwd, ['add', 'tracked.txt'])
          git(input.cwd, ['commit', '-m', 'late unpushed commit after final HEAD'])
        }
      }
      return result
    }
  })

  assert.throws(
    () => racing.archiveWorkspace('task-final-head-race'),
    error => /cannot lock ref|无法创建/.test(error.message)
  )
  assert.equal(quarantineHeadChecks, 2)
  assert.equal(attempted, true)
  assert.equal(existsSync(active.workspacePath), true)
  assert.equal(git(active.workspacePath, ['rev-parse', 'HEAD']), originalHead)
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'late unpushed commit\n')
  assert.equal(JSON.parse(readFileSync(racing.describe('task-final-head-race').metadataPath, 'utf8')).state, 'active')
})

test('archive atomically restores the worktree and quarantines data recreated at the original path', () => {
  const fixture = createRepository()
  const workspaceManager = manager(fixture)
  const active = workspaceManager.ensureWorkspace('task-late-original-writer')
  const delegated = httpsVerificationRunner(fixture)
  let quarantineHeadChecks = 0
  const racing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      const command = gitCommandArgs(input.args)
      if (input.cwd.includes('.archive-quarantine')
          && command.length === 2 && command[0] === 'rev-parse' && command[1] === 'HEAD') {
        quarantineHeadChecks += 1
        if (quarantineHeadChecks === 2) {
          mkdirSync(active.workspacePath, { recursive: true })
          writeFileSync(resolve(active.workspacePath, 'late-writer.txt'), 'preserve me\n')
        }
      }
      return result
    }
  })

  assert.throws(
    () => racing.archiveWorkspace('task-late-original-writer'),
    error => error.code === 'WORKSPACE_ARCHIVE_RACE'
  )
  const metadata = JSON.parse(readFileSync(racing.describe('task-late-original-writer').metadataPath, 'utf8'))
  assert.equal(metadata.state, 'active')
  assert.match(metadata.archiveRecoveryConflictPath, /late-writer-/)
  assert.equal(readFileSync(resolve(metadata.archiveRecoveryConflictPath, 'late-writer.txt'), 'utf8'), 'preserve me\n')
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'baseline\n')
  assert.equal(git(active.workspacePath, ['rev-parse', '--show-toplevel']), active.workspacePath)
})

test('archive retains the quarantined Git worktree and persists its location across restart', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-retained-archive')
  const delegated = httpsVerificationRunner(fixture)
  let removeCalls = 0
  const retaining = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const command = gitCommandArgs(input.args)
      if (command[0] === 'worktree' && command[1] === 'remove') removeCalls += 1
      return delegated(input)
    }
  })

  const archived = retaining.archiveWorkspace('task-retained-archive')
  assert.equal(archived.state, 'archived')
  assert.match(archived.quarantinePath, /\.archive-quarantine\//)
  assert.equal(removeCalls, 0)
  assert.equal(existsSync(active.workspacePath), false)
  assert.equal(existsSync(archived.quarantinePath), true)
  assert.equal(readFileSync(resolve(archived.quarantinePath, 'tracked.txt'), 'utf8'), 'baseline\n')
  assert.equal(git(archived.quarantinePath, ['rev-parse', '--show-toplevel']), archived.quarantinePath)
  assert.match(git(fixture.repository, ['worktree', 'list', '--porcelain']), new RegExp(`worktree ${archived.quarantinePath}`))

  const persisted = JSON.parse(readFileSync(retaining.describe('task-retained-archive').metadataPath, 'utf8'))
  assert.equal(persisted.state, 'archived')
  assert.equal(persisted.quarantinePath, archived.quarantinePath)
  const inspected = runChildWorkspaceProbe(fixture, 'task-retained-archive', 'inspect')
  assert.equal(inspected.ok, true)
  assert.equal(inspected.value.state, 'archived')
  assert.equal(inspected.value.quarantinePath, archived.quarantinePath)
  const ensured = runChildWorkspaceProbe(fixture, 'task-retained-archive', 'ensure')
  assert.equal(ensured.ok, false)
  assert.equal(ensured.code, 'WORKSPACE_NOT_ACTIVE')
})

test('archived restart probe rejects a missing retained worktree registration', () => {
  const taskId = 'task-archived-registration-missing'
  const { fixture, archived } = archiveBaselineWorkspace(taskId)
  const gitDirectory = git(archived.quarantinePath, ['rev-parse', '--path-format=absolute', '--git-dir'])
  rmSync(gitDirectory, { recursive: true, force: true })
  assert.equal(existsSync(archived.quarantinePath), true)
  assert.equal(readFileSync(resolve(archived.quarantinePath, 'tracked.txt'), 'utf8'), 'baseline\n')

  assertArchivedRestartRecoveryRequired(fixture, taskId, /registration/)
})

test('archived restart probes reject detached and wrong retained branches', () => {
  for (const variant of ['detached', 'wrong-branch']) {
    const taskId = `task-archived-${variant}`
    const { fixture, archived } = archiveBaselineWorkspace(taskId)
    if (variant === 'detached') {
      git(archived.quarantinePath, ['checkout', '--detach', archived.archivedHead])
    } else {
      git(archived.quarantinePath, ['checkout', '-b', 'wrong-retained-branch'])
    }
    assertArchivedRestartRecoveryRequired(fixture, taskId, /branch|detached/)
  }
})

test('archived restart probe rejects actual HEAD mismatch with metadata archivedHead', () => {
  const taskId = 'task-archived-head-mismatch'
  const { fixture, archived, metadataPath } = archiveBaselineWorkspace(taskId)
  const alternateHead = createAlternateCommit(fixture, archived.archivedHead)
  const persisted = JSON.parse(readFileSync(metadataPath, 'utf8'))
  writeFileSync(metadataPath, `${JSON.stringify({ ...persisted, archivedHead: alternateHead }, null, 2)}\n`)

  assertArchivedRestartRecoveryRequired(fixture, taskId, /HEAD|branch ref/)
})

test('archived restart probe rejects retained branch ref drift', () => {
  const taskId = 'task-archived-ref-drift'
  const { fixture, archived } = archiveBaselineWorkspace(taskId)
  const alternateHead = createAlternateCommit(fixture, archived.archivedHead)
  git(fixture.repository, [
    'update-ref', `refs/heads/${archived.branch}`, alternateHead, archived.archivedHead
  ])

  assertArchivedRestartRecoveryRequired(fixture, taskId, /HEAD|branch ref/)
})

test('archived restart probe rejects Git top-level mismatch at the retained path', () => {
  const taskId = 'task-archived-top-level-mismatch'
  const { fixture, archived } = archiveBaselineWorkspace(taskId)
  const wrongTopLevel = resolve(fixture.root, 'wrong-retained-top-level')
  mkdirSync(wrongTopLevel)
  git(fixture.repository, ['config', 'extensions.worktreeConfig', 'true'])
  git(archived.quarantinePath, ['config', '--worktree', 'core.worktree', wrongTopLevel])
  assert.equal(git(archived.quarantinePath, ['rev-parse', '--show-toplevel']), wrongTopLevel)
  assert.match(git(fixture.repository, ['worktree', 'list', '--porcelain']), new RegExp(`worktree ${archived.quarantinePath}`))

  assertArchivedRestartRecoveryRequired(fixture, taskId, /top-level/)
})

test('archive preserves a late ignored file injected after final validation', () => {
  const fixture = createRepository()
  writeFileSync(resolve(fixture.repository, '.gitignore'), 'late-ignored.txt\n')
  git(fixture.repository, ['add', '.gitignore'])
  git(fixture.repository, ['commit', '-m', 'ignore late file'])
  const active = manager(fixture).ensureWorkspace('task-late-ignored-file')
  const delegated = httpsVerificationRunner(fixture)
  let branchChecks = 0
  let injectedPath = ''
  let removeCalls = 0
  const racing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      const command = gitCommandArgs(input.args)
      if (command[0] === 'worktree' && command[1] === 'remove') removeCalls += 1
      if (input.cwd === fixture.repository
          && command[0] === 'rev-parse'
          && command[1] === '--verify'
          && command.at(-1) === `refs/heads/${active.branch}^{commit}`) {
        branchChecks += 1
        if (branchChecks === 2) {
          const archiving = JSON.parse(readFileSync(manager(fixture).describe('task-late-ignored-file').metadataPath, 'utf8'))
          injectedPath = resolve(archiving.quarantinePath, 'late-ignored.txt')
          writeFileSync(injectedPath, 'must survive archive\n')
          assert.equal(git(archiving.quarantinePath, ['check-ignore', 'late-ignored.txt']), 'late-ignored.txt')
          assert.equal(git(archiving.quarantinePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')
        }
      }
      return result
    }
  })

  const archived = racing.archiveWorkspace('task-late-ignored-file')
  assert.equal(branchChecks, 2)
  assert.equal(removeCalls, 0)
  assert.equal(archived.state, 'archived')
  assert.equal(injectedPath, resolve(archived.quarantinePath, 'late-ignored.txt'))
  assert.equal(existsSync(active.workspacePath), false)
  assert.equal(existsSync(archived.quarantinePath), true)
  assert.equal(readFileSync(injectedPath, 'utf8'), 'must survive archive\n')
  assert.equal(JSON.parse(readFileSync(racing.describe('task-late-ignored-file').metadataPath, 'utf8')).quarantinePath, archived.quarantinePath)
})

test('archive preserves a late ignored directory injected after final validation', () => {
  const fixture = createRepository()
  writeFileSync(resolve(fixture.repository, '.gitignore'), 'late-ignored-dir/\n')
  git(fixture.repository, ['add', '.gitignore'])
  git(fixture.repository, ['commit', '-m', 'ignore late directory'])
  const active = manager(fixture).ensureWorkspace('task-late-ignored-dir')
  const delegated = httpsVerificationRunner(fixture)
  let branchChecks = 0
  let injectedDirectory = ''
  let removeCalls = 0
  const racing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      const command = gitCommandArgs(input.args)
      if (command[0] === 'worktree' && command[1] === 'remove') removeCalls += 1
      if (input.cwd === fixture.repository
          && command[0] === 'rev-parse'
          && command[1] === '--verify'
          && command.at(-1) === `refs/heads/${active.branch}^{commit}`) {
        branchChecks += 1
        if (branchChecks === 2) {
          const archiving = JSON.parse(readFileSync(manager(fixture).describe('task-late-ignored-dir').metadataPath, 'utf8'))
          injectedDirectory = resolve(archiving.quarantinePath, 'late-ignored-dir')
          mkdirSync(injectedDirectory)
          writeFileSync(resolve(injectedDirectory, 'payload.txt'), 'directory data survives\n')
          assert.equal(git(archiving.quarantinePath, ['check-ignore', 'late-ignored-dir/payload.txt']), 'late-ignored-dir/payload.txt')
          assert.equal(git(archiving.quarantinePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')
        }
      }
      return result
    }
  })

  const archived = racing.archiveWorkspace('task-late-ignored-dir')
  assert.equal(branchChecks, 2)
  assert.equal(removeCalls, 0)
  assert.equal(archived.state, 'archived')
  assert.equal(injectedDirectory, resolve(archived.quarantinePath, 'late-ignored-dir'))
  assert.equal(existsSync(active.workspacePath), false)
  assert.equal(existsSync(archived.quarantinePath), true)
  assert.equal(readFileSync(resolve(injectedDirectory, 'payload.txt'), 'utf8'), 'directory data survives\n')
  assert.equal(JSON.parse(readFileSync(racing.describe('task-late-ignored-dir').metadataPath, 'utf8')).quarantinePath, archived.quarantinePath)
})

test('archive final lease hardens checkStat minimal against same-second same-length rewrites', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-checkstat-minimal-delete')
  const trackedPath = resolve(active.workspacePath, 'tracked.txt')
  const timestamp = new Date((Math.floor(Date.now() / 1000) - 240) * 1000 + 123)
  utimesSync(trackedPath, timestamp, timestamp)
  git(active.workspacePath, ['update-index', '--refresh'])
  git(active.workspacePath, ['config', 'core.trustctime', 'false'])
  git(active.workspacePath, ['config', 'core.checkStat', 'minimal'])
  assert.equal(git(active.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')

  const delegated = httpsVerificationRunner(fixture)
  let sawHardenedRefresh = false
  let injected = false
  const hardened = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      const command = gitCommandArgs(input.args)
      if (!injected && input.cwd === active.workspacePath
          && command.length === 2 && command[0] === 'rev-parse' && command[1] === 'HEAD') {
        writeFileSync(trackedPath, 'tampered\n')
        utimesSync(trackedPath, timestamp, timestamp)
        injected = true
        assert.equal(git(active.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')
      }
      if (command[0] === 'update-index' && command[1] === '--really-refresh') {
        assertHardenedWorktreeGit(input.args)
        sawHardenedRefresh = true
      }
      return result
    }
  })

  assert.throws(
    () => hardened.archiveWorkspace('task-checkstat-minimal-delete'),
    error => ['WORKSPACE_GIT_ERROR', 'WORKSPACE_TRACKED_MISMATCH', 'WORKSPACE_DIRTY'].includes(error.code)
  )
  assert.equal(injected, true)
  assert.equal(sawHardenedRefresh, true)
  assert.equal(existsSync(active.workspacePath), true)
  assert.equal(readFileSync(trackedPath, 'utf8'), 'tampered\n')
  assert.equal(JSON.parse(readFileSync(hardened.describe('task-checkstat-minimal-delete').metadataPath, 'utf8')).state, 'active')
})

test('archive final lease disables a lying fsmonitor and restores hidden data', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-lying-fsmonitor-delete')
  const trackedPath = resolve(active.workspacePath, 'tracked.txt')
  const hookPath = resolve(fixture.root, 'lying-fsmonitor.mjs')
  const hookLog = resolve(fixture.root, 'lying-fsmonitor.log')
  writeFileSync(hookPath, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(hookLog)}, 'called\\n')\nprocess.stdout.write('liar-token\\0')\n`)
  chmodSync(hookPath, 0o755)
  git(active.workspacePath, ['config', 'core.fsmonitor', hookPath])
  git(active.workspacePath, ['config', 'core.fsmonitorHookVersion', '2'])
  git(active.workspacePath, ['config', 'core.trustctime', 'false'])
  assert.equal(git(active.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')
  assert.equal(readFileSync(hookLog, 'utf8').includes('called'), true)

  const delegated = httpsVerificationRunner(fixture)
  let sawHardenedRefresh = false
  let injected = false
  const hardened = manager(fixture, 'agent-a', {
    gitRunner: input => {
      const result = delegated(input)
      const command = gitCommandArgs(input.args)
      if (!injected && input.cwd === active.workspacePath
          && command.length === 2 && command[0] === 'rev-parse' && command[1] === 'HEAD') {
        const before = statSync(trackedPath)
        writeFileSync(trackedPath, 'tampered\n')
        utimesSync(trackedPath, before.atime, before.mtime)
        injected = true
        assert.equal(git(active.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '')
      }
      if (command[0] === 'update-index' && command[1] === '--really-refresh') {
        assertHardenedWorktreeGit(input.args)
        sawHardenedRefresh = true
      }
      return result
    }
  })

  assert.throws(
    () => hardened.archiveWorkspace('task-lying-fsmonitor-delete'),
    error => ['WORKSPACE_GIT_ERROR', 'WORKSPACE_TRACKED_MISMATCH', 'WORKSPACE_DIRTY'].includes(error.code)
  )
  assert.equal(injected, true)
  assert.equal(sawHardenedRefresh, true)
  assert.equal(existsSync(active.workspacePath), true)
  assert.equal(readFileSync(trackedPath, 'utf8'), 'tampered\n')
  assert.equal(JSON.parse(readFileSync(hardened.describe('task-lying-fsmonitor-delete').metadataPath, 'utf8')).state, 'active')
})

test('archive ignores target-repository local upstream and remote configuration', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-remote-proof')
  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'agent commit\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'agent commit'])
  git(fixture.repository, ['branch', 'published-local-only', git(active.workspacePath, ['rev-parse', 'HEAD'])])
  git(fixture.repository, ['config', `branch.${active.branch}.remote`, '.'])
  git(fixture.repository, ['config', `branch.${active.branch}.merge`, 'refs/heads/published-local-only'])
  git(fixture.repository, ['remote', 'add', 'origin', fixture.repository])
  git(fixture.repository, ['update-ref', 'refs/remotes/origin/master', git(active.workspacePath, ['rev-parse', 'HEAD'])])
  git(fixture.repository, ['config', 'http.sslVerify', 'false'])
  git(fixture.repository, ['config', 'http.proxy', 'http://127.0.0.1:9'])
  git(fixture.repository, ['config', `url.file://${fixture.repository}.insteadOf`, fixture.policy.trustedRemoteUrl])

  assert.throws(
    () => manager(fixture).archiveWorkspace('task-remote-proof'),
    error => error.code === 'WORKSPACE_UNPUSHED'
  )
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'agent commit\n')
})

test('archive verifies a published HEAD through a fresh sanitized HTTPS verification repository', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-https-published')
  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'published commit\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'published commit'])
  git(active.workspacePath, ['push', fixture.publisher, `HEAD:${fixture.policy.trustedRemoteRef}`])

  const poisoned = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    GIT_ASKPASS: process.env.GIT_ASKPASS,
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND
  }
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${fixture.repository}.insteadOf`,
    GIT_CONFIG_VALUE_0: fixture.policy.trustedRemoteUrl,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    GIT_ASKPASS: '/tmp/attacker-askpass',
    GIT_SSH_COMMAND: '/tmp/attacker-ssh'
  })
  let fetches = 0
  let verificationDirectory = ''
  try {
    const publishedManager = manager(fixture, 'agent-a', {
      gitRunner: httpsVerificationRunner(fixture, input => {
        fetches += 1
        verificationDirectory = input.cwd
        assert.notEqual(input.cwd, fixture.repository)
        assert.match(input.cwd, /^\/tmp\/codex-ws-agent-publish-/)
        assert.equal(input.args.at(-2), fixture.policy.trustedRemoteUrl)
        assert.equal(
          input.args.at(-1),
          `+${fixture.policy.trustedRemoteRef}:refs/remotes/trusted/published`
        )
        assert.equal(input.args.includes('http.sslVerify=true'), true)
        assert.equal(input.args.includes('http.proxy='), true)
        assert.equal(input.env.GIT_CONFIG_NOSYSTEM, '1')
        assert.equal(input.env.GIT_CONFIG_GLOBAL, '/dev/null')
        assert.equal(input.env.GIT_TERMINAL_PROMPT, '0')
        assert.equal(input.env.GIT_ASKPASS, '/bin/false')
        assert.equal(input.env.GIT_SSH_COMMAND, '/bin/false')
        assert.equal(input.env.HTTPS_PROXY, undefined)
        assert.equal(input.env.GIT_CONFIG_COUNT, undefined)
      })
    })
    const archived = publishedManager.archiveWorkspace('task-https-published')
    assert.equal(fetches, 1)
    assert.equal(archived.state, 'archived')
    assert.equal(statSync(verificationDirectory, { throwIfNoEntry: false }), undefined)
  } finally {
    for (const [key, value] of Object.entries(poisoned)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('archive preserves the worktree when isolated trusted HTTPS fetch fails', () => {
  const fixture = createRepository()
  const active = manager(fixture).ensureWorkspace('task-fetch-failure')
  writeFileSync(resolve(active.workspacePath, 'tracked.txt'), 'agent commit\n')
  git(active.workspacePath, ['add', 'tracked.txt'])
  git(active.workspacePath, ['commit', '-m', 'agent commit'])
  let fetches = 0
  const failing = manager(fixture, 'agent-a', {
    gitRunner: input => {
      if (verificationFetchIndex(input.args) >= 0) {
        fetches += 1
        assert.notEqual(input.cwd, fixture.repository)
        return { status: 1, stdout: '', stderr: 'injected isolated HTTPS fetch failure' }
      }
      return runGitProcess(input)
    }
  })
  assert.throws(
    () => failing.archiveWorkspace('task-fetch-failure'),
    error => error.code === 'WORKSPACE_GIT_ERROR' && /injected isolated HTTPS fetch failure/.test(error.message)
  )
  assert.equal(fetches, 1)
  assert.equal(readFileSync(resolve(active.workspacePath, 'tracked.txt'), 'utf8'), 'agent commit\n')
})

test('workspace policies allow only fixed HTTPS publication refs and reject canonical resource overlap', () => {
  const fixture = createRepository()
  for (const trustedRemoteUrl of [fixture.repository, `file://${fixture.repository}`, 'ssh://git@trusted.example/a07.git', 'https://trusted.example/a07.git?token=secret']) {
    assert.throws(
      () => new GitWorkspaceManager({
        policy: { ...fixture.policy, trustedRemoteUrl },
        agentId: 'agent-a'
      }),
      error => error.code === 'WORKSPACE_POLICY_INVALID'
    )
  }
  assert.throws(
    () => new GitWorkspaceManager({
      policy: { ...fixture.policy, trustedRemoteRef: 'refs/heads/*' },
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
  const second = new GitWorkspaceManager({ policy: aliasPolicy, agentId: 'agent-a', gitRunner: httpsVerificationRunner(fixture) })
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
  const selectedProfile = { ...runtimeProfile(fixture), codexModel: 'gpt-m1-agent-a' }
  const resultPromise = runCodex(selectedProfile, dispatch(), 'command', {
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
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], selectedProfile.codexModel)
  assert.equal(invocation.args.includes('resume'), false, 'managed command must not resume a session from another worktree')
})

test('command runner lease blocks archive until the child exits', async () => {
  const fixture = createRepository()
  const workspaceManager = manager(fixture)
  const child = new FakeChild()
  const run = runCodex(runtimeProfile(fixture), dispatch('task-runner-lease'), 'command', {
    workspaceManager,
    requireWorkspace: true,
    spawnFn: () => child,
    sendLegacyFn: () => true,
    sendStatusFn: () => true
  })
  const descriptor = workspaceManager.describe('task-runner-lease')
  assert.equal(existsSync(descriptor.lockPath), true)
  const owner = JSON.parse(readFileSync(resolve(descriptor.lockPath, 'owner.json'), 'utf8'))
  assert.equal(owner.kind, 'command-runner')

  const archiveManager = manager(fixture, 'agent-a', { lockTimeoutMs: 20, lockRetryMs: 1 })
  assert.throws(
    () => archiveManager.archiveWorkspace('task-runner-lease'),
    error => error.code === 'WORKSPACE_LOCK_TIMEOUT'
  )
  assert.equal(existsSync(descriptor.workspacePath), true)

  child.stdout.end()
  child.stderr.end()
  child.exitCode = 0
  child.emit('close', 0)
  const result = await run
  assert.equal(result.status, 'completed')
  assert.equal(existsSync(descriptor.lockPath), false)
})

test('a separate command-runner process holds the same workspace lease for its full execution', async () => {
  const fixture = createRepository()
  const workspaceManager = manager(fixture)
  const active = workspaceManager.ensureWorkspace('task-cross-process-runner')
  const moduleUrl = new URL('../workspace-manager.mjs', import.meta.url).href
  const script = `
    import { GitWorkspaceManager } from ${JSON.stringify(moduleUrl)};
    const manager = new GitWorkspaceManager({
      policy: JSON.parse(process.env.A07_POLICY),
      agentId: process.env.A07_AGENT,
      role: 'coder'
    });
    const lease = manager.acquireCommandWorkspace({ taskId: process.env.A07_TASK });
    console.log('LEASE_READY');
    process.stdin.resume();
    process.stdin.on('end', () => { lease.release(); process.exit(0); });
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      A07_POLICY: JSON.stringify(fixture.policy),
      A07_AGENT: 'agent-a',
      A07_TASK: 'task-cross-process-runner'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      let stdout = ''
      const timeout = setTimeout(() => rejectPromise(new Error(`lease child timeout: ${stderr}`)), 5000)
      child.stdout.on('data', chunk => {
        stdout += chunk
        if (stdout.includes('LEASE_READY')) {
          clearTimeout(timeout)
          resolvePromise()
        }
      })
      child.on('error', rejectPromise)
      child.on('close', code => {
        if (!stdout.includes('LEASE_READY')) rejectPromise(new Error(stderr || `lease child exited ${code}`))
      })
    })
    const descriptor = workspaceManager.describe('task-cross-process-runner')
    const owner = JSON.parse(readFileSync(resolve(descriptor.lockPath, 'owner.json'), 'utf8'))
    assert.equal(owner.kind, 'command-runner')
    assert.notEqual(owner.pid, process.pid)
    assert.throws(
      () => manager(fixture, 'agent-a', { lockTimeoutMs: 25, lockRetryMs: 1 })
        .archiveWorkspace('task-cross-process-runner'),
      error => error.code === 'WORKSPACE_LOCK_TIMEOUT'
    )
    assert.equal(existsSync(active.workspacePath), true)
  } finally {
    child.stdin.end()
    const code = await new Promise(resolvePromise => child.once('close', resolvePromise))
    assert.equal(code, 0, stderr)
  }
  assert.equal(existsSync(workspaceManager.describe('task-cross-process-runner').lockPath), false)
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

const installerScript = fileURLToPath(new URL('../../../shell/codex_ws_agent_install.sh', import.meta.url))
const policyChecker = fileURLToPath(new URL('../install-policy-check.mjs', import.meta.url))

const runInstallerValidationGate = ({ policy, validateExit = 0, npmExit = 0, missingNpm = false, start = 'y' }) => {
  const appHome = resolve(temporaryDirectory(), 'app')
  mkdirSync(appHome)
  cpSync(policyChecker, resolve(appHome, 'install-policy-check.mjs'))
  if (policy !== undefined) writeFileSync(resolve(appHome, 'workspace-policies.json'), `${JSON.stringify(policy)}\n`)
  writeFileSync(resolve(appHome, 'agent-client.mjs'), `
    import { writeFileSync } from 'node:fs'
    writeFileSync('validate.marker', 'validated\\n')
    process.exit(Number(process.env.A07_VALIDATE_EXIT || 0))
  `)
  const npmBin = resolve(appHome, 'npm-stub')
  if (!missingNpm) {
    writeFileSync(npmBin, '#!/bin/bash\npwd > npm.cwd\nprintf "%s\\n" "$@" > npm.args\nexit "${A07_NPM_EXIT:-0}"\n')
    chmodSync(npmBin, 0o755)
  }
  const restartMarker = resolve(appHome, 'restart.marker')
  const result = spawnSync('bash', [installerScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_WS_AGENT_INSTALL_TEST_MODE: '1',
      CODEX_WS_AGENT_TEST_APP_HOME: appHome,
      CODEX_WS_AGENT_TEST_NODE_BIN: process.execPath,
      CODEX_WS_AGENT_TEST_NPM_BIN: npmBin,
      A07_NPM_EXIT: String(npmExit),
      CODEX_WS_AGENT_TEST_RESTART_MARKER: restartMarker,
      A07_VALIDATE_EXIT: String(validateExit),
      START_CODEX_WS_AGENT: start
    }
  })
  return { ...result, appHome, restartMarker }
}

test('installer rejects legacy remote{name,url} policy schema and never restarts', () => {
  const result = runInstallerValidationGate({
    policy: {
      legacy: {
        repository: '/trusted/repository',
        root: '/trusted/root',
        baseRef: 'refs/heads/master',
        remote: { name: 'origin', url: 'https://trusted.example/a07.git' }
      }
    }
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /migrate explicitly to trustedRemoteUrl and trustedRemoteRef/)
  assert.equal(existsSync(result.restartMarker), false)
})

test('installer propagates agent validation failure and never restarts', () => {
  const result = runInstallerValidationGate({
    policy: { current: { trustedRemoteUrl: 'https://trusted.example/a07.git', trustedRemoteRef: 'refs/heads/master' } },
    validateExit: 9
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /配置验证失败/)
  assert.equal(existsSync(result.restartMarker), false)
})

test('installer restarts only after policy and agent validation both succeed', () => {
  const result = runInstallerValidationGate({
    policy: { current: { trustedRemoteUrl: 'https://trusted.example/a07.git', trustedRemoteRef: 'refs/heads/master' } },
    validateExit: 0
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(readFileSync(result.restartMarker, 'utf8'), 'restart requested\n')
})


test('installer copies locked dependencies and installs before validation without starting by default', () => {
  const result = runInstallerValidationGate({ start: 'n' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  for (const name of ['package.json', 'package-lock.json']) {
    assert.equal(readFileSync(resolve(result.appHome, name), 'utf8'), readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
  }
  assert.equal(readFileSync(resolve(result.appHome, 'npm.cwd'), 'utf8').trim(), result.appHome)
  assert.deepEqual(readFileSync(resolve(result.appHome, 'npm.args'), 'utf8').trim().split('\n'), [
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'
  ])
  assert.equal(existsSync(resolve(result.appHome, 'validate.marker')), true)
  assert.equal(existsSync(result.restartMarker), false)
})

test('installer stops before validation and restart if dependency installation fails', () => {
  const result = runInstallerValidationGate({ npmExit: 7 })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /npm 依赖安装失败/)
  assert.equal(existsSync(resolve(result.appHome, 'validate.marker')), false)
  assert.equal(existsSync(result.restartMarker), false)
})

test('installer rejects missing npm before validation or restart', () => {
  const result = runInstallerValidationGate({ missingNpm: true })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /未找到可执行 npm/)
  assert.equal(existsSync(resolve(result.appHome, 'validate.marker')), false)
  assert.equal(existsSync(result.restartMarker), false)
})
