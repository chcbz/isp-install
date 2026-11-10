import assert from 'node:assert/strict';
import test from 'node:test';
import { eventMessage, validateMessage } from '../lib/message-envelope.mjs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { hostingFixture, candidateRequest, quotedPreparation, fixtureInventory, tick, code } from './hosting-fixture.mjs';
import { parseHostingJson, validateHostingRequest, validateHostingAssociation, hostingReply } from '../lib/hosting-wire.mjs';
import { startHostingServer } from '../lib/hosting-server.mjs';
import { digestManifest, runtimeSubjectKey, stableJson } from '../lib/manifest.mjs';
import { readPrivateJson, writePrivateJson } from '../lib/security.mjs';
const fixtureBytes = await readFile(new URL('./fixtures/gss-hosting-control-v1.json', import.meta.url));
const wire = JSON.parse(fixtureBytes);
const prepare = quotedPreparation(wire.prepareRequest);

// Frozen acceptance: exact wire and full immutable association; private journal
// before admission; no enrollment during prepare/observe; single initial enroll;
// same-installation reprovision; stale/replayed generation; lost HTTP/UDS reply;
// restart reload/live proof; subject/OS permissions; no broker or HOME adoption.

test('frozen Main synthetic fixture has exact provenance and accepted request/manifest catalogs', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '5c4b833e6db5bab3122c6dee17ef49198462aee3c3edf58f628ed8571e241403');
  for (const key of ['capabilitiesRequest', 'prepareRequest', 'ensureRequest', 'observeRequest', 'reprovisionPrepareRequest']) assert.deepEqual(validateHostingAssociation(wire[key]), wire[key]);
  assert.equal(digestManifest(wire.preparedResponse.manifest), wire.preparedResponse.manifest.manifestSha256);
  for (const key of ['preparedResponse', 'readyResponse', 'unknownResponse', 'reprovisionPreparedResponse']) {
    assert.equal(wire[key].protocol, 'runtime-hosting-v1'); assert.ok(['prepare', 'observe'].includes(wire[key].method));
  }
});

test('strict reused parser rejects duplicate/Unicode aliases and sanitizes arbitrary secret property errors', () => {
  for (const text of ['{"secret-canary":1,"secret-canary":2}', '{"method":"prepare","m\\u0065thod":"ensure"}',
    '{"a":{"x":1,"x":2}}', '{"a":1,}', '{"a":"\\ud800"}', '{"a":1e400}']) {
    assert.throws(() => parseHostingJson(text), cause => /^HOSTING_/.test(cause.code) && !cause.message.includes('secret-canary'));
  }
  assert.deepEqual({ ...parseHostingJson('{"a":1}') }, { a: 1 });
});

test('wire rejects missing/unknown credentials, unsafe generations, association aliases and unknown protocol', () => {
  for (const request of [{ ...prepare, command: 'shell' }, { ...prepare, ownerJiacn: ' fixture-owner' },
    { ...prepare, protocol: 'retired' }, { ...prepare, method: 'enroll' }, { ...prepare, validUntil: 1 },
    { ...prepare, operationId: 'other' }, { ...prepare, requestedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...wire.ensureRequest, provisionGeneration: 0 }, { ...wire.ensureRequest, manifestSha256: 'sha256:' + 'a'.repeat(64) },
    { ...wire.ensureRequest, enrollmentSecret: 'never-accepted' }]) assert.throws(() => validateHostingAssociation(request));
});

test('capabilities is exact scope and configured host, not socket existence', async t => {
  const f = await hostingFixture(t); const control = f.control();
  assert.deepEqual(await control.handle(wire.capabilitiesRequest), { ...wire.capabilitiesRequest, available: true, hostId: 'fixture-host' });
  for (const field of ['tenantId', 'clientId', 'ownerJiacn']) await assert.rejects(control.handle({ ...wire.capabilitiesRequest, [field]: 'wrong' }), code('HOSTING_SCOPE_REJECTED'));
  control.closing = true; await assert.rejects(control.handle(wire.capabilitiesRequest), code('HOSTING_CONTROL_NOT_RUNNING')); control.closing = false;
});

test('prepare concurrent replay persists one private installation/secret and has no activation or enrollment', async t => {
  const f = await hostingFixture(t); const responses = await Promise.all(Array.from({ length: 12 }, () => f.control().handle(prepare)));
  for (const response of responses) assert.deepEqual(response, responses[0]);
  const prepared = responses[0]; assert.match(prepared.installationId, /^rti_[a-f0-9]{32}$/); assert.equal(prepared.provisionGeneration, 1);
  assert.equal(prepared.protocol, prepare.protocol); assert.equal(prepared.method, 'prepare'); assert.equal(prepared.outcome, 'PREPARED');
  assert.equal(prepared.manifest.manifestSha256, 'sha256:' + prepared.manifestSha256);
  const path = f.control().path; const stat = await lstat(path); assert.equal(stat.mode & 0o777, 0o600);
  const stored = await readPrivateJson(path); const subject = Object.values(stored.subjects)[0];
  assert.equal(createHash('sha256').update(subject.enrollmentSecret).digest('hex'), prepared.enrollmentSecretSha256);
  assert.equal(JSON.stringify(prepared).includes(subject.enrollmentSecret), false); assert.equal(f.enrollmentCount(), 0); assert.equal(f.host().agents.size, 3);
  const observed = await f.control().handle(candidateRequest(prepare, prepared, 'observe')); assert.equal(observed.outcome, 'UNKNOWN');
  assert.equal(f.enrollmentCount(), 0); assert.equal(f.host().agents.size, 3);
  await assert.rejects(f.control().handle({ ...prepare, bindingId: 'other' }), code('HOSTING_OPERATION_CONFLICT'));
});

test('immutable association cannot be reused across owners, subjects, scopes or changed ensure candidate', async t => {
  const f = await hostingFixture(t); const prepared = await f.control().handle(prepare);
  for (const field of ['canonicalAgentId', 'bindingId', 'leaseId', 'initialIntentId', 'reservedAt', 'requestedAt']) {
    const request = candidateRequest(prepare, prepared, 'ensure'); request[field] = typeof request[field] === 'number' ? request[field] + 1 : request[field] + '-wrong';
    await assert.rejects(f.control().handle(request));
  }
  await assert.rejects(f.control().handle({ ...prepare, canonicalAgentId: 'agt_different' }), code('HOSTING_OPERATION_CONFLICT'));
  for (const field of ['installationId', 'manifestSha256', 'provisionGeneration']) {
    const request = candidateRequest(prepare, prepared, 'ensure'); request[field] = field === 'provisionGeneration' ? 2 : field === 'installationId' ? 'rti_' + 'd'.repeat(32) : 'd'.repeat(64);
    await assert.rejects(f.control().handle(request), code('HOSTING_ASSOCIATION_REJECTED'));
  }
  assert.equal(f.enrollmentCount(), 0);
});

test('ensure replay starts one native enroll/session and adds one subject to SAME host without peer mutation', async t => {
  const f = await hostingFixture(t); const peerStates = f.peers.map(peer => structuredClone(f.states.get(peer.subjectKey)[0]));
  const prepared = await f.control().handle(prepare); const ensure = candidateRequest(prepare, prepared, 'ensure');
  await Promise.all(Array.from({ length: 10 }, () => f.control().handle(ensure))); await f.settle();
  const ready = await f.control().handle({ ...ensure, method: 'observe' });
  assert.equal(ready.outcome, 'SERVICE_READY'); assert.equal(ready.provisionGeneration, 1); assert.equal(ready.runtimeInstanceId, f.host().instanceId);
  assert.equal(ready.executorReady, true); assert.equal(ready.durableReady, true); assert.equal(f.enrollmentCount(), 1); assert.equal(f.sessionCount(), 1); assert.equal(f.host().agents.size, 4);
  assert.deepEqual(f.peers.map(peer => structuredClone(f.states.get(peer.subjectKey)[0])), peerStates);
  assert.equal((await f.control().handle(ensure)).outcome, 'SERVICE_READY'); assert.equal(f.enrollmentCount(), 1); assert.equal(f.sessionCount(), 1);
  const journal = await readPrivateJson(f.control().path); const secret = Object.values(journal.subjects)[0].enrollmentSecret;
  assert.equal(JSON.stringify(ready).includes(secret), false); assert.equal(JSON.stringify(ready).includes('rta1_'), false);
});

test('free reprovision allocates once, same install/manifest/secret expiry; closes only subject and gets fresh session', async t => {
  const f = await hostingFixture(t); const initial = await f.control().handle(prepare); const ensure = candidateRequest(prepare, initial, 'ensure');
  await f.control().handle(ensure); await f.settle(); const before = await f.control().handle({ ...ensure, method: 'observe' }); f.advance(3000);
  const reprepare = wire.reprovisionPrepareRequest;
  const results = await Promise.all(Array.from({ length: 8 }, () => f.control().handle(reprepare))); const candidate = results[0];
  for (const result of results) assert.deepEqual(result, candidate);
  assert.equal(candidate.provisionGeneration, 2);
  for (const field of ['installationId', 'manifestSha256', 'enrollmentSecretSha256', 'enrollmentExpiresAt']) assert.equal(candidate[field], initial[field]);
  const repro = candidateRequest(reprepare, candidate, 'ensure'); await f.control().handle(repro); await f.settle();
  const after = await f.control().handle({ ...repro, method: 'observe' }); assert.equal(after.outcome, 'SERVICE_READY'); assert.equal(after.provisionGeneration, 2);
  assert.ok(BigInt(after.sessionGeneration) > BigInt(before.sessionGeneration)); assert.ok(after.registeredAt >= reprepare.requestedAt); assert.equal(f.enrollmentCount(), 1);
  assert.equal(f.sessionCount(), 2); assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'UNKNOWN');
  await f.control().handle(repro); await f.settle(); assert.equal(f.sessionCount(), 2);
  for (const peer of f.peers) { assert.equal(f.states.get(peer.subjectKey).length, 1); assert.equal(f.states.get(peer.subjectKey)[0].closed, 0); }
  const dynamic = [...f.states.entries()].find(([key]) => !f.peers.some(peer => peer.subjectKey === key))[1];
  assert.equal(dynamic.length, 2); assert.equal(dynamic[0].closed, 1); assert.equal(dynamic[1].closed, 0);
});

test('reprovision requires exact original association and unexpired lease; allocation overflow refuses', async t => {
  const f = await hostingFixture(t); await f.control().handle(prepare);
  for (const field of ['ownerJiacn', 'bindingId', 'leaseId', 'initialIntentId', 'reservedAt']) await assert.rejects(f.control().handle({ ...wire.reprovisionPrepareRequest,
    [field]: typeof wire.reprovisionPrepareRequest[field] === 'number' ? wire.reprovisionPrepareRequest[field] + 1 : 'other' }));
  f.advance(3000); await assert.rejects(f.control().handle({ ...wire.reprovisionPrepareRequest, validUntil: f.now() }), code('HOSTING_WIRE_INVALID'));
  const key = Object.keys(f.control().state.subjects)[0]; f.control().state.subjects[key].latestGeneration = Number.MAX_SAFE_INTEGER;
  await assert.rejects(f.control().handle(wire.reprovisionPrepareRequest), code('HOSTING_GENERATION_EXHAUSTED'));
});

test('enrollment-response loss persists recovery marker and never reuses consumed secret on ensure/restart', async t => {
  const f = await hostingFixture(t, { loseEnrollment: true }); const candidate = await f.control().handle(prepare); const ensure = candidateRequest(prepare, candidate, 'ensure');
  await f.control().handle(ensure); await f.settle(); assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'RECOVERY_REQUIRED');
  assert.equal(f.enrollmentCount(), 1); await f.control().handle(ensure); await f.settle(); assert.equal(f.enrollmentCount(), 1);
  await f.stop(); await f.start(); f.control().resumeAdmitted(); await f.settle();
  assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'RECOVERY_REQUIRED'); assert.equal(f.enrollmentCount(), 1);
});

test('restart reloads admitted dynamic subjects only and rejects stale persisted/live READY until fresh registration', async t => {
  const f = await hostingFixture(t); const candidate = await f.control().handle(prepare); const ensure = candidateRequest(prepare, candidate, 'ensure');
  await f.control().handle(ensure); await f.settle(); const prior = await f.control().handle({ ...ensure, method: 'observe' });
  const otherPrepare = { ...prepare, canonicalAgentId: 'agt_prepared_only', initialIntentId: 'hri_prepared_only', operationId: 'hri_prepared_only' };
  await f.control().handle(otherPrepare); await f.stop(); f.advance(); await f.start();
  assert.equal(f.host().agents.size, 3); assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'UNKNOWN');
  f.control().resumeAdmitted(); await f.settle(); const fresh = await f.control().handle({ ...ensure, method: 'observe' });
  assert.equal(fresh.outcome, 'SERVICE_READY'); assert.notEqual(fresh.runtimeInstanceId, prior.runtimeInstanceId); assert.ok(BigInt(fresh.sessionGeneration) > BigInt(prior.sessionGeneration));
  assert.equal(f.host().agents.size, 4); assert.equal(f.enrollmentCount(), 1); assert.equal((await f.control().handle(prepare)).installationId, candidate.installationId);
});

test('live readiness is fresh exact session/durable/executor/operation proof, not prior online or persisted snapshot', async t => {
  const f = await hostingFixture(t); const candidate = await f.control().handle(prepare); const ensure = candidateRequest(prepare, candidate, 'ensure');
  await f.control().handle(ensure); await f.settle(); const key = Object.keys(f.control().state.subjects)[0]; const state = f.states.get(key).at(-1); const proof = { ...state.proof };
  for (const mutation of [{ executorReady: false }, { durableReady: false }, { sessionGeneration: 0 }, { runtimeInstanceId: 'old' },
    { hostId: 'wrong' }, { installationId: 'wrong' }, { tenantId: 'other' }, { registeredAt: prepare.requestedAt - 1 }, { serviceReadyAt: proof.registeredAt - 1 }]) {
    state.proof = { ...proof, ...mutation }; assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'UNKNOWN');
  }
  state.proof = proof; assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'SERVICE_READY');
  state.ready = false; assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'UNKNOWN');
});

test('prepared journal corruption and unmanaged existing roots fail closed without enrollment or adoption', async t => {
  const f = await hostingFixture(t); const candidate = await f.control().handle(prepare); const journal = await readPrivateJson(f.control().path);
  const [key, subject] = Object.entries(journal.subjects)[0]; const original = stableJson(journal);
  const root = resolve(f.controlConfig.managedRoot, key); await mkdir(root, { mode: 0o700 });
  await f.control().handle(candidateRequest(prepare, candidate, 'ensure')); await f.settle(); assert.equal(f.enrollmentCount(), 0);
  assert.deepEqual(await readdir(root), []); await f.stop();
  subject.manifest.clientId = 'tampered'; await writePrivateJson(f.control().path, journal);
  await assert.rejects(f.start());
  assert.equal(f.enrollmentCount(), 0); assert.notEqual(stableJson(await readPrivateJson(f.control().path)), original);
});

function exchange(path, bytes) {
  return new Promise((done, reject) => { const socket = connect(path); let response = '';
    socket.on('connect', () => socket.write(bytes)); socket.on('error', reject); socket.on('data', bytes => { response += bytes; }); socket.on('end', () => done(JSON.parse(response))); });
}

function messageOf(internal) {
  const { protocol, method, ...data } = internal;
  if (Object.hasOwn(data, 'validUntil')) { data.validUntilAt = data.validUntil; delete data.validUntil; }
  if (Object.hasOwn(data, 'installationId')) { data.runtimeInstallationId = data.installationId; delete data.installationId; }
  if (Object.hasOwn(data, 'provisionGeneration')) data.provisionGeneration = String(data.provisionGeneration);
  return eventMessage('hosting-fixture-request', `hosting.${method}`, 'hosting-fixture-message', data);
}
async function wireExchange(path, internal) {
  const request = messageOf(internal);
  const reply = validateMessage(await exchange(path, JSON.stringify(request) + '\n'));
  assert.equal(reply.requestId, request.requestId); assert.equal(reply.correlationId, request.messageId);
  assert.equal(reply.messageType, `${request.messageType}.result`); assert.equal(reply.code, 'E0');
  return reply.data;
}

test('private UDS uses closed correlated envelopes, preserves scope and rejects old wire/duplicates', async t => {
  const f = await hostingFixture(t); const server = await startHostingServer({ control: f.control() }); t.after(() => server.close());
  const stat = await lstat(f.controlConfig.socketPath); assert.equal(stat.mode & 0o777, 0o660); assert.equal(stat.gid, f.controlConfig.socketGid);
  const inventoryRequest = { protocol: 'runtime-hosting-v1', method: 'inventory', tenantId: prepare.tenantId,
    clientId: prepare.clientId, ownerJiacn: prepare.ownerJiacn, canonicalAgentId: prepare.canonicalAgentId };
  assert.equal((await wireExchange(f.controlConfig.socketPath, inventoryRequest)).installedSkillCount, '0');
  const candidate = await wireExchange(f.controlConfig.socketPath, prepare); assert.equal(candidate.outcome, 'PREPARED');
  assert.equal(candidate.provisionGeneration, '1'); assert.equal(candidate.validUntilAt, null);
  assert.match(candidate.runtimeInstallationId, /^rti_[0-9a-f]{32}$/); assert.equal(Object.hasOwn(candidate, 'installationId'), false);
  assert.deepEqual(await wireExchange(f.controlConfig.socketPath, prepare), candidate);
  const duplicate = await exchange(f.controlConfig.socketPath, JSON.stringify(messageOf(prepare)).replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1') + '\n');
  assert.equal(duplicate.messageType, 'protocol.error'); assert.equal(duplicate.data.reasonCode, 'HOSTING_DUPLICATE_FIELD');
  const invalid = await exchange(f.controlConfig.socketPath, JSON.stringify(messageOf({ ...prepare, command: 'do-not-run' })) + '\n');
  assert.equal(invalid.code, 'HOSTING_FIELD_FORBIDDEN'); assert.equal(invalid.data, null); assert.equal(invalid.correlationId, 'hosting-fixture-message');
  const legacy = await exchange(f.controlConfig.socketPath, JSON.stringify(prepare) + '\n'); assert.equal(legacy.messageType, 'protocol.error');
  assert.equal((await wireExchange(f.controlConfig.socketPath, wire.capabilitiesRequest)).available, true);
  assert.equal(f.enrollmentCount(), 0); await server.close();
});

test('hosting projection round-trips private fixture association without changing manifest or journal schema', () => {
  for (const key of ['capabilitiesRequest', 'prepareRequest', 'ensureRequest', 'observeRequest', 'reprovisionPrepareRequest'])
    assert.deepEqual(validateHostingRequest(messageOf(wire[key])), wire[key]);
  assert.throws(() => validateHostingRequest(wire.prepareRequest));
  const request = messageOf(wire.ensureRequest); request.data.provisionGeneration = 1;
  assert.throws(() => validateHostingRequest(request));
  request.data.provisionGeneration = '9007199254740992'; assert.throws(() => validateHostingRequest(request));
});

test('UDS rejects unsafe world/writable parents and existing files/listeners without unlinking them', async t => {
  const f = await hostingFixture(t);
  for (const mode of [0o755, 0o770, 0o777, 0o700]) {
    await chmod(resolve(f.root, 'socket'), mode); await assert.rejects(startHostingServer({ control: f.control() }), code('HOSTING_SOCKET_PARENT_UNSAFE'));
  }
  await chmod(resolve(f.root, 'socket'), 0o750); await writeFile(f.controlConfig.socketPath, 'unknown-owned-file', { mode: 0o600 });
  await assert.rejects(startHostingServer({ control: f.control() }), code('HOSTING_SOCKET_EXISTS'));
  assert.equal(await readFile(f.controlConfig.socketPath, 'utf8'), 'unknown-owned-file');
});

const until = async predicate => { for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(done => setTimeout(done, 1)); assert.ok(predicate(), 'synthetic lifecycle reached expected event'); };

test('lost actual ensure UDS response recovers identical admission without another installation/enrollment/session', async t => {
  const f = await hostingFixture(t); const server = await startHostingServer({ control: f.control() }); t.after(() => server.close());
  const candidate = await wireExchange(f.controlConfig.socketPath, prepare); const ensure = candidateRequest(prepare, { installationId: candidate.runtimeInstallationId, manifestSha256: candidate.manifestSha256, provisionGeneration: Number(candidate.provisionGeneration) }, 'ensure');
  // Parent disconnects after write completion, before consuming any response.
  await new Promise((done, reject) => {
    const socket = connect(f.controlConfig.socketPath); socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(messageOf(ensure)) + '\n', () => { socket.destroy(); done(); }));
  });
  await until(() => Object.values(f.control().state.operations).some(operation => operation.admittedAt !== null)); await f.settle();
  const response = await wireExchange(f.controlConfig.socketPath, ensure); assert.equal(response.outcome, 'SERVICE_READY');
  assert.equal(response.runtimeInstallationId, candidate.runtimeInstallationId); assert.equal(f.enrollmentCount(), 1); assert.equal(f.sessionCount(), 1);
  await server.close();
});

test('reprovision supersedes pending registration through subject cancellation, not shared host restart', async t => {
  const f = await hostingFixture(t, { stalled: true }); const candidate = await f.control().handle(prepare);
  const ensure = candidateRequest(prepare, candidate, 'ensure'); await f.control().handle(ensure); await until(() => !!f.pending());
  assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'UNKNOWN');
  const old = f.pending(); f.advance(3000); const reprepare = wire.reprovisionPrepareRequest;
  const reproCandidate = await f.control().handle(reprepare); const repro = candidateRequest(reprepare, reproCandidate, 'ensure');
  await f.control().handle(repro); await until(() => f.pending() !== old); f.pending().release(); await f.settle();
  assert.equal(old.closed, 1); assert.equal(f.enrollmentCount(), 1); assert.equal(f.sessionCount(), 2);
  assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'UNKNOWN');
  assert.equal((await f.control().handle({ ...repro, method: 'observe' })).outcome, 'SERVICE_READY');
  for (const peer of f.peers) assert.equal(f.states.get(peer.subjectKey)[0].closed, 0);
});

test('clean shutdown while registration pending reloads admission without marking false recovery or reenrolling', async t => {
  const f = await hostingFixture(t, { stalled: true }); const candidate = await f.control().handle(prepare); const ensure = candidateRequest(prepare, candidate, 'ensure');
  await f.control().handle(ensure); await until(() => !!f.pending()); const old = f.pending(); await f.stop();
  assert.equal(Object.values((await readPrivateJson(f.control().path)).operations)[0].recoveryRequired, false);
  f.advance(); await f.start(); f.control().resumeAdmitted(); await until(() => f.pending() !== old); f.pending().release(); await f.settle();
  const ready = await f.control().handle({ ...ensure, method: 'observe' }); assert.equal(ready.outcome, 'SERVICE_READY');
  assert.equal(ready.sessionGeneration, '2'); assert.equal(f.enrollmentCount(), 1);
});

test('journal write uncertainty closes admission and every queued mutation, preserving unknown durable result', async t => {
  const f = await hostingFixture(t); const before = await readFile(f.control().path, 'utf8'); await chmod(f.control().path, 0o640);
  const inputs = Array.from({ length: 3 }, (_, i) => ({ ...prepare, canonicalAgentId: `agt_write-${i}`, operationId: `hri_write-${i}`, initialIntentId: `hri_write-${i}` }));
  const results = await Promise.allSettled(inputs.map(input => f.control().handle(input)));
  assert.equal(results.every(result => result.status === 'rejected'), true); assert.equal(f.control().closing, true); assert.equal(f.control().journalFailed, true);
  await assert.rejects(f.control().mutate(() => { throw Error('must never run'); }), code('HOSTING_JOURNAL_WRITE_UNCONFIRMED'));
  assert.equal(await readFile(f.control().path, 'utf8'), before); assert.equal(f.enrollmentCount(), 0); await chmod(f.control().path, 0o600);
});

test('persisted journal rejects extra fields, orphan operation, duplicate installation and noncontiguous generations', async t => {
  const f = await hostingFixture(t); await f.control().handle(prepare); const pristine = structuredClone(f.control().state);
  const [subjectKey, subject] = Object.entries(pristine.subjects)[0]; const operationKey = Object.keys(pristine.operations)[0];
  const changes = [state => { state.extra = true; }, state => { state.subjects[subjectKey].extra = true; }, state => { state.operations[operationKey].extra = true; },
    state => { state.subjects[subjectKey].latestGeneration = 2; }, state => { state.subjects[subjectKey].lastSessionGeneration = -1; },
    state => { state.subjects[subjectKey].activeOperationKey = 'missing'; }, state => { state.operations[operationKey].subjectKey = 'missing'; },
    state => { state.operations[operationKey].provisionGeneration = 2; }, state => { state.operations[operationKey].recoveryRequired = 'false'; },
    state => { state.subjects[subjectKey].enrollmentSecret = 'f'.repeat(64); }, state => { state.subjects[subjectKey].initialAssociation.ownerJiacn = 'wrong'; },
    state => { state.subjects[subjectKey].template.providerEnvironment.HOME = '/other/user'; }];
  for (const change of changes) { const modified = structuredClone(pristine); change(modified); f.control().state = modified; assert.throws(() => f.control().validateJournal()); }
  f.control().state = pristine; assert.doesNotThrow(() => f.control().validateJournal()); assert.equal(f.enrollmentCount(), 0);
});

test('managed restart honors durable handover without creating a new executor, enrollment or recovery failure', async t => {
  const f = await hostingFixture(t); const candidate = await f.control().handle(prepare);
  const ensure = candidateRequest(prepare, candidate, 'ensure');
  await f.control().handle(ensure); await f.settle();
  const key = Object.keys(f.control().state.subjects)[0];
  const operationKey = f.control().state.subjects[key].activeOperationKey;
  const request = { installationId: candidate.installationId, operationId: 'final-handover' };
  await f.host().quiesceAgent(key, request);
  assert.equal((await f.control().handle({ ...ensure, method: 'observe' })).outcome, 'UNKNOWN');
  await f.stop(); f.advance(); await f.start();
  f.control().resumeAdmitted(); await f.settle();
  assert.equal(f.enrollmentCount(), 1); assert.equal(f.sessionCount(), 1);
  assert.equal(f.states.get(key).length, 1); assert.equal(f.states.get(key)[0].closed, 1);
  assert.equal(f.host().snapshot().agents.find(agent => agent.subjectKey === key).phase, 'QUIESCED');
  assert.equal(f.control().state.operations[operationKey].recoveryRequired, false);
  const journal = await readPrivateJson(f.control().path);
  assert.equal(journal.operations[operationKey].recoveryRequired, false);
  assert.equal(journal.subjects[key].activeOperationKey, operationKey);
  assert.equal((await f.control().handle(ensure)).outcome, 'UNKNOWN');
  assert.equal((await f.host().quiesceAgent(key, request)).phase, 'QUIESCED');
  for (const peer of f.peers) assert.equal(f.host().snapshot().agents.find(agent => agent.subjectKey === peer.subjectKey).ready, true);
});

test('quiesce shared public fixture preserves current generation and distinct handover identity', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hosting-quiesce-v1.json', import.meta.url)));
  const request = validateHostingRequest(fixture.request);
  assert.equal(request.method, 'quiesce'); assert.equal(request.handoverId, 'finish-fixture-lease');
  assert.equal(request.provisionGeneration, 1);
  const { hostingReply } = await import('../lib/hosting-wire.mjs');
  const reply = hostingReply(fixture.request, { ...request, outcome: 'QUIESCED', hostId: 'fixture-host' });
  assert.deepEqual({ ...reply, messageId: fixture.reply.messageId }, fixture.reply);
  for (const changed of [{ handoverId: '' }, { handoverId: null }, { privatePath: '/tmp/forbidden' }])
    assert.throws(() => validateHostingAssociation({ ...request, ...changed }));
});

test('authenticated quiesce stops only current relationship, is durable and never reports cleanup', async t => {
  const f = await hostingFixture(t); const control = f.control();
  const candidate = await control.handle(prepare);
  const request = { ...candidateRequest(prepare, candidate, 'quiesce'), handoverId: 'finish-one' };
  await assert.rejects(control.handle(request), code('HOSTING_OPERATION_SUPERSEDED'));
  await control.handle(candidateRequest(prepare, candidate, 'ensure')); await f.settle();
  for (const field of ['ownerJiacn', 'leaseId', 'bindingId', 'installationId', 'manifestSha256']) {
    const changed = field === 'installationId' ? 'rti_' + 'd'.repeat(32) : field === 'manifestSha256' ? 'd'.repeat(64) : 'wrong';
    await assert.rejects(control.handle({ ...request, [field]: changed }));
  }
  const stopped = await control.handle(request);
  assert.deepEqual(stopped, { ...request, outcome: 'QUIESCED', hostId: 'fixture-host' });
  assert.equal(Object.hasOwn(stopped, 'cleanupComplete'), false);
  assert.deepEqual(await control.handle(request), stopped);
  await assert.rejects(control.handle({ ...request, handoverId: 'other' }), code('RUNTIME_HANDOVER_CONFLICT'));
  const reenroll = { ...wire.reprovisionPrepareRequest, operationId: 'not-allowed-after-quiesce' };
  await assert.rejects(control.handle(reenroll), code('RUNTIME_HANDOVER_PENDING'));
  const sessions = f.sessionCount(); await f.stop(); await f.start(); f.control().resumeAdmitted(); await f.settle();
  assert.deepEqual(await f.control().handle(request), stopped); assert.equal(f.sessionCount(), sessions);
  assert.equal(f.host().snapshot().agents.filter(a => a.ready).length, 3);
});

test('late prior-generation quiesce cannot stop a reprovisioned current executor', async t => {
  const f = await hostingFixture(t); const control = f.control(); const initial = await control.handle(prepare);
  await control.handle(candidateRequest(prepare, initial, 'ensure')); await f.settle();
  const next = await control.handle(wire.reprovisionPrepareRequest);
  await control.handle(candidateRequest(wire.reprovisionPrepareRequest, next, 'ensure')); await f.settle();
  await assert.rejects(control.handle({ ...candidateRequest(prepare, initial, 'quiesce'), handoverId: 'stale' }), code('HOSTING_OPERATION_SUPERSEDED'));
  const request = { ...candidateRequest(wire.reprovisionPrepareRequest, next, 'quiesce'), handoverId: 'current' };
  assert.equal((await control.handle(request)).outcome, 'QUIESCED');
});

test('quiesce interrupts pending subject registration and joins its job without stopping peers', async t => {
  const f = await hostingFixture(t, { stalled: true }); const candidate = await f.control().handle(prepare);
  await f.control().handle(candidateRequest(prepare, candidate, 'ensure')); await until(() => !!f.pending());
  const result = await f.control().handle({ ...candidateRequest(prepare, candidate, 'quiesce'), handoverId: 'finish-pending' });
  assert.equal(result.outcome, 'QUIESCED'); assert.equal(f.control().jobs.size, 0);
  assert.equal(Object.values(f.control().state.operations)[0].recoveryRequired, false);
  assert.equal(f.host().snapshot().agents.filter(a => a.ready).length, 3);
});

test('evidence wire shares the exact original relation and does not assert cleanup', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hosting-evidence-v1.json', import.meta.url)));
  const request = validateHostingRequest(fixture.request);
  assert.equal(request.method, 'evidence'); assert.equal(request.handoverId, 'finish-fixture-lease');
  const reply = hostingReply(fixture.request, { ...request, outcome: 'EVIDENCE_ACCEPTED', hostId: 'fixture-host' });
  assert.deepEqual({ ...reply, messageId: fixture.reply.messageId }, fixture.reply);
});

test('original evidence is sent only after stop and exact relation match, pending retries do not release or restart', async t => {
  const f = await hostingFixture(t); const control = f.control(), candidate = await control.handle(prepare);
  await control.handle(candidateRequest(prepare, candidate, 'ensure')); await f.settle();
  const request = { ...candidateRequest(prepare, candidate, 'evidence'), handoverId: 'finish-evidence' };
  let confirmed = false, sends = 0;
  const deliver = async ({ ownerJiacn }) => { assert.equal(ownerJiacn, prepare.ownerJiacn); sends++; return { confirmed }; };
  f.host().flushEvidence = deliver;
  await assert.rejects(control.handle(request), code('RUNTIME_HANDOVER_STATE_INVALID')); assert.equal(sends, 0);
  await control.handle({ ...request, method: 'quiesce' });
  for (const field of ['ownerJiacn', 'leaseId', 'bindingId', 'handoverId']) await assert.rejects(control.handle({ ...request, [field]: 'wrong' }));
  assert.equal(sends, 0);
  assert.equal((await control.handle(request)).outcome, 'EVIDENCE_PENDING'); assert.equal(sends, 1);
  confirmed = true;
  const response = await control.handle(request); assert.equal(response.outcome, 'EVIDENCE_ACCEPTED');
  assert.equal(Object.hasOwn(response, 'cleanupComplete'), false);
  assert.deepEqual(await control.handle(request), response); assert.equal(sends, 2);
  const sessions = f.sessionCount(); await f.stop(); await f.start(); f.host().flushEvidence = deliver;
  f.control().resumeAdmitted(); await f.settle();
  assert.deepEqual(await f.control().handle(request), response); assert.equal(sends, 2); assert.equal(f.sessionCount(), sessions);
  await assert.rejects(f.control().handle({ ...wire.reprovisionPrepareRequest, operationId: 'forbidden-after-evidence' }), code('RUNTIME_HANDOVER_PENDING'));
});

test('cleanup wire binds original relation and refuses caller-selected public files or paths', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hosting-cleanup-v1.json', import.meta.url)));
  const original = fixture.request;
  const request = { ...original, messageType: 'hosting.cleanup' };
  const decoded = validateHostingRequest(request);
  assert.equal(decoded.method, 'cleanup'); assert.equal(decoded.handoverId, 'finish-fixture-lease');
  for (const patch of [{ publicFiles: { 'config.toml': 'caller' } }, { codexHome: '/tmp/caller' }, { handoverId: '' }])
    assert.throws(() => validateHostingRequest({ ...request, data: { ...request.data, ...patch } }));
  assert.equal(hostingReply(request, { ...decoded, outcome: 'CLEANED', hostId: 'host' }).messageType, 'hosting.cleanup.result');
});

test('cleanup control uses trusted saved template, requires evidence and preserves stopped association across restart', async t => {
  const { cleanStoppedPrivateData } = await import('../lib/private-data-cleanup.mjs');
  const { writeFile } = await import('node:fs/promises');
  const f = await hostingFixture(t), control = f.control(), candidate = await control.handle(prepare);
  await control.handle(candidateRequest(prepare, candidate, 'ensure')); await f.settle();
  const request = { ...candidateRequest(prepare, candidate, 'cleanup'), handoverId: 'finish-cleanup' };
  const subject = Object.values(control.state.subjects)[0], agent = control.subjectAgent(subject);
  await writeFile(resolve(agent.profile.codexHome, 'config.toml'), 'private user config');
  await writeFile(resolve(agent.profile.codexHome, 'auth.json'), 'private credential');
  await writeFile(resolve(agent.profile.codexWorkdir, 'private'), 'private task');
  let cleans = 0;
  f.host().cleanPrivateData = options => {
    cleans++; return cleanStoppedPrivateData({ ...options, apiOrigin: 'https://example.test', instanceId: 'cleanup',
      publicFiles: options.agent.publicFiles, flushPlatformCosts: async () => ({ confirmed: true }), extractKnowledge: async () => ({ confirmed: true }) });
  };
  await assert.rejects(control.handle(request), code('RUNTIME_HANDOVER_STATE_INVALID'));
  await control.handle({ ...request, method: 'quiesce' });
  f.host().flushEvidence = async () => ({ confirmed: false });
  await control.handle({ ...request, method: 'evidence' });
  await assert.rejects(control.handle(request), code('RUNTIME_HANDOVER_EVIDENCE_REQUIRED')); assert.equal(cleans, 0);
  f.host().flushEvidence = async () => ({ confirmed: true }); await control.handle({ ...request, method: 'evidence' });
  for (const patch of [{ handoverId: 'other' }, { ownerJiacn: 'other' }, { bindingId: 'other' }, { provisionGeneration: 9 }])
    await assert.rejects(control.handle({ ...request, ...patch }));
  assert.equal(cleans, 0);
  const result = await control.handle(request); assert.equal(result.outcome, 'CLEANED'); assert.equal(cleans, 1);
  assert.equal(await readFile(resolve(agent.profile.codexHome, 'config.toml'), 'utf8'), subject.template.codexConfig);
  await assert.rejects(readFile(resolve(agent.profile.codexHome, 'auth.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(agent.profile.codexWorkdir), []);
  assert.deepEqual(await control.handle(request), result); assert.equal(cleans, 1);
  const sessions = f.sessionCount(); await f.stop(); await f.start(); f.control().resumeAdmitted(); await f.settle();
  assert.deepEqual(await f.control().handle(request), result); assert.equal(f.sessionCount(), sessions);
  await assert.rejects(f.control().handle({ ...wire.reprovisionPrepareRequest, operationId: 'no-readmission' }), code('RUNTIME_HANDOVER_PENDING'));
});

test('current lookup is read-only and selects admitted operation rather than highest prepared generation', async t => {
  const f = await hostingFixture(t);
  const prepared = await f.control().handle(prepare);
  const current = { ...wire.prepareRequest, method: 'current' };
  const before = await readFile(f.control().path, 'utf8');
  assert.equal((await f.control().handle(current)).outcome, 'UNKNOWN');
  assert.equal(await readFile(f.control().path, 'utf8'), before);
  assert.equal(f.enrollmentCount(), 0);
  await f.control().handle(candidateRequest(prepare, prepared, 'ensure')); await f.settle();
  f.advance(1000);
  const newer = await f.control().handle(wire.reprovisionPrepareRequest);
  const allocated = await readFile(f.control().path, 'utf8');
  const active = await f.control().handle(current);
  assert.equal(active.operationId, prepare.operationId); assert.equal(active.provisionGeneration, 1);
  assert.equal(active.outcome, 'CURRENT'); assert.equal(newer.provisionGeneration, 2);
  assert.equal(await readFile(f.control().path, 'utf8'), allocated);
  assert.equal(f.enrollmentCount(), 1); assert.equal(f.sessionCount(), 1);
  const request = eventMessage('current-fixture-request', 'hosting.current', 'current-fixture-message', { ...(() => {
    const { protocol, method, validUntil, ...data } = current; return { ...data, validUntilAt: validUntil };
  })() });
  assert.deepEqual(validateHostingRequest(request), current);
  const reply = hostingReply(request, active);
  assert.equal(reply.data.provisionGeneration, '1');
  assert.equal(reply.data.runtimeInstallationId, prepared.installationId);
  for (const field of ['bindingId', 'leaseId', 'initialIntentId'])
    await assert.rejects(f.control().handle({ ...current, [field]: 'foreign', ...(field === 'initialIntentId' ? { operationId: 'foreign' } : {}) }), code('HOSTING_ASSOCIATION_REJECTED'));
  await assert.rejects(f.control().handle({ ...wire.reprovisionPrepareRequest, method: 'current' }), code('HOSTING_WIRE_INVALID'));
  await f.control().handle(candidateRequest(wire.reprovisionPrepareRequest, newer, 'ensure')); await f.settle();
  const updated = await f.control().handle(current);
  assert.equal(updated.operationId, wire.reprovisionPrepareRequest.operationId);
  assert.equal(updated.provisionGeneration, 2);
  await f.stop(); await f.start();
  assert.deepEqual(await f.control().handle(current), updated);
});

test('shared current-operation fixture uses original initial query and active association reply', async () => {
  const shared = JSON.parse(await readFile(new URL('./fixtures/hosting-current-v1.json', import.meta.url)));
  assert.deepEqual(validateHostingAssociation(shared.request), shared.request);
  assert.equal(shared.request.operationKind, 'INITIAL');
  assert.equal(shared.response.operationKind, 'REPROVISION');
  const { protocol, method, validUntil, ...data } = shared.request;
  const query = eventMessage('fixture-current-request', 'hosting.current', 'fixture-current-message', { ...data, validUntilAt: validUntil });
  const reply = hostingReply(query, shared.response);
  assert.equal(reply.data.provisionGeneration, '2');
  assert.equal(reply.data.operationId, shared.response.operationId);
  assert.equal(reply.correlationId, query.messageId);
});

test('prepared reprovision cannot change admitted operation after permanent quiesce', async t => {
  const f = await hostingFixture(t); const control = f.control();
  const first = await control.handle(prepare);
  await control.handle(candidateRequest(prepare, first, 'ensure')); await f.settle();
  const pending = await control.handle(wire.reprovisionPrepareRequest);
  await control.handle({ ...candidateRequest(prepare, first, 'quiesce'), handoverId: 'finish-before-ensure' });
  const before = await readFile(control.path, 'utf8');
  await assert.rejects(control.handle(candidateRequest(wire.reprovisionPrepareRequest, pending, 'ensure')), code('RUNTIME_HANDOVER_PENDING'));
  assert.equal(await readFile(control.path, 'utf8'), before);
  assert.equal((await control.handle({ ...wire.prepareRequest, method: 'current' })).provisionGeneration, 1);
  assert.equal(f.sessionCount(), 1);
});

test('format1 journal upgrades exact candidate facts once without enrollment or changed prepared bytes', async t => {
  const f = await hostingFixture(t), control = f.control();
  const original = await control.handle(prepare), path = control.path;
  delete original.quotedInventory;
  const legacy = await readPrivateJson(path); legacy.formatVersion = 1;
  for (const operation of Object.values(legacy.operations)) { delete operation.candidate; delete operation.quotedInventory; }
  await f.stop(); await writePrivateJson(path, legacy); await f.start();
  assert.equal((await readPrivateJson(path)).formatVersion, 2);
  assert.deepEqual(await f.control().handle(wire.prepareRequest), original);
  await assert.rejects(f.control().handle(prepare), code('HOSTING_OPERATION_CONFLICT'));
  assert.equal(f.enrollmentCount(), 0);
  const bytes = await readFile(path);
  await f.stop(); await f.start();
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await f.control().handle(wire.prepareRequest), original);
});

test('invalid format1 migration does not persist a guessed candidate or enroll', async t => {
  const f = await hostingFixture(t), path = f.control().path;
  await f.control().handle(prepare);
  const legacy = await readPrivateJson(path); legacy.formatVersion = 1;
  for (const operation of Object.values(legacy.operations)) { delete operation.candidate; operation.subjectKey = 'missing'; }
  await f.stop(); await writePrivateJson(path, legacy);
  const bytes = await readFile(path);
  await assert.rejects(f.start(), code('HOSTING_JOURNAL_INVALID'));
  assert.deepEqual(await readFile(path), bytes); assert.equal(f.enrollmentCount(), 0);
});

test('original candidate replay is immutable after public subject changes; old lifecycle writes are fenced', async t => {
  const f = await hostingFixture(t), control = f.control(), original = await control.handle(prepare);
  const oldKey = Object.keys(control.state.operations)[0], subjectKey = Object.keys(control.state.subjects)[0];
  // Storage-boundary fixture only. Full CLEANED -> admission is separately required.
  const current = control.state.subjects[subjectKey];
  current.manifest = { ...current.manifest, installationId: 'rti_' + '9'.repeat(32) };
  current.manifest.manifestSha256 = digestManifest(current.manifest);
  current.initialAssociation = { ...current.initialAssociation, bindingId: 'next-binding', leaseId: 'next-lease',
    initialIntentId: 'next-intent', operationId: 'next-intent' };
  const operation = { ...structuredClone(control.state.operations[oldKey]), association: structuredClone(current.initialAssociation),
    candidate: control.candidateFacts(current) };
  const key = createHash('sha256').update(stableJson({ tenantId: operation.association.tenantId,
    clientId: operation.association.clientId, operationId: operation.association.operationId })).digest('hex');
  control.state.operations[key] = operation;
  assert.doesNotThrow(() => control.validateJournal());
  assert.deepEqual(await control.handle(prepare), original);
  const observed = await control.handle(candidateRequest(prepare, original, 'observe'));
  assert.equal(observed.installationId, original.installationId); assert.equal(observed.outcome, 'UNKNOWN');
  await assert.rejects(control.handle(candidateRequest(prepare, original, 'ensure')), code('HOSTING_OPERATION_SUPERSEDED'));
  for (const method of ['quiesce', 'evidence', 'cleanup'])
    await assert.rejects(control.handle({ ...candidateRequest(prepare, original, method), handoverId: 'old-handover' }), code('HOSTING_OPERATION_SUPERSEDED'));
  assert.equal(f.enrollmentCount(), 0);
  control.state.operations[oldKey].candidate.enrollmentSecretSha256 = 'invalid';
  assert.throws(() => control.validateJournal());
});

test('CLEANED public subject can be invited twice more in the same roots with fresh enrollment and immutable old replies', async t => {
  const { cleanStoppedPrivateData } = await import('../lib/private-data-cleanup.mjs');
  const f = await hostingFixture(t, { observeInventory: fixtureInventory });
  f.controlConfig.scopes.push({ ...f.controlConfig.scopes[0], ownerJiacn: 'second-owner' });
  let request = prepare, candidate = await f.control().handle(request);
  await f.control().handle(candidateRequest(request, candidate, 'ensure')); await f.settle();
  const original = candidate, rootAgent = f.control().subjectAgent(Object.values(f.control().state.subjects)[0]);
  const repo = resolve(rootAgent.profile.codexWorkdir, '.git'); await mkdir(repo);
  await writeFile(resolve(repo, 'public-history'), 'public immutable repository history');
  const privateCredential = resolve(rootAgent.profile.codexHome, 'auth.json'); await writeFile(privateCredential, 'original private credential');
  let admissions = 0;
  for (let invitation = 2; invitation <= 3; invitation++) {
    const next = { ...prepare, ownerJiacn: invitation === 2 ? 'second-owner' : prepare.ownerJiacn,
      operationId: `invite-${invitation}`, initialIntentId: `invite-${invitation}`, bindingId: `binding-${invitation}`, leaseId: `lease-${invitation}` };
    await assert.rejects(f.control().handle(next)); // An active relationship is not reusable.
    const finish = { ...candidateRequest(request, candidate, 'quiesce'), handoverId: `finish-${invitation - 1}` };
    await f.control().handle(finish);
    f.host().flushEvidence = async () => ({ confirmed: true });
    await f.control().handle({ ...finish, method: 'evidence' });
    await assert.rejects(f.control().handle(next), code('RUNTIME_HANDOVER_PENDING'));
    f.host().cleanPrivateData = options => cleanStoppedPrivateData({ ...options,
      apiOrigin: 'https://no-network.invalid', instanceId: f.host().instanceId,
      publicFiles: options.agent.publicFiles, publicRepositoryRoots: [rootAgent.profile.codexWorkdir],
      flushPlatformCosts: async () => ({ confirmed: true }), extractKnowledge: async () => ({ confirmed: true }) });
    assert.equal((await f.control().handle({ ...finish, method: 'cleanup' })).outcome, 'CLEANED');
    await assert.rejects(readFile(privateCredential), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(rootAgent.stateRoot, 'runtime-authorization.json')), { code: 'ENOENT' });
    if (invitation === 2) { await f.stop(); await f.start(); } // Cleanup must survive host restart before prepare.
    const nextCandidate = await f.control().handle(next);
    assert.notEqual(nextCandidate.installationId, candidate.installationId);
    assert.notEqual(nextCandidate.enrollmentSecretSha256, candidate.enrollmentSecretSha256);
    assert.equal(nextCandidate.manifest.canonicalAgentId, original.manifest.canonicalAgentId);
    assert.equal(f.enrollmentCount(), invitation - 1);
    assert.deepEqual(await f.control().handle(prepare), original);
    await assert.rejects(f.control().handle({ ...finish, method: 'cleanup' }), code('HOSTING_OPERATION_SUPERSEDED'));
    // Prepared readmission must reload without borrowing the old native authorization.
    await f.stop(); await f.start();
    f.host().admitRelationship = async () => { admissions++; };
    await f.control().handle(candidateRequest(next, nextCandidate, 'ensure')); await f.settle();
    const ready = await f.control().handle(candidateRequest(next, nextCandidate, 'observe'));
    assert.equal(ready.outcome, 'SERVICE_READY'); assert.equal(ready.installationId, nextCandidate.installationId);
    const agent = f.control().subjectAgent(Object.values(f.control().state.subjects)[0]);
    assert.equal(agent.stateRoot, rootAgent.stateRoot); assert.deepEqual(agent.profile, rootAgent.profile);
    assert.equal(await readFile(resolve(repo, 'public-history'), 'utf8'), 'public immutable repository history');
    assert.equal(f.enrollmentCount(), invitation); assert.equal(f.host().agents.size, 4);
    await f.stop(); await f.start(); f.control().resumeAdmitted(); await f.settle();
    assert.equal((await f.control().handle(candidateRequest(next, nextCandidate, 'observe'))).outcome, 'SERVICE_READY');
    assert.equal(f.enrollmentCount(), invitation);
    request = next; candidate = nextCandidate;
  }
  assert.equal(admissions, 2);
});

test('control resumes partially materialized readmission after restart without extra enrollment or old execution', async t => {
  const { cleanStoppedPrivateData } = await import('../lib/private-data-cleanup.mjs');
  const f = await hostingFixture(t, { observeInventory: fixtureInventory }), original = await f.control().handle(prepare);
  await f.control().handle(candidateRequest(prepare, original, 'ensure')); await f.settle();
  const agent = f.control().subjectAgent(Object.values(f.control().state.subjects)[0]);
  const finish = { ...candidateRequest(prepare, original, 'quiesce'), handoverId: 'finish-before-interruption' };
  await f.control().handle(finish);
  f.host().flushEvidence = async () => ({ confirmed: true });
  await f.control().handle({ ...finish, method: 'evidence' });
  f.host().cleanPrivateData = options => cleanStoppedPrivateData({ ...options, apiOrigin: 'https://no-network.invalid',
    instanceId: f.host().instanceId, publicFiles: options.agent.publicFiles,
    flushPlatformCosts: async () => ({ confirmed: true }), extractKnowledge: async () => ({ confirmed: true }) });
  await f.control().handle({ ...finish, method: 'cleanup' });
  const next = { ...prepare, operationId: 'recover-invite', initialIntentId: 'recover-invite', bindingId: 'recover-binding', leaseId: 'recover-lease' };
  const candidate = await f.control().handle(next);
  f.host().admitRelationship = async () => { throw Error('fixture interruption after manifest materialization'); };
  await f.control().handle(candidateRequest(next, candidate, 'ensure')); await f.settle();
  assert.equal((await readPrivateJson(agent.manifestPath)).installationId, candidate.installationId);
  assert.equal((await readPrivateJson(resolve(agent.stateRoot, 'relationship-admission.json'))).phase, 'PREPARED');
  assert.equal(f.enrollmentCount(), 1); assert.equal(f.states.get(agent.subjectKey).length, 1);
  await f.stop(); await f.start();
  f.host().admitRelationship = async () => {};
  f.control().resumeAdmitted(); await f.settle();
  assert.equal((await f.control().handle(candidateRequest(next, candidate, 'observe'))).outcome, 'SERVICE_READY');
  assert.equal(f.enrollmentCount(), 2); assert.equal(f.states.get(agent.subjectKey).length, 2);
  assert.equal(f.states.get(agent.subjectKey)[1].agent.manifest.installationId, candidate.installationId);
  assert.deepEqual(await f.control().handle(prepare), original);
});

test('public inventory is scoped, has no paths or provisioning side effects, and does not instantiate a new Agent', async t => {
  const f = await hostingFixture(t), control = f.control();
  const request = { protocol: 'runtime-hosting-v1', method: 'inventory', tenantId: prepare.tenantId,
    clientId: prepare.clientId, ownerJiacn: prepare.ownerJiacn, canonicalAgentId: prepare.canonicalAgentId };
  const before = await readFile(control.path, 'utf8');
  const empty = await control.handle(request);
  assert.equal(empty.installedSkillCount, '0'); assert.equal(empty.inventoryVersion, '1');
  assert.equal(f.enrollmentCount(), 0); assert.equal(await readFile(control.path, 'utf8'), before);
  let observations = 0;
  control.observeInventory = async ({ profile }) => { observations++; assert.equal(profile.agentId, f.peers[0].manifest.canonicalAgentId);
    return { inventoryVersion: '1', inventorySha256: 'a'.repeat(64), installedSkillCount: '1', skills: [{ skillKey: 'manual', source: 'NATIVE', revision: 'b'.repeat(64), enabled: true, installation: null }] }; };
  const existing = await control.handle({ ...request, canonicalAgentId: f.peers[0].manifest.canonicalAgentId });
  assert.equal(existing.installedSkillCount, '1'); assert.equal(observations, 1);
  await assert.rejects(control.handle({ ...request, ownerJiacn: 'other' }), code('HOSTING_SCOPE_REJECTED'));
  assert.equal(observations, 1); assert.equal(await readFile(control.path, 'utf8'), before);
  assert.throws(() => validateHostingAssociation({ ...request, codexHome: '/caller-selected' }));
  const message = eventMessage('inventory-request', 'hosting.inventory', 'inventory-fixture', Object.fromEntries(Object.entries(request).filter(([key]) => !['protocol', 'method'].includes(key))));
  assert.deepEqual(validateHostingRequest(message), request);
  assert.equal(hostingReply(message, existing).data.installedSkillCount, '1');
});


test('shared inventory fixture preserves Unicode digest and public envelope without local paths', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hosting-inventory-v1.json', import.meta.url)));
  assert.deepEqual(validateHostingAssociation(fixture.request), fixture.request);
  assert.equal(createHash('sha256').update(JSON.stringify(fixture.response.skills)).digest('hex'), fixture.response.inventorySha256);
  assert.equal(String(fixture.response.skills.length), fixture.response.installedSkillCount);
  const request = messageOf(fixture.request), reply = hostingReply(request, fixture.response);
  assert.deepEqual(reply.data.skills.map(skill => skill.skillKey), ['installed', '菜谱']);
  assert.equal(reply.data.installedSkillCount, '2');
});


test('inventory never treats an orphan public root or missing workspace policy as an empty new Agent', async t => {
  const f = await hostingFixture(t), control = f.control();
  const request = { protocol: 'runtime-hosting-v1', method: 'inventory', tenantId: prepare.tenantId,
    clientId: prepare.clientId, ownerJiacn: prepare.ownerJiacn, canonicalAgentId: prepare.canonicalAgentId };
  const before = await readFile(control.path, 'utf8');
  control.config.template.profile.workspacePolicyId = 'missing-policy';
  await assert.rejects(control.handle(request), code('HOSTING_TEMPLATE_PROFILE_INVALID'));
  delete control.config.template.profile.workspacePolicyId;
  const orphan = resolve(control.config.managedRoot, runtimeSubjectKey(request));
  await mkdir(orphan, { mode: 0o700 });
  await assert.rejects(control.handle(request), code('HOSTING_SUBJECT_CONFLICT'));
  assert.equal(await readFile(control.path, 'utf8'), before);
  assert.equal(f.enrollmentCount(), 0);
});


test('inventory mismatch is a durable terminal no-effect reply across restart, not a retryable candidate', async t => {
  const f = await hostingFixture(t);
  const stale = quotedPreparation(wire.prepareRequest, 'fixture-host', 'a'.repeat(64));
  const rejection = await f.control().handle(stale);
  const shared = JSON.parse(await readFile(new URL('./fixtures/hosting-inventory-rejection-v1.json', import.meta.url)));
  assert.deepEqual(stale, shared.request); assert.deepEqual(rejection, shared.response);
  assert.equal(rejection.outcome, 'FAILED_NO_EFFECT'); assert.equal(rejection.reasonCode, 'HOSTING_INVENTORY_CHANGED');
  assert.match(rejection.evidenceRef, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(f.control().state.subjects).length, 0); assert.equal(f.enrollmentCount(), 0);
  assert.equal(Object.values(f.control().state.operations)[0].candidate, null);
  assert.doesNotThrow(() => f.control().validateJournal());
  await f.stop(); await f.start();
  assert.deepEqual(await f.control().handle(stale), rejection);
  await assert.rejects(f.control().handle(prepare), code('HOSTING_OPERATION_CONFLICT'));
  const next = { ...prepare, initialIntentId: 'new-quote-intent', operationId: 'new-quote-intent' };
  assert.equal((await f.control().handle(next)).outcome, 'PREPARED');
  assert.deepEqual(await f.control().handle(stale), rejection); assert.equal(f.enrollmentCount(), 0);
});
test('initial prepare requires an exact quote and successful replay never re-observes mutable inventory', async t => {
  const f = await hostingFixture(t);
  await assert.rejects(f.control().handle(wire.prepareRequest), code('HOSTING_INVENTORY_REQUIRED'));
  for (const value of [{}, { hostId: 'fixture-host', inventorySha256: 'bad' }, { ...prepare.quotedInventory, price: 0 }])
    await assert.rejects(f.control().handle({ ...prepare, quotedInventory: value }));
  assert.equal(Object.keys(f.control().state.operations).length, 0);
  const candidate = await f.control().handle(prepare);
  f.control().observeInventory = async () => { throw Error('later inventory must not rewrite first prepare'); };
  assert.deepEqual(await f.control().handle(prepare), candidate);
  await f.stop(); await f.start(); assert.deepEqual(await f.control().handle(prepare), candidate);
});

test('inventory observation or rejection journal failure never becomes a refundable no-effect proof', async t => {
  const f = await hostingFixture(t);
  f.control().installedInventory = async () => { throw Object.assign(Error('unconfirmed'), { code: 'SKILL_INVENTORY_UNCONFIRMED' }); };
  await assert.rejects(f.control().handle(prepare), code('SKILL_INVENTORY_UNCONFIRMED'));
  assert.equal(Object.keys(f.control().state.operations).length, 0);
  // Reboot restores the real observation method. A failed durable write may not return a rejection.
  await f.stop(); await f.start(); f.control().path = f.controlConfig.managedRoot;
  await assert.rejects(f.control().handle(quotedPreparation(wire.prepareRequest, 'fixture-host', 'a'.repeat(64))), code('HOSTING_JOURNAL_WRITE_UNCONFIRMED'));
  assert.equal(Object.keys(f.control().state.operations).length, 0); assert.equal(f.enrollmentCount(), 0);
});
