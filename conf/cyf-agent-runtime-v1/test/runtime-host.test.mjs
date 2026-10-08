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
  await assert.rejects(executor.activate({ madeUpToken: 'fake' }), code('RUNTIME_ENROLLMENT_REQUIRED'));
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

test('multi-Agent validate CLI reads config without engine effects; run fails closed until wire is bound', async t => {
  const f = await fixture(t);
  const entry = resolve(repo, 'conf/cyf-agent-runtime-v1/agent-runtime.mjs');
  const stdout = execFileSync(process.execPath, [entry, 'validate', '--config', f.path], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout), { valid: true, hostId: 'stable-host', agentCount: 3 });
  assert.deepEqual(await readdir(f.raw.stateRoot), []);
  const { main } = await import(entry);
  await assert.rejects(main(['run', '--config', f.path], {}), code('RUNTIME_API_ORIGIN_REQUIRED'));
  assert.deepEqual(await Promise.all(f.entries.map(entry => readdir(entry.stateRoot))), [[], [], []]);
});

test('installer refuses existing targets, wrong Node and unprepared parents before dependencies', async t => {
  const f = await fixture(t, { count: 1 });
  const installer = resolve(repo, 'conf/cyf-agent-runtime-v1/install.sh');
  const target = resolve(f.root, 'artifact'); await mkdir(target, { mode: 0o700 });
  await writeFile(resolve(target, 'foreign-marker'), 'untouched');
  assert.throws(() => execFileSync('bash', [installer, '--target', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /target exists/.test(cause.stderr));
  assert.equal(await readFile(resolve(target, 'foreign-marker'), 'utf8'), 'untouched');
  assert.throws(() => execFileSync('bash', [installer, '--target', resolve(f.root, 'unprepared/artifact')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /parent must exist/.test(cause.stderr));
  const wrongNode = resolve(f.root, 'wrong-node'); await writeFile(wrongNode, '#!/bin/sh\necho 22.0.0\n', { mode: 0o700 });
  assert.throws(() => execFileSync('bash', [installer, '--target', resolve(f.root, 'new-artifact'), '--node', wrongNode], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /pinned Node 20.20.2/.test(cause.stderr));
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.cyf-agent-runtime.stage')), false);
});

test('dependency preparation failure never publishes or leaves its stage; does not invoke Python', async t => {
  const f = await fixture(t, { count: 1 });
  const installer = resolve(repo, 'conf/cyf-agent-runtime-v1/install.sh');
  const npm = resolve(f.root, 'fixture-npm.cjs'); await writeFile(npm, 'process.exit(31)\n', { mode: 0o700 });
  const python = resolve(f.root, 'fixture-python'); const marker = resolve(f.root, 'python-was-called');
  await writeFile(python, `#!/bin/sh\ntouch '${marker}'\nexit 32\n`, { mode: 0o700 });
  const target = resolve(f.root, 'artifact');
  assert.throws(() => execFileSync('bash', [installer, '--target', target, '--node', process.execPath, '--npm', npm, '--python', python], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }), cause => cause.status === 31);
  await assert.rejects(lstat(target), cause => cause.code === 'ENOENT');
  await assert.rejects(lstat(marker), cause => cause.code === 'ENOENT');
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.cyf-agent-runtime.stage')), false);
});

test('validator checks full artifact-local dependency/toolchain graph instead of accepting payload-only collation', async t => {
  const f = await fixture(t, { count: 1 });
  const artifact = resolve(f.root, 'artifact'); await mkdir(artifact);
  await cp(resolve(repo, 'conf/cyf-agent-runtime-v1'), resolve(artifact, 'runtime'), { recursive: true });
  await collateExecutionPayload(engineSource, resolve(artifact, 'codex-ws-agent'));
  await mkdir(resolve(artifact, 'node/bin'), { recursive: true }); await cp(process.execPath, resolve(artifact, 'node/bin/node')); await chmod(resolve(artifact, 'node/bin/node'), 0o755);
  const validator = resolve(artifact, 'runtime/validate.sh');
  assert.throws(() => execFileSync('bash', [validator, '--root', artifact], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /node_modules/.test(cause.stderr));
  await cp(resolve(engineSource, 'node_modules'), resolve(artifact, 'codex-ws-agent/node_modules'), { recursive: true });
  assert.throws(() => execFileSync('bash', [validator, '--root', artifact], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /\.toolchain/.test(cause.stderr));
  const ws = resolve(artifact, 'codex-ws-agent/node_modules/ws/package.json');
  const packageJson = JSON.parse(await readFile(ws, 'utf8')); packageJson.version = '0.0.0'; await writeFile(ws, JSON.stringify(packageJson));
  await assert.rejects(validateExecutionPayload(resolve(artifact, 'codex-ws-agent'), { toolchain: false }), code('RUNTIME_DEPENDENCY_VERSION_MISMATCH'));
});

test('single-artifact units pin local Node and shared host config; shell entry has no activation/reload', async () => {
  const units = await Promise.all([resolve(repo, 'systemd/cyf-agent-runtime-v1@.service'), resolve(repo, 'conf/cyf-agent-runtime-v1/systemd/cyf-agent-runtime-v1@.service')].map(path => readFile(path, 'utf8')));
  assert.equal(units[0], units[1]);
  assert.match(units[0], /^ExecStart=.*\/node\/bin\/node .*\/runtime\/agent-runtime.mjs run --config .*%i.host.json$/m);
  assert.match(units[0], /^ExecStartPre=.*\/runtime\/validate.sh --root .* --config .*%i.host.json$/m);
  assert.equal(units[0].includes('--state-dir'), false); assert.equal(units[0].includes('/usr/bin/env node'), false);
  const shell = await readFile(resolve(repo, 'shell/cyf_agent_runtime_v1_install.sh'), 'utf8');
  assert.equal(/\bsystemctl\b/.test(shell), false); assert.equal(/\b(?:stop|restart|enable)\b/.test(shell), false);
});

test('toolchain validation refuses a host-global interpreter alias instead of falsely claiming release closure', async t => {
  const f = await fixture(t, { count: 1 }); const artifact = resolve(f.root, 'engine');
  await collateExecutionPayload(engineSource, artifact);
  await mkdir(resolve(artifact, '.toolchain/bin'), { recursive: true });
  await symlink('/usr/bin/python3', resolve(artifact, '.toolchain/bin/python'));
  await assert.rejects(validateExecutionPayload(artifact, { dependencies: false }), code('RUNTIME_TOOLCHAIN_PATH_UNSAFE'));
});

// M3 adapter acceptance: exact Wire r1 token-free registration and per-subject
// lifecycle. Synthetic socket/HTTP only; no server/production claim.
async function channelFixture(t, { ackRegistration = true, chatReady = false, types = ['TASK_INVITE'], healthy = true } = {}) {
  const { EventEmitter } = await import('node:events');
  const { RuntimeV1Client } = await import('../lib/runtime-client.mjs');
  const f = await fixture(t, { count: 2 }); const config = await f.config();
  const requests = []; const sockets = []; const engines = new Map();
  const socketEvents = new EventEmitter();
  class Socket extends EventEmitter {
    constructor(url, options) {
      super(); this.url = url; this.headers = options.headers; this.readyState = 0; this.sent = []; sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); socketEvents.emit('opened', this); } });
    }
    send(bytes) {
      const frame = JSON.parse(bytes); this.sent.push(frame);
      if (frame.messageType === 'agent.register' && ackRegistration) queueMicrotask(() => this.receive({ type: 'agent_registered',
        messageId: frame.messageId, agentId: frame.agentId, runtimeInstanceId: frame.runtimeInstanceId,
        installationId: frame.installationId, hostId: frame.hostId, sessionGeneration: frame.sessionGeneration,
        status: 'online', durableStateHealthy: frame.durableStateHealthy, readyCommandTypes: frame.readyCommandTypes }));
    }
    receive(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', code)); }
    terminate() { this.close(); }
  }
  const module = {
    buildProtocolEnvelope: (messageType, payload) => ({ schemaVersion: 1, messageType, ...payload }),
    createRuntimeExecutionHost: () => ({
      createExecutor: ({ subjectKey, agent }) => {
        const state = { profile: agent.profile, processor: { pause: () => { state.paused = true; } }, healthy,
          accepted: [], closed: false, resumed: 0, types: [...types], paused: true, transport: null };
        engines.set(subjectKey, state);
        return {
          initialize: async () => {}, bindTransport: transport => { state.transport = transport; }, attachSocket: socket => { state.socket = socket; },
          durableStateHealthy: () => state.healthy, readyCommandTypes: () => state.types, chatReady: () => chatReady,
          registrationPayload: () => ({ runtimeCapabilities: { profiles: { EXECUTE: { available: false } } } }),
          acceptFrame: async frame => { state.accepted.push(frame); }, resume: async () => { state.resumed++; },
          disconnected: () => { state.paused = true; }, suspendAdmission: () => { state.paused = true; },
          close: async () => { state.closed = true; }, state: () => state
        };
      }, close: async () => {}
    })
  };
  for (const agent of config.agents) await f.json(resolve(agent.stateRoot, 'runtime-authorization.json'), { installationId: agent.manifest.installationId, runtimeAuthorization: 'synthetic-' + agent.manifest.installationId });
  const generation = new Map();
  const adapters = await createExecutionAdapterFactory({ config, instanceId: 'boot-fixture', apiOrigin: 'https://api.example.test', socketFactory: Socket,
    loadEngine: async () => module, clientFactory: settings => new RuntimeV1Client({ ...settings, fetchFn: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, options, body });
      if (url.endsWith('/session')) {
        const current = (generation.get(body.installationId) || 6) + 1; generation.set(body.installationId, current);
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ data: { ...Object.fromEntries(['installationId','tenantId','clientId','canonicalAgentId','hostId','runtimeInstanceId'].map(key => [key, body[key]])), sessionGeneration: current,
          scheme: 'AgentRuntime', sessionToken: 'rts1_' + 'a'.repeat(64), websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' } }) };
      }
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ data: { kind: 'ADVANCED', status: body.status, deliveryVersion: (body.deliveryVersion ?? 0) + 1 } }) };
    } }) });
  f.cleanup(() => adapters.close());
  const executors = config.agents.map(agent => adapters.createExecutor({ subjectKey: agent.subjectKey, agent }));
  for (const executor of executors) await executor.initialize();
  return { f, config, adapters, sockets, requests, executors, engines, states: () => [...engines.values()], opened: () => sockets.some(socket => socket.readyState === 1) ? Promise.resolve() : new Promise(resolveOpen => socketEvents.once('opened', resolveOpen)), tick: () => new Promise(resolveTick => setImmediate(resolveTick)) };
}

test('two independent session channels activate only exact receipt; health revocation keeps terminal reporting', async t => {
  const c = await channelFixture(t);
  await Promise.all(c.executors.map(executor => executor.activate()));
  assert.deepEqual(c.executors.map(executor => executor.ready()), [true, true]);
  assert.equal(c.requests[0].options.headers.Authorization.startsWith('Bearer synthetic-'), true);
  const first = c.sockets[0].sent[0]; assert.deepEqual(first.readyCommandTypes, ['TASK_INVITE']);
  assert.equal(first.durableStateHealthy, true); assert.equal(Object.hasOwn(first, 'sessionToken'), false);
  assert.equal(c.sockets[0].headers['X-API-Key'], undefined); assert.equal(c.sockets[0].url, 'wss://api.example.test/ws/agent/channel');
  const state = c.states()[0]; state.healthy = false; await c.adapters.heartbeat();
  assert.deepEqual(c.executors.map(executor => executor.ready()), [false, true]);
  assert.equal(state.transport.reportReady(), true); assert.equal(state.paused, true);
  const command = { ...Object.fromEntries(['installationId','tenantId','clientId','canonicalAgentId'].map(key => [key, c.config.agents[0].manifest[key]])), messageId: 'original-message', correlationId: 'original-correlation', commandId: 'original-command', taskId: 'task', workItemId: null, payloadReference: 'payload', expiresAt: '2000-01-01T00:00:00Z' };
  const result = await state.transport.acknowledge(command, 'SUCCEEDED', 10);
  assert.equal(result.deliveryVersion, 11); assert.equal(c.requests.at(-1).body.sessionGeneration, 7);
  const presence = c.sockets[0].sent.findLast(frame => frame.messageType === 'agent.presence'); assert.equal(presence.durableStateHealthy, false);
  state.healthy = true; await c.adapters.heartbeat(); await c.tick(); assert.equal(c.executors[0].ready(), true);
});

test('zero real adapters authenticate channel but never advertise or become execution-ready', async t => {
  const c = await channelFixture(t, { types: [], healthy: false });
  await c.executors[0].activate(); assert.equal(c.executors[0].ready(), false);
  assert.deepEqual(c.sockets[0].sent[0].readyCommandTypes, []); assert.equal(c.sockets[0].sent[0].durableStateHealthy, false);
});

test('stale generation or outer/nested proof mismatch cannot activate/enter engine; CHAT/result keep their own channel', async t => {
  const c = await channelFixture(t, { ackRegistration: false });
  const activating = c.executors[0].activate(); await c.opened();
  const socket = c.sockets[0]; const registration = socket.sent[0];
  const receipt = { type: 'agent_registered', messageId: registration.messageId, agentId: registration.agentId, runtimeInstanceId: registration.runtimeInstanceId,
    installationId: registration.installationId, hostId: registration.hostId, sessionGeneration: registration.sessionGeneration, status: 'online', durableStateHealthy: true, readyCommandTypes: registration.readyCommandTypes };
  socket.receive({ ...receipt, sessionGeneration: 6 }); await c.tick(); assert.equal(c.executors[0].ready(), false);
  socket.receive({ ...receipt, token: 'old-auth' }); await c.tick(); assert.equal(c.executors[0].ready(), false);
  socket.receive(receipt); await activating;
  socket.receive({ messageType: 'chat.message', sessionGeneration: 6 });
  socket.receive({ messageType: 'chat.message', tenantId: 'foreign', data: {} });
  socket.receive({ messageType: 'command.ack' });
  socket.receive({ type: 'agent_message_saved', turnId: 'chat-own-turn' });
  socket.receive({ messageType: 'work.result.receipt', commandId: 'result-own-command' });
  await c.tick(); assert.deepEqual(c.states()[0].accepted.map(frame => frame.messageType || frame.type), ['agent_message_saved','work.result.receipt']);
  assert.equal(c.states()[0].transport.send({ messageType: 'command.ack' }), false);
});

test('closing pending registration releases activation and only owned executor, no shutdown deadlock', async t => {
  const c = await channelFixture(t, { ackRegistration: false });
  const activating = assert.rejects(c.executors[0].activate(), code('RUNTIME_CHANNEL_STOPPED'));
  await c.tick(); await c.executors[0].close(); await activating;
  assert.equal(c.states()[0].closed, true); assert.equal(c.states()[1].closed, false);
});

test('policy revocation isolates one subject while peer channel remains ready', async t => {
  const c = await channelFixture(t); await Promise.all(c.executors.map(executor => executor.activate()));
  c.sockets[0].close(1008); await c.tick(); assert.deepEqual(c.executors.map(executor => executor.ready()), [false,true]);
});

test('unified SIGTERM while registration activation waits closes transports before host lifecycle gate', async t => {
  const { runUnifiedRuntime } = await import('../agent-runtime.mjs');
  const f = await fixture(t, { count: 2 }); const config = await f.config(); const controller = new AbortController();
  let entered; const began = new Promise(resolveBegan => { entered = resolveBegan; }); const states = [];
  const createAdapters = async () => {
    const adapter = { createExecutor: () => {
      const state = { closed: false, releaseActivation: null }; states.push(state);
      return { initialize: async () => {}, activate: () => { entered(); return new Promise(resolveActivation => { state.releaseActivation = resolveActivation; }); },
        ready: () => false, pause: async () => {}, close: async () => { state.closed = true; state.releaseActivation?.(); } };
    }, heartbeat: async () => assert.fail('must not heartbeat pending activation'), close: async () => { for (const state of states) { state.closed = true; state.releaseActivation?.(); } } };
    return adapter;
  };
  const running = runUnifiedRuntime({ config, apiOrigin: 'https://api.example.test', instanceId: 'boot-signal', signal: controller.signal, createAdapters });
  await began; controller.abort(); const snapshot = await running;
  assert.deepEqual(snapshot.agents.map(agent => agent.phase), ['STOPPED','STOPPED']); assert.ok(states.every(state => state.closed));
  assert.deepEqual(await readdir(config.stateRoot), []); assert.deepEqual(await Promise.all(config.agents.map(agent => readdir(agent.stateRoot))), [[],[]]);
});

test('unified runtime heartbeat stops after SIGTERM and does not create a second ACK authority', async t => {
  const { runUnifiedRuntime } = await import('../agent-runtime.mjs');
  const f = await fixture(t, { count: 1 }); const config = await f.config(); const controller = new AbortController(); let heartbeats = 0;
  const fake = executors();
  await runUnifiedRuntime({ config, apiOrigin: 'https://api.example.test', instanceId: 'boot-signal', signal: controller.signal,
    createAdapters: async () => ({ createExecutor: fake.createExecutor, heartbeat: async () => { heartbeats++; controller.abort(); }, close: async () => {} }) });
  assert.equal(heartbeats, 1); assert.deepEqual(await readdir(config.agents[0].stateRoot), []);
});
