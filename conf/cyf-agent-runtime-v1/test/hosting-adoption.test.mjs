import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostingFixture, fixtureInventory, quotedPreparation, candidateRequest, code } from './hosting-fixture.mjs';
import { eventMessage } from '../lib/message-envelope.mjs';
import { validateHostingRequest, hostingReply } from '../lib/hosting-wire.mjs';
import { cleanStoppedPrivateData } from '../lib/private-data-cleanup.mjs';

const association = (f, peer = f.peers[0]) => ({ protocol: 'runtime-hosting-v1', method: 'adopt',
  tenantId: peer.manifest.tenantId, clientId: peer.manifest.clientId, ownerJiacn: 'fixture-owner',
  canonicalAgentId: peer.manifest.canonicalAgentId, bindingId: 'existing-binding', leaseId: 'transition-lease',
  initialIntentId: 'transition-intent', operationId: 'transition-intent', operationKind: 'INITIAL',
  reservedAt: f.now(), requestedAt: f.now(), validUntil: null,
  installationId: peer.manifest.installationId, manifestSha256: peer.manifest.manifestSha256.slice(7), provisionGeneration: 1 });
const initial = request => { const { installationId, manifestSha256, provisionGeneration, ...rest } = request; return rest; };

test('adoption wire uses the common envelope and accepts no path, credential or quote', () => {
  const f = { peers: [{ manifest: { tenantId: '0', clientId: 'fixture-client', canonicalAgentId: 'jyt-fixture',
    installationId: 'rti_' + '1'.repeat(32), manifestSha256: 'sha256:' + 'a'.repeat(64) } }], now: () => 1791594000000 };
  const request = association(f), { protocol, method, installationId, validUntil, provisionGeneration, ...data } = request;
  const message = eventMessage('adopt-request', 'hosting.adopt', 'adopt-trace', { ...data,
    runtimeInstallationId: installationId, validUntilAt: validUntil, provisionGeneration: String(provisionGeneration) });
  assert.deepEqual(validateHostingRequest(message), request);
  assert.equal(hostingReply(message, { ...request, outcome: 'ADOPTED', hostId: 'fixture-host' }).messageType, 'hosting.adopt.result');
  for (const patch of [{ profileId: 'attacker' }, { codexHome: '/caller' }, { runtimeAuthorization: 'secret' },
    { quotedInventory: { hostId: 'fixture-host', inventorySha256: 'b'.repeat(64) } }, { provisionGeneration: '2' },
    { operationKind: 'REPROVISION', operationId: 'different', validUntilAt: f.now() + 1000 }]) {
    assert.throws(() => validateHostingRequest({ ...message, data: { ...message.data, ...patch } }));
  }
});

test('adoption preserves exact static installation, executor, private files and peer state with durable replay', async t => {
  const f = await hostingFixture(t, { staticPeers: true, observeInventory: fixtureInventory });
  const peer = f.peers[0], request = association(f), control = f.control();
  const before = f.peers.map(p => structuredClone(f.states.get(p.subjectKey)[0]));
  await writeFile(resolve(peer.profile.codexHome, 'private.txt'), 'private-canary');
  const responses = await Promise.all(Array.from({ length: 8 }, () => control.handle(request)));
  for (const response of responses) assert.deepEqual(response, { ...request, outcome: 'ADOPTED', hostId: 'fixture-host' });
  assert.deepEqual(f.peers.map(p => structuredClone(f.states.get(p.subjectKey)[0])), before);
  assert.equal(f.enrollmentCount(), 0); assert.equal(f.sessionCount(), 0);
  assert.equal(await readFile(resolve(peer.profile.codexHome, 'private.txt'), 'utf8'), 'private-canary');
  assert.equal(control.managesActivation(peer.subjectKey), false);
  control.validateJournal();
  const current = await control.handle({ ...initial(request), method: 'current' });
  assert.equal(current.installationId, peer.manifest.installationId); assert.equal(current.outcome, 'CURRENT');
  assert.equal((await control.handle({ ...request, method: 'observe' })).outcome, 'UNKNOWN');
  await f.stop(); await f.start(); f.control().resumeAdmitted(); await f.settle();
  assert.deepEqual(await f.control().handle(request), responses[0]);
  assert.equal(f.enrollmentCount(), 0); assert.equal(f.sessionCount(), 0);
  assert.equal(f.states.get(peer.subjectKey).length, 2); // only the explicit host restart
  assert.equal(f.host().snapshot().agents[0].ready, true);
});

test('adoption cannot change installation, scope, relationship or select an unconfigured subject', async t => {
  const f = await hostingFixture(t, { staticPeers: true }), request = association(f);
  for (const patch of [{ installationId: 'rti_' + 'a'.repeat(32) }, { manifestSha256: 'a'.repeat(64) },
    { canonicalAgentId: 'not-configured' }, { ownerJiacn: 'other' }, { clientId: 'other' }, { tenantId: 'other' }]) {
    await assert.rejects(f.control().handle({ ...request, ...patch }));
  }
  assert.deepEqual(f.control().state.subjects, {});
  await f.control().handle(request);
  await assert.rejects(f.control().handle({ ...request, bindingId: 'different' }), code('HOSTING_OPERATION_CONFLICT'));
  await assert.rejects(f.control().handle({ ...request, initialIntentId: 'new', operationId: 'new' }), code('HOSTING_SUBJECT_CONFLICT'));
  assert.equal(f.host().snapshot().agents.filter(agent => agent.ready).length, 3);
});

test('adopted static installation uses the same stopped evidence and private cleanup flow', async t => {
  const f = await hostingFixture(t, { staticPeers: true, observeInventory: fixtureInventory });
  const peer = f.peers[0], request = association(f); await f.control().handle(request);
  const handover = { ...request, method: 'quiesce', handoverId: 'transition-finish' };
  await writeFile(resolve(peer.profile.codexHome, 'config.toml'), 'private model config');
  await writeFile(resolve(peer.profile.codexHome, 'auth.json'), 'private credential');
  await writeFile(resolve(peer.profile.codexWorkdir, 'private.txt'), 'private work');
  await f.control().handle(handover);
  assert.equal(f.states.get(peer.subjectKey)[0].closed, 1);
  assert.equal(f.host().snapshot().agents.filter(agent => agent.ready).length, 2);
  await assert.rejects(f.control().handle({ ...handover, method: 'cleanup' }), code('RUNTIME_HANDOVER_IDENTITY_CONFLICT'));
  f.host().flushEvidence = async () => ({ confirmed: false });
  await f.control().handle({ ...handover, method: 'evidence' });
  await assert.rejects(f.control().handle({ ...handover, method: 'cleanup' }), code('RUNTIME_HANDOVER_EVIDENCE_REQUIRED'));
  f.host().flushEvidence = async () => ({ confirmed: true });
  assert.equal((await f.control().handle({ ...handover, method: 'evidence' })).outcome, 'EVIDENCE_ACCEPTED');
  f.host().cleanPrivateData = options => cleanStoppedPrivateData({ ...options, apiOrigin: 'https://example.test',
    instanceId: 'adoption-cleanup', publicFiles: options.agent.publicFiles,
    flushPlatformCosts: async () => ({ confirmed: true }), extractKnowledge: async () => ({ confirmed: true }) });
  const result = await f.control().handle({ ...handover, method: 'cleanup' });
  assert.equal(result.outcome, 'CLEANED');
  assert.equal(await readFile(resolve(peer.profile.codexHome, 'config.toml'), 'utf8'), peer.publicFiles['config.toml']);
  await assert.rejects(readFile(resolve(peer.profile.codexHome, 'auth.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(peer.profile.codexWorkdir), []);
  await f.stop(); await f.start(); f.control().resumeAdmitted(); await f.settle();
  assert.equal(f.host().snapshot().agents[0].ready, false);
  assert.deepEqual(await f.control().handle({ ...handover, method: 'cleanup' }), result);
  assert.equal(f.enrollmentCount(), 0);
  const originalHome = peer.profile.codexHome, originalManifest = peer.manifest;
  let admissions = 0;
  f.host().admitRelationship = async ({ previousAgent, agent }) => {
    admissions++;
    assert.equal(previousAgent.manifest.installationId, originalManifest.installationId);
    assert.equal(agent.profile.codexHome, originalHome);
  };
  f.advance(1000);
  const next = quotedPreparation({ ...initial(request), method: 'prepare', initialIntentId: 'next-intent',
    operationId: 'next-intent', leaseId: 'next-lease', bindingId: 'next-binding', reservedAt: f.now(), requestedAt: f.now() });
  const candidate = await f.control().handle(next);
  assert.notEqual(candidate.installationId, originalManifest.installationId);
  await f.control().handle(candidateRequest(next, candidate, 'ensure')); await f.settle();
  assert.equal((await f.control().handle(candidateRequest(next, candidate, 'observe'))).outcome, 'SERVICE_READY');
  assert.equal(admissions, 1); assert.equal(f.enrollmentCount(), 1);
  assert.equal(f.host().agents.get(peer.subjectKey).agent.profile.codexHome, originalHome);
  assert.equal(JSON.parse(await readFile(peer.manifestPath, 'utf8')).installationId, candidate.installationId);
  await assert.rejects(f.control().handle({ ...handover, method: 'cleanup' }), code('HOSTING_OPERATION_SUPERSEDED'));
  await f.stop(); await f.start(); f.control().resumeAdmitted(); await f.settle();
  assert.equal(f.control().state.subjects[peer.subjectKey].manifest.installationId, candidate.installationId);
  assert.equal(f.enrollmentCount(), 1);
});
