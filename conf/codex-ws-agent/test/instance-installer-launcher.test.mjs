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

const runInstaller = (fixture, instance, { release = `release-${instance}`, failPhase = '', extraEnv = {} } = {}) =>
  spawnSync('bash', [installer, '--instance', instance], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...isolatedEnv(fixture),
      ISP_APPS: resolve(fixture.root, 'shared-apps'),
      CODEX_WS_AGENT_INSTALL_TEST_MODE: '1',
      CODEX_WS_AGENT_INSTALL_TEST_FULL: '1',
      CODEX_WS_AGENT_TEST_FIXTURE_ROOT: fixture.root,
      CODEX_WS_AGENT_TEST_APP_HOME: fixture.sharedRoot,
      CODEX_WS_AGENT_TEST_INSTANCE_ROOT: fixture.instanceRoot,
      CODEX_WS_AGENT_TEST_SYSTEMD_DIR: fixture.systemd,
      CODEX_WS_AGENT_TEST_BIN_DIR: fixture.bin,
      CODEX_WS_AGENT_TEST_SYSTEMCTL: fixture.systemctl,
      CODEX_WS_AGENT_TEST_NODE_BIN: fixture.node,
      CODEX_WS_AGENT_TEST_NPM_BIN: fixture.npm,
      CODEX_WS_AGENT_TEST_PYTHON_BIN: fixture.python,
      CODEX_WS_AGENT_TEST_RELEASE_ID: release,
      CODEX_WS_AGENT_TEST_FAIL_PHASE: failPhase,
      CODEX_WS_AGENT_SOURCE_COMMIT: 'a'.repeat(40),
      CODEX_WS_AGENT_SOURCE_TREE: 'b'.repeat(40),
      START_CODEX_WS_AGENT: 'n',
      ...extraEnv
    }
  })


const installerContractEnv = fixture => ({
  ...isolatedEnv(fixture),
  CODEX_WS_AGENT_INSTALL_TEST_MODE: '1',
  CODEX_WS_AGENT_TEST_FIXTURE_ROOT: fixture.root,
  CODEX_WS_AGENT_TEST_APP_HOME: fixture.sharedRoot,
  CODEX_WS_AGENT_TEST_INSTANCE_ROOT: fixture.instanceRoot,
  CODEX_WS_AGENT_TEST_SYSTEMD_DIR: fixture.systemd,
  CODEX_WS_AGENT_TEST_BIN_DIR: fixture.bin,
  CODEX_WS_AGENT_TEST_SYSTEMCTL: fixture.systemctl,
  CODEX_WS_AGENT_TEST_NODE_BIN: fixture.node,
  CODEX_WS_AGENT_TEST_NPM_BIN: fixture.npm,
  CODEX_WS_AGENT_TEST_PYTHON_BIN: fixture.python
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
    const installerEnv = installerContractEnv(fixture)
    const installerValid = spawnSync('bash', [installer, '--test-isolation-check'], { encoding: 'utf8', env: installerEnv })
    assert.equal(installerValid.status, 0, `${installerValid.stdout}\n${installerValid.stderr}`)
    for (const key of [
      'CODEX_WS_AGENT_TEST_FIXTURE_ROOT', 'CODEX_WS_AGENT_TEST_APP_HOME',
      'CODEX_WS_AGENT_TEST_INSTANCE_ROOT', 'CODEX_WS_AGENT_TEST_SYSTEMD_DIR',
      'CODEX_WS_AGENT_TEST_BIN_DIR', 'CODEX_WS_AGENT_TEST_SYSTEMCTL',
      'CODEX_WS_AGENT_TEST_NODE_BIN', 'CODEX_WS_AGENT_TEST_NPM_BIN',
      'CODEX_WS_AGENT_TEST_PYTHON_BIN', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'NPM_CONFIG_CACHE'
    ]) {
      await t.test(`installer rejects missing ${key}`, () => {
        const env = { ...installerEnv }
        delete env[key]
        const result = spawnSync('bash', [installer, '--test-isolation-check'], { encoding: 'utf8', env })
        assert.notEqual(result.status, 0)
        assert.match(`${result.stdout}\n${result.stderr}`, /TEST_ISOLATION_REQUIRED/)
      })
    }

    const invalidRelease = spawnSync('bash', [installer, '--test-isolation-check'], {
      encoding: 'utf8', env: { ...installerEnv, CODEX_WS_AGENT_TEST_RELEASE_ID: '../escape' }
    })
    assert.notEqual(invalidRelease.status, 0)
    assert.match(`${invalidRelease.stdout}\n${invalidRelease.stderr}`, /TEST_ISOLATION_REQUIRED/)
    const outsideMarker = resolve(fixture.root, '..', `outside-marker-${process.pid}`)
    const invalidMarker = spawnSync('bash', [installer, '--test-isolation-check'], {
      encoding: 'utf8', env: { ...installerEnv, CODEX_WS_AGENT_TEST_RESTART_MARKER: outsideMarker }
    })
    assert.notEqual(invalidMarker.status, 0)
    assert.match(`${invalidMarker.stdout}\n${invalidMarker.stderr}`, /TEST_ISOLATION_REQUIRED/)

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
      const installerEscape = spawnSync('bash', [installer, '--test-isolation-check'], {
        encoding: 'utf8', env: { ...installerEnv, CODEX_WS_AGENT_TEST_APP_HOME: escape }
      })
      assert.notEqual(installerEscape.status, 0)
      assert.match(`${installerEscape.stdout}\n${installerEscape.stderr}`, /symlink|fixture root/)
      const launcherEscape = spawnSync('bash', [launcher, '--test-isolation-check'], {
        encoding: 'utf8', env: { ...launcherEnv, CODEX_WS_AGENT_PROC_ROOT: escape }
      })
      assert.notEqual(launcherEscape.status, 0)
      assert.match(`${launcherEscape.stdout}\n${launcherEscape.stderr}`, /symlink|fixture root/)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

const appHome = (fixture, instance) => resolve(fixture.instanceRoot, instance)

const manifestMap = releaseRoot => new Map(readFileSync(resolve(releaseRoot, 'release-manifest.sha256'), 'utf8')
  .trim().split('\n').map(line => [line.slice(66), line.slice(0, 64)]))

test('two explicit instances install isolated roots and preserve the exact release payload proof', () => {
  const fixture = prepareFixture()
  try {
    const alpha = runInstaller(fixture, 'local-a', { extraEnv: { START_CODEX_WS_AGENT: 'y' } })
    assert.equal(alpha.status, 0, `${alpha.stdout}\n${alpha.stderr}`)
    const alphaHome = appHome(fixture, 'local-a')
    const alphaCurrent = resolve(alphaHome, 'current')
    const templateBytes = readFileSync(resolve(fixture.systemd, 'codex-ws-agent@.service'))
    const alphaEnvBefore = readFileSync(resolve(alphaHome, '.env'))
    const alphaProfileBefore = readFileSync(resolve(alphaHome, 'codex-profiles.conf'))

    const beta = runInstaller(fixture, 'server-b')
    assert.equal(beta.status, 0, `${beta.stdout}\n${beta.stderr}`)
    const betaHome = appHome(fixture, 'server-b')
    assert.equal(readFileSync(resolve(fixture.sharedRoot, 'canary'), 'utf8'), 'default-untouched\n')
    assert.deepEqual(readFileSync(resolve(fixture.systemd, 'codex-ws-agent@.service')), templateBytes)
    assert.deepEqual(readFileSync(resolve(alphaHome, '.env')), alphaEnvBefore)
    assert.deepEqual(readFileSync(resolve(alphaHome, 'codex-profiles.conf')), alphaProfileBefore)
    assert.equal(readlinkSync(alphaCurrent), 'releases/release-local-a')
    assert.equal(readlinkSync(resolve(betaHome, 'current')), 'releases/release-server-b')

    for (const [instance, home] of [['local-a', alphaHome], ['server-b', betaHome]]) {
      assert.equal(readFileSync(resolve(home, '.codex-ws-agent-instance'), 'utf8'), `instance=${instance}\n`)
      const env = readFileSync(resolve(home, '.env'), 'utf8')
      const profile = readFileSync(resolve(home, 'codex-profiles.conf'), 'utf8')
      assert.match(env, new RegExp(`^CODEX_PROFILES_FILE=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/codex-profiles\\.conf$`, 'm'))
      assert.match(env, new RegExp(`^COMMAND_INBOX_DIR=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/data/inbox$`, 'm'))
      assert.match(env, new RegExp(`^CODEX_SESSION_MAP_FILE=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/state/codex-session-map\\.json$`, 'm'))
      assert.equal(env.includes('/home/isp/apps/codex-ws-agent/data/inbox'), false)
      assert.match(env, new RegExp(`\"profileId\":\"instance-${instance}\"`))
      assert.match(env, new RegExp(`\"agentId\":\"unconfigured-${instance}\"`))
      assert.match(env, new RegExp(`\"codexWorkdir\":\"${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/workspace\"`))
      assert.match(profile, new RegExp(`^codexHome=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.codex-default$`, 'm'))
      assert.match(profile, new RegExp(`^codexWorkdir=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/workspace$`, 'm'))
      assert.match(profile, new RegExp(`^controlledImageHttpLedgerRoot=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/data/provider-ledgers/`, 'm'))
      assert.match(profile, new RegExp(`^agentId=unconfigured-${instance}$`, 'm'))
      for (const relative of ['logs', 'data/inbox', 'data/outbox', 'data/provider-ledgers', 'data/private-runs', 'state', 'run', 'homes', 'workspace', 'workspaces']) {
        assert.equal(lstatSync(resolve(home, relative)).isSymbolicLink(), false, `${instance}:${relative}`)
      }
      const releaseRoot = resolve(home, readlinkSync(resolve(home, 'current')))
      const manifest = manifestMap(releaseRoot)
      const payloadSource = readFileSync(installer, 'utf8').match(/RELEASE_PAYLOAD=\(\n([\s\S]*?)\n\)/)[1]
      const expectedPayload = payloadSource.split('\n').map(line => line.match(/^\s+"([^"]+)"$/)[1])
      assert.deepEqual([...manifest.keys()].sort(), expectedPayload.sort())
      assert.equal(manifest.get('migrate-ack-high-water.mjs'), sha256(resolve(repositoryRoot, 'conf/codex-ws-agent/migrate-ack-high-water.mjs')))
      assert.equal(manifest.get('controlled-image-delivery-retention-v3.mjs'), sha256(resolve(repositoryRoot, 'conf/codex-ws-agent/controlled-image-delivery-retention-v3.mjs')))
      for (const [relative, digest] of manifest) assert.equal(sha256(resolve(releaseRoot, relative)), digest, relative)
      // Collation uses a stub validator; independently close every release-local import.
      // A real installation failed when agent-client imported an unlisted action contract.
      for (const relative of manifest.keys()) {
        if (!relative.endsWith('.mjs')) continue
        const modulePath = resolve(releaseRoot, relative)
        const source = readFileSync(modulePath, 'utf8')
        const relativeImports = /(?:from\s*|import\s*\(\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g
        for (const match of source.matchAll(relativeImports)) {
          const dependency = resolve(dirname(modulePath), match[1])
          assert.equal(existsSync(dependency), true, `${relative} imports missing ${match[1]}`)
          assert.equal([...manifest.keys()].some(path => resolve(releaseRoot, path) === dependency), true,
            `${relative} imports unhashed ${match[1]}`)
        }
      }
      const provenance = JSON.parse(readFileSync(resolve(releaseRoot, 'release-provenance.json'), 'utf8'))
      assert.equal(provenance.payloadCount, expectedPayload.length)
      assert.equal(provenance.sourceCommit, 'a'.repeat(40))
      assert.equal(provenance.sourceTree, 'b'.repeat(40))
      assert.equal(provenance.payloadManifestSha256, sha256(resolve(releaseRoot, 'release-manifest.sha256')))
      const wrapper = readFileSync(resolve(home, 'bin/codex_ws_agent.sh'), 'utf8')
      assert.match(wrapper, new RegExp(`--instance '${instance}'`))
    }
    const calls = readFileSync(fixture.systemctlLog, 'utf8')
    assert.equal(/(^|\s)(enable|start|restart)(\s|$)/m.test(calls), false, calls)
    assert.equal(calls.trim().split('\n').every(line => line === 'daemon-reload'), true)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('instance installer rejects unsafe names and symlinked roots before target mutation', async t => {
  for (const slug of ['../escape', 'a/b', 'a.service', 'a@b', '-leading', 'trailing-', 'UPPER', 'a;touch-x', '']) {
    await t.test(slug || 'empty', () => {
      const fixture = prepareFixture()
      try {
        const result = runInstaller(fixture, slug)
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
        assert.equal(readFileSync(resolve(fixture.sharedRoot, 'canary'), 'utf8'), 'default-untouched\n')
        assert.equal(existsSync(resolve(fixture.systemd, 'codex-ws-agent@.service')), false)
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })
  }

  const fixture = prepareFixture()
  try {
    const outside = resolve(fixture.root, 'outside')
    mkdirSync(outside)
    rmSync(fixture.instanceRoot, { recursive: true, force: true })
    mkdirSync(dirname(fixture.instanceRoot), { recursive: true })
    symlinkSync(outside, fixture.instanceRoot)
    const result = runInstaller(fixture, 'safe-name')
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(readFileSync(resolve(fixture.sharedRoot, 'canary')), Buffer.from('default-untouched\n'))
    assert.deepEqual(readdirSync(outside), [])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('reinstall preserves private config/state and activation failure restores the prior current release', () => {
  const fixture = prepareFixture()
  try {
    const first = runInstaller(fixture, 'local-a', { release: 'release-one' })
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
    const home = appHome(fixture, 'local-a')
    writeFileSync(resolve(home, '.env'), 'OPENCLAW_API_KEY=private-owner-key\nCOMMAND_INBOX_DIR=' + resolve(home, 'data/inbox') + '\n', { mode: 0o600 })
    writeFileSync(resolve(home, 'codex-profiles.conf'), '[agent.owner]\nprofileId=owner\nagentId=real-owner\ncodexHome=' + resolve(home, 'homes/owner') + '\ncodexWorkdir=' + resolve(home, 'workspace') + '\nisDefault=true\n', { mode: 0o600 })
    mkdirSync(resolve(home, 'data/inbox/real-owner'), { recursive: true })
    writeFileSync(resolve(home, 'data/inbox/real-owner/state.json'), 'private-state\n')

    const second = runInstaller(fixture, 'local-a', { release: 'release-two' })
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`)
    assert.equal(readFileSync(resolve(home, '.env'), 'utf8').startsWith('OPENCLAW_API_KEY=private-owner-key'), true)
    assert.match(readFileSync(resolve(home, 'codex-profiles.conf'), 'utf8'), /agentId=real-owner/)
    assert.equal(readFileSync(resolve(home, 'data/inbox/real-owner/state.json'), 'utf8'), 'private-state\n')
    assert.equal(readlinkSync(resolve(home, 'current')), 'releases/release-two')

    const failed = runInstaller(fixture, 'local-a', { release: 'release-three', failPhase: 'activation' })
    assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`)
    assert.equal(readlinkSync(resolve(home, 'current')), 'releases/release-two')
    assert.equal(readFileSync(resolve(home, 'agent-client.mjs')).equals(readFileSync(resolve(home, 'releases/release-two/agent-client.mjs'))), true)
    assert.match(readFileSync(resolve(home, '.env'), 'utf8'), /private-owner-key/)
    assert.equal(readFileSync(resolve(home, 'data/inbox/real-owner/state.json'), 'utf8'), 'private-state\n')
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

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
    const installed = runInstaller(fixture, 'local-a')
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    const home = appHome(fixture, 'local-a')
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
