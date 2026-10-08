import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestManifest, readRuntimeHostConfig, runtimeSubjectKey } from '../lib/manifest.mjs';
import { acquireRuntimeOwnership, RuntimeHost } from '../lib/runtime-host.mjs';
import { collateExecutionPayload, createExecutionAdapterFactory, EXECUTION_PAYLOAD_FILES, validateExecutionPayload } from '../lib/execution-adapter.mjs';

// Frozen offline acceptance coverage, before implementation: config -> identity,
// installation/path collisions and credential allowlist; host -> readiness,
// independent lifecycle, stop-v-start and writer ownership; executor -> one
// injected host, exact subject/boot IDs, no legacy network/env; payload -> exact
// mature catalog, literal import closure and no private-state wildcard copies.
// Wire/D06 ACK/CHAT-result confirmations are separate, not claimed by this suite.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const engineSource = resolve(repo, 'conf/codex-ws-agent');
const code = expected => cause => cause?.code === expected;

async function fixture(t, { count = 3, sameAgentId = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'ur01-owned-fixture-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { await rm(root, { recursive: true, force: true }); } // only this test's fresh root
  });
  const hostRoot = resolve(root, 'host');
  await mkdir(hostRoot, { mode: 0o700 });
  const entries = []; const manifests = []; const profiles = [];
  const json = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  for (let i = 0; i < count; i++) {
    const base = resolve(root, `agent-${i}`); await mkdir(base, { mode: 0o700 });
    for (const name of ['state', 'home', 'work']) await mkdir(resolve(base, name), { mode: 0o700 });
    const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: `installation-${i}`,
      tenantId: `tenant-${i}`, clientId: 'client', canonicalAgentId: sameAgentId ? 'agent' : `agent-${i}` };
    const manifest = { ...unsigned, manifestSha256: digestManifest(unsigned) };
    const profile = { profileId: `profile-${i}`, agentId: manifest.canonicalAgentId, codexBin: '/bin/true',
      codexHome: resolve(base, 'home'), codexWorkdir: resolve(base, 'work'), appServerEnabled: false,
      fastChatEnabled: false, typedInspectionProviderNetwork: 'isolated' };
    const entry = { manifestPath: resolve(base, 'manifest.json'), profilePath: resolve(base, 'profile.json'), stateRoot: resolve(base, 'state') };
    await json(entry.manifestPath, manifest); await json(entry.profilePath, profile);
    entries.push(entry); manifests.push(manifest); profiles.push(profile);
  }
  const raw = { configVersion: 1, hostId: 'stable-host', stateRoot: hostRoot, agents: entries };
  const path = resolve(root, 'host.json'); await json(path, raw);
  return { root, raw, path, entries, manifests, profiles, json, cleanup: fn => cleanups.push(fn),
    async config() { await json(path, raw); return readRuntimeHostConfig(path); },
    async profile(i, change) { Object.assign(profiles[i], change); await json(entries[i].profilePath, profiles[i]); },
    async manifest(i, change) { Object.assign(manifests[i], change); manifests[i].manifestSha256 = digestManifest(manifests[i]); await json(entries[i].manifestPath, manifests[i]); }
  };
}

function executors({ failure = null, unconfirmed = null, wait = null } = {}) {
  const states = new Map();
  return { states, createExecutor: async ({ subjectKey }) => {
    const state = { initialized: 0, closed: 0, paused: 0, bound: false }; states.set(subjectKey, state);
    return { initialize: async () => { state.initialized++; await wait?.(); if (subjectKey === failure) throw new Error('private fixture detail'); },
      activate: async () => { state.bound = true; }, ready: () => state.bound,
      pause: async () => { state.paused++; state.bound = false; },
      close: async () => { state.closed++; if (subjectKey === unconfirmed) throw new Error('unconfirmed fixture'); } };
  } };
}

test('three complete subjects initialize immutable config without writing any state', async t => {
  const f = await fixture(t, { sameAgentId: true });
  const before = await Promise.all(f.entries.map(entry => readdir(entry.stateRoot)));
  const config = await f.config();
  assert.equal(new Set(config.agents.map(agent => agent.subjectKey)).size, 3);
  assert.equal(config.hostId, 'stable-host');
  assert.throws(() => { config.agents[0].manifest.tenantId = 'wrong'; }, TypeError);
  assert.throws(() => { config.agents[0].profile.codexHome = f.root; }, TypeError);
  assert.deepEqual(await Promise.all(f.entries.map(entry => readdir(entry.stateRoot))), before);
});

test('duplicate complete subjects and installation authorization are rejected independently', async t => {
  const f = await fixture(t);
  await f.manifest(1, { tenantId: f.manifests[0].tenantId, clientId: f.manifests[0].clientId, canonicalAgentId: f.manifests[0].canonicalAgentId });
  await assert.rejects(f.config(), code('RUNTIME_AGENT_IDENTITY_DUPLICATE'));
  await f.manifest(1, { tenantId: 'another-tenant', installationId: f.manifests[0].installationId });
  await assert.rejects(f.config(), code('RUNTIME_INSTALLATION_DUPLICATE'));
});

for (const kind of ['equal', 'nested', 'state', 'host', 'alias', 'ancestor-alias']) test(`reject ${kind} writable root collision without adopting state`, async t => {
  const f = await fixture(t);
  const first = f.profiles[0].codexHome;
  if (kind === 'equal') await f.profile(1, { codexHome: first });
  if (kind === 'nested') await f.profile(1, { codexHome: resolve(first, 'not-created') });
  if (kind === 'state') await f.profile(1, { workspaceFileRootDir: resolve(f.entries[0].stateRoot, 'not-created') });
  if (kind === 'host') await f.profile(1, { codexHome: resolve(f.raw.stateRoot, 'not-created') });
  if (kind === 'alias') { const link = resolve(f.root, 'home-alias'); await symlink(first, link); await f.profile(1, { codexHome: link }); }
  if (kind === 'ancestor-alias') { const link = resolve(f.root, 'parent-alias'); await symlink(first, link); await f.profile(1, { codexHome: resolve(link, 'not-created') }); }
  await assert.rejects(f.config(), code(['alias', 'ancestor-alias'].includes(kind) ? 'RUNTIME_PATH_SYMLINK' : kind === 'host' ? 'RUNTIME_HOST_ROOT_OVERLAP' : 'RUNTIME_AGENT_ROOTS_OVERLAP'));
  assert.deepEqual(await readdir(f.entries[0].stateRoot), []);
});

test('identity substitution, legacy credentials and injected runtime keys fail closed', async t => {
  const f = await fixture(t);
  await f.profile(0, { agentId: 'other-agent' });
  await assert.rejects(f.config(), code('RUNTIME_PROFILE_IDENTITY_INVALID'));
  await f.profile(0, { agentId: f.manifests[0].canonicalAgentId });
  for (const key of ['apiKey', 'workspaceFileRuntimeAuthHeader', 'runtimeAuthorization', 'runtimeSubjectKey', 'runtimeProviderEnvironment']) {
    await f.profile(0, { extra: [{ [key]: 'private-never-logged' }] });
    await assert.rejects(f.config(), code('RUNTIME_PROFILE_CREDENTIAL_FORBIDDEN'));
  }
});

test('sealed/config file mutations and symlink replacement are rejected', async t => {
  const f = await fixture(t);
  await chmod(f.entries[0].profilePath, 0o666);
  await assert.rejects(f.config(), code('RUNTIME_CONFIG_FILE_UNSAFE'));
  await chmod(f.entries[0].profilePath, 0o600);
  await f.json(f.entries[0].manifestPath, { ...f.manifests[0], clientId: 'tampered' });
  await assert.rejects(f.config(), /SHA-256 mismatch/);
  await f.json(f.entries[0].manifestPath, f.manifests[0]);
  const stored = `${f.entries[0].profilePath}.owned-backup`; await rename(f.entries[0].profilePath, stored);
  await symlink(stored, f.entries[0].profilePath);
  await assert.rejects(f.config(), code('RUNTIME_PATH_SYMLINK'));
});

test('one host boots three isolated executors; initialization never means READY and revoke is per Agent', async t => {
  const f = await fixture(t); const config = await f.config(); const mock = executors();
  const host = new RuntimeHost({ config, instanceId: 'boot-one', createExecutor: mock.createExecutor });
  f.cleanup(() => host.stop());
  const started = await host.start();
  assert.deepEqual(started.agents.map(agent => [agent.phase, agent.ready]), [['INITIALIZED', false], ['INITIALIZED', false], ['INITIALIZED', false]]);
  await Promise.all(config.agents.map(agent => host.activate(agent.subjectKey, {})));
  assert.equal(host.snapshot().agents.filter(agent => agent.ready).length, 3);
  await host.isolate(config.agents[1].subjectKey);
  assert.deepEqual(host.snapshot().agents.map(agent => agent.ready), [true, false, true]);
  const firstStop = host.stop(); assert.equal(host.stop(), firstStop); await firstStop;
  assert.equal(host.snapshot().agents.every(agent => agent.phase === 'STOPPED'), true);
  for (const root of [config.stateRoot, ...config.agents.map(agent => agent.stateRoot)]) assert.deepEqual(await readdir(root), []);
});

test('one initialization failure is redacted and does not tear down other Agents', async t => {
  const f = await fixture(t); const config = await f.config(); const logs = [];
  const host = new RuntimeHost({ config, instanceId: 'boot-one', createExecutor: executors({ failure: config.agents[1].subjectKey }).createExecutor,
    logger: (...args) => logs.push(args) }); f.cleanup(() => host.stop());
  await host.start(); assert.deepEqual(host.snapshot().agents.map(agent => agent.phase), ['INITIALIZED', 'ISOLATED', 'INITIALIZED']);
  assert.equal(JSON.stringify(logs).includes('private fixture detail'), false);
  assert.deepEqual(await readdir(config.agents[1].stateRoot), []);
});

test('stop during initialization waits and never opens a late execution channel', async t => {
  const f = await fixture(t); const config = await f.config();
  let release; let entered; const started = new Promise(resolve => { entered = resolve; }); const wait = new Promise(resolve => { release = resolve; });
  const host = new RuntimeHost({ config, instanceId: 'boot-one', createExecutor: executors({ wait: async () => { entered(); await wait; } }).createExecutor });
  const starting = host.start(); await started; const stopping = host.stop();
  const late = host.activate(config.agents[0].subjectKey, {}); release(); await starting; await stopping;
  await assert.rejects(late, code('RUNTIME_AGENT_NOT_INITIALIZED'));
  await assert.rejects(host.start(), code('RUNTIME_HOST_STOPPED'));
  assert.deepEqual(await readdir(config.stateRoot), []);
});

test('unconfirmed executor shutdown retains both Agent and host writer ownership', async t => {
  const f = await fixture(t); const config = await f.config();
  const host = new RuntimeHost({ config, instanceId: 'boot-one', createExecutor: executors({ unconfirmed: config.agents[0].subjectKey }).createExecutor });
  await host.start(); await assert.rejects(host.stop(), code('RUNTIME_HOST_STOP_UNCONFIRMED'));
  for (const root of [config.stateRoot, config.agents[0].stateRoot]) {
    await assert.rejects(acquireRuntimeOwnership(root, { hostId: 'other', instanceId: 'boot-two' }), code('RUNTIME_WRITER_BUSY'));
  }
});

test('existing stale or replaced writer locks are never stolen/deleted', async t => {
  const f = await fixture(t); const root = f.raw.stateRoot;
  const release = await acquireRuntimeOwnership(root, { hostId: 'stable-host', instanceId: 'boot-one' });
  const lock = resolve(root, '.runtime-writer.lock');
  const bytes = await readFile(resolve(lock, 'owner.json'), 'utf8');
  await assert.rejects(acquireRuntimeOwnership(root, { hostId: 'other', instanceId: 'boot-two' }), code('RUNTIME_WRITER_BUSY'));
  assert.equal(await readFile(resolve(lock, 'owner.json'), 'utf8'), bytes);
  await rename(lock, `${lock}.owned-backup`); await mkdir(lock, { mode: 0o700 }); await writeFile(resolve(lock, 'owner.json'), bytes, { mode: 0o600 });
  await assert.rejects(release(), code('RUNTIME_WRITER_OWNERSHIP_LOST'));
  assert.equal(await readFile(resolve(lock, 'owner.json'), 'utf8'), bytes);
});

test('replaced private root cannot make an old owner delete a new root lock', async t => {
  const f = await fixture(t); const root = f.raw.stateRoot;
  const release = await acquireRuntimeOwnership(root, { hostId: 'stable-host', instanceId: 'boot-one' });
  await rename(root, `${root}.owned-backup`); await mkdir(root, { mode: 0o700 });
  await cp(resolve(`${root}.owned-backup`, '.runtime-writer.lock'), resolve(root, '.runtime-writer.lock'), { recursive: true });
  await assert.rejects(release(), code('RUNTIME_WRITER_OWNERSHIP_LOST'));
  assert.equal((await lstat(resolve(root, '.runtime-writer.lock'))).isDirectory(), true);
});

test('writer ownership persists identity and boot IDs independently and releases only once', async t => {
  const f = await fixture(t); const root = f.raw.stateRoot;
  const release = await acquireRuntimeOwnership(root, { hostId: 'stable-host', instanceId: 'boot-one' });
  const owner = JSON.parse(await readFile(resolve(root, '.runtime-writer.lock/owner.json'), 'utf8'));
  assert.equal(owner.hostId, 'stable-host'); assert.equal(owner.instanceId, 'boot-one');
  await Promise.all([release(), release()]); await release(); assert.deepEqual(await readdir(root), []);
});

test('unprotected/symlink state roots are not repaired or adopted', async t => {
  const f = await fixture(t); const root = f.raw.stateRoot;
  await chmod(root, 0o755);
  await assert.rejects(acquireRuntimeOwnership(root, { hostId: 'stable', instanceId: 'boot' }), code('RUNTIME_ROOT_UNSAFE'));
  assert.deepEqual(await readdir(root), []);
  const link = resolve(f.root, 'root-alias'); await symlink(root, link);
  await assert.rejects(acquireRuntimeOwnership(link, { hostId: 'stable', instanceId: 'boot' }), code('RUNTIME_ROOT_UNSAFE'));
});

test('injected adapter refuses guessed sessions and never imports legacy environment', async t => {
  const f = await fixture(t); const config = await f.config();
  await writeFile(resolve(f.root, '.env'), 'UR01_PRIVATE_IMPORT_CANARY=host-secret\nOPENCLAW_API_KEY=foreign-key\n');
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(resolve(engineSource, 'agent-client.mjs'))}); console.log(process.env.UR01_PRIVATE_IMPORT_CANARY || 'clean')`], { cwd: f.root, encoding: 'utf8' });
  assert.equal(stdout.trim(), 'clean');
  const adapter = await createExecutionAdapterFactory({ config, instanceId: 'boot-one', apiOrigin: 'https://api.example.test' });
  f.cleanup(() => adapter.close());
  const executor = adapter.createExecutor({ agent: config.agents[0], subjectKey: config.agents[0].subjectKey });
  await executor.initialize(); assert.equal(executor.ready(), false);
  await assert.rejects(executor.activate({ madeUpToken: 'fake' }), code('RUNTIME_WIRE_ADAPTER_REQUIRED'));
  await executor.close();
});

test('mature executor retains isolated subjects/session namespaces and allowlisted child environment', async t => {
  const f = await fixture(t, { sameAgentId: true }); const config = await f.config();
  const { buildRuntimeExecutionEnvironment, createRuntimeExecutionHost } = await import(resolve(engineSource, 'agent-client.mjs'));
  const engine = createRuntimeExecutionHost({ agents: config.agents, runtimeInstanceId: 'boot-one', apiOrigin: 'https://api.example.test' });
  f.cleanup(() => engine.close());
  assert.throws(() => createRuntimeExecutionHost({ agents: config.agents, runtimeInstanceId: 'boot-two', apiOrigin: 'https://api.example.test' }), code('RUNTIME_EXECUTOR_HOST_BUSY'));
  const states = [];
  for (const agent of config.agents) {
    const executor = engine.createExecutor({ subjectKey: agent.subjectKey });
    await executor.initialize(); const state = executor.state(); states.push(state);
    assert.equal(state.profile.runtimeIdentity.installationId, agent.manifest.installationId);
    assert.equal(state.profile.runtimeInstanceId, 'boot-one'); assert.equal(executor.ready(), false);
    assert.equal(state.processor.paused, true);
    assert.throws(() => buildRuntimeExecutionEnvironment(state.profile, { OPENAI_API_KEY: 'foreign' }), code('RUNTIME_EXECUTION_ENV_FORBIDDEN'));
    const env = buildRuntimeExecutionEnvironment(state.profile);
    assert.equal(env.HOME, agent.profile.codexHome); assert.equal(env.CODEX_HOME, agent.profile.codexHome);
    assert.equal(env.OPENCLAW_API_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
    state.sessionStore.remember(state.profile, { conversationId: 'conversation' }, `session-${agent.subjectKey}`);
  }
  assert.equal(new Set(states.map(state => state.inbox.rootDir)).size, 3);
  for (const [i, state] of states.entries()) assert.equal(state.sessionStore.get(state.profile, { conversationId: 'conversation' }), `session-${config.agents[i].subjectKey}`);
});

test('execution artifact catalog equals mature installer; clean collation has complete imports, no host state', async t => {
  const f = await fixture(t, { count: 1 });
  const installer = await readFile(resolve(repo, 'shell/codex_ws_agent_install.sh'), 'utf8');
  const list = installer.match(/RELEASE_PAYLOAD=\(\n([\s\S]*?)\n\)/)[1];
  assert.deepEqual(EXECUTION_PAYLOAD_FILES, [...list.matchAll(/"([^"\n]+)"/g)].map(match => match[1]));
  const target = resolve(f.root, 'codex-ws-agent');
  const result = await collateExecutionPayload(engineSource, target);
  assert.equal(result.payloadCount, EXECUTION_PAYLOAD_FILES.length); assert.equal(result.dependenciesValidated, false);
  await assert.rejects(collateExecutionPayload(engineSource, target), cause => cause.code === 'EEXIST');
  const installed = await readdir(target); assert.equal(installed.includes('.env'), false); assert.equal(installed.includes('node_modules'), false);
  await writeFile(resolve(target, '.env'), 'foreign-secret');
  await assert.rejects(validateExecutionPayload(target, { dependencies: false, toolchain: false }), code('RUNTIME_PAYLOAD_PRIVATE_STATE_FORBIDDEN'));
});

test('packaged engine literal import tampering or linked source fails closed', async t => {
  const f = await fixture(t, { count: 1 }); const source = resolve(f.root, 'source');
  await collateExecutionPayload(engineSource, source);
  await writeFile(resolve(source, 'agent-client.mjs'), "import './not-packaged.mjs';\n");
  await assert.rejects(validateExecutionPayload(source, { dependencies: false, toolchain: false }), code('RUNTIME_PAYLOAD_IMPORT_MISSING'));
  const path = resolve(source, 'package.json'); await rename(path, `${path}.owned-backup`); await symlink(`${path}.owned-backup`, path);
  await assert.rejects(collateExecutionPayload(source, resolve(f.root, 'target')), code('RUNTIME_PAYLOAD_SOURCE_UNSAFE'));
});


test('owned child cleanup escalates after signal-sent and awaits close, without leaking host secrets', async t => {
  const f = await fixture(t, { count: 1 });
  const { buildRuntimeExecutionEnvironment, stopRuntimeExecutionChild } = await import(resolve(engineSource, 'agent-client.mjs'));
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)"], {
    cwd: f.profiles[0].codexWorkdir, env: buildRuntimeExecutionEnvironment(f.profiles[0]), stdio: ['ignore', 'pipe', 'pipe']
  });
  f.cleanup(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed; } });
  await new Promise(resolve => child.stdout.once('data', resolve));
  let closed = false; child.once('close', () => { closed = true; });
  await stopRuntimeExecutionChild(f.profiles[0], child, { escalationMs: 10 });
  assert.equal(child.killed, true); assert.equal(child.signalCode, 'SIGKILL'); assert.equal(closed, true);
  await stopRuntimeExecutionChild(f.profiles[0], child);
});
