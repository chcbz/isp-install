import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { digestManifest, readRuntimeHostConfig } from '../lib/manifest.mjs';
import { RuntimeHost } from '../lib/runtime-host.mjs';

async function setup(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'ur03-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agents = [];
  for (let i = 0; i < 3; i++) {
    const base = resolve(root, `agent-${i}`);
    for (const dir of ['state', 'home', 'work']) await mkdir(resolve(base, dir), { recursive: true, mode: 0o700 });
    const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: `synthetic-install-${i}`,
      tenantId: `synthetic-tenant-${i}`, clientId: 'fixture-client', canonicalAgentId: `synthetic-agent-${i}` };
    const manifest = { ...unsigned, manifestSha256: digestManifest(unsigned) };
    const profile = { profileId: `fixture-profile-${i}`, agentId: unsigned.canonicalAgentId, codexBin: '/bin/true',
      codexHome: resolve(base, 'home'), codexWorkdir: resolve(base, 'work'), appServerEnabled: false, fastChatEnabled: false,
      typedInspectionProviderNetwork: 'isolated' };
    const manifestPath = resolve(base, 'manifest.json'); const profilePath = resolve(base, 'profile.json');
    for (const [path, value] of [[manifestPath, manifest], [profilePath, profile]]) await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    agents.push({ manifestPath, profilePath, stateRoot: resolve(base, 'state') });
  }
  const stateRoot = resolve(root, 'host'); await mkdir(stateRoot, { mode: 0o700 });
  const configPath = resolve(root, 'host.json');
  await writeFile(configPath, `${JSON.stringify({ configVersion: 1, hostId: 'synthetic-stable-host', stateRoot, agents })}\n`, { mode: 0o600 });
  return { root, stateRoot, config: await readRuntimeHostConfig(configPath) };
}

function executorFactory({ failIndex = -1 } = {}) {
  const executors = new Map();
  return { executors, createExecutor: async ({ agent, subjectKey }) => {
    const state = { initialized: false, active: false, paused: false, closed: false };
    executors.set(agent.manifest.installationId, state);
    return { async initialize() { if (Number(agent.manifest.installationId.slice(-1)) === failIndex) throw Error('synthetic init failure'); state.initialized = true; },
      async activate() { state.active = true; }, ready() { return state.active && !state.paused; },
      async pause() { state.paused = true; }, async close() { state.closed = true; } };
  } };
}

test('synthetic three-Agent host keeps directory, child env, and lifecycle isolated; one Agent failure/revocation leaves peers active', async t => {
  const f = await setup(t); const mock = executorFactory({ failIndex: 1 }); const logs = [];
  const host = new RuntimeHost({ config: f.config, instanceId: 'synthetic-boot-1', createExecutor: mock.createExecutor, logger: (...args) => logs.push(args) });
  t.after(async () => { await host.stop().catch(() => {}); });
  await host.start();
  const keys = f.config.agents.map(agent => agent.subjectKey);
  await host.activate(keys[0], { synthetic: true }); await host.activate(keys[2], { synthetic: true });
  await host.isolate(keys[0], 'SYNTHETIC_REVOKED');
  const states = host.snapshot().agents;
  assert.deepEqual(states.map(row => row.phase), ['ISOLATED', 'ISOLATED', 'READY']);
  assert.equal(states[2].ready, true);
  assert.deepEqual([...mock.executors.keys()].sort(), ['synthetic-install-0', 'synthetic-install-1', 'synthetic-install-2']);
  assert.equal(JSON.stringify(logs).includes('synthetic init failure'), false);
  for (const agent of f.config.agents) {
    assert.notEqual(agent.stateRoot, f.stateRoot);
    assert.notEqual(agent.profile.codexHome, f.config.agents.find(other => other !== agent).profile.codexHome);

  }
});

test('redacted API wire fixture is pinned as data; it is not treated as client/server integration evidence', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/unified-runtime-wire-v1.redacted.json', import.meta.url), 'utf8'));
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.ack.firstRequest.sessionGeneration, fixture.ack.request.sessionGeneration);
  assert.equal(fixture.ack.firstRequest.deliveryVersion, null);
  assert.equal(fixture.ack.response.kind, 'ADVANCED');
  assert.equal(fixture.ack.priorResponse.kind, 'PRIOR');
  assert.match(fixture.session.response.sessionToken, /^REDACTED_/);
});

// Existing runtime-host.test.mjs covers real mature-engine environment allowlisting. This fixture intentionally avoids importing its dependency closure.
// NOT_RUN by design: these require the not-yet-integrated M3 client/server boundary.
test('NOT_RUN: HTTP ACK commit, stale-generation rejection, recovery and restart unknown-result non-replay', { skip: 'M3 cross-end interfaces/implementation not integrated; mock-only test would not be valid evidence' }, () => {});
