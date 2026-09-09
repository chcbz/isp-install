import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { buildCodexArgs, runCodex } from '../agent-client.mjs'

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

for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
  test(`new and resumed sessions explicitly preserve ${sandbox}, workdir, model and approval`, t => {
    const root = fixture(t)
    const profile = { ...profileFor(root), codexSandbox: sandbox }
    mkdirSync(profile.codexHome)
    const fresh = buildCodexArgs(profile, {}, 'test prompt')
    assert.equal(fresh.includes('resume'), false)
    writeFileSync(resolve(profile.codexHome, 'session_index.jsonl'), '{"id":"prior-session"}\n')
    const resumed = buildCodexArgs(profile, {}, 'test prompt')
    assert.ok(resumed.includes('resume'))
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
    assert.equal(buildCodexArgs(profile, {}, 'test prompt', root, true).includes('resume'), false)
  })
}

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
