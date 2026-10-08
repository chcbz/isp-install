import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')
const installer = resolve(repositoryRoot, 'shell/codex_ws_agent_install.sh')
const launcher = resolve(repositoryRoot, 'bin/codex_ws_agent.sh')
const serviceTemplate = resolve(repositoryRoot, 'systemd/codex-ws-agent@.service')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const temporaryRoot = () => mkdtempSync(resolve(tmpdir(), 'cyf-agent-instance-'))

const prepareFixture = () => {
  const root = temporaryRoot()
  const bin = resolve(root, 'bin')
  const systemd = resolve(root, 'systemd')
  const instanceRoot = resolve(root, 'apps', 'codex-ws-agent-instances')
  const sharedRoot = resolve(root, 'shared-apps', 'codex-ws-agent')
  const proc = resolve(root, 'proc')
  const home = resolve(root, 'home')
  const temp = resolve(root, 'tmp')
  const cache = resolve(root, 'cache')
  const npmCache = resolve(cache, 'npm')
  const config = resolve(root, 'config')
  const state = resolve(root, 'state')
  const systemctlLog = resolve(root, 'systemctl.log')
  mkdirSync(bin, { recursive: true })
  mkdirSync(systemd, { recursive: true })
  mkdirSync(instanceRoot, { recursive: true })
  mkdirSync(sharedRoot, { recursive: true })
  mkdirSync(proc, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(temp, { recursive: true })
  mkdirSync(npmCache, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(resolve(sharedRoot, 'canary'), 'default-untouched\n')
  const node = resolve(bin, 'node')
  const npm = resolve(bin, 'npm')
  const python = resolve(bin, 'python')
  const systemctl = resolve(bin, 'systemctl')
  writeFileSync(node, `#!/bin/bash
set -e
if [ "\${1:-}" = -v ]; then echo v20.20.2; exit 0; fi
if [[ "\${1:-}" == */agent-client.mjs && "\${2:-}" == --validate ]]; then exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`)
  writeFileSync(npm, '#!/bin/bash\nset -e\nmkdir -p node_modules\n')
  writeFileSync(python, '#!/bin/bash\nset -euo pipefail\nexit 0\n')
  writeFileSync(systemctl, `#!/bin/bash
set -e
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
exit 0
`)
  for (const path of [node, npm, python, systemctl]) chmodSync(path, 0o755)
  return { root, bin, systemd, instanceRoot, sharedRoot, proc, home, temp, cache, npmCache, config, state, systemctlLog, node, npm, python, systemctl }
}

const isolatedEnv = fixture => ({
  PATH: '/usr/bin:/bin',
  HOME: fixture.home,
  TMPDIR: fixture.temp,
  XDG_CACHE_HOME: fixture.cache,
  XDG_CONFIG_HOME: fixture.config,
  XDG_STATE_HOME: fixture.state,
  NPM_CONFIG_CACHE: fixture.npmCache,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8'
})

const launcherContractEnv = fixture => ({
  ...isolatedEnv(fixture),
  CODEX_WS_AGENT_LAUNCHER_TEST_MODE: '1',
  CODEX_WS_AGENT_TEST_FIXTURE_ROOT: fixture.root,
  CODEX_WS_AGENT_DEFAULT_APP_HOME: fixture.sharedRoot,
  CODEX_WS_AGENT_INSTANCE_ROOT: fixture.instanceRoot,
  CODEX_WS_AGENT_SYSTEMD_DIR: fixture.systemd,
  CODEX_WS_AGENT_PROC_ROOT: fixture.proc,
  CODEX_WS_AGENT_SYSTEMCTL: fixture.systemctl,
  CODEX_WS_AGENT_NODE_BIN: fixture.node
})

test('test modes require one explicit private fixture boundary before any operational path', async t => {
  const fixture = prepareFixture()
  try {
    const launcherEnv = launcherContractEnv(fixture)
    const launcherValid = spawnSync('bash', [launcher, '--test-isolation-check'], { encoding: 'utf8', env: launcherEnv })
    assert.equal(launcherValid.status, 0, `${launcherValid.stdout}\n${launcherValid.stderr}`)
    for (const key of [
      'CODEX_WS_AGENT_TEST_FIXTURE_ROOT', 'CODEX_WS_AGENT_DEFAULT_APP_HOME',
      'CODEX_WS_AGENT_INSTANCE_ROOT', 'CODEX_WS_AGENT_SYSTEMD_DIR',
      'CODEX_WS_AGENT_PROC_ROOT', 'CODEX_WS_AGENT_SYSTEMCTL', 'CODEX_WS_AGENT_NODE_BIN',
      'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'
    ]) {
      await t.test(`launcher rejects missing ${key}`, () => {
        const env = { ...launcherEnv }
        delete env[key]
        const result = spawnSync('bash', [launcher, '--test-isolation-check'], { encoding: 'utf8', env })
        assert.notEqual(result.status, 0)
        assert.match(`${result.stdout}\n${result.stderr}`, /TEST_ISOLATION_REQUIRED/)
      })
    }

    const outside = temporaryRoot()
    try {
      const escape = resolve(fixture.root, 'escape')
      symlinkSync(outside, escape)
      const launcherEscape = spawnSync('bash', [launcher, '--test-isolation-check'], {
        encoding: 'utf8', env: { ...launcherEnv, CODEX_WS_AGENT_PROC_ROOT: escape }
      })
      assert.notEqual(launcherEscape.status, 0)
      assert.match(`${launcherEscape.stdout}\n${launcherEscape.stderr}`, /symlink|fixture root/)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

const appHome = (fixture, instance) => resolve(fixture.instanceRoot, instance)

const writeProcIdentity = ({ procRoot, pid, cwd, entry, unit }) => {
  const dir = resolve(procRoot, String(pid))
  mkdirSync(dir, { recursive: true })
  symlinkSync(cwd, resolve(dir, 'cwd'))
  writeFileSync(resolve(dir, 'cmdline'), Buffer.from(`/usr/bin/node\0${entry}\0`))
  writeFileSync(resolve(dir, 'cgroup'), `0::/system.slice/${unit}\n`)
  writeFileSync(resolve(dir, 'stat'), `${pid} (node) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345 0\n`)
}

const launcherSystemctl = fixture => {
  const path = resolve(fixture.bin, 'launcher-systemctl')
  writeFileSync(path, `#!/bin/bash
set -e
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ "\${1:-}" = cat ]; then exit 0; fi
if [ "\${1:-}" = show ]; then
  prop=''
  while [ "$#" -gt 0 ]; do if [ "$1" = -p ]; then prop="$2"; shift 2; else shift; fi; done
  case "$prop" in FragmentPath) echo "$STUB_FRAGMENT";; ActiveState) echo "$STUB_ACTIVE";; MainPID) echo "$STUB_PID";; esac
  exit 0
fi
exit 0
`)
  chmodSync(path, 0o755)
  return path
}

test('instance launcher binds the selected unit/root and refuses a foreign MainPID without stop', () => {
  const fixture = prepareFixture()
  try {
    const home = appHome(fixture, 'local-a')
    mkdirSync(home, { recursive: true })
    writeFileSync(resolve(home, '.codex-ws-agent-instance'), 'instance=local-a\n')
    writeFileSync(resolve(home, 'agent-client.mjs'), '// historical maintenance fixture; never executed\n')
    writeFileSync(resolve(fixture.systemd, 'codex-ws-agent@.service'), readFileSync(serviceTemplate))
    const procRoot = fixture.proc
    const stubLog = resolve(fixture.root, 'launcher.log')
    const stub = launcherSystemctl(fixture)
    const unit = 'codex-ws-agent@local-a.service'
    const commonEnv = {
      ...isolatedEnv(fixture),
      CODEX_WS_AGENT_LAUNCHER_TEST_MODE: '1',
      CODEX_WS_AGENT_TEST_FIXTURE_ROOT: fixture.root,
      CODEX_WS_AGENT_DEFAULT_APP_HOME: fixture.sharedRoot,
      CODEX_WS_AGENT_INSTANCE_ROOT: fixture.instanceRoot,
      CODEX_WS_AGENT_SYSTEMD_DIR: fixture.systemd,
      CODEX_WS_AGENT_SYSTEMCTL: stub,
      CODEX_WS_AGENT_PROC_ROOT: procRoot,
      CODEX_WS_AGENT_NODE_BIN: fixture.node,
      STUB_LOG: stubLog,
      STUB_FRAGMENT: resolve(fixture.systemd, 'codex-ws-agent@.service'),
      STUB_ACTIVE: 'active',
      STUB_PID: '4242'
    }

    const foreign = resolve(fixture.root, 'foreign')
    mkdirSync(foreign)
    writeProcIdentity({ procRoot, pid: 4242, cwd: foreign, entry: resolve(home, 'agent-client.mjs'), unit })
    const refused = spawnSync('bash', [launcher, '--instance', 'local-a', 'stop'], { encoding: 'utf8', env: commonEnv })
    assert.notEqual(refused.status, 0, `${refused.stdout}\n${refused.stderr}`)
    assert.match(`${refused.stdout}\n${refused.stderr}`, /refusing foreign PID 4242/)
    assert.equal(readFileSync(stubLog, 'utf8').split('\n').some(line => line === `stop ${unit}`), false)

    rmSync(resolve(procRoot, '4242'), { recursive: true, force: true })
    writeProcIdentity({ procRoot, pid: 4242, cwd: home, entry: resolve(home, 'agent-client.mjs'), unit })
    writeFileSync(stubLog, '')
    const status = spawnSync('bash', [launcher, '--instance', 'local-a', 'status'], { encoding: 'utf8', env: commonEnv })
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`)
    const calls = readFileSync(stubLog, 'utf8')
    assert.match(calls, new RegExp(`--no-pager --full status ${unit.replaceAll('.', '\\.')}`))
    assert.equal(calls.includes('server-b'), false)
    const pidRecord = readFileSync(resolve(home, 'codex-ws-agent.pid'), 'utf8')
    assert.match(pidRecord, /^pid=4242$/m)
    assert.match(pidRecord, new RegExp(`^service=${unit.replaceAll('.', '\\.')}$`, 'm'))
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('systemd template and launcher source contain no instance shell interpolation or tmux fallback', () => {
  const unit = readFileSync(serviceTemplate, 'utf8')
  const source = readFileSync(launcher, 'utf8')
  assert.match(unit, /WorkingDirectory=\/home\/isp\/apps\/codex-ws-agent-instances\/%i/)
  assert.match(unit, /ExecStart=\/usr\/bin\/env node \/home\/isp\/apps\/codex-ws-agent-instances\/%i\/agent-client\.mjs/)
  assert.equal(unit.includes('/bin/sh -c'), false)
  assert.match(source, /instance controls require the installed systemd unit/)
  assert.match(source, /no tmux\/nohup fallback is allowed/)
})

test('retired shared/instance installer rejects every old mode without tool calls or new roots', async t => {
  const fixture = prepareFixture()
  try {
    const before = readdirSync(fixture.instanceRoot)
    for (const args of [[], ['--instance', 'local-a'], ['--instance', '../escape'], ['--help'], ['--test-isolation-check']]) {
      await t.test(JSON.stringify(args), () => {
        const result = spawnSync('/bin/bash', [installer, ...args], { encoding: 'utf8', cwd: fixture.root, env: {
          ...isolatedEnv(fixture), PATH: fixture.bin,
          ISP_APPS: resolve(fixture.root, 'shared-apps'), OPENCLAW_API_KEY: 'legacy-secret-do-not-echo',
          START_CODEX_WS_AGENT: 'y', CODEX_WS_AGENT_INSTALL_TEST_MODE: '1', CODEX_WS_AGENT_INSTALL_TEST_FULL: '1',
          CODEX_WS_AGENT_TEST_FIXTURE_ROOT: fixture.root, CODEX_WS_AGENT_TEST_INSTANCE_ROOT: fixture.instanceRoot,
          CODEX_WS_AGENT_TEST_SYSTEMCTL: fixture.systemctl
        } })
        assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
        assert.match(result.stderr, /UNIFIED_RUNTIME_ENTRY_REQUIRED/)
        assert.equal(`${result.stdout}${result.stderr}`.includes('legacy-secret-do-not-echo'), false)
        assert.deepEqual(readdirSync(fixture.instanceRoot), before)
        assert.equal(existsSync(fixture.systemctlLog), false)
        assert.equal(readFileSync(resolve(fixture.sharedRoot, 'canary'), 'utf8'), 'default-untouched\n')
      })
    }
    const source = readFileSync(installer, 'utf8')
    assert.equal(/^(?:source|exec|install|mkdir|cp|chmod|chown|systemctl|read)\s/m.test(source), false)
    assert.equal(source.includes('RELEASE_PAYLOAD='), false)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})
