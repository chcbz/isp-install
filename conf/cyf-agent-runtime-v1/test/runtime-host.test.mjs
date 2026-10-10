import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestManifest, readRuntimeHostConfig, runtimeSubjectKey } from '../lib/manifest.mjs';
import { acquireRuntimeOwnership, RuntimeHost } from '../lib/runtime-host.mjs';
import { collateExecutionPayload, createExecutionAdapterFactory, EXECUTION_PAYLOAD_FILES, RETIRED_EXECUTION_PAYLOAD_PATHS, validateExecutionPayload } from '../lib/execution-adapter.mjs';

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

test('unified library catalog closes actual engine imports without retired provisioning or host state', async t => {
  const f = await fixture(t, { count: 1 });
  for (const path of RETIRED_EXECUTION_PAYLOAD_PATHS) {
    assert.equal(EXECUTION_PAYLOAD_FILES.some(entry => entry === path || entry.startsWith(`${path}/`)), false, path);
  }
  const target = resolve(f.root, 'codex-ws-agent');
  const result = await collateExecutionPayload(engineSource, target);
  assert.equal(result.payloadCount, EXECUTION_PAYLOAD_FILES.length); assert.equal(result.dependenciesValidated, false);
  await assert.rejects(collateExecutionPayload(engineSource, target), cause => cause.code === 'EEXIST');
  const installed = await readdir(target); assert.equal(installed.includes('.env'), false); assert.equal(installed.includes('node_modules'), false);
  await writeFile(resolve(target, '.env'), 'foreign-secret');
  await assert.rejects(validateExecutionPayload(target, { dependencies: false, toolchain: false }), code('RUNTIME_PAYLOAD_PRIVATE_STATE_FORBIDDEN'));
});

test('unified library rejects reintroduced legacy auth/provisioning assets, symlinks and executable package entries', async t => {
  const f = await fixture(t, { count: 1 });
  const target = resolve(f.root, 'retirement-artifact'); await collateExecutionPayload(engineSource, target);
  for (const path of RETIRED_EXECUTION_PAYLOAD_PATHS) {
    const injected = resolve(target, path); await mkdir(dirname(injected), { recursive: true });
    await writeFile(injected, 'retired fixture, never executed');
    await assert.rejects(validateExecutionPayload(target, { dependencies: false, toolchain: false }), code('RUNTIME_PAYLOAD_LEGACY_ENTRY_FORBIDDEN'));
    await rm(injected);
  }
  await symlink(resolve(f.root, 'missing-broker'), resolve(target, 'managed-host.mjs'));
  await assert.rejects(validateExecutionPayload(target, { dependencies: false, toolchain: false }), code('RUNTIME_PAYLOAD_LEGACY_ENTRY_FORBIDDEN'));
  await rm(resolve(target, 'managed-host.mjs'));
  const path = resolve(target, 'package.json'); const original = JSON.parse(await readFile(path, 'utf8'));
  for (const entry of ['start', 'prestart', 'poststart', 'bin']) {
    const injected = structuredClone(original);
    if (entry === 'bin') injected.bin = { 'old-agent': './agent-client.mjs' };
    else injected.scripts[entry] = 'node agent-client.mjs';
    await writeFile(path, JSON.stringify(injected));
    await assert.rejects(validateExecutionPayload(target, { dependencies: false, toolchain: false }), code('RUNTIME_PAYLOAD_LEGACY_ENTRY_FORBIDDEN'));
  }
  await writeFile(path, JSON.stringify(original));
  assert.equal((await validateExecutionPayload(target, { dependencies: false, toolchain: false })).payloadCount, EXECUTION_PAYLOAD_FILES.length);
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

test('installer refuses existing targets, unavailable Node and unprepared parents before dependencies', async t => {
  const f = await fixture(t, { count: 1 });
  const installer = resolve(repo, 'conf/cyf-agent-runtime-v1/install.sh');
  const target = resolve(f.root, 'artifact'); await mkdir(target, { mode: 0o700 });
  await writeFile(resolve(target, 'foreign-marker'), 'untouched');
  assert.throws(() => execFileSync('bash', [installer, '--target', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /target exists/.test(cause.stderr));
  assert.equal(await readFile(resolve(target, 'foreign-marker'), 'utf8'), 'untouched');
  assert.throws(() => execFileSync('bash', [installer, '--target', resolve(f.root, 'unprepared/artifact')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /parent must exist/.test(cause.stderr));
  const wrongNode = resolve(f.root, 'missing-node');
  assert.throws(() => execFileSync('bash', [installer, '--target', resolve(f.root, 'new-artifact'), '--node', wrongNode], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cause => /Node\/npm\/Python toolchain unavailable/.test(cause.stderr));
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.cyf-agent-runtime.stage')), false);
});

test('dependency preparation failure never publishes or leaves its stage; does not invoke Python', async t => {
  const f = await fixture(t, { count: 1 });
  const installer = resolve(repo, 'conf/cyf-agent-runtime-v1/install.sh');
  const versionReadback = resolve(f.root, 'packaged-node-version.txt');
  const npm = resolve(f.root, 'fixture-npm.cjs');
  await writeFile(npm, `const fs = require('node:fs'); const path = require('node:path');
    fs.copyFileSync(path.resolve(process.cwd(), '../runtime/node-version.txt'), ${JSON.stringify(versionReadback)});
    process.exit(31);\n`, { mode: 0o700 });
  const python = resolve(f.root, 'fixture-python'); const marker = resolve(f.root, 'python-was-called');
  await writeFile(python, `#!/bin/sh\ntouch '${marker}'\nexit 32\n`, { mode: 0o700 });
  const target = resolve(f.root, 'artifact');
  assert.throws(() => execFileSync('bash', [installer, '--target', target, '--node', process.execPath, '--npm', npm, '--python', python], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }), cause => cause.status === 31 && cause.stdout.includes(`Runtime Node version: ${process.versions.node}`));
  assert.equal((await readFile(versionReadback, 'utf8')).trim(), process.versions.node);
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

// Exercise the validator's exact eval command with real collated source and an
// explicit copy of this worktree's existing JS dependencies, as above. No installer,
// npm/pip, Python/config/auth or service runs; this is NOT clean-target C1-C4 proof.
async function validatorImportFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'ur01-validator import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = resolve(root, 'artifact'); await mkdir(artifact);
  const engine = resolve(artifact, 'codex-ws-agent');
  await collateExecutionPayload(engineSource, engine);
  await cp(resolve(engineSource, 'node_modules'), resolve(engine, 'node_modules'), { recursive: true });
  await validateExecutionPayload(engine, { toolchain: false });
  const source = await readFile(resolve(repo, 'conf/cyf-agent-runtime-v1/validate.sh'), 'utf8');
  const start = source.indexOf('# The import must resolve from this artifact');
  const end = source.indexOf('if [ -n "$CONFIG" ]; then', start);
  assert.ok(start >= 0 && end > start, 'validator import command boundaries are present');
  const command = source.slice(start, end);
  const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH || '', NODE_BIN: process.execPath, PACKAGE_ROOT: artifact } };
  return { root, engine, options, run: () => execFileSync('bash', ['--noprofile', '--norc', '-c', command], options) };
}

test('validator artifact import loads the real engine without invoking its retired CLI', async t => {
  const f = await validatorImportFixture(t);
  const before = await readdir(f.root);
  assert.equal(f.run(), '');
  assert.deepEqual(await readdir(f.root), before);
  for (const name of ['.env', 'data', '.toolchain', 'codex-session-map.json']) {
    await assert.rejects(lstat(resolve(f.engine, name)), cause => cause.code === 'ENOENT');
  }
});

test('validator artifact import regression reproduces eval ambiguity and keeps direct engine CLI retired', async t => {
  const f = await validatorImportFixture(t);
  const entry = resolve(f.engine, 'agent-client.mjs');
  const originalEval = 'await import((await import("node:url")).pathToFileURL(process.argv[1]));';
  const denied = cause => cause.status === 1 && /legacy API-key execution is retired/.test(cause.stderr);
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', originalEval, entry], f.options), denied);
  for (const args of [[], ['--validate']]) {
    assert.throws(() => execFileSync(process.execPath, [entry, ...args], f.options), denied);
  }
});

test('validator artifact import fails closed for a missing local module or execution host export', async t => {
  const f = await validatorImportFixture(t);
  const dependency = resolve(f.engine, 'workspace-manager.mjs');
  const source = await readFile(dependency);
  await rm(dependency);
  assert.throws(f.run, cause => cause.status !== 0 && /ERR_MODULE_NOT_FOUND/.test(cause.stderr));
  await writeFile(dependency, source);
  await writeFile(resolve(f.engine, 'agent-client.mjs'), 'export const unrelated = true;\n');
  assert.throws(f.run, cause => cause.status !== 0 && /Runtime execution host export is missing/.test(cause.stderr));
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
  return { f, config, adapters, sockets, requests, executors, engines, states: () => [...engines.values()], nextOpened: () => new Promise(resolveOpen => socketEvents.once('opened', resolveOpen)), opened: () => sockets.some(socket => socket.readyState === 1) ? Promise.resolve() : new Promise(resolveOpen => socketEvents.once('opened', resolveOpen)), tick: () => new Promise(resolveTick => setImmediate(resolveTick)) };
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

test('CHAT-only registration rejects durable ACK disagreement even with empty command types', async t => {
  const c = await channelFixture(t, { ackRegistration: false, chatReady: true, types: [] });
  const activating = assert.rejects(c.executors[0].activate(), code('RUNTIME_REGISTRATION_READINESS_MISMATCH')); await c.opened();
  const registration = c.sockets[0].sent[0];
  c.sockets[0].receive({ type: 'agent_registered', messageId: registration.messageId, agentId: registration.agentId,
    runtimeInstanceId: registration.runtimeInstanceId, installationId: registration.installationId,
    hostId: registration.hostId, sessionGeneration: registration.sessionGeneration, status: 'online', durableStateHealthy: false, readyCommandTypes: [] });
  await activating; assert.equal(c.executors[0].ready(), false); assert.equal(c.executors[0].evidence(), null);
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
    }, heartbeat: async () => {}, close: async () => { for (const state of states) { state.closed = true; state.releaseActivation?.(); } } };
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


test('normal reconnect rotates only owned session; old socket, old generation and peer stop never reach cancel adapter', async t => {
  const c = await channelFixture(t); await Promise.all(c.executors.map(executor => executor.activate()))
  const old = c.sockets[0]; const nextOpened = c.nextOpened(); old.close()
  await c.tick(); assert.deepEqual(c.executors.map(executor => executor.ready()), [false, true])
  const stop = { messageType: 'chat.stop', requestId: 'request', turnId: 'turn', dispatchId: 'dispatch',
    targetAgentId: c.config.agents[0].manifest.canonicalAgentId, sessionGeneration: 7 }
  old.receive(stop); await c.tick(); assert.equal(c.states()[0].accepted.length, 0)
  const current = await nextOpened; await c.tick()
  assert.equal(current.headers['X-Agent-Session-Generation'], '8'); assert.deepEqual(c.executors.map(executor => executor.ready()), [true, true])
  current.receive(stop) // old-generation cancellation must remain harmless
  current.receive({ ...stop, sessionGeneration: 8, installationId: c.config.agents[1].manifest.installationId })
  old.receive({ ...stop, sessionGeneration: 8 })
  current.receive({ ...stop, sessionGeneration: 8 })
  await c.tick(); assert.equal(c.states()[0].accepted.length, 1); assert.equal(c.states()[0].accepted[0].sessionGeneration, 8)
  assert.equal(c.states()[1].accepted.length, 0)
  const proofs = c.requests.filter(row => row.url.endsWith('/session')); assert.equal(proofs.length, 3)
  assert.equal(c.sockets[1].headers['X-Agent-Session-Generation'], '7')
})

// r2: business product installation cannot collide with Runtime proof guards.
test('canonical skill product installation is data; wrong raw scope/Runtime-product confusion never reaches engine', async t => {
  const c = await channelFixture(t, { types: ['SKILL_INSTALL'] });
  await Promise.all(c.executors.map(executor => executor.activate()));
  const identity = c.config.agents[0].manifest;
  const raw = { schemaVersion: 1, messageType: 'command.dispatch', commandType: 'SKILL_INSTALL',
    tenantId: identity.tenantId, clientId: identity.clientId, targetAgentId: identity.canonicalAgentId,
    installationId: 'synthetic-product-installation', commandId: 'skill-command', messageId: 'skill-message',
    correlationId: 'task', taskId: 'task', expiresAt: 3601000, payload: { instruction: 'install original product' } };
  c.sockets[0].receive(raw); await c.tick();
  assert.deepEqual(c.states()[0].accepted, [raw]);
  for (const patch of [{ tenantId: 'foreign' }, { clientId: 'foreign' }, { targetAgentId: 'foreign' },
    { targetAgentId: undefined }, { installationId: identity.installationId }, { canonicalAgentId: 'foreign' }, { sessionGeneration: 6 }]) {
    c.sockets[0].receive({ ...raw, ...patch });
  }
  c.sockets[0].receive({ ...raw, commandType: 'WORK_ITEM_EXECUTE' }); // product field is not a Runtime proof
  await c.tick(); assert.deepEqual(c.states()[0].accepted, [raw]); assert.equal(c.states()[1].accepted.length, 0);
});

// Run only the install/validate stdlib snippets against hand-written launcher
// files. No installer, venv, npm, pip, dependency download or format library is
// run here. These regressions do NOT prove actual C1-C4 or Python ABI closure.
async function venvLauncherFixture(t, { longPath = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "ur01-launcher 'quote space-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = longPath ? resolve(root, 'nested-' + 'a'.repeat(110), 'nested-' + 'b'.repeat(110)) : root;
  const stage = resolve(parent, '.cyf-agent-runtime.stage.fixture');
  const target = resolve(parent, 'target "quote $value !');
  const relativeBin = 'codex-ws-agent/.toolchain/bin';
  const bin = resolve(stage, relativeBin); await mkdir(bin, { recursive: true });
  const metadata = resolve(stage, 'codex-ws-agent/.toolchain/lib/python3.6/site-packages/fixture.dist-info');
  await mkdir(metadata, { recursive: true });
  await writeFile(resolve(stage, 'codex-ws-agent/.toolchain/pyvenv.cfg'), 'home = /explicit-test-base\n');
  for (const name of ['python', 'platform-python3.6']) {
    // Synthetic interpreter forwarder, explicitly not an installed --copies venv.
    await writeFile(resolve(bin, name), '#!/bin/sh\nexec /usr/bin/python3 "$@"\n', { mode: 0o755 });
  }
  const body = 'import json, sys\nprint(json.dumps({"file": __file__, "args": sys.argv[1:]}))\n';
  const scripts = ['pip', 'easy_install', 'vba_extract.py', 'distlib-pip'];
  for (const name of scripts) {
    const interpreter = resolve(bin, name === 'easy_install' ? 'platform-python3.6' : 'python');
    const header = name === 'distlib-pip'
      ? `#!/bin/sh\n'''exec' "${interpreter}" "$0" "$@"\n' '''\n`
      : `#!${interpreter}\n`;
    await writeFile(resolve(bin, name), header + body, { mode: 0o755 });
  }
  const venv = resolve(stage, 'codex-ws-agent/.toolchain');
  await writeFile(resolve(bin, 'activate'), `VIRTUAL_ENV="${venv}"\nexport VIRTUAL_ENV\n`);
  await writeFile(resolve(bin, 'activate.csh'), `setenv VIRTUAL_ENV "${venv}"\n`);
  await writeFile(resolve(bin, 'activate.fish'), `set -gx VIRTUAL_ENV "${venv}"\n`);
  await writeFile(resolve(metadata, 'RECORD'), scripts.map(name => `../../../bin/${name},sha256=old,1\n`).join('') + 'untouched.py,sha256=unchanged,7\n');
  const script = async (path, marker) => {
    const source = await readFile(resolve(repo, path), 'utf8');
    const start = source.indexOf(`<<'${marker}'\n`); const end = source.indexOf(`\n${marker}\n`, start);
    assert.ok(start >= 0 && end > start, 'exact production snippet remains available');
    return source.slice(start + marker.length + 5, end);
  };
  const relocate = await script('conf/cyf-agent-runtime-v1/install.sh', 'PY_RUNTIME_RELOCATE');
  const validate = await script('conf/cyf-agent-runtime-v1/validate.sh', 'PY_RUNTIME_LAUNCHER_VALIDATE');
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } };
  const python = (source, args) => execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', source, ...args], options);
  return { root, stage, target, bin, body, scripts, relativeBin, metadata, options, relocate, validate,
    prepare: () => python(relocate, [stage, target]), check: path => python(validate, [path]), python };
}

test('venv generated launchers preserve direct CLI, argv, modes and RECORD integrity across stage deletion', async t => {
  const f = await venvLauncherFixture(t);
  assert.throws(() => f.check(f.stage), cause => /VENV_STALE_STAGE_LAUNCHER_OR_ACTIVATION/.test(cause.stderr));
  f.prepare(); f.check(f.stage);
  const args = ['space argument', "apostrophe'", '$not-expanded'];
  const run = path => JSON.parse(execFileSync(path, args, f.options));
  for (const name of f.scripts) {
    const path = resolve(f.bin, name);
    assert.deepEqual(run(path), { file: path, args });
    assert.equal((await lstat(path)).mode & 0o777, 0o755);
    const text = await readFile(path, 'utf8');
    assert.equal(text.includes(f.stage), false); assert.ok(text.endsWith(f.body));
  }
  const recordBefore = await readFile(resolve(f.metadata, 'RECORD'), 'utf8');
  assert.match(recordBefore, /untouched\.py,sha256=unchanged,7/);
  const verifyRecord = `import base64, csv, hashlib, os, sys
venv = os.path.join(sys.argv[1], 'codex-ws-agent', '.toolchain')
site = os.path.join(venv, 'lib', 'python3.6', 'site-packages')
with open(os.path.join(site, 'fixture.dist-info', 'RECORD'), newline='') as stream:
    for row in csv.reader(stream):
        if row[0] == 'untouched.py': continue
        with open(os.path.normpath(os.path.join(site, row[0])), 'rb') as file: data = file.read()
        assert row[1] == 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
        assert int(row[2]) == len(data)
`;
  f.python(verifyRecord, [f.stage]);
  await rename(f.stage, f.target);
  await assert.rejects(lstat(f.stage), cause => cause.code === 'ENOENT');
  f.check(f.target); f.python(verifyRecord, [f.target]);
  for (const name of f.scripts) {
    const path = resolve(f.target, f.relativeBin, name);
    assert.deepEqual(run(path), { file: path, args });
  }
  const activation = resolve(f.target, f.relativeBin, 'activate');
  const activated = execFileSync('bash', ['--noprofile', '--norc', '-c', '. "$1"; printf "%s" "$VIRTUAL_ENV"', 'activation-test', activation], f.options);
  assert.equal(activated, resolve(f.target, 'codex-ws-agent/.toolchain'));
  for (const name of ['activate', 'activate.csh', 'activate.fish']) {
    assert.equal((await readFile(resolve(f.target, f.relativeBin, name), 'utf8')).includes(f.stage), false);
  }
  assert.equal(await readFile(resolve(f.target, 'codex-ws-agent/.toolchain/lib/python3.6/site-packages/fixture.dist-info/RECORD'), 'utf8'), recordBefore);
});

test('venv publication fails closed for unknown stage references, launcher bodies and stale links', async t => {
  for (const kind of ['unknown', 'body', 'link', 'activation']) {
    const f = await venvLauncherFixture(t);
    if (kind === 'unknown') await writeFile(resolve(f.bin, 'unknown-cli'), `#!/bin/sh\necho '${f.stage}'\n`, { mode: 0o755 });
    if (kind === 'body') await writeFile(resolve(f.bin, 'pip'), `#!${f.bin}/python\nprint(${JSON.stringify(f.stage)})\n`, { mode: 0o755 });
    if (kind === 'link') await symlink(resolve(f.bin, 'python'), resolve(f.bin, 'stale-link'));
    if (kind === 'activation') await writeFile(resolve(f.bin, 'activate'), `# unknown format ${f.stage}\n`);
    assert.throws(() => f.prepare(), cause => /VENV_(?:TRAMPOLINE_NOT_RECOGNIZED|STAGE_REFERENCE_NOT_RECOGNIZED|LAUNCHER_BODY_CONTAINS_STAGE_REFERENCE|STAGE_SYMLINK_NOT_RELOCATABLE|ACTIVATION_NOT_RELOCATABLE)/.test(cause.stderr));
    await assert.rejects(lstat(f.target), cause => cause.code === 'ENOENT');
  }
});

test('venv validator rejects stale shell trampolines and activation even when imports could pass', async t => {
  for (const kind of ['trampoline', 'activation', 'link', 'config']) {
    const f = await venvLauncherFixture(t); f.prepare();
    if (kind === 'trampoline') await writeFile(resolve(f.bin, 'pip'), `#!/bin/sh\n'''exec' "${f.bin}/python" "$0" "$@"\n' '''\n${f.body}`);
    if (kind === 'activation') await writeFile(resolve(f.bin, 'activate'), `VIRTUAL_ENV="${f.stage}/codex-ws-agent/.toolchain"\n`);
    if (kind === 'link') await symlink(resolve(f.bin, 'python'), resolve(f.bin, 'bad-link'));
    if (kind === 'config') await writeFile(resolve(f.stage, 'codex-ws-agent/.toolchain/pyvenv.cfg'), `home = ${f.stage}\n`);
    assert.throws(() => f.check(f.stage), cause => /VENV_STALE_STAGE_(?:LAUNCHER_OR_ACTIVATION|SYMLINK)/.test(cause.stderr));
  }
});

// Python 3.11 command is an audit string, not a shell command. These are
// hand-written cfg files plus ORIGINAL stdlib snippets: never a real venv,
// package install, import/ABI, C1-C4 or old failed cfg-byte readback.
const cfgPosixQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const cfgBaseFields = 'home = /explicit-test-base\ninclude-system-site-packages = false\nversion = 3.11.13\nexecutable = /explicit-test-base/python3.11\nprompt = unchanged synthetic audit\n';

test('Python 3.11 cfg command audit maps only its exact venv operand preserving every base field, quotes, modes and stage-to-target bytes', async t => {
  for (const quoted of [false, true]) for (const withoutPip of [false, true]) {
    const f = await venvLauncherFixture(t, { longPath: true });
    const cfg = resolve(f.stage, 'codex-ws-agent/.toolchain/pyvenv.cfg');
    const beforeVenv = resolve(f.stage, 'codex-ws-agent/.toolchain');
    const finalVenv = resolve(f.target, 'codex-ws-agent/.toolchain');
    assert.ok(beforeVenv.length > 256, 'exercise a genuine long synthetic path, not a fake version probe');
    const prefix = '/explicit-test-base/python3.11 -m venv --copies' + (withoutPip ? ' --without-pip' : '') + ' ';
    const quote = quoted ? cfgPosixQuote : value => value;
    const base = withoutPip ? cfgBaseFields.replaceAll('\n', '\r\n') : cfgBaseFields;
    const newline = withoutPip ? '' : '\n'; // also preserve an absent final newline
    const before = base + 'command = ' + prefix + quote(beforeVenv) + newline;
    const expected = base + 'command = ' + prefix + quote(finalVenv) + newline;
    await writeFile(cfg, before); await chmod(cfg, 0o640);
    assert.throws(() => f.check(f.stage), cause => /VENV_STALE_STAGE_LAUNCHER_OR_ACTIVATION/.test(cause.stderr));
    f.prepare(); f.check(f.stage);
    assert.equal(await readFile(cfg, 'utf8'), expected);
    assert.equal((await lstat(cfg)).mode & 0o777, 0o640);
    assert.equal((await readFile(cfg, 'utf8')).includes('.cyf-agent-runtime.stage.'), false);
    const record = await readFile(resolve(f.metadata, 'RECORD'), 'utf8');
    await rename(f.stage, f.target);
    await assert.rejects(lstat(f.stage), cause => cause.code === 'ENOENT');
    f.check(f.target);
    const finalCfg = resolve(f.target, 'codex-ws-agent/.toolchain/pyvenv.cfg');
    assert.equal(await readFile(finalCfg, 'utf8'), expected);
    assert.equal((await lstat(finalCfg)).mode & 0o777, 0o640);
    assert.equal(await readFile(resolve(f.target, 'codex-ws-agent/.toolchain/lib/python3.6/site-packages/fixture.dist-info/RECORD'), 'utf8'), record);
    const pip = resolve(f.target, f.relativeBin, 'pip');
    assert.deepEqual(JSON.parse(execFileSync(pip, ['synthetic cfg path', '$not-expanded'], f.options)),
      { file: pip, args: ['synthetic cfg path', '$not-expanded'] });
  }
});

test('Python 3.11 cfg relocation rejects unknown command, stale home/base/body/foreign stage and duplicate fields without deleting audit metadata', async t => {
  for (const kind of ['extra-option', 'wrong-module', 'wrong-operand', 'extra-tail', 'foreign-stage',
    'duplicate-command', 'stale-home', 'stale-base', 'unknown-field', 'missing-command', 'cfg-symlink']) {
    const f = await venvLauncherFixture(t);
    const venv = resolve(f.stage, 'codex-ws-agent/.toolchain');
    const cfg = resolve(venv, 'pyvenv.cfg');
    const command = `command = /explicit-test-base/python3.11 -m venv --copies ${venv}\n`;
    let text = cfgBaseFields + command;
    if (kind === 'extra-option') text = cfgBaseFields + command.replace('--copies ', '--copies --system-site-packages ');
    if (kind === 'wrong-module') text = cfgBaseFields + command.replace('-m venv', '-m unrelated');
    if (kind === 'wrong-operand') text = cfgBaseFields + command.replace(`${venv}\n`, `${venv}-not-the-venv\n`);
    if (kind === 'extra-tail') text = cfgBaseFields + command.trimEnd() + ' extra-operand\n';
    if (kind === 'foreign-stage') text = cfgBaseFields + command.replace(venv, '/tmp/.cyf-agent-runtime.stage.foreign/codex-ws-agent/.toolchain');
    if (kind === 'duplicate-command') text += command;
    if (kind === 'stale-home') text = text.replace('/explicit-test-base\n', `${f.stage}\n`);
    if (kind === 'stale-base') text = cfgBaseFields + command.replace('/explicit-test-base/python3.11', resolve(f.stage, 'untrusted-base/python3.11'));
    if (kind === 'unknown-field') text += `unknown-audit = ${f.stage}\n`;
    if (kind === 'missing-command') text = cfgBaseFields + `unknown-audit = ${f.stage}\n`;
    await writeFile(cfg, text);
    let external;
    if (kind === 'cfg-symlink') {
      external = resolve(f.root, 'external-synthetic-cfg'); await writeFile(external, text);
      await rm(cfg); await symlink(external, cfg);
    }
    assert.throws(() => f.prepare(), cause => /VENV_CONFIG_(?:UNSAFE|COMMAND_NOT_RECOGNIZED|BASE_CONTAINS_STAGE|STAGE_REFERENCE_NOT_RECOGNIZED)/.test(cause.stderr));
    assert.equal(await readFile(cfg, 'utf8'), text, 'do not delete/reconstruct/partially rewrite unrecognized cfg');
    if (external) assert.equal(await readFile(external, 'utf8'), text, 'never follow cfg symlink for writes');
    assert.ok((await readFile(resolve(f.bin, 'pip'), 'utf8')).startsWith(`#!${f.bin}/python\n`), 'bad cfg fails before launcher mutation');
    await assert.rejects(lstat(f.target), cause => cause.code === 'ENOENT');
  }
});

test('Python 3.11 cfg command remains subject to the ORIGINAL strict stale validator after successful preparation', async t => {
  const f = await venvLauncherFixture(t); const cfg = resolve(f.stage, 'codex-ws-agent/.toolchain/pyvenv.cfg');
  const venv = resolve(f.stage, 'codex-ws-agent/.toolchain');
  await writeFile(cfg, cfgBaseFields + `command = /explicit-test-base/python3.11 -m venv --copies ${venv}\n`);
  f.prepare(); f.check(f.stage);
  await writeFile(cfg, cfgBaseFields + `command = /explicit-test-base/python3.11 -m venv --copies ${venv}\n`);
  assert.throws(() => f.check(f.stage), cause => /VENV_STALE_STAGE_LAUNCHER_OR_ACTIVATION/.test(cause.stderr));
  await writeFile(cfg, cfgBaseFields + `unknown-audit = /tmp/.cyf-agent-runtime.stage.foreign\n`);
  assert.throws(() => f.check(f.stage), cause => /VENV_STALE_STAGE_LAUNCHER_OR_ACTIVATION/.test(cause.stderr));
});

test('PPTX semantic reopen reconstructs original producer wrapping and rejects lost/reordered/extra text', async () => {
  const { REOPEN } = await import('./clean-target-install.acceptance.mjs');
  // Only original stdlib wrapping and the exact assertion predicate are run;
  // no fake presentation, dependency import or actual C4 pass is manufactured.
  const check = `import ast, runpy, sys
helper = runpy.run_path(sys.argv[1], run_name='ur01_stdlib_only')
tree = ast.parse(sys.argv[2])
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'pptx_text_matches')
namespace = {}
exec(compile(ast.Module(body=[function]), '<actual-harness-pptx-predicate>', 'exec'), namespace)
match = namespace['pptx_text_matches']
instruction = 'UR01 synthetic clean-install acceptance material'
lines = helper['wrapped'](instruction, 40)[:10]
text = '\\n'.join(lines)
assert len(instruction) == 48 and len(lines) == 2
assert instruction not in text, 'must reproduce original false negative'
assert match(text, instruction)
assert not match(text[:-1], instruction), 'lost character must fail'
assert not match(' '.join(instruction.split()[:-1]), instruction), 'lost word must fail'
assert not match(' '.join(reversed(instruction.split())), instruction), 'reordered words must fail'
assert not match(text + ' extra', instruction), 'extra content must fail'
assert not match('Agent 交付演示', instruction), 'title alone must fail'
print('PPTX stdlib predicate regression: 8 assertions PASS; real reopen NOT_RUN')
`;
  const output = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', check, resolve(engineSource, 'toolchain/delivery_tool.py'), REOPEN], { encoding: 'utf8' });
  assert.match(output, /8 assertions PASS; real reopen NOT_RUN/);
});

// Consumer units use the exact FIXED SOURCE as static git blobs, and a
// hand-written SYNTHETIC target. No installer, Node/Python dependency install,
// Runtime execution, Java/HTTP/DB/UR04 or C1-C4 acceptance is run locally.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function consumerFixture(t) {
  const module = await import('./clean-target-install.acceptance.mjs');
  const owner = await mkdtemp(resolve(tmpdir(), 'ur01-consumer-unit-'));
  t.after(() => rm(owner, { recursive: true, force: true }));
  const root = resolve(owner, 'exclusive-root'); await mkdir(root, { mode: 0o700 });
  const archive = resolve(root, 'static-fixed-source.tar'); const archiveFd = await open(archive, 'wx', 0o600);
  try { execFileSync('git', ['archive', '--format=tar', module.SOURCE.commit], { cwd: repo, stdio: ['ignore', archiveFd.fd, 'pipe'] }); }
  finally { await archiveFd.close(); }
  const sourceRoot = resolve(root, 'source');
  // Original stdlib-only extractor is a static source test, not an installation.
  execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', module.EXTRACT, archive, sourceRoot, module.SOURCE.commit], { stdio: 'pipe' });
  const { tree, files } = await module.sourceInventory(sourceRoot);
  assert.equal(tree, module.SOURCE.tree); assert.equal(files.length, 285);
  const target = resolve(root, 'parent/target'); await mkdir(target, { recursive: true, mode: 0o700 });
  // Derive the exact frozen runtime list rather than another installer catalog.
  const harnessSource = await readFile(resolve(repo, 'conf/cyf-agent-runtime-v1/test/clean-target-install.acceptance.mjs'), 'utf8');
  const runtimeList = [...harnessSource.match(/const RUNTIME_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const installInputs = [...runtimeList.map(path => `conf/cyf-agent-runtime-v1/${path}`), ...EXECUTION_PAYLOAD_FILES.map(path => `conf/codex-ws-agent/${path}`)];
  for (const input of installInputs) {
    const relative = input.startsWith('conf/cyf-agent-runtime-v1/') ? input.replace('conf/cyf-agent-runtime-v1/', 'runtime/') : input.slice('conf/'.length);
    const path = resolve(target, relative); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readFile(resolve(sourceRoot, input)), { mode: 0o644 });
  }
  await mkdir(resolve(target, 'node/bin'), { recursive: true });
  // Deliberately NOT a working Node binary; never execute it or call this a
  // proven installation. The narrow hook unit tests real identity/hash checks.
  const nodeBin = resolve(target, 'node/bin/node'); await writeFile(nodeBin, 'SYNTHETIC consumer unit: not Node\n', { mode: 0o700 });
  await mkdir(resolve(target, 'codex-ws-agent/node_modules/synthetic-only'), { recursive: true });
  const dependency = resolve(target, 'codex-ws-agent/node_modules/synthetic-only/payload'); await writeFile(dependency, 'SYNTHETIC dependency; not installed\n');
  await symlink('node_modules', resolve(target, 'codex-ws-agent/synthetic-internal-link'));
  const hash = async path => sha256(await readFile(path));
  const archiveSha = await hash(archive), nodeSha = await hash(nodeBin);
  assert.equal(archiveSha, '9b5d74b27a91579359ad0a18d241f66f19d6df13d376e3cff5dbd45b729b7687');
  assert.equal((await lstat(archive)).size, 3635200);
  const stat = await lstat(root), targetStat = await lstat(target);
  const receipt = { ...module.localFixtureReceipt({ BUILD_ID: 'SYNTHETIC-HOOK-LOCAL-UNIT-NOT-INSTALL', SOURCE_ARCHIVE: archive, SOURCE_SHA256: archiveSha }, sha256(harnessSource)),
    source: { ...module.SOURCE, readbackTree: tree, finalReadbackTree: tree, members: files, installInputs,
      archive: { sha256: archiveSha, expectedSha256: archiveSha, finalSha256: archiveSha } },
    harness: { sha256: sha256(harnessSource) },
    // These are synthetic prerequisite states, NOT executions of the four lanes.
    acceptance: Object.fromEntries(['C1', 'C2', 'C3', 'C4'].map(key => [key, { status: 'PASS' }])),
    publication: { target, stageAbsent: true, installerSourceUnchanged: true }, targetPublished: true,
    node: { sha256: nodeSha }, toolchain: { node: { sha256: nodeSha } },
    privateSecret: 'unit-secret-never-in-snapshot', result: 'PASS' };
  const context = { receipt, input: { SOURCE_ARCHIVE: archive, SOURCE_SHA256: archiveSha }, sourceRoot, root,
    identity: { dev: stat.dev, ino: stat.ino }, target, targetIdentity: { dev: targetStat.dev, ino: targetStat.ino } };
  return { module, owner, context, root, target, archive, nodeBin, dependency, sourceRoot, hash, receipt, harnessSource };
}

// Execute the exact existing final-source/consumer/catch/finally source slice,
// supplying only real filesystem/hash/sourceInventory functions. The earlier
// installation/dependency/C phases are intentionally NOT executed or mocked.
async function consumerTail(f, consumeArtifact) {
  const start = f.harnessSource.indexOf("    current = 'final-source-readback';");
  const end = f.harnessSource.indexOf('\nexport function describe()', start);
  assert.ok(start >= 0 && end > start);
  const slice = f.harnessSource.slice(start, end).trimEnd();
  assert.ok(slice.endsWith('}'));
  const receiptPath = resolve(f.owner, 'synthetic-receipt.json');
  const receiptFd = await open(receiptPath, 'wx', 0o600);
  const context = { ...f.context, input: { ...f.context.input, RECEIPT: receiptPath },
    consumer: f.module.createArtifactConsumer(consumeArtifact), consumeArtifact, receiptFd };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runTail = new AsyncFunction('context', 'sourceInventory', 'hashFile', 'lstat', 'realpath', 'rm', 'fail', 'console', `
    const { receipt, input, sourceRoot, root, identity, target, targetIdentity, consumer, consumeArtifact, receiptFd } = context;
    let current = 'synthetic-unit-tail'; const evidenceOwned = false; const evidence = undefined;
    try {
    ${slice.slice(0, -1)}
  `);
  const exit = await runTail(context, f.module.sourceInventory, f.hash, lstat, realpath, rm,
    code => Object.assign(new Error(code), { code }), { log() {} });
  await assert.rejects(lstat(f.root), cause => cause.code === 'ENOENT');
  return { exit, receipt: JSON.parse(await readFile(receiptPath, 'utf8')) };
}

test('current delivery dependency candidate keeps six exact pins and one fixed payload source', async () => {
  const { SOURCE } = await import('./clean-target-install.acceptance.mjs');
  assert.deepEqual(SOURCE, { commit: '5666fd2c990e4577cd4e16d5a32924ea0f3a8b7b',
    tree: 'd3cdc69da62bddc48af0bc86b4f32dbfa9429b60', files: 285 });
  const requirements = await readFile(resolve(engineSource, 'toolchain/requirements.txt'), 'utf8');
  assert.deepEqual(requirements.split(/\r?\n/).filter(line => line && !line.startsWith('#')), [
    'python-docx==0.8.11', 'python-pptx==0.6.23', 'openpyxl==3.1.3',
    'Pillow==10.4.0', 'PyPDF2==1.28.6', 'reportlab==3.6.13'
  ]);
  assert.match(requirements, /Python 3\.11\.13.*not yet accepted/);
  // Source/pin assertions only; no install, wheel import, format or ABI PASS.
});

test('local fixture identity and origin schema reject retired inputs before any acceptance IO', async t => {
  const { acceptance, parseInputs, origin, describe, invocationMode, localFixtureReceipt, SOURCE } = await import('./clean-target-install.acceptance.mjs');
  const root = await mkdtemp(resolve(tmpdir(), 'ur01-local-schema-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(['SOURCE_ARCHIVE', 'NODE', 'NPM_CLI', 'PYTHON', 'BASH', 'TOOLCHAIN_PROVENANCE', 'PARENT', 'RECEIPT'].map(key => [`CYF_CLEAN_INSTALL_${key}`, resolve(root, key.toLowerCase())]));
  Object.assign(env, { CYF_CLEAN_INSTALL: '1', CYF_CLEAN_INSTALL_BUILD_ID: 'SYNTHETIC-local-schema-NOT-INSTALL', CYF_CLEAN_INSTALL_SOURCE_SHA256: 'a'.repeat(64), CYF_CLEAN_INSTALL_PATH: '/usr/bin:/bin' });
  const input = parseInputs(env);
  assert.equal(input.BUILD_ID, env.CYF_CLEAN_INSTALL_BUILD_ID);
  assert.equal(Object.hasOwn(input, 'CLOUD_RUN'), false);
  const receipt = localFixtureReceipt(input, 'b'.repeat(64));
  assert.equal(receipt.format, 'ur01-clean-target-local-fixture-v1');
  assert.equal(receipt.buildId, input.BUILD_ID); assert.equal(receipt.localBackendFixtureOnly, true);
  assert.equal(Object.hasOwn(receipt, 'cloudRun'), false); assert.equal(Object.hasOwn(receipt.scope, 'cloudOnlyOptIn'), false);
  assert.deepEqual(receipt.source.commit, SOURCE.commit); assert.deepEqual(receipt.source.tree, SOURCE.tree);
  assert.equal(Object.values(receipt.acceptance).every(check => check.status === 'NOT_RUN'), true);
  assert.equal(receipt.result, 'FAIL'); // schema construction is never acceptance proof
  for (const legacyOnly of [false, true]) {
    const legacy = { ...env, CYF_CLEAN_INSTALL_CLOUD_RUN: 'retired-input' };
    if (legacyOnly) delete legacy.CYF_CLEAN_INSTALL_BUILD_ID;
    assert.throws(() => parseInputs(legacy), code('INPUT_LEGACY_RUN_FORBIDDEN'));
    await assert.rejects(acceptance(legacy), code('INPUT_LEGACY_RUN_FORBIDDEN'));
    assert.deepEqual(await readdir(root), []);
  }
  for (const value of [undefined, 42, true, 'build with spaces', 'build\nsecret']) {
    const invalid = { ...env, CYF_CLEAN_INSTALL_BUILD_ID: value };
    assert.throws(() => parseInputs(invalid), code(value === undefined ? 'INPUT_REQUIRED_BUILD_ID' : 'INPUT_BUILD_ID_INVALID'));
    await assert.rejects(acceptance(invalid), code(value === undefined ? 'INPUT_REQUIRED_BUILD_ID' : 'INPUT_BUILD_ID_INVALID'));
    assert.deepEqual(await readdir(root), []);
  }
  for (const value of ['local-host:/usr/bin/python3', 'fixed-input:node20.20.2/sha256-abc', 'https://public.example/tool']) assert.equal(origin(value), value);
  for (const value of ['flow-input:node', 'system-image:python', 'http://public.example/tool', 'https://user:secret@public.example/tool', 'https://public.example/tool?token=x', 'fixed-input:secret?token=x', 'local-host:', 'fixed-input:', undefined]) assert.throws(() => origin(value));
  const description = describe();
  assert.equal(description.format, 'ur01-clean-target-local-fixture-input-v1');
  assert.equal(description.requiredEnvironment.includes('CYF_CLEAN_INSTALL_BUILD_ID'), true);
  assert.equal(JSON.stringify(description).includes('cloudRun'), false);
  assert.equal(JSON.stringify(description).includes('flow-input'), false);
  assert.equal(description.consumer.snapshotFormat, 'ur01-accepted-local-target-v1');
  assert.equal(invocationMode([], {}), 'local-fixture');
  assert.equal(invocationMode([], { NODE_TEST_CONTEXT: 'child' }), 'node-test-not-acceptance');
});

test('artifact consumer callback type rejection precedes every acceptance side effect', async t => {
  const { acceptance } = await import('./clean-target-install.acceptance.mjs');
  const root = await mkdtemp(resolve(tmpdir(), 'ur01-consumer-type-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CYF_CLEAN_INSTALL: '1', CYF_CLEAN_INSTALL_RECEIPT: resolve(root, 'never-created') };
  for (const consumeArtifact of [null, false, 1, 'module/path', {}, []]) {
    await assert.rejects(acceptance(env, { consumeArtifact }), code('CONSUMER_CALLBACK_INVALID'));
    assert.deepEqual(await readdir(root), []);
  }
  await assert.rejects(acceptance({ CYF_CLEAN_INSTALL_CONSUMER: 'must-not-load-or-exec' }), code('LOCAL_FIXTURE_OPT_IN_REQUIRED'));
  assert.deepEqual(await readdir(root), []);
});

test('artifact consumer all-checks gate makes zero callback calls and original tail still cleans', async t => {
  const f = await consumerFixture(t); let calls = 0;
  const consumer = f.module.createArtifactConsumer(() => { calls++; return { status: 'PASS' }; });
  for (const key of ['C1', 'C2', 'C3', 'C4']) for (const status of ['FAIL', 'NOT_RUN']) {
    f.receipt.acceptance[key].status = status;
    const attempt = f.module.createArtifactConsumer(() => { calls++; return { status: 'PASS' }; });
    assert.equal(await attempt(f.context), false); assert.equal(f.receipt.consumer.calls, 0);
    assert.equal(f.receipt.consumer.status, 'NOT_RUN'); assert.equal(f.receipt.consumer.code, 'CONSUMER_INSTALL_NOT_ACCEPTED');
    f.receipt.acceptance[key].status = 'PASS';
  }
  f.receipt.acceptance.C4.status = 'NOT_RUN';
  assert.equal(calls, 0); assert.equal(await consumer(f.context), false);
  await assert.rejects(consumer(f.context), code('CONSUMER_ALREADY_INVOKED'));
  const tail = await consumerTail(f, () => { calls++; return { status: 'PASS' }; });
  assert.equal(tail.exit, 1); assert.equal(calls, 0); assert.equal(tail.receipt.acceptance.C4.status, 'NOT_RUN');
  assert.equal(tail.receipt.cleanup.removed, true);
});

test('artifact consumer deep-freezes exact ordered projection and one-shot await preserves borrowed target', async t => {
  const f = await consumerFixture(t); let entered; let finish;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { finish = resolve; }); let calls = 0;
  const callback = async projection => {
    calls++; assert.equal(await realpath(projection.target), f.target);
    assert.deepEqual(Object.keys(projection), ['format', 'buildId', 'target', 'nodeBin', 'nodeSha256', 'source', 'harnessSha256', 'checks', 'acceptedSnapshotSha256']);
    assert.equal(projection.format, 'ur01-accepted-local-target-v1');
    assert.equal(projection.buildId, f.receipt.buildId);
    assert.equal(Object.hasOwn(projection, 'cloudRun'), false);
    assert.deepEqual(Object.keys(projection.source), ['commit', 'tree', 'files', 'archiveSha256', 'finalReadbackTree']);
    assert.deepEqual(Object.keys(projection.checks), ['C1', 'C2', 'C3', 'C4']);
    for (const value of [projection, projection.source, projection.checks]) assert.equal(Object.isFrozen(value), true);
    const { acceptedSnapshotSha256, ...ordered } = projection;
    assert.equal(acceptedSnapshotSha256, sha256(JSON.stringify(ordered)));
    assert.equal(JSON.stringify(projection).includes('unit-secret-never-in-snapshot'), false);
    assert.throws(() => { projection.source.commit = 'tamper'; }, TypeError);
    assert.throws(() => { projection.checks.C1 = 'FAIL'; }, TypeError);
    entered(); await wait;
    assert.equal(await realpath(projection.target), f.target);
    await writeFile(resolve(projection.target, 'ur04-clean-artifact.json'), '{"syntheticUnitOnly":true}\n', { mode: 0o600 });
    return { status: 'PASS' };
  };
  const tailPromise = consumerTail(f, callback);
  await Promise.race([enteredPromise, tailPromise.then(() => { throw new Error('consumer tail finished without entering awaited callback'); })]);
  assert.equal(await realpath(f.root), f.root); assert.equal(calls, 1);
  finish(); const tail = await tailPromise;
  assert.equal(tail.exit, 0); assert.equal(tail.receipt.consumer.status, 'PASS');
  assert.equal(tail.receipt.consumer.calls, 1); assert.equal(tail.receipt.consumer.integrityReadback, 'PASS');
  assert.equal(tail.receipt.cleanup.removed, true); assert.equal(tail.receipt.result, 'PASS');
  // Separate factory instance explicitly exercises repeat rejection on a live
  // synthetic target, not a background task after the finally cleanup above.
  const g = await consumerFixture(t); const once = g.module.createArtifactConsumer(() => ({ status: 'PASS' }));
  assert.equal(await once(g.context), true); await assert.rejects(once(g.context), code('CONSUMER_ALREADY_INVOKED'));
});

test('artifact consumer invalid/throwing/explicit failure results preserve C gates and cleanup without leaking errors', async t => {
  const cases = [
    [() => { throw Object.assign(new Error('secret exception payload'), { code: 'secret arbitrary code' }); }, 'CONSUMER_CALLBACK_THREW'],
    [() => undefined, 'CONSUMER_RESULT_INVALID'],
    [() => ({ status: 'PASS', token: 'unit-secret-never-in-snapshot' }), 'CONSUMER_RESULT_INVALID'],
    [() => ({ status: 'FAIL', code: 'secret arbitrary code' }), 'CONSUMER_RESULT_INVALID'],
    [() => ({ status: 'FAIL', code: 'CONSUMER_TEST_FAILED' }), 'CONSUMER_TEST_FAILED'],
    [() => Object.defineProperty({}, 'status', { get() { throw new Error('secret getter'); } }), 'CONSUMER_RESULT_INVALID']
  ];
  for (const [callback, expected] of cases) {
    const f = await consumerFixture(t); const tail = await consumerTail(f, callback);
    assert.equal(tail.exit, 1); assert.equal(tail.receipt.consumer.status, 'FAIL');
    assert.equal(tail.receipt.consumer.code, expected); assert.equal(tail.receipt.consumer.calls, 1);
    assert.equal(tail.receipt.cleanup.removed, true); assert.equal(tail.receipt.result, 'FAIL');
    assert.deepEqual(tail.receipt.acceptance, Object.fromEntries(['C1', 'C2', 'C3', 'C4'].map(key => [key, { status: 'PASS' }])));
    assert.equal(JSON.stringify(tail.receipt.consumer).includes('secret'), false);
  }
});

test('artifact consumer pre-gates reject changed fixed source, archive, target identity, Node and original payload', async t => {
  const cases = [
    ['source', 'CONSUMER_SOURCE_CHANGED'], ['archive', 'CONSUMER_SOURCE_CHANGED'],
    ['target', 'CONSUMER_TARGET_IDENTITY_CHANGED'], ['node', 'CONSUMER_NODE_CHANGED'], ['payload', 'CONSUMER_PAYLOAD_CHANGED'],
    ['proof', 'CONSUMER_SOURCE_NOT_FIXED'], ['retired-payload', 'CONSUMER_SOURCE_NOT_FIXED'], ['harness', 'CONSUMER_HARNESS_CHANGED'], ['catalog', 'CONSUMER_PAYLOAD_CHANGED'],
    ['schema', 'CONSUMER_PROJECTION_INVALID'], ['buildId', 'CONSUMER_PROJECTION_INVALID'], ['legacy', 'CONSUMER_PROJECTION_INVALID']
  ];
  for (const [kind, expected] of cases) {
    const f = await consumerFixture(t); let calls = 0;
    if (kind === 'source') await writeFile(resolve(f.sourceRoot, 'AGENTS.md'), 'changed original source');
    if (kind === 'archive') await writeFile(f.archive, 'changed archive');
    if (kind === 'target') { await rename(f.target, `${f.target}.original`); await mkdir(f.target); }
    if (kind === 'node') await writeFile(f.nodeBin, 'changed synthetic Node');
    if (kind === 'payload') await writeFile(resolve(f.target, 'runtime/agent-runtime.mjs'), 'changed original payload');
    if (kind === 'proof') f.receipt.source.finalReadbackTree = '0'.repeat(40);
    if (kind === 'retired-payload') {
      f.receipt.source.commit = '7594fd72251d38b6e1d23a1a3cca184ae0d085e7';
      f.receipt.source.tree = '0827ce904179862ab55648fe99b780cea94faf98';
    }
    if (kind === 'harness') f.receipt.harness.sha256 = '0'.repeat(64);
    if (kind === 'catalog') f.receipt.source.installInputs.pop();
    if (kind === 'schema') f.receipt.localBackendFixtureOnly = false;
    if (kind === 'buildId') delete f.receipt.buildId;
    if (kind === 'legacy') f.receipt.cloudRun = 'retired-identity';
    const consume = f.module.createArtifactConsumer(() => { calls++; return { status: 'PASS' }; });
    assert.equal(await consume(f.context), false); assert.equal(calls, 0);
    assert.equal(f.receipt.consumer.code, expected); assert.equal(f.receipt.consumer.status, 'FAIL');
    assert.equal(f.receipt.consumer.calls, 0); assert.equal(f.receipt.acceptance.C1.status, 'PASS');
  }
});

test('artifact consumer post-readback catches original members, dependencies, modes, links, source and Node tampering', async t => {
  const cases = [
    ['payload', 'CONSUMER_PAYLOAD_CHANGED'], ['dependency', 'CONSUMER_ARTIFACT_CHANGED'],
    ['mode', 'CONSUMER_ARTIFACT_CHANGED'], ['link', 'CONSUMER_ARTIFACT_CHANGED'],
    ['source', 'CONSUMER_SOURCE_CHANGED'], ['archive', 'CONSUMER_SOURCE_CHANGED'],
    ['node', 'CONSUMER_NODE_CHANGED'], ['metadata-link', 'CONSUMER_ARTIFACT_CHANGED'],
    ['target', 'CONSUMER_TARGET_IDENTITY_CHANGED']
  ];
  for (const [kind, expected] of cases) {
    const f = await consumerFixture(t);
    const tail = await consumerTail(f, async () => {
      if (kind === 'payload') await writeFile(resolve(f.target, 'runtime/agent-runtime.mjs'), 'tampered');
      if (kind === 'dependency') await writeFile(f.dependency, 'tampered');
      if (kind === 'mode') await chmod(f.dependency, 0o700);
      if (kind === 'link') await symlink(f.owner, resolve(f.target, 'outside-link'));
      if (kind === 'source') await writeFile(resolve(f.sourceRoot, 'AGENTS.md'), 'tampered');
      if (kind === 'archive') await writeFile(f.archive, 'tampered');
      if (kind === 'node') await writeFile(f.nodeBin, 'tampered');
      if (kind === 'metadata-link') await symlink(f.dependency, resolve(f.target, 'ur04-clean-artifact.json'));
      if (kind === 'target') { await rename(f.target, `${f.target}.moved`); await mkdir(f.target); }
      return { status: 'PASS' };
    });
    assert.equal(tail.exit, 1); assert.equal(tail.receipt.consumer.status, 'FAIL');
    assert.equal(tail.receipt.consumer.code, expected); assert.equal(tail.receipt.consumer.calls, 1);
    assert.equal(tail.receipt.cleanup.removed, true); assert.equal(tail.receipt.acceptance.C4.status, 'PASS');
  }
});

test('artifact consumer absent callback retains original standalone tail/cleanup and no consumer receipt', async t => {
  const f = await consumerFixture(t); const tail = await consumerTail(f, undefined);
  assert.equal(tail.exit, 0); assert.equal(tail.receipt.result, 'PASS');
  assert.equal(Object.hasOwn(tail.receipt, 'consumer'), false); assert.equal(tail.receipt.cleanup.removed, true);
  // Default helper does not even inspect a synthetic context or claim a gate.
  assert.equal(await f.module.createArtifactConsumer(undefined)(null), true);
});


test('artifact consumer return schema is exact plain data with only the declared failure code whitelist', async () => {
  const { consumerResult, CONSUMER_FAILURE_CODES } = await import('./clean-target-install.acceptance.mjs');
  assert.deepEqual(consumerResult({ status: 'PASS' }), { status: 'PASS' });
  for (const code of CONSUMER_FAILURE_CODES) assert.deepEqual(consumerResult({ status: 'FAIL', code }), { status: 'FAIL', code });
  const getter = Object.defineProperty({}, 'status', { get() { throw new Error('must never read diagnostic getter'); } });
  for (const invalid of [null, [], 'PASS', {}, { status: 'PASS', code: 'CONSUMER_TEST_FAILED' },
    { status: 'FAIL' }, { status: 'NOT_RUN' }, { status: 'FAIL', code: 'arbitrary-secret' },
    { status: 'PASS', [Symbol('secret')]: true }, getter, Object.create({ status: 'PASS' })]) {
    assert.throws(() => consumerResult(invalid), code('CONSUMER_RESULT_INVALID'));
  }
});


// S01: execute the exact CLI main/argument-parser source with the real config
// reader and workspace loader. Only the Runtime execution boundary and process
// listeners are inert captures, as in the existing final-tail source units.
// This is NOT a running Runtime, WS/session, workspace build or installation.
async function workspaceCliUnit(t) {
  const f = await fixture(t, { count: 1 });
  const source = await readFile(resolve(repo, 'conf/cyf-agent-runtime-v1/agent-runtime.mjs'), 'utf8');
  const argsStart = source.indexOf('const failure =');
  const argsEnd = source.indexOf('const wait =', argsStart);
  const mainStart = source.indexOf('export async function main(');
  const mainEnd = source.indexOf('\nconst isMain =', mainStart);
  assert.ok(argsStart >= 0 && argsEnd > argsStart && mainStart > argsEnd && mainEnd > mainStart);
  const { pathToFileURL } = await import('node:url');
  const { createLogger } = await import('../lib/security.mjs');
  const loaderUrl = pathToFileURL(resolve(engineSource, 'workspace-manager.mjs')).href;
  let mainSource = source.slice(mainStart, mainEnd).replace('export async function main(', 'async function main(');
  const loaderImport = "import('../codex-ws-agent/workspace-manager.mjs')";
  assert.equal(mainSource.split(loaderImport).length, 2, 'one original workspace loader import');
  // Only resolve the original loader URL in the source slice, never replace its
  // call/validation or the CLI selection/precedence/control flow under test.
  mainSource = mainSource.replace(loaderImport, `import(${JSON.stringify(loaderUrl)})`);
  const calls = []; const listeners = new Map();
  const processCapture = {
    once(event, fn) { assert.ok(['SIGTERM', 'SIGINT'].includes(event)); assert.equal(listeners.has(event), false); listeners.set(event, fn); },
    removeListener(event, fn) { assert.equal(listeners.get(event), fn); listeners.delete(event); }
  };
  const never = () => assert.fail('S01 source unit must not enroll/create a session');
  const main = new Function('resolve', 'readRuntimeHostConfig', 'createLogger', 'runUnifiedRuntime',
    'RuntimeV1Client', 'readEnrollmentSecret', 'process', `${source.slice(argsStart, argsEnd)}\n${mainSource}\nreturn main;`)(
    resolve, readRuntimeHostConfig, createLogger, async settings => { calls.push(settings); }, never, never, processCapture);
  const invoke = async ({ argv = [], env = {} } = {}) => {
    try {
      return await main(['run', '--config', f.path, ...argv], { CYF_RUNTIME_V1_API_BASE_URL: 'https://no-network.invalid', ...env });
    } finally {
      assert.equal(listeners.size, 0, 'all original CLI signal listeners released');
      assert.deepEqual(await readdir(f.raw.stateRoot), [], 'no host writer/adoption');
      assert.deepEqual(await readdir(f.entries[0].stateRoot), [], 'no queue/session/checkpoint IO');
    }
  };
  const policyFile = async (id, change = {}) => {
    const policy = { policyId: id, root: resolve(f.root, `${id}-workspaces`), repository: resolve(f.root, `${id}-repository`),
      baseRef: 'develop', trustedRemoteUrl: 'https://repository.invalid/synthetic.git', trustedRemoteRef: 'refs/heads/develop', ...change };
    const file = resolve(f.root, `${id}.json`); await f.json(file, [policy]);
    return { policy, file };
  };
  return { ...f, invoke, calls, policyFile };
}

test('S01 workspace CLI: explicit file reproduces old string empty Map and passes real loaded policy to Runtime boundary', async t => {
  const f = await workspaceCliUnit(t); const { file, policy } = await f.policyFile('s01-cli');
  const { loadWorkspacePolicies } = await import(resolve(engineSource, 'workspace-manager.mjs'));
  assert.deepEqual([...loadWorkspacePolicies(file)], [], 'historical string argument misses the current env-shaped signature');
  assert.equal(await f.invoke({ argv: ['--workspace-policies', file] }), 0);
  assert.equal(f.calls.length, 1); assert.deepEqual([...f.calls[0].workspacePolicies], [[policy.policyId, policy]]);
  assert.equal(f.calls[0].config.agents[0].manifest.canonicalAgentId, f.manifests[0].canonicalAgentId);
  await assert.rejects(lstat(policy.root), code('ENOENT')); await assert.rejects(lstat(policy.repository), code('ENOENT'));
});

test('S01 workspace CLI: CYF file input reaches original loader without inheriting legacy inline/file keys', async t => {
  const f = await workspaceCliUnit(t); const { file, policy } = await f.policyFile('s01-cyf');
  assert.equal(await f.invoke({ env: { CYF_RUNTIME_WORKSPACE_POLICIES_FILE: file,
    CODEX_WORKSPACE_POLICIES_FILE: 'must-not-open-legacy-file', CODEX_WORKSPACE_POLICIES: 'must-not-parse-legacy-inline' } }), 0);
  assert.equal(f.calls.length, 1); assert.deepEqual([...f.calls[0].workspacePolicies], [[policy.policyId, policy]]);
});

test('S01 workspace CLI: CLI file has priority over CYF file rather than merging either scope', async t => {
  const f = await workspaceCliUnit(t); const cli = await f.policyFile('s01-priority-cli'); const cyf = await f.policyFile('s01-priority-cyf');
  assert.equal(await f.invoke({ argv: ['--workspace-policies', cli.file], env: { CYF_RUNTIME_WORKSPACE_POLICIES_FILE: cyf.file } }), 0);
  assert.equal(f.calls.length, 1); assert.deepEqual([...f.calls[0].workspacePolicies], [[cli.policy.policyId, cli.policy]]);
  assert.equal(f.calls[0].workspacePolicies.has(cyf.policy.policyId), false);
});

test('S01 workspace CLI: invalid selected CLI file never falls back to a valid CYF file', async t => {
  const f = await workspaceCliUnit(t); const cyf = await f.policyFile('s01-valid-fallback');
  await assert.rejects(f.invoke({ argv: ['--workspace-policies', 'relative-policy.json'], env: { CYF_RUNTIME_WORKSPACE_POLICIES_FILE: cyf.file } }), code('WORKSPACE_POLICY_INVALID'));
  assert.equal(f.calls.length, 0);
});

test('S01 workspace CLI: absent or empty CYF file defaults to an empty Map and ignores old-only policy inputs', async t => {
  const f = await workspaceCliUnit(t); const legacy = await f.policyFile('s01-legacy');
  for (const env of [{}, { CYF_RUNTIME_WORKSPACE_POLICIES_FILE: '' }, {
    CODEX_WORKSPACE_POLICIES_FILE: legacy.file, CODEX_WORKSPACE_POLICIES: JSON.stringify([legacy.policy])
  }]) {
    assert.equal(await f.invoke({ env }), 0); assert.deepEqual([...f.calls.at(-1).workspacePolicies], []);
  }
  assert.equal(f.calls.length, 3);
});

for (const kind of ['relative', 'missing', 'file-symlink', 'ancestor-symlink', 'invalid-json', 'invalid-shape', 'relative-resource', 'overlapping-resources', 'remote-credentials']) {
  test(`S01 workspace CLI: original loader rejects ${kind} before any Runtime execution`, async t => {
    const f = await workspaceCliUnit(t); const valid = await f.policyFile('s01-invalid'); let file = valid.file;
    let expected = 'WORKSPACE_POLICY_INVALID';
    if (kind === 'relative') file = 'relative-policy.json';
    if (kind === 'missing') { file = resolve(f.root, 'absent.json'); expected = 'WORKSPACE_PATH_MISSING'; }
    if (kind === 'file-symlink') { file = resolve(f.root, 'linked.json'); await symlink(valid.file, file); expected = 'WORKSPACE_SYMLINK_ESCAPE'; }
    if (kind === 'ancestor-symlink') { const link = resolve(f.root, 'linked-parent'); await symlink(f.root, link); file = resolve(link, 's01-invalid.json'); expected = 'WORKSPACE_SYMLINK_ESCAPE'; }
    if (kind === 'invalid-json') await writeFile(file, 'not-json\n');
    if (kind === 'invalid-shape') await f.json(file, [null]);
    if (kind === 'relative-resource') await f.json(file, [{ ...valid.policy, repository: 'relative-repository' }]);
    if (kind === 'overlapping-resources') await f.json(file, [{ ...valid.policy, root: resolve(valid.policy.repository, 'nested-workspace') }]);
    if (kind === 'remote-credentials') await f.json(file, [{ ...valid.policy, trustedRemoteUrl: 'https://synthetic:NOT-A-SECRET@repository.invalid/repo' }]);
    // Cover both public selection inputs while preserving CLI priority when set.
    for (const input of [{ argv: ['--workspace-policies', file] }, { env: { CYF_RUNTIME_WORKSPACE_POLICIES_FILE: file } }]) {
      await assert.rejects(f.invoke(input), code(expected)); assert.equal(f.calls.length, 0);
      const { main } = await import('../agent-runtime.mjs');
      // Also execute the actual exported CLI. The pre-existing invalid interval
      // prevents executor/network effects even if the old empty-Map bug returns.
      await assert.rejects(main(['run', '--config', f.path, ...(input.argv || [])], {
        CYF_RUNTIME_V1_API_BASE_URL: 'https://no-network.invalid',
        CYF_RUNTIME_V1_HEARTBEAT_INTERVAL_MS: '0', ...(input.env || {})
      }), code(expected));
      assert.deepEqual(await readdir(f.raw.stateRoot), []);
      assert.deepEqual(await readdir(f.entries[0].stateRoot), []);
    }
  });
}
