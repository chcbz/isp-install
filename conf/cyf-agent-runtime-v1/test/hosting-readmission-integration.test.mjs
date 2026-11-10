import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { RuntimeHost } from '../lib/runtime-host.mjs';
import { HostingControl } from '../lib/hosting-control.mjs';
import { RuntimeV1Client } from '../lib/runtime-client.mjs';
import { createExecutionAdapterFactory } from '../lib/execution-adapter.mjs';
import { digestManifest, runtimeSubjectKey } from '../lib/manifest.mjs';
import { agentMessageFixture, httpFixture } from './agent-wire-fixture.mjs';
import { candidateRequest, quotedPreparation, fixtureInventory } from './hosting-fixture.mjs';
import { fromAgentWire, toAgentWire } from '../../codex-bridge/agent-message-wire.mjs';
import { packageFixture, command, activate, reconcile } from '../../codex-bridge/test/fixtures/skill-management-fixture.mjs';
import { replyMessage } from '../../codex-bridge/message-envelope.mjs';
import * as realEngine from '../../codex-bridge/agent-client.mjs';

const receiptFor = result => replyMessage(result, 'work.result.receipt', `receipt_${result.messageId}`, 'E0', 'committed', {
  schemaVersion: 2, skillChangeId: result.data.skillChangeId, commandId: result.data.commandId, attempt: result.data.attempt, receiptStatus: 'ACCEPTED' });

test('real control/host/adapter/engine preserve installed skill through cleanup and a new owner session', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'readmit-real-'));
  const roots = ['host', 'managed', 'socket', 'seed-state', 'seed-home', 'seed-work'];
  for (const name of roots) await mkdir(resolve(root, name), { mode: 0o700 });
  let host, control, adapters;
  t.after(async () => { try { await control?.close(); await host?.stop(); await adapters?.close(); await control?.releaseOwnership(); }
    finally { await rm(root, { recursive: true, force: true }); } });
  const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: 'seed-installation',
    tenantId: '0', clientId: 'fixture-client', canonicalAgentId: 'seed-agent' };
  const manifest = { ...unsigned, manifestSha256: digestManifest(unsigned) };
  const seed = { subjectKey: runtimeSubjectKey(manifest), manifest, stateRoot: resolve(root, 'seed-state'),
    profile: { profileId: 'seed', agentId: 'seed-agent', codexBin: '/bin/true', codexHome: resolve(root, 'seed-home'),
      codexWorkdir: resolve(root, 'seed-work'), appServerEnabled: false, fastChatEnabled: false } };
  const config = { configVersion: 1, hostId: 'real-fixture-host', stateRoot: resolve(root, 'host'), agents: [seed] };
  const apiOrigin = 'https://no-network.invalid', instanceId = 'real-fixture-instance';
  const captures = new Map(), owners = new Map(), sockets = [], received = [], logs = [];
  let owner = 'fixture-owner', enrollments = 0, generations = 0, downloaded = 0, resolveResult;
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(bytes) {
      const frame = fromAgentWire(bytes);
      if (frame.messageType === 'agent.register') {
        const runtimeAuth = { scheme: 'native-runtime-v1', tenantId: '0', clientId: 'fixture-client',
          ownerJiacn: owners.get(frame.installationId), agentId: frame.agentId, installationId: frame.installationId,
          hostId: frame.hostId, runtimeInstanceId: frame.runtimeInstanceId, sessionGeneration: frame.sessionGeneration };
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(agentMessageFixture({
          type: 'agent_registered', messageId: frame.messageId, agentId: frame.agentId, installationId: frame.installationId,
          hostId: frame.hostId, runtimeInstanceId: frame.runtimeInstanceId, sessionGeneration: frame.sessionGeneration,
          status: 'online', durableStateHealthy: frame.durableStateHealthy, readyCommandTypes: frame.readyCommandTypes, runtimeAuth })))));
      }
      if (frame.messageType === 'work.result') { received.push(frame); resolveResult?.(frame); }
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', 1000)); }
  }
  const clientFactory = settings => new RuntimeV1Client({ ...settings, fetchFn: async (url, options) => {
    assert.equal(new URL(url).origin, apiOrigin);
    const body = options.body ? JSON.parse(options.body).data : null;
    if (url.endsWith('/enroll')) {
      enrollments++; owners.set(body.runtimeInstallationId, owner);
      return httpFixture(options, { installation: { ...Object.fromEntries(['runtimeInstallationId', 'tenantId', 'clientId', 'canonicalAgentId', 'manifestVersion', 'manifestSha256'].map(key => [key, body[key]])),
        enrollmentExpiresAt: Date.now() + 3600000, status: 'ACTIVE', lastHeartbeatAt: null }, runtimeAuthorization: 'rta1_' + 'c'.repeat(64) });
    }
    if (url.endsWith('/session')) return httpFixture(options, { ...Object.fromEntries(['runtimeInstallationId', 'tenantId', 'clientId', 'canonicalAgentId', 'hostId', 'runtimeInstanceId'].map(key => [key, body[key]])),
      sessionGeneration: String(++generations), scheme: 'AgentRuntime', sessionToken: 'rts1_' + 'e'.repeat(64), websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' });
    // No configured native/background business work in this fixture; never use the network.
    return new Response('{}', { status: 404 });
  } });
  const extractKnowledge = async () => ({ confirmed: true }); extractKnowledge.flushPlatformCosts = async () => ({ confirmed: true });
  adapters = await createExecutionAdapterFactory({ config, instanceId, apiOrigin, clientFactory, socketFactory: Socket, extractKnowledge,
    logger: (...args) => logs.push(args), loadEngine: async () => ({ ...realEngine,
      createRuntimeExecutionHost: options => { const engine = realEngine.createRuntimeExecutionHost(options); return { ...engine,
        createExecutor: options => { const executor = engine.createExecutor(options); captures.set(options.subjectKey, executor); return executor; } }; } }) });
  host = new RuntimeHost({ config, instanceId, createExecutor: adapters.createExecutor, flushEvidence: adapters.flushEvidence,
    cleanPrivateData: adapters.cleanPrivateData, admitRelationship: adapters.admitRelationship }); await host.start();
  control = await new HostingControl({ host, clientFactory, apiOrigin, observeInventory: fixtureInventory, config: { configVersion: 1,
    socketPath: resolve(root, 'socket/control.sock'), socketGid: process.getgid(), managedRoot: resolve(root, 'managed'),
    scopes: ['fixture-owner', 'next-owner'].map(ownerJiacn => ({ tenantId: '0', clientId: 'fixture-client', ownerJiacn })), enrollmentTtlMs: 3600000,
    template: { profile: { codexBin: '/bin/true', appServerEnabled: false, fastChatEnabled: false },
      codexConfig: 'model_provider = "managed"\n[model_providers.managed]\nbase_url = "https://no-network.invalid/v1"\nenv_key = "CYF_MANAGED_PROVIDER_API_KEY"\nrequires_openai_auth = false\n',
      providerEnvironment: { CYF_MANAGED_PROVIDER_API_KEY: 'never-live-fixture' } } } }).initialize();
  const wire = JSON.parse(await readFile(new URL('./fixtures/gss-hosting-control-v1.json', import.meta.url)));
  const request = quotedPreparation(wire.prepareRequest, 'real-fixture-host'), candidate = await control.handle(request);
  await control.handle(candidateRequest(request, candidate, 'ensure')); await Promise.all([...control.jobs.values()]);
  assert.equal((await control.handle(candidateRequest(request, candidate, 'observe'))).outcome, 'SERVICE_READY', JSON.stringify(logs));
  const agent = control.subjectAgent(Object.values(control.state.subjects)[0]), old = captures.get(agent.subjectKey).state(), manager = old.skillInstallManager;
  assert.equal(manager.boundIdentity.ownerJiacn, 'fixture-owner');
  const pkg = packageFixture(); manager.fetchFn = async () => { downloaded++; return new Response(pkg.bytes, { headers: { 'content-length': String(pkg.bytes.length), 'content-type': 'application/octet-stream' } }); };
  const prepareSkill = command(pkg.target, { ...manager.boundIdentity });
  const prepared = (await manager.handle(prepareSkill)).resultEnvelope;
  assert.equal(prepared.data.evidence.outcome, 'PREPARED'); manager.acknowledgeResultReceipt(receiptFor(prepared));
  const applied = (await manager.handle(activate(prepareSkill))).resultEnvelope;
  assert.equal(applied.data.evidence.outcome, 'APPLIED'); manager.acknowledgeResultReceipt(receiptFor(applied));
  const skills = manager.listInstalledSkills({ includeRetained: true }), skillBytes = await readFile(resolve(agent.profile.codexHome, 'skills/repo-test/SKILL.md'));
  const repository = resolve(agent.profile.codexWorkdir, '.git'); await mkdir(repository); await writeFile(resolve(repository, 'history'), 'public history');
  const finish = { ...candidateRequest(request, candidate, 'quiesce'), handoverId: 'real-finish' };
  await control.handle(finish);
  assert.equal((await control.handle({ ...finish, method: 'evidence' })).outcome, 'EVIDENCE_ACCEPTED', JSON.stringify(logs));
  assert.equal((await control.handle({ ...finish, method: 'cleanup' })).outcome, 'CLEANED');
  assert.equal(old.disposed, true);
  owner = 'next-owner';
  const next = { ...request, ownerJiacn: owner, operationId: 'real-reinvite', initialIntentId: 'real-reinvite', bindingId: 'real-new-binding', leaseId: 'real-new-lease' };
  const inventory = await control.handle({ protocol: request.protocol, method: 'inventory', tenantId: next.tenantId,
    clientId: next.clientId, ownerJiacn: next.ownerJiacn, canonicalAgentId: next.canonicalAgentId });
  assert.equal(inventory.installedSkillCount, '1');
  next.quotedInventory = { hostId: inventory.hostId, inventorySha256: inventory.inventorySha256 };
  const nextCandidate = await control.handle(next);
  await control.handle(candidateRequest(next, nextCandidate, 'ensure')); await Promise.all([...control.jobs.values()]);
  assert.equal((await control.handle(candidateRequest(next, nextCandidate, 'observe'))).outcome, 'SERVICE_READY', JSON.stringify(logs));
  const current = captures.get(agent.subjectKey).state(), nextManager = current.skillInstallManager;
  assert.notEqual(current, old); assert.equal(nextManager.boundIdentity.ownerJiacn, 'next-owner');
  assert.equal(nextManager.boundIdentity.runtimeInstallationId, nextCandidate.installationId);
  assert.deepEqual(nextManager.listInstalledSkills({ includeRetained: true }), skills);
  assert.deepEqual(await readFile(resolve(agent.profile.codexHome, 'skills/repo-test/SKILL.md')), skillBytes);
  assert.equal(await readFile(resolve(repository, 'history'), 'utf8'), 'public history');
  assert.equal(downloaded, 1); assert.equal(enrollments, 2);
  const read = reconcile(command(pkg.target, { ...nextManager.boundIdentity }));
  const resultPromise = new Promise(done => { resolveResult = frame => { if (frame.data.commandId === read.data.commandId) done(frame); }; });
  sockets.at(-1).emit('message', Buffer.from(JSON.stringify(toAgentWire(read))));
  const result = await resultPromise; assert.equal(result.data.runtimeInstallationId, nextCandidate.installationId);
  assert.deepEqual(result.data.evidence.actual, pkg.target);
  nextManager.acknowledgeResultReceipt(receiptFor(result));
  assert.equal(old.skillInstallManager.session, null);
});
