import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { hostingFixture, candidateRequest, tick, code } from './hosting-fixture.mjs';
import { parseHostingJson, validateHostingRequest } from '../lib/hosting-wire.mjs';
import { startHostingServer, hostingRejection } from '../lib/hosting-server.mjs';
import { digestManifest, stableJson } from '../lib/manifest.mjs';
import { readPrivateJson, writePrivateJson } from '../lib/security.mjs';
const fixtureBytes = await readFile(new URL('./fixtures/gss-hosting-control-v1.json', import.meta.url));
const wire = JSON.parse(fixtureBytes);
const prepare = wire.prepareRequest;

// Frozen acceptance: exact wire and full immutable association; private journal
// before admission; no enrollment during prepare/observe; single initial enroll;
// same-installation reprovision; stale/replayed generation; lost HTTP/UDS reply;
// restart reload/live proof; subject/OS permissions; no broker or HOME adoption.

test('frozen Main synthetic fixture has exact provenance and accepted request/manifest catalogs', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '5c4b833e6db5bab3122c6dee17ef49198462aee3c3edf58f628ed8571e241403');
  for (const key of ['capabilitiesRequest', 'prepareRequest', 'ensureRequest', 'observeRequest', 'reprovisionPrepareRequest']) assert.deepEqual(validateHostingRequest(wire[key]), wire[key]);
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
    { ...wire.ensureRequest, enrollmentSecret: 'never-accepted' }]) assert.throws(() => validateHostingRequest(request));
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
  assert.ok(after.sessionGeneration > before.sessionGeneration); assert.ok(after.registeredAt >= reprepare.requestedAt); assert.equal(f.enrollmentCount(), 1);
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
  assert.equal(fresh.outcome, 'SERVICE_READY'); assert.notEqual(fresh.runtimeInstanceId, prior.runtimeInstanceId); assert.ok(fresh.sessionGeneration > prior.sessionGeneration);
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

test('private UDS usable trusted group0660/parent0750, exact newline response, duplicate rejection and lost prepare reply recovery', async t => {
  const f = await hostingFixture(t); const server = await startHostingServer({ control: f.control() }); t.after(() => server.close());
  const stat = await lstat(f.controlConfig.socketPath); assert.equal(stat.mode & 0o777, 0o660); assert.equal(stat.gid, f.controlConfig.socketGid);
  const candidate = await exchange(f.controlConfig.socketPath, JSON.stringify(prepare) + '\n'); assert.equal(candidate.outcome, 'PREPARED');
  assert.deepEqual(await exchange(f.controlConfig.socketPath, JSON.stringify(prepare) + '\n'), candidate);
  const duplicate = await exchange(f.controlConfig.socketPath, JSON.stringify(prepare).replace('"method":"prepare"', '"method":"prepare","method":"ensure"') + '\n');
  assert.equal(duplicate.outcome, 'REJECTED'); assert.equal(duplicate.reasonCode, 'HOSTING_DUPLICATE_FIELD');
  const invalid = await exchange(f.controlConfig.socketPath, JSON.stringify({ ...prepare, command: 'do-not-run' }) + '\n'); assert.equal(invalid.outcome, 'REJECTED');
  assert.equal((await exchange(f.controlConfig.socketPath, JSON.stringify(wire.capabilitiesRequest) + '\n')).available, true);
  assert.equal(f.enrollmentCount(), 0); await server.close();
});

test('UDS rejects unsafe world/writable parents and existing files/listeners without unlinking them', async t => {
  const f = await hostingFixture(t);
  for (const mode of [0o755, 0o770, 0o777, 0o700]) {
    await chmod(resolve(f.root, 'socket'), mode); await assert.rejects(startHostingServer({ control: f.control() }), code('HOSTING_SOCKET_PARENT_UNSAFE'));
  }
  await chmod(resolve(f.root, 'socket'), 0o750); await writeFile(f.controlConfig.socketPath, 'unknown-owned-file', { mode: 0o600 });
  await assert.rejects(startHostingServer({ control: f.control() }), code('HOSTING_SOCKET_EXISTS'));
  assert.equal(await readFile(f.controlConfig.socketPath, 'utf8'), 'unknown-owned-file');
  assert.equal(hostingRejection('observe', Error('never leak arbitrary detail')).reasonCode, 'HOSTING_CONTROL_ERROR');
});

const until = async predicate => { for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(done => setTimeout(done, 1)); assert.ok(predicate(), 'synthetic lifecycle reached expected event'); };

test('lost actual ensure UDS response recovers identical admission without another installation/enrollment/session', async t => {
  const f = await hostingFixture(t); const server = await startHostingServer({ control: f.control() }); t.after(() => server.close());
  const candidate = await exchange(f.controlConfig.socketPath, JSON.stringify(prepare) + '\n'); const ensure = candidateRequest(prepare, candidate, 'ensure');
  // Parent disconnects after write completion, before consuming any response.
  await new Promise((done, reject) => {
    const socket = connect(f.controlConfig.socketPath); socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(ensure) + '\n', () => { socket.destroy(); done(); }));
  });
  await until(() => Object.values(f.control().state.operations).some(operation => operation.admittedAt !== null)); await f.settle();
  const response = await exchange(f.controlConfig.socketPath, JSON.stringify(ensure) + '\n'); assert.equal(response.outcome, 'SERVICE_READY');
  assert.equal(response.installationId, candidate.installationId); assert.equal(f.enrollmentCount(), 1); assert.equal(f.sessionCount(), 1);
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
  assert.equal(ready.sessionGeneration, 2); assert.equal(f.enrollmentCount(), 1);
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
