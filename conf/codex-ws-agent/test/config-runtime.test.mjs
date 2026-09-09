import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { buildCodexArgs, createCodexSessionStore, runCodex } from '../agent-client.mjs'

const entrypoint = resolve(import.meta.dirname, '..', 'agent-client.mjs')
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'codex-config-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
const profileFor = root => ({
  profileId: 'audit', agentId: 'audit-agent', codexBin: '/bin/true',
  codexHome: resolve(root, 'home'), codexWorkdir: root,
  codexSandbox: 'workspace-write', codexApproval: 'never',
  codexSessionMode: 'resume', codexTimeoutMs: 1000,
  codexModel: 'test-model', workspaceNoTaskPolicy: 'reject'
})
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !/^(CODEX_|AGENT_|OPENCLAW_|DEFAULT_CODEX_PROFILE$|WS_URL$)/.test(key)
)))
const runCli = (root, profiles, args, extraEnv = {}) => spawnSync(process.execPath, [entrypoint, ...args], {
  cwd: root, encoding: 'utf8', timeout: 10000,
  env: { ...cleanEnv(), CODEX_PROFILES: JSON.stringify(profiles), DEFAULT_CODEX_PROFILE: 'audit', ...extraEnv }
})

const writeSession = (selectedProfile, sessionId, fileName = sessionId) => {
  const directory = resolve(selectedProfile.codexHome, 'sessions', '2026', '09', '10')
  mkdirSync(directory, { recursive: true })
  const filePath = resolve(directory, `rollout-${fileName}.jsonl`)
  writeFileSync(filePath, `${JSON.stringify({
    type: 'session_meta',
    payload: { id: sessionId, session_id: sessionId }
  })}
`)
  return filePath
}

const sessionStoreFor = (root, entries = {}) => {
  mkdirSync(root, { recursive: true })
  const filePath = resolve(root, 'codex-session-map.json')
  if (Object.keys(entries).length) writeFileSync(filePath, `${JSON.stringify(entries)}
`)
  return { filePath, store: createCodexSessionStore(filePath) }
}

const successfulChild = onStart => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  queueMicrotask(() => {
    onStart?.(child)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)
  })
  return child
}

for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
  test(`new and exactly mapped resumed sessions explicitly preserve ${sandbox}, workdir, model and approval`, t => {
    const root = fixture(t)
    const selectedProfile = { ...profileFor(root), codexSandbox: sandbox }
    const conversation = { conversationId: 'conversation-1' }
    const sessionId = `session-${sandbox}`
    mkdirSync(selectedProfile.codexHome)
    writeSession(selectedProfile, 'unrelated-history')

    const fresh = buildCodexArgs(selectedProfile, conversation, 'test prompt')
    assert.equal(fresh.includes('resume'), false, 'Home history alone must not resume')

    writeSession(selectedProfile, sessionId)
    const { store } = sessionStoreFor(root, { [`${selectedProfile.agentId}:${conversation.conversationId}`]: sessionId })
    const resumed = buildCodexArgs(selectedProfile, conversation, 'test prompt', root, false, store)
    assert.ok(resumed.includes('resume'))
    assert.ok(resumed.includes(sessionId))
    assert.equal(resumed.includes('--last'), false)
    assert.equal(resumed.includes('--all'), false)
    for (const args of [fresh, resumed]) {
      assert.equal(args[args.indexOf('--sandbox') + 1], sandbox)
      assert.equal(args[args.indexOf('--cd') + 1], root)
      assert.equal(args[args.indexOf('--model') + 1], 'test-model')
      assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never')
      assert.ok(args.includes('--json'))
      assert.equal(args.at(-1), 'test prompt')
    }
    assert.ok(resumed.indexOf('--sandbox') < resumed.indexOf('resume'))
    assert.ok(resumed.indexOf('--cd') < resumed.indexOf('resume'))
    assert.equal(buildCodexArgs(selectedProfile, conversation, 'test prompt', root, true, store).includes('resume'), false)
  })
}

test('resume mode starts new for an unmapped conversation even when Home has history', t => {
  const root = fixture(t)
  const selectedProfile = profileFor(root)
  writeSession(selectedProfile, 'unrelated-session')
  const { store } = sessionStoreFor(root)
  const args = buildCodexArgs(selectedProfile, { conversationId: 'new-conversation' }, 'hello', root, false, store)
  assert.equal(args.includes('resume'), false)
  assert.equal(args.includes('--last'), false)
  assert.equal(args.includes('--all'), false)
})

test('resume mode without a conversationId never resumes unrelated Home history', t => {
  const root = fixture(t)
  const selectedProfile = profileFor(root)
  writeSession(selectedProfile, 'unrelated-session')
  const { store } = sessionStoreFor(root)
  assert.equal(buildCodexArgs(selectedProfile, {}, 'hello', root, false, store).includes('resume'), false)
  assert.equal(buildCodexArgs(selectedProfile, { conversationId: '   ' }, 'hello', root, false, store).includes('resume'), false)
})

test('mapped session missing from the selected profile Home fails explicitly without spawning Codex', async t => {
  const root = fixture(t)
  const selectedProfile = profileFor(root)
  mkdirSync(selectedProfile.codexHome)
  const conversation = { conversationId: 'conversation-missing', content: 'hello' }
  const { store } = sessionStoreFor(root, { [`${selectedProfile.agentId}:${conversation.conversationId}`]: 'missing-session' })
  assert.throws(
    () => buildCodexArgs(selectedProfile, conversation, 'hello', root, false, store),
    error => error.code === 'CODEX_SESSION_NOT_FOUND'
  )

  let spawnCount = 0
  const sent = []
  const result = await runCodex(selectedProfile, conversation, 'chat', {
    sessionStore: store,
    spawnFn: () => { spawnCount += 1 },
    sendProtocolFn: (type, payload) => { sent.push({ type, payload }); return true }
  })
  assert.equal(spawnCount, 0)
  assert.equal(result.status, 'failed')
  assert.equal(result.sessionErrorCode, 'CODEX_SESSION_NOT_FOUND')
  assert.match(result.errorMessage, /missing-session/)
  assert.equal(sent.at(-1).payload.status, 'failed')
})

test('conversation mappings are isolated by exact agent identity and selected profile Home', t => {
  const root = fixture(t)
  const agentA = profileFor(resolve(root, 'a'))
  const agentB = { ...profileFor(resolve(root, 'b')), profileId: 'audit-b', agentId: 'audit-agent-b' }
  const conversation = { conversationId: 'shared-conversation' }
  writeSession(agentA, 'agent-a-session')
  writeSession(agentB, 'agent-b-unrelated-history')
  const { store } = sessionStoreFor(root, { [`${agentA.agentId}:${conversation.conversationId}`]: 'agent-a-session' })

  assert.ok(buildCodexArgs(agentA, conversation, 'hello', agentA.codexWorkdir, false, store).includes('agent-a-session'))
  assert.equal(buildCodexArgs(agentB, conversation, 'hello', agentB.codexWorkdir, false, store).includes('resume'), false)

  const { store: wrongHomeStore } = sessionStoreFor(resolve(root, 'wrong-home-map'), {
    [`${agentB.agentId}:${conversation.conversationId}`]: 'agent-a-session'
  })
  assert.throws(
    () => buildCodexArgs(agentB, conversation, 'hello', agentB.codexWorkdir, false, wrongHomeStore),
    error => error.code === 'CODEX_SESSION_NOT_FOUND'
  )
})

test('configured new mode and forceNew commands ignore even valid conversation mappings', t => {
  const root = fixture(t)
  const selectedProfile = profileFor(root)
  const conversation = { conversationId: 'conversation-1' }
  writeSession(selectedProfile, 'mapped-session')
  const { store } = sessionStoreFor(root, { [`${selectedProfile.agentId}:${conversation.conversationId}`]: 'mapped-session' })

  assert.equal(buildCodexArgs({ ...selectedProfile, codexSessionMode: 'new' }, conversation, 'hello', root, false, store).includes('resume'), false)
  assert.equal(buildCodexArgs(selectedProfile, conversation, 'hello', root, true, store).includes('resume'), false)
})

test('thread.started thread_id is captured and atomically persisted for the exact conversation', async t => {
  const root = fixture(t)
  const selectedProfile = profileFor(root)
  const conversation = { conversationId: 'conversation-capture', content: 'hello' }
  const sessionId = 'thread-from-current-run'
  const { filePath, store } = sessionStoreFor(root)
  let invocation

  const result = await runCodex(selectedProfile, conversation, 'chat', {
    sessionStore: store,
    spawnFn: (binary, args) => {
      invocation = { binary, args }
      return successfulChild(child => {
        writeSession(selectedProfile, sessionId)
        child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}
`)
        child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}
`)
      })
    },
    sendProtocolFn: () => true
  })

  assert.equal(result.status, 'completed')
  assert.equal(invocation.args.includes('resume'), false)
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
    [`${selectedProfile.agentId}:${conversation.conversationId}`]: sessionId
  })
  assert.equal(statSync(filePath).mode & 0o777, 0o600)
  assert.ok(buildCodexArgs(selectedProfile, conversation, 'again', root, false, store).includes(sessionId))
})

test('session files without a current-run session event are never broadly associated to a conversation', async t => {
  const root = fixture(t)
  const selectedProfile = profileFor(root)
  const conversation = { conversationId: 'conversation-no-event', content: 'hello' }
  writeSession(selectedProfile, 'old-unrelated-session')
  const { store } = sessionStoreFor(root)

  const result = await runCodex(selectedProfile, conversation, 'chat', {
    sessionStore: store,
    spawnFn: () => successfulChild(child => {
      writeSession(selectedProfile, 'concurrent-unrelated-session')
      child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}
`)
    }),
    sendProtocolFn: () => true
  })

  assert.equal(result.status, 'completed')
  assert.deepEqual(store.snapshot(), {})
  assert.equal(buildCodexArgs(selectedProfile, conversation, 'again', root, false, store).includes('resume'), false)
})

test('empty codexModel leaves model selection to Codex Home', t => {
  const profile = { ...profileFor(fixture(t)), codexModel: '' }
  assert.equal(buildCodexArgs(profile, {}, 'test').includes('--model'), false)
})

test('inspect-config is read-only, secret-free and distinguishes ignored metadata from runtime abilities', t => {
  const root = fixture(t)
  const profile = {
    ...profileFor(root), apiKey: 'profile-key-never-print',
    abilities: ['rail-ticket-search'], skills: ['high-speed-rail'],
    workspacePolicyId: 'example'
  }
  mkdirSync(profile.codexHome)
  writeFileSync(resolve(profile.codexHome, 'auth.json'), 'not JSON; inspection must not parse this credential file')
  writeFileSync(resolve(root, 'weather.py'), 'print("sunny")')
  const workspaceRoot = resolve(root, 'workspaces')
  const before = readdirSync(root)
  const result = runCli(root, [profile], ['--inspect-config'], {
    OPENCLAW_API_KEY: 'global-key-never-print',
    WS_URL: 'ws://127.0.0.1:1/?api_key=url-key-never-print',
    CODEX_WORKSPACE_POLICIES: JSON.stringify({ example: {
      root: workspaceRoot, repository: resolve(root, 'missing-repository'),
      baseRef: 'refs/heads/main', trustedRemoteUrl: 'https://git.example.com/repo.git',
      trustedRemoteRef: 'refs/heads/main'
    } })
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  const actual = report.profiles[0]
  assert.equal(actual.commandReadiness, 'policy-configured; requires --validate')
  assert.deepEqual(actual.schedulingAbilities, ['天气查询'])
  assert.equal(actual.websocketAuthSource, 'profile.apiKey')
  assert.equal(actual.modelSource, 'agent --model')
  assert.ok(actual.warnings.some(value => value.startsWith('LEGACY_ABILITIES_IGNORED:')))
  assert.ok(actual.warnings.some(value => value.startsWith('LEGACY_SKILLS_IGNORED:')))
  assert.doesNotMatch(result.stdout + result.stderr, /profile-key-never-print|global-key-never-print|url-key-never-print/)
  assert.equal(existsSync(workspaceRoot), false)
  assert.deepEqual(readdirSync(root), before)
  assert.deepEqual(readdirSync(profile.codexHome), ['auth.json'])
})

test('inspect-config works without WebSocket credentials and reports blocked commands', t => {
  const root = fixture(t)
  const result = runCli(root, [profileFor(root)], ['--inspect-config'])
  assert.equal(result.status, 0, result.stderr)
  const profile = JSON.parse(result.stdout).profiles[0]
  assert.equal(profile.websocketAuthSource, 'missing')
  assert.equal(profile.commandReadiness, 'blocked-no-workspace-policy')
  assert.ok(profile.warnings.some(value => value.startsWith('WORKSPACE_POLICY_REQUIRED:')))
})

for (const [key, value] of [
  ['codexSandbox', 'workspace-wirte'], ['codexApproval', 'always'], ['codexSessionMode', 'reuse'],
  ['codexTimeoutMs', -1], ['codexTimeoutMs', 1.5], ['codexTimeoutMs', 'invalid'], ['codexTimeoutMs', 2147483648],
  ['codexTimeoutMs', false], ['codexTimeoutMs', []]
]) {
  test(`validate rejects ${key}=${value} instead of silently using an unintended policy or timeout`, t => {
    const root = fixture(t)
    const result = runCli(root, [{ ...profileFor(root), [key]: value }], ['--validate'], { OPENCLAW_API_KEY: 'test' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(key))
    assert.doesNotMatch(result.stdout, /configuration valid/)
  })
}

test('inspect-config returns a failing status and structured errors for malformed execution settings', t => {
  const root = fixture(t)
  const result = runCli(root, [{ ...profileFor(root), codexTimeoutMs: 'invalid' }], ['--inspect-config'])
  assert.equal(result.status, 1)
  assert.match(JSON.parse(result.stdout).profiles[0].errors[0], /codexTimeoutMs/)
})

test('legacy CODEX_MODEL and zero timeout are inherited when the profile does not override them', t => {
  const root = fixture(t)
  const { codexTimeoutMs, codexModel, ...profile } = profileFor(root)
  const result = runCli(root, [profile], ['--inspect-config'], { CODEX_MODEL: 'legacy-model', CODEX_TIMEOUT_MS: '0' })
  assert.equal(result.status, 0, result.stderr)
  const actual = JSON.parse(result.stdout).profiles[0]
  assert.equal(actual.codexModel, 'legacy-model')
  assert.equal(actual.codexTimeoutMs, 0)
})

for (const timeoutMs of [0, 10]) {
  test(`runtime timeout ${timeoutMs} ${timeoutMs ? 'terminates the child' : 'does not immediately terminate the child'}`, async t => {
    const root = fixture(t)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const signals = []
    child.kill = signal => signals.push(signal)
    const run = runCodex({ ...profileFor(root), codexTimeoutMs: timeoutMs }, { content: 'test' }, 'command', {
      spawnFn: () => child, sendLegacyFn: () => true, sendStatusFn: () => true
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)
    await run
    assert.deepEqual(signals, timeoutMs ? ['SIGTERM'] : [])
  })
}

test('explicit profile model takes precedence over CODEX_MODEL', t => {
  const root = fixture(t)
  const result = runCli(root, [profileFor(root)], ['--inspect-config'], { CODEX_MODEL: 'environment-model' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).profiles[0].codexModel, 'test-model')
})

test('section-style profile template has a conservative inherited sandbox', t => {
  const root = fixture(t)
  const profilesFile = resolve(import.meta.dirname, '..', 'codex-profiles.conf')
  const result = runCli(root, [], ['--inspect-config'], {
    CODEX_PROFILES_FILE: profilesFile, DEFAULT_CODEX_PROFILE: 'codex-default'
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.profiles.length, 1)
  assert.equal(report.defaultProfileId, 'codex-default')
  assert.equal(report.profiles[0].codexSandbox, 'workspace-write')
  assert.equal(report.profiles[0].codexTimeoutMs, 900000)
})
