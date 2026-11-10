import { fromAgentWire } from '../../codex-bridge/agent-message-wire.mjs';
import { agentMessageFixture, httpFixture } from './agent-wire-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { hostingFixture, candidateRequest, tick, code } from './hosting-fixture.mjs';
import { digestManifest, runtimeSubjectKey } from '../lib/manifest.mjs';
import { createRuntimeExecutionHost, buildRuntimeExecutionEnvironment } from '../../codex-bridge/agent-client.mjs';
import { createExecutionAdapterFactory } from '../lib/execution-adapter.mjs';
import { RuntimeV1Client } from '../lib/runtime-client.mjs';
import { writePrivateJson } from '../lib/security.mjs';
import { startHostingServer } from '../lib/hosting-server.mjs';
import { runUnifiedRuntime } from '../agent-runtime.mjs';
const wire = JSON.parse(await readFile(new URL('./fixtures/gss-hosting-control-v1.json', import.meta.url)));

async function freshAgent(f, id = 'agt_dynamic') {
  const root = resolve(f.root, id); await mkdir(root, { mode: 0o700 });
  for (const name of ['state', 'home', 'work']) await mkdir(resolve(root, name), { mode: 0o700 });
  const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: `rti_${'d'.repeat(32)}`,
    tenantId: '0', clientId: 'fixture-client', canonicalAgentId: id };
  const manifest = { ...unsigned, manifestSha256: digestManifest(unsigned) };
  return { manifest, subjectKey: runtimeSubjectKey(manifest), stateRoot: resolve(root, 'state'),
    providerEnvironment: { CYF_MANAGED_PROVIDER_API_KEY: 'unit-explicit-only', HOME: 'must-not-replace-home', OPENAI_API_KEY: 'must-not-copy', NODE_OPTIONS: 'must-not-inject' },
    profile: { agentId: id, profileId: `profile-${id}`, codexBin: '/bin/true', codexHome: resolve(root, 'home'), codexWorkdir: resolve(root, 'work'),
      appServerEnabled: false, fastChatEnabled: false } };
}

test('RuntimeHost dynamic add/recreate uses existing host, serializes one subject, retains lock and preserves peers', async t => {
  const f = await hostingFixture(t); const host = f.host(); const agent = await freshAgent(f);
  const peerStates = f.peers.map(peer => f.states.get(peer.subjectKey)[0]);
  await Promise.all(Array.from({ length: 8 }, () => host.ensureAgent(agent))); assert.equal(f.states.get(agent.subjectKey).length, 1);
  await writePrivateJson(resolve(agent.stateRoot, 'runtime-authorization.json'), { installationId: agent.manifest.installationId, runtimeAuthorization: 'rta1_' + 'f'.repeat(64) });
  await host.activate(agent.subjectKey); const lock = await lstat(resolve(agent.stateRoot, '.runtime-writer.lock'), { bigint: true });
  // The fake activation requires a valid local auth; enroll once through control
  // is tested elsewhere. Supply only a synthetic state before direct host use.
  assert.equal(host.agents.size, 4);
  await host.reprovisionAgent(agent);
  const replacementLock = await lstat(resolve(agent.stateRoot, '.runtime-writer.lock'), { bigint: true });
  assert.equal(replacementLock.ino, lock.ino); assert.equal(f.states.get(agent.subjectKey).length, 2);
  assert.equal(f.states.get(agent.subjectKey)[0].closed, 1); assert.equal(f.states.get(agent.subjectKey)[1].closed, 0);
  for (let i = 0; i < f.peers.length; i++) { assert.equal(f.states.get(f.peers[i].subjectKey)[0], peerStates[i]); assert.equal(peerStates[i].closed, 0); assert.equal(peerStates[i].ready, true); }
});

test('RuntimeHost rejects dynamic identity/installation/root collision without altering peers', async t => {
  const f = await hostingFixture(t); const agent = await freshAgent(f);
  for (const mutation of [{ subjectKey: 'wrong' }, { profile: { ...agent.profile, agentId: 'wrong' } },
    { profile: { ...agent.profile, codexHome: f.peers[0].profile.codexHome } }, { stateRoot: f.hostConfig.stateRoot }]) await assert.rejects(f.host().ensureAgent({ ...agent, ...mutation }));
  assert.equal(f.host().agents.size, 3);
  await f.host().ensureAgent(agent);
  await assert.rejects(f.host().ensureAgent({ ...agent, profile: { ...agent.profile, codexModel: 'changed' } }), code('RUNTIME_AGENT_IDENTITY_CONFLICT'));
  assert.equal(f.states.get(agent.subjectKey).length, 1);
});

test('mature engine adds and recreates closed entry, refreshes profiles/profileStates, independent peers retain exact state', async t => {
  const f = await hostingFixture(t); const agent = await freshAgent(f);
  const engine = createRuntimeExecutionHost({ agents: f.peers, runtimeInstanceId: 'engine-unit', apiOrigin: 'https://no-network.invalid' });
  t.after(() => engine.close()); const peer = engine.createExecutor({ subjectKey: f.peers[0].subjectKey }); await peer.initialize(); const peerState = peer.state();
  engine.addAgent(agent); const first = engine.createExecutor({ subjectKey: agent.subjectKey }); await first.initialize(); const old = first.state();
  assert.equal(old.profile.runtimeIdentity.installationId, agent.manifest.installationId); assert.equal(old.profile.runtimeSubjectKey, agent.subjectKey);
  assert.throws(() => engine.addAgent(agent), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  await first.close(); assert.equal(old.disposed, true); assert.equal(first.state(), null);
  assert.throws(() => engine.createExecutor({ subjectKey: agent.subjectKey }), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  engine.addAgent(agent); const second = engine.createExecutor({ subjectKey: agent.subjectKey }); await second.initialize();
  assert.notEqual(second.state(), old); assert.equal(second.state().disposed, false); assert.equal(second.state().profile.agentId, agent.manifest.canonicalAgentId);
  assert.equal(peer.state(), peerState); assert.equal(peerState.disposed, false);
  const env = buildRuntimeExecutionEnvironment(second.state().profile);
  assert.equal(env.CYF_MANAGED_PROVIDER_API_KEY, 'unit-explicit-only'); assert.equal(env.HOME, agent.profile.codexHome);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
});

test('provider environment reaches actual child via allowlisted builder, never inherited user credentials/HOME/Node options', async t => {
  const f = await hostingFixture(t); const agent = await freshAgent(f); const saved = process.env.CYF_MANAGED_PROVIDER_INHERIT;
  process.env.CYF_MANAGED_PROVIDER_INHERIT = 'must-not-inherit'; t.after(() => { if (saved === undefined) delete process.env.CYF_MANAGED_PROVIDER_INHERIT; else process.env.CYF_MANAGED_PROVIDER_INHERIT = saved; });
  const profile = { ...agent.profile, runtimeProviderEnvironment: agent.providerEnvironment };
  const env = buildRuntimeExecutionEnvironment(profile);
  const stdout = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['-e', 'console.log(JSON.stringify({home:process.env.HOME,codexHome:process.env.CODEX_HOME,key:process.env.CYF_MANAGED_PROVIDER_API_KEY,inherited:process.env.CYF_MANAGED_PROVIDER_INHERIT,openai:process.env.OPENAI_API_KEY,node:process.env.NODE_OPTIONS}))'], { env, cwd: agent.profile.codexWorkdir });
    let out = ''; child.on('error', reject); child.stdout.on('data', bytes => { out += bytes; }); child.on('exit', code => code === 0 ? done(out) : reject(Error('fixture child failed')));
  });
  assert.deepEqual(JSON.parse(stdout), { home: agent.profile.codexHome, codexHome: agent.profile.codexHome, key: 'unit-explicit-only' });
});

test('adapter replaces only closed subject/session; stalled durable replay cannot block peer heartbeat', async t => {
  const f = await hostingFixture(t); const agent = await freshAgent(f); const states = new Map(); const adds = []; const sent = []; let generation = 0;
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(bytes) { const frame = fromAgentWire(bytes); sent.push(frame); if (frame.messageType === 'agent.register') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(agentMessageFixture({
      type: 'agent_registered', messageId: frame.messageId, agentId: frame.agentId, installationId: frame.installationId,
      hostId: frame.hostId, runtimeInstanceId: frame.runtimeInstanceId, sessionGeneration: frame.sessionGeneration,
      status: 'online', durableStateHealthy: frame.durableStateHealthy, readyCommandTypes: frame.readyCommandTypes }))))); }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', 1000)); }
  }
  const module = { buildProtocolEnvelope: (messageType, payload) => ({ messageType, ...payload }), createRuntimeExecutionHost: () => ({
    addAgent: agent => adds.push(agent.subjectKey), createExecutor: ({ agent, subjectKey }) => {
      const state = { profile: agent.profile, healthy: true, closed: false, processor: { pause() {} } }; states.set(subjectKey, state);
      return { initialize: async () => {}, bindTransport: transport => { state.transport = transport; }, attachSocket: () => {},
        durableStateHealthy: () => state.healthy, readyCommandTypes: () => ['TASK_INVITE'], chatReady: () => false,
        registrationPayload: () => ({}), state: () => state, resume: async () => { state.resumeCalls = (state.resumeCalls || 0) + 1; if (state.stalled) await new Promise(done => { state.releaseReplay = done; }); }, disconnected() {}, suspendAdmission() {},
        close: async () => { state.closed = true; }, acceptFrame: async () => {} };
    }, close: async () => {} }) };
  const adapters = await createExecutionAdapterFactory({ config: f.hostConfig, apiOrigin: 'https://no-network.invalid', instanceId: 'adapter-unit',
    socketFactory: Socket, loadEngine: async () => module, clientFactory: settings => new RuntimeV1Client({ ...settings, fetchFn: async (url, options) => {
      assert.ok(url.endsWith('/session')); const body = JSON.parse(options.body).data;
      return httpFixture(options, { ...Object.fromEntries(['runtimeInstallationId', 'tenantId', 'clientId', 'canonicalAgentId', 'hostId', 'runtimeInstanceId'].map(key => [key, body[key]])),
        sessionGeneration: String(++generation), scheme: 'AgentRuntime', sessionToken: 'rts1_' + 'e'.repeat(64), websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' });
    } }) });
  t.after(() => adapters.close());
  await writePrivateJson(resolve(agent.stateRoot, 'runtime-authorization.json'), { installationId: agent.manifest.installationId, runtimeAuthorization: 'rta1_' + 'f'.repeat(64) });
  const create = () => adapters.createExecutor({ agent, subjectKey: agent.subjectKey });
  const first = create(); await first.initialize(); await first.activate(); assert.equal(first.ready(), true); const old = first.evidence();
  assert.throws(create, code('RUNTIME_EXECUTOR_SUBJECT_INVALID')); await first.close(); assert.equal(first.ready(), false);
  const second = create(); await second.initialize(); await second.activate(); assert.equal(second.ready(), true); assert.equal(second.evidence().sessionGeneration, String(BigInt(old.sessionGeneration) + 1n));
  assert.deepEqual(adds, [agent.subjectKey, agent.subjectKey]); assert.equal(second.sessionGeneration(), '2');
  const peer = f.peers[0];
  await writePrivateJson(resolve(peer.stateRoot, 'runtime-authorization.json'), { installationId: peer.manifest.installationId, runtimeAuthorization: 'rta1_' + 'f'.repeat(64) });
  const peerExecutor = adapters.createExecutor({ agent: peer, subjectKey: peer.subjectKey }); await peerExecutor.initialize(); await peerExecutor.activate(); await tick();
  const slow = states.get(agent.subjectKey); slow.stalled = true; const before = slow.resumeCalls;
  await adapters.heartbeat(); await tick(); assert.equal(typeof slow.releaseReplay, 'function');
  const peerBeats = () => sent.filter(frame => frame.messageType === 'agent.presence' && frame.agentId === peer.manifest.canonicalAgentId).length;
  const beats = peerBeats(); await adapters.heartbeat(); await adapters.heartbeat();
  assert.equal(peerBeats(), beats + 2); assert.equal(slow.resumeCalls, before + 1); assert.equal(peerExecutor.ready(), true);
  slow.releaseReplay(); await tick();
  slow.healthy = false; assert.equal(second.evidence(), null); await second.close(); await peerExecutor.close();
});

test('one pending registration cannot block existing peer heartbeat or host SIGTERM', async t => {
  const f = await hostingFixture(t); await f.stop(); const controller = new AbortController(); const states = []; let beats = 0;
  const running = runUnifiedRuntime({ config: f.hostConfig, apiOrigin: 'https://no-network.invalid', instanceId: 'independent-unit', signal: controller.signal,
    waitFn: async () => { await tick(); }, createAdapters: async () => ({ createExecutor: ({ agent }) => {
      const state = { agent, closed: false, ready: false, release: null }; states.push(state);
      return { initialize: async () => {}, activate: async () => { if (states.indexOf(state) === 2) await new Promise(done => { state.release = done; }); else state.ready = true; },
        ready: () => state.ready, pause: async () => {}, close: async () => { state.closed = true; state.release?.(); } };
    }, heartbeat: async () => { if (states.some(state => state.ready)) { beats++; controller.abort(); } },
      close: async () => { for (const state of states) { state.closed = true; state.release?.(); } } }) });
  const result = await running; assert.equal(beats, 1); assert.equal(result.agents.every(agent => agent.phase === 'STOPPED'), true); assert.equal(states.every(state => state.closed), true);
});

test('private socket trusted-group child UID1001/GID1000 can exchange while untrusted GID is denied (root-only local fixture)', { skip: process.getuid() !== 0 }, async t => {
  // Close the listener before hostingFixture removes its owned socket/root,
  // including when an assertion fails. Otherwise cleanup itself leaks a server.
  let server; t.after(async () => { await server?.close(); });
  // This test intentionally crosses UID boundaries. Private CI TMPDIR and its
  // downloaded Node parent are not searchable by the synthetic client UID.
  // Expose only this synthetic fixture and its executable, never the CI HOME.
  const f = await hostingFixture(t, { rootParent: '/tmp' }); f.controlConfig.socketGid = 1000;
  const clientNode = resolve(f.root, 'client-node');
  await copyFile(process.execPath, clientNode); await chmod(clientNode, 0o755);
  const { chown } = await import('node:fs/promises'); await chmod(f.root, 0o711); await chown(resolve(f.root, 'socket'), 0, 1000);
  server = await startHostingServer({ control: f.control() });
  const run = gid => new Promise((done, reject) => {
    const script = `const s=require('net').connect(${JSON.stringify(f.controlConfig.socketPath)});let b='';s.on('connect',()=>s.write(${JSON.stringify(JSON.stringify({ protocolVersion: 1, requestId: 'req', messageType: 'hosting.capabilities', messageId: 'msg', data: { tenantId: wire.capabilitiesRequest.tenantId, clientId: wire.capabilitiesRequest.clientId, ownerJiacn: wire.capabilitiesRequest.ownerJiacn } }) + '\n')}));s.on('data',v=>b+=v);s.on('end',()=>{console.log(b);process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(13)});`;
    const child = spawn(clientNode, ['-e', script], { uid: 1001, gid, cwd: f.root, env: { PATH: '/usr/bin:/bin' } }); let stdout = ''; let stderr = '';
    child.on('error', reject); child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.on('exit', exit => done({ exit, stdout, stderr }));
  });
  const trusted = await run(1000); assert.equal(trusted.exit, 0, trusted.stderr); assert.equal(JSON.parse(trusted.stdout).data.available, true);
  const other = await run(1001); assert.equal(other.exit, 13); assert.match(other.stdout, /EACCES/);
  await server.close();
});

test('trusted engine readmission replaces only the closed identity in the same public roots; ordinary add stays fenced', async t => {
  const f = await hostingFixture(t), agent = await freshAgent(f);
  const engine = createRuntimeExecutionHost({ agents: f.peers, runtimeInstanceId: 'engine-readmission', apiOrigin: 'https://no-network.invalid' });
  t.after(() => engine.close());
  const peer = engine.createExecutor({ subjectKey: f.peers[0].subjectKey }); await peer.initialize(); const peerState = peer.state();
  engine.addAgent(agent); const first = engine.createExecutor({ subjectKey: agent.subjectKey }); await first.initialize();
  const oldState = first.state(), next = structuredClone(agent);
  next.manifest.installationId = 'rti_' + 'e'.repeat(32); next.manifest.manifestSha256 = digestManifest(next.manifest);
  assert.throws(() => engine.admitAgent(next, agent.manifest), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  await first.close(); assert.equal(oldState.disposed, true);
  assert.throws(() => engine.addAgent(next), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  assert.throws(() => engine.admitAgent(next, { ...agent.manifest, installationId: 'wrong' }), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  assert.throws(() => engine.admitAgent({ ...next, profile: { ...next.profile, codexHome: f.peers[0].profile.codexHome } }, agent.manifest), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  engine.admitAgent(next, agent.manifest); engine.admitAgent(structuredClone(next), structuredClone(agent.manifest));
  const second = engine.createExecutor({ subjectKey: next.subjectKey }); await second.initialize();
  assert.equal(second.state().profile.runtimeIdentity.installationId, next.manifest.installationId);
  assert.equal(second.state().profile.codexHome, oldState.profile.codexHome);
  assert.notEqual(second.state(), oldState); assert.equal(peer.state(), peerState); assert.equal(peerState.disposed, false);
  assert.throws(() => engine.admitAgent(next, agent.manifest), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  assert.throws(() => engine.addAgent(agent), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  // Initialization failure/host retry may have closed the newly admitted entry.
  await second.close(); engine.admitAgent(next, agent.manifest);
  const recovered = engine.createExecutor({ subjectKey: next.subjectKey }); await recovered.initialize();
  assert.equal(recovered.state().profile.runtimeIdentity.installationId, next.manifest.installationId);
});

test('engine readmission after host restart registers the public subject without an old executor', async t => {
  const f = await hostingFixture(t), agent = await freshAgent(f), next = structuredClone(agent);
  next.manifest.installationId = 'rti_' + 'f'.repeat(32); next.manifest.manifestSha256 = digestManifest(next.manifest);
  const engine = createRuntimeExecutionHost({ agents: f.peers, runtimeInstanceId: 'engine-restart', apiOrigin: 'https://no-network.invalid' });
  t.after(() => engine.close());
  assert.throws(() => engine.admitAgent(next, { ...agent.manifest, clientId: 'other' }), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  assert.throws(() => engine.admitAgent(next, next.manifest), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  engine.admitAgent(next, agent.manifest);
  const executor = engine.createExecutor({ subjectKey: next.subjectKey }); await executor.initialize();
  assert.equal(executor.state().profile.runtimeIdentity.installationId, next.manifest.installationId);
});

test('adapter readmission joins durable skill identity and real engine registration without enrollment or execution', async t => {
  const f = await hostingFixture(t), previousAgent = await freshAgent(f), agent = structuredClone(previousAgent);
  agent.manifest.installationId = 'rti_' + 'e'.repeat(32); agent.manifest.manifestSha256 = digestManifest(agent.manifest);
  const { SkillInstallManager, defaultSkillInstallStateRoot } = await import('../../codex-bridge/skill-install-manager.mjs');
  const { stoppedSkillManager } = await import('../lib/evidence-handover.mjs');
  const apiOrigin = 'https://no-network.invalid', instanceId = 'adapter-readmission';
  const stateRoot = defaultSkillInstallStateRoot(resolve(previousAgent.stateRoot, 'inbox'), previousAgent.profile, 'wss://no-network.invalid');
  const manager = new SkillInstallManager({ profile: previousAgent.profile, stateRoot, wsUrl: 'wss://no-network.invalid', runtimeInstanceId: instanceId });
  manager.initialize();
  const identity = { tenantId: '0', clientId: 'fixture-client', agentId: previousAgent.manifest.canonicalAgentId, ownerJiacn: 'original-owner' };
  manager.bindSession({ scope: identity, fence: { installationId: previousAgent.manifest.installationId, runtimeInstanceId: instanceId } });
  manager.bindSession(null);
  await manager.retireRelationship({ identity: { ...identity, runtimeInstallationId: previousAgent.manifest.installationId }, operationId: 'retirement-join' });
  const adapters = await createExecutionAdapterFactory({ config: f.hostConfig, instanceId, apiOrigin,
    socketFactory: class { constructor() { assert.fail('admission must not open socket'); } },
    clientFactory: () => ({ invalidateSession() {}, session() { assert.fail('admission must not enroll/session'); } }) });
  t.after(() => adapters.close());
  const request = { agent, previousAgent, operationId: 'retirement-join', previousOwnerJiacn: 'original-owner', ownerJiacn: 'next-owner' };
  await adapters.admitRelationship(request); await adapters.admitRelationship(request);
  const reloaded = stoppedSkillManager({ agent, apiOrigin, instanceId }); reloaded.initialize();
  assert.equal(reloaded.boundIdentity.ownerJiacn, 'next-owner');
  assert.equal(reloaded.boundIdentity.runtimeInstallationId, agent.manifest.installationId);
  // Registration is already present: createExecutor must not fall back to ordinary addAgent.
  const executor = adapters.createExecutor({ agent, subjectKey: agent.subjectKey });
  await assert.rejects(adapters.admitRelationship(request), code('RUNTIME_EXECUTOR_SUBJECT_INVALID'));
  await executor.close();
});

async function cleanedReadmission(t) {
  const f = await hostingFixture(t), previous = await freshAgent(f), next = structuredClone(previous), host = f.host();
  next.manifest.installationId = 'rti_' + 'e'.repeat(32); next.manifest.manifestSha256 = digestManifest(next.manifest);
  const association = { operationId: 'next-invitation', handoverId: 'original-finish', leaseId: 'original-lease',
    previousOwnerJiacn: 'old-owner', ownerJiacn: 'new-owner' };
  await host.ensureAgent(previous);
  await host.quiesceAgent(previous.subjectKey, { installationId: previous.manifest.installationId, operationId: association.handoverId });
  host.flushEvidence = async () => ({ confirmed: true }); host.cleanPrivateData = async () => ({ confirmed: true });
  await host.flushAgentEvidence(previous.subjectKey, { installationId: previous.manifest.installationId,
    operationId: association.handoverId, ownerJiacn: association.previousOwnerJiacn });
  await host.cleanAgentPrivateData(previous.subjectKey, { installationId: previous.manifest.installationId,
    operationId: association.handoverId, ownerJiacn: association.previousOwnerJiacn, leaseId: association.leaseId });
  return { f, previous, next, association };
}

test('host readmission requires full original cleanup, preserves writer inode/public files, and initializes only new identity', async t => {
  const { f, previous, next, association } = await cleanedReadmission(t), host = f.host();
  const lockPath = resolve(previous.stateRoot, '.runtime-writer.lock'), lock = await lstat(lockPath, { bigint: true });
  const publicPath = resolve(previous.profile.codexWorkdir, 'public-repo.txt'); await writeFile(publicPath, 'keep-public-history');
  let admitted = 0, materialized = 0;
  host.admitRelationship = async options => { admitted++; assert.equal(options.operationId, association.handoverId); assert.equal(options.agent.manifest.installationId, next.manifest.installationId); };
  const materialize = async () => { materialized++; };
  await assert.rejects(host.readmitAgent(previous, next, { ...association, previousOwnerJiacn: 'wrong' }, materialize), code('RUNTIME_ADMISSION_CLEANUP_REQUIRED'));
  await assert.rejects(host.readmitAgent(previous, next, { ...association, leaseId: 'wrong' }, materialize), code('RUNTIME_ADMISSION_CLEANUP_REQUIRED'));
  const alteredRoot = resolve(f.root, 'unknown-state');
  await assert.rejects(host.readmitAgent({ ...previous, stateRoot: alteredRoot }, { ...next, stateRoot: alteredRoot }, association, materialize), code('RUNTIME_ADMISSION_IDENTITY_CONFLICT'));
  const result = await host.readmitAgent(previous, next, association, materialize);
  assert.equal(result.phase, 'INITIALIZED'); assert.equal((await lstat(lockPath, { bigint: true })).ino, lock.ino);
  assert.equal(await readFile(publicPath, 'utf8'), 'keep-public-history'); assert.equal(admitted, 1); assert.equal(materialized, 1);
  assert.equal(f.states.get(previous.subjectKey).length, 2); assert.equal(f.states.get(previous.subjectKey)[0].closed, 1);
  assert.equal(f.states.get(previous.subjectKey)[1].agent.manifest.installationId, next.manifest.installationId);
  await host.readmitAgent(previous, next, association, materialize); assert.equal(admitted, 1);
  await assert.rejects(host.quiesceAgent(previous.subjectKey, { installationId: previous.manifest.installationId, operationId: association.handoverId }));
  await host.quiesceAgent(next.subjectKey, { installationId: next.manifest.installationId, operationId: 'new-finish' });
  await assert.rejects(host.readmitAgent(previous, next, association, materialize));
});

test('interrupted host admission blocks old startup after restart and resumes the exact transition', async t => {
  const { f, previous, next, association } = await cleanedReadmission(t);
  f.host().admitRelationship = async () => { throw Error('fixture interrupted identity transition'); };
  await assert.rejects(f.host().readmitAgent(previous, next, association, async () => {}), /fixture interrupted/);
  const markerPath = resolve(previous.stateRoot, 'relationship-admission.json');
  assert.equal(JSON.parse(await readFile(markerPath)).phase, 'PREPARED');
  await f.stop(); await f.start();
  const host = f.host(); let admitted = 0;
  await assert.rejects(host.ensureAgent(previous), code('RUNTIME_HANDOVER_PENDING'));
  assert.equal(f.states.get(previous.subjectKey).length, 1); // No old executor recreated.
  host.admitRelationship = async () => { admitted++; };
  await assert.rejects(host.readmitAgent(previous, next, { ...association, operationId: 'another-invitation' }, async () => {}), code('RUNTIME_ADMISSION_IDENTITY_CONFLICT'));
  await host.readmitAgent(previous, next, association, async () => {});
  assert.equal(admitted, 1); assert.equal(JSON.parse(await readFile(markerPath)).phase, 'COMMITTED');
  assert.equal(f.states.get(previous.subjectKey).at(-1).agent.manifest.installationId, next.manifest.installationId);
});

test('committed admission receipt prevents old startup even after old handover marker is removed', async t => {
  const { f, previous, next, association } = await cleanedReadmission(t);
  f.host().admitRelationship = async () => {};
  await f.host().readmitAgent(previous, next, association, async () => {});
  await f.stop(); await f.start();
  await assert.rejects(f.host().ensureAgent(previous), code('RUNTIME_HANDOVER_PENDING'));
  assert.equal(f.states.get(previous.subjectKey).length, 2);
  f.host().admitRelationship = async () => {};
  await f.host().readmitAgent(previous, next, association, async () => {});
  assert.equal(f.states.get(previous.subjectKey).length, 3);
  assert.equal(f.states.get(previous.subjectKey).at(-1).agent.manifest.installationId, next.manifest.installationId);
});

test('committed receipt with old handover still present resumes without restarting old identity', async t => {
  const { f, previous, next, association } = await cleanedReadmission(t);
  const path = resolve(previous.stateRoot, 'relationship-admission.json');
  f.host().admitRelationship = async () => {
    const record = JSON.parse(await readFile(path));
    await writePrivateJson(path, { ...record, phase: 'COMMITTED' });
    throw Error('fixture crash between commit and old marker deletion');
  };
  await assert.rejects(f.host().readmitAgent(previous, next, association, async () => {}), /fixture crash/);
  await f.stop(); await f.start();
  await assert.rejects(f.host().ensureAgent(previous), code('RUNTIME_HANDOVER_PENDING'));
  f.host().admitRelationship = async () => {};
  await f.host().readmitAgent(previous, next, association, async () => {});
  await assert.rejects(readFile(resolve(previous.stateRoot, 'handover.json')), { code: 'ENOENT' });
  assert.equal(f.states.get(previous.subjectKey).length, 2);
});
