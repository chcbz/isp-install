// Source-only retirement, not authorization to touch installed services/PIDs.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')
const installer = resolve(repositoryRoot, 'shell/codex_ws_agent_install.sh')
const launcher = resolve(repositoryRoot, 'bin/codex_ws_agent.sh')

const snapshot = path => {
  const st = lstatSync(path, { bigint: true })
  const metadata = [String(st.dev), String(st.ino), String(st.mode), String(st.mtimeNs), String(st.ctimeNs)]
  if (st.isSymbolicLink()) return [...metadata, readlinkSync(path)]
  if (st.isDirectory()) return [...metadata, readdirSync(path).sort().map(name => [name, snapshot(resolve(path, name))])]
  return [...metadata, readFileSync(path).toString('hex')]
}

test('retired installer and launcher reject shared/instance/maintenance modes without any tool or historical state effects', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'ur01-retired-entries-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = resolve(root, 'bin'); const app = resolve(root, 'historical-app'); const units = resolve(root, 'units')
  for (const path of [bin, app, units, resolve(app, 'releases/old'), resolve(app, 'data/inbox')]) mkdirSync(path, { recursive: true })
  writeFileSync(resolve(app, '.env'), 'OPENCLAW_API_KEY=private-legacy-key\n', { mode: 0o600 })
  writeFileSync(resolve(app, 'codex-ws-agent.pid'), 'pid=4242\nstart_ticks=12345\n')
  writeFileSync(resolve(app, 'data/inbox/unknown.json'), 'UNKNOWN execution evidence\n')
  symlinkSync('releases/old', resolve(app, 'current'))
  for (const name of ['codex-ws-agent.service', 'codex-ws-agent@.service']) {
    writeFileSync(resolve(units, name), '# synthetic INSTALLED history, must remain unchanged\n')
  }
  const calls = resolve(root, 'tool-was-called')
  for (const name of ['node', 'npm', 'python', 'systemctl', 'pgrep', 'tmux', 'nohup', 'setsid', 'kill',
    'rm', 'chmod', 'chown', 'mkdir', 'cp', 'install', 'dirname', 'realpath', 'stat', 'id']) {
    const path = resolve(bin, name)
    writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' '${name}' >> '${calls}'\nexit 19\n`); chmodSync(path, 0o755)
  }
  const before = snapshot(root)
  const env = { PATH: bin, HOME: app, ISP_APPS: root, OPENCLAW_API_KEY: 'private-legacy-key',
    CODEX_WS_AGENT_INSTALL_TEST_MODE: '1', CODEX_WS_AGENT_INSTALL_TEST_FULL: '1', CODEX_WS_AGENT_INSTALL_TEST_COLLATE: '1',
    CODEX_WS_AGENT_LAUNCHER_TEST_MODE: '1', CODEX_WS_AGENT_TEST_FIXTURE_ROOT: root,
    CODEX_WS_AGENT_TEST_APP_HOME: app, CODEX_WS_AGENT_TEST_INSTANCE_ROOT: app, CODEX_WS_AGENT_INSTANCE_ROOT: app,
    CODEX_WS_AGENT_DEFAULT_APP_HOME: app, CODEX_WS_AGENT_SYSTEMD_DIR: units, CODEX_WS_AGENT_SYSTEMCTL: resolve(bin, 'systemctl'),
    START_CODEX_WS_AGENT: 'y' }
  for (const [script, modes] of [
    [installer, [[], ['--instance', 'local-a'], ['--instance', '../escape'], ['--help'], ['--test-isolation-check']]],
    [launcher, [[], ['start'], ['restart'], ['stop'], ['status'], ['--instance', 'local-a', 'start'],
      ['--instance', '../escape', 'stop'], ['workspace', 'archive', '--policy', 'foreign'], ['--test-isolation-check']]]
  ]) for (const args of modes) {
    await t.test(`${script.split('/').pop()} ${JSON.stringify(args)}`, () => {
      const result = spawnSync('/bin/bash', [script, ...args], { cwd: root, encoding: 'utf8', env })
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /UNIFIED_RUNTIME_ENTRY_REQUIRED/)
      assert.equal(`${result.stdout}${result.stderr}`.includes('private-legacy-key'), false)
      assert.equal(existsSync(calls), false)
      assert.deepEqual(snapshot(root), before, 'no service/PID action, credential readback, chmod, inode change, archive or new state')
    })
  }
})

test('retired source diagnostics contain no operational implementation or installed service mutation', () => {
  for (const path of [installer, launcher]) {
    const source = readFileSync(path, 'utf8')
    assert.equal(/^(?:source|exec|install|mkdir|cp|chmod|chown|systemctl|read|kill|rm)\s/m.test(source), false)
    assert.equal(source.includes('RELEASE_PAYLOAD='), false)
    assert.equal(source.includes('agent-client.mjs'), false)
    assert.equal(source.includes('$'), false, 'does not interpret caller configuration/args')
  }
})
