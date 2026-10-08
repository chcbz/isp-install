// Retirement regressions: no V0 broker implementation, compatibility shim or auto-adoption.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { main } from '../agent-client.mjs'
import { EXECUTION_PAYLOAD_FILES } from '../../cyf-agent-runtime-v1/lib/execution-adapter.mjs'

const engine = resolve(import.meta.dirname, '..')

test('private API-key provisioning broker is removed rather than retained as a fallback', async () => {
  assert.equal(existsSync(resolve(engine, 'managed-host.mjs')), false)
  const source = readFileSync(resolve(engine, 'agent-client.mjs'), 'utf8')
  for (const name of ['managed-host.mjs', 'managedHostModule', 'managedHostChannel', 'startManagedHostSocket']) {
    assert.equal(source.includes(name), false, name)
  }
  assert.equal(EXECUTION_PAYLOAD_FILES.includes('managed-host.mjs'), false)
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(resolve(engine, 'package.json'))).scripts, 'start'), false)
  await assert.rejects(main(), { code: 'UNIFIED_RUNTIME_ENTRY_REQUIRED' })
})

test('old API-key/profiles/socket environment cannot make the retired engine CLI provision or execute', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'ur01-retired-host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = resolve(root, 'home'); mkdirSync(home)
  const profile = resolve(root, 'profiles.json'); writeFileSync(profile, '[{"apiKey":"legacy-secret","agentId":"historical-agent"}]\n')
  const credential = resolve(home, 'credential.json'); writeFileSync(credential, '{"apiKey":"legacy-secret"}\n', { mode: 0o600 })
  const before = readdirSync(root)
  for (const args of [[], ['--validate'], ['--help']]) {
    const result = spawnSync(process.execPath, [resolve(engine, 'agent-client.mjs'), ...args], { cwd: root,
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, OPENCLAW_API_KEY: 'legacy-secret',
        CODEX_PROFILES_FILE: profile, MANAGED_HOST_ENABLED: '1', MANAGED_HOST_ROOT: home,
        MANAGED_HOST_SOCKET: resolve(root, 'broker.sock'), AGENT_WEBSOCKET_URL: 'ws://127.0.0.1:1' } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /legacy API-key execution is retired/)
    assert.equal(`${result.stdout}${result.stderr}`.includes('legacy-secret'), false)
    assert.deepEqual(readdirSync(root), before)
    assert.equal(readFileSync(credential, 'utf8'), '{"apiKey":"legacy-secret"}\n')
    assert.deepEqual(readdirSync(home), ['credential.json'])
  }
})
