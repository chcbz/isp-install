import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const installer = resolve(root, 'shell/codex_ws_agent_install.sh')
const config = resolve(root, 'conf/codex-ws-agent')
const leaseModule = resolve(config, 'work-item-lease.mjs')
const contextPackModule = resolve(config, 'task-context-pack.mjs')

const makeFixture = () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'codex-ws-agent-e05-installer-'))
  const appHome = resolve(fixtureRoot, 'app')
  const binDir = resolve(fixtureRoot, 'bin')
  const npmRecord = resolve(fixtureRoot, 'npm-record')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(binDir)

  const nodeWrapper = resolve(binDir, 'node-wrapper')
  const npmWrapper = resolve(binDir, 'npm-wrapper')
  writeFileSync(nodeWrapper, `#!/bin/bash
if [[ "$1" == */agent-client.mjs && "$2" == --validate ]]; then exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`)
  writeFileSync(npmWrapper, `#!/bin/bash
set -eu
test -f work-item-lease.mjs
test -f task-context-pack.mjs
printf '%s\\n' "$PWD" > ${JSON.stringify(npmRecord)}
mkdir -p node_modules
`)
  chmodSync(nodeWrapper, 0o755)
  chmodSync(npmWrapper, 0o755)

  const result = spawnSync('bash', [installer], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_WS_AGENT_INSTALL_TEST_MODE: '1',
      CODEX_WS_AGENT_INSTALL_TEST_COLLATE: '1',
      CODEX_WS_AGENT_TEST_RELEASE_ID: 'e05-contract',
      CODEX_WS_AGENT_TEST_APP_HOME: appHome,
      CODEX_WS_AGENT_TEST_NODE_BIN: nodeWrapper,
      CODEX_WS_AGENT_TEST_NPM_BIN: npmWrapper,
      START_CODEX_WS_AGENT: 'n'
    }
  })
  return { fixtureRoot, appHome, npmRecord, result }
}

test('installer stages native E05/F01 modules beside agent-client without generating credentials', () => {
  const fixture = makeFixture()
  try {
    assert.equal(fixture.result.status, 0, `${fixture.result.stdout}\n${fixture.result.stderr}`)

    const release = resolve(fixture.appHome, 'releases', 'e05-contract')
    const installedLease = resolve(release, 'work-item-lease.mjs')
    const installedContextPack = resolve(release, 'task-context-pack.mjs')
    assert.equal(readlinkSync(resolve(fixture.appHome, 'current')), 'releases/e05-contract')
    assert.equal(existsSync(installedLease), true)
    assert.deepEqual(readFileSync(installedLease), readFileSync(leaseModule))
    assert.deepEqual(readFileSync(installedContextPack), readFileSync(contextPackModule))
    assert.equal(statSync(installedLease).mode & 0o777, 0o644)
    assert.equal(statSync(installedContextPack).mode & 0o777, 0o644)
    assert.equal(readFileSync(fixture.npmRecord, 'utf8'), `${resolve(fixture.appHome, 'releases', '.stage-e05-contract')}\n`)

    const env = readFileSync(resolve(fixture.appHome, '.env'), 'utf8')
    assert.match(env, /AGENT_WORK_ITEM_LEASE_BEARER_TOKEN_FILE=\n/)
    assert.match(env, /AGENT_WORK_ITEM_LEASE_TENANT_ID=\n/)
    assert.match(env, /AGENT_TASK_CONTEXT_PACK_BEARER_TOKEN_FILE=\n/)
    assert.match(env, /AGENT_TASK_CONTEXT_PACK_TENANT_ID=\n/)
    assert.doesNotMatch(env, /leaseToken|token-secret|ey[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/)
    assert.equal(existsSync(resolve(fixture.appHome, 'lease-token')), false)
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})
