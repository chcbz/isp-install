import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { hostingFixture, candidateRequest, tick, code } from './hosting-fixture.mjs';
import { digestManifest, runtimeSubjectKey } from '../lib/manifest.mjs';
import { createRuntimeExecutionHost, buildRuntimeExecutionEnvironment } from '../../codex-ws-agent/agent-client.mjs';
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
    send(bytes) { const frame = JSON.parse(bytes); sent.push(frame); if (frame.messageType === 'agent.register') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      type: 'agent_registered', messageId: frame.messageId, agentId: frame.agentId, installationId: frame.installationId,
      hostId: frame.hostId, runtimeInstanceId: frame.runtimeInstanceId, sessionGeneration: frame.sessionGeneration,
      status: 'online', durableStateHealthy: frame.durableStateHealthy, readyCommandTypes: frame.readyCommandTypes })))); }
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
      assert.ok(url.endsWith('/session')); const body = JSON.parse(options.body);
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ data: { ...Object.fromEntries(['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'hostId', 'runtimeInstanceId'].map(key => [key, body[key]])),
        sessionGeneration: ++generation, scheme: 'AgentRuntime', sessionToken: 'rts1_' + 'e'.repeat(64), websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' } }) };
    } }) });
  t.after(() => adapters.close());
  await writePrivateJson(resolve(agent.stateRoot, 'runtime-authorization.json'), { installationId: agent.manifest.installationId, runtimeAuthorization: 'rta1_' + 'f'.repeat(64) });
  const create = () => adapters.createExecutor({ agent, subjectKey: agent.subjectKey });
  const first = create(); await first.initialize(); await first.activate(); assert.equal(first.ready(), true); const old = first.evidence();
  assert.throws(create, code('RUNTIME_EXECUTOR_SUBJECT_INVALID')); await first.close(); assert.equal(first.ready(), false);
  const second = create(); await second.initialize(); await second.activate(); assert.equal(second.ready(), true); assert.equal(second.evidence().sessionGeneration, old.sessionGeneration + 1);
  assert.deepEqual(adds, [agent.subjectKey, agent.subjectKey]); assert.equal(second.sessionGeneration(), 2);
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
  const f = await hostingFixture(t); f.controlConfig.socketGid = 1000;
  const { chown } = await import('node:fs/promises'); await chmod(f.root, 0o711); await chown(resolve(f.root, 'socket'), 0, 1000);
  const server = await startHostingServer({ control: f.control() });
  const run = gid => new Promise((done, reject) => {
    const script = `const s=require('net').connect(${JSON.stringify(f.controlConfig.socketPath)});let b='';s.on('connect',()=>s.write(${JSON.stringify(JSON.stringify(wire.capabilitiesRequest) + '\n')}));s.on('data',v=>b+=v);s.on('end',()=>{console.log(b);process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(13)});`;
    const child = spawn(process.execPath, ['-e', script], { uid: 1001, gid, env: { PATH: '/usr/bin:/bin' } }); let stdout = ''; let stderr = '';
    child.on('error', reject); child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.on('exit', exit => done({ exit, stdout, stderr }));
  });
  const trusted = await run(1000); assert.equal(trusted.exit, 0, trusted.stderr); assert.equal(JSON.parse(trusted.stdout).available, true);
  const other = await run(1001); assert.equal(other.exit, 13); assert.match(other.stdout, /EACCES/);
  await server.close();
});
