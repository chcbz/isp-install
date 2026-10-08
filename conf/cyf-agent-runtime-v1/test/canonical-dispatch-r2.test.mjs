import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { RuntimeV1Client } from '../lib/runtime-client.mjs';
import { digestManifest } from '../lib/manifest.mjs';
import { canonicalSha256 } from '../../codex-ws-agent/chat-runtime.mjs';
import { PersistentCommandInbox, DurableDedupeLedger, AckOutbox, AgentMessageProcessor,
  normalizeInboundMessage, runtimeCommandContext, CommandFingerprint } from '../../codex-ws-agent/agent-client.mjs';

// Actual codec bytes from APIa2dbe650, not a hand-authored dispatch or amended expiry.
// Local HTTP/engine injection is client-boundary evidence, NOT Java D06/MySQL/Provider acceptance.
const fixtureBytes = readFileSync(new URL('./fixtures/command-dispatch-e05.canonical.redacted.json', import.meta.url));
const raw = JSON.parse(fixtureBytes);
const wireBytes = readFileSync(new URL('./fixtures/unified-runtime-wire-v2.redacted.json', import.meta.url));
const wire = JSON.parse(wireBytes);
const wireSha = '7a1b0b41d3d57634557401b1a6e9fdf1ccd6f2ef09e14eea1ce42acef6616312';
const frozenClock = wire.canonicalDispatchProjectionR2.clockEpochMillis;
const hostId = wire.session.request.hostId; const bootId = wire.session.request.runtimeInstanceId;
const fixtureSha = '057a4626387846f4bf420cab046d7d0bb4d12cdae6569e90839af00161cbd5a3';
const fixture = () => JSON.parse(fixtureBytes);
const manifest = () => {
  const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: wire.session.request.installationId,
    tenantId: raw.tenantId, clientId: raw.clientId, canonicalAgentId: raw.targetAgentId };
  return { ...unsigned, manifestSha256: digestManifest(unsigned) };
};
const profile = () => ({ profileId: 'r2-codec-fixture', agentId: raw.targetAgentId, runtimeIdentity: manifest() });
const expected = (command = raw) => ({ installationId: manifest().installationId, tenantId: raw.tenantId, clientId: raw.clientId,
  canonicalAgentId: raw.targetAgentId, messageId: command.messageId, correlationId: command.correlationId,
  commandId: command.commandId, taskId: command.taskId, workItemId: command.workItemId ?? null,
  payloadReference: command.payloadReference ?? null, expiresAt: new Date(command.expiresAt).toISOString() });

function checkpoint(t, { root, ack, run = async () => ({ status: 'completed' }) }) {
  const selected = profile();
  const inbox = new PersistentCommandInbox({ rootDir: root, profile: selected }); inbox.initialize();
  const store = resolve(root, Buffer.from(selected.agentId).toString('hex'));
  const ledger = new DurableDedupeLedger({ rootDir: store, profile: selected }); ledger.initialize();
  const outbox = new AckOutbox({ rootDir: store, profile: selected }); outbox.initialize();
  const rejected = [];
  const processor = new AgentMessageProcessor({ profile: selected, inbox, ledger, ackOutbox: outbox,
    runCommand: run, runChat: async () => assert.fail('command never becomes CHAT'),
    sendCommandAckFn: ack, onReject: error => rejected.push(error) });
  processor.start({ drain: false }); t.after(() => processor.stop());
  return { inbox, ledger, outbox, processor, rejected };
}

async function httpFixture(t, { loseTerminalUntilRotation = false, command = raw } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'ur01-canonical-r2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = []; const errors = []; const records = new Map();
  let generation = 6;
  const token = () => `rts1_${generation.toString(16).padStart(64, '0')}`;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); const headers = request.headers;
      requests.push({ path: request.url, headers, body });
      const send = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data })); };
      assert.equal(request.method, 'POST');
      if (request.url === '/agent/runtime/v1/session') {
        assert.equal(headers.authorization, 'Bearer synthetic-install-authorization');
        for (const key of ['installationId', 'tenantId', 'clientId', 'canonicalAgentId']) assert.equal(body[key], manifest()[key]);
        generation++;
        send({ ...manifest(), hostId, runtimeInstanceId: bootId, sessionGeneration: generation,
          scheme: 'AgentRuntime', sessionToken: token(), websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' }); return;
      }
      assert.equal(request.url, `/agent/runtime/v1/commands/${encodeURIComponent(raw.messageId)}/acks`);
      assert.equal(headers.authorization, `AgentRuntime ${token()}`);
      assert.equal(headers['x-agent-id'], raw.targetAgentId);
      assert.equal(headers['x-agent-installation-id'], manifest().installationId);
      assert.equal(headers['x-agent-host-id'], hostId); assert.equal(headers['x-agent-runtime-id'], bootId);
      assert.equal(headers['x-agent-session-generation'], String(generation));
      for (const [key, value] of Object.entries(expected(command))) assert.equal(body[key], value);
      assert.equal(body.hostId, hostId); assert.equal(body.runtimeInstanceId, bootId); assert.equal(body.sessionGeneration, generation);
      assert.equal(headers['x-api-key'], undefined);
      const previous = records.get(body.messageId);
      const prior = previous?.status === body.status;
      const version = prior ? previous.deliveryVersion : (previous?.deliveryVersion ?? 0) + 1;
      assert.equal(body.deliveryVersion, prior ? version - 1 : (previous?.deliveryVersion ?? null), 'last client-confirmed value, never predicted CAS');
      const result = { kind: prior ? 'PRIOR' : 'ADVANCED', status: body.status, deliveryVersion: version };
      records.set(body.messageId, result);
      if (loseTerminalUntilRotation && body.status === 'SUCCEEDED' && generation === 7) { request.socket.destroy(); return; }
      send(result);
    })().catch(error => { errors.push(error); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: { code: 'SYNTHETIC_HTTP_ASSERTION' } })); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); });
  const client = new RuntimeV1Client({ manifest: manifest(), apiBaseUrl: `http://127.0.0.1:${server.address().port}`, stateDir: root,
    hostId, runtimeInstanceId: bootId });
  writeFileSync(client.authorizationPath(), JSON.stringify({ installationId: manifest().installationId,
    runtimeAuthorization: 'synthetic-install-authorization' }), { mode: 0o600 });
  await client.session(); t.after(() => client.invalidateSession());
  return { root, client, requests, errors, acks: () => requests.filter(row => row.path.endsWith('/acks')) };
}

const stateJson = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(root, entry.name);
  return entry.isDirectory() ? stateJson(path) : entry.name.endsWith('.json') && entry.name !== 'runtime-authorization.json' ? [readFileSync(path, 'utf8')] : [];
});

test('byte-pinned E05 r2 at fake clock reaches local real HTTP ACK and unique mature checkpoint before business', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: frozenClock });
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), fixtureSha);
  assert.equal(createHash('sha256').update(wireBytes).digest('hex'), wireSha);
  assert.deepEqual(raw, wire.canonicalDispatchProjectionR2.raw);
  assert.equal(fixtureSha, wire.canonicalDispatchProjectionR2.rawSha256);
  const h = await httpFixture(t); let runtime; let runs = 0;
  runtime = checkpoint(t, { root: h.root, ack: (context, status, version) => h.client.acknowledge(context, status, version),
    run: async message => {
      runs++;
      assert.deepEqual(message.rawPayload, raw); assert.deepEqual(message.payload.context, raw.payload.context);
      assert.equal(message.leaseToken, undefined, 'no invented lease proof');
      assert.equal(runtime.ledger.runtimeAckCommit(raw.commandId, raw.messageId).status, 'STARTED');
      assert.deepEqual(h.acks().map(row => row.body.status), ['RECEIVED', 'STARTED']);
      return { status: 'completed' };
    } });
  const accepted = await runtime.processor.handle(fixtureBytes);
  assert.equal(accepted.kind, 'command'); assert.deepEqual(accepted.item.record.rawPayload, raw);
  assert.deepEqual(runtime.ledger.getEntry(raw.commandId).runtimeCommand, expected());
  assert.equal(accepted.item.record.expiresAt, raw.expiresAt);
  runtime.processor.resume(); await runtime.processor.waitForIdle(); await runtime.processor.runtimeAckTail;
  assert.equal(runs, 1); assert.deepEqual(h.errors, []);
  assert.deepEqual(h.acks()[0].body, wire.canonicalDispatchProjectionR2.projectedFirstAck);
  assert.deepEqual(h.acks().map(row => [row.body.status, row.body.deliveryVersion]), [['RECEIVED', null], ['STARTED', 1], ['SUCCEEDED', 2]]);
  assert.equal(runtime.ledger.getEntry(raw.commandId).fingerprint, canonicalSha256(raw).slice(7));
  assert.equal(runtime.ledger.runtimeAckCommit(raw.commandId, raw.messageId).deliveryVersion, 3);
  assert.equal(runtime.outbox.pendingEnvelopes().length, 0);
  const persisted = stateJson(h.root).join('\n');
  for (const secret of [h.client.currentSession.sessionToken, 'sessionToken', 'sessionGeneration', 'runtimeAuthorization', bootId]) assert.equal(persisted.includes(secret), false);
  assert.equal(readdirSync(h.root).includes('pending-acks.json'), false);
});

test('lost real HTTP terminal receipt replays original r2 checkpoint after expiry and session rotation, without reexecution', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: frozenClock });
  const h = await httpFixture(t, { loseTerminalUntilRotation: true }); let runs = 0;
  const ack = (context, status, version) => h.client.acknowledge(context, status, version);
  const initial = checkpoint(t, { root: h.root, ack, run: async () => { runs++; return { status: 'completed' }; } });
  await initial.processor.handle(fixtureBytes); initial.processor.resume(); await initial.processor.waitForIdle(); await initial.processor.runtimeAckTail;
  assert.equal(runs, 1); assert.equal(initial.ledger.runtimeAckCommit(raw.commandId, raw.messageId).status, 'STARTED');
  assert.equal(initial.outbox.pendingEnvelopes()[0].envelope.ackStatus, 'SUCCEEDED'); initial.processor.stop();
  const beforeRestart = h.acks().map(row => [row.body.status, row.body.deliveryVersion, row.body.sessionGeneration]);
  assert.deepEqual(beforeRestart.slice(0, 2), [['RECEIVED', null, 7], ['STARTED', 1, 7]]);
  assert.ok(beforeRestart.length >= 3);
  for (const attempt of beforeRestart.slice(2)) assert.deepEqual(attempt, ['SUCCEEDED', 2, 7]);
  t.mock.timers.setTime(raw.expiresAt + 1000); await h.client.session();
  const restarted = checkpoint(t, { root: h.root, ack, run: async () => assert.fail('unknown/terminal business is never reexecuted') });
  await restarted.processor.replayAcks(); restarted.processor.resume(); await restarted.processor.waitForIdle(); await restarted.processor.runtimeAckTail;
  assert.deepEqual(h.errors, []); assert.equal(runs, 1); assert.equal(restarted.outbox.pendingEnvelopes().length, 0);
  assert.equal(restarted.ledger.runtimeAckCommit(raw.commandId, raw.messageId).deliveryVersion, 3);
  assert.deepEqual(h.acks().map(row => [row.body.status, row.body.deliveryVersion, row.body.sessionGeneration]),
    [...beforeRestart, ['SUCCEEDED', 2, 8]]);
  assert.equal(restarted.ledger.runtimeAckCommit(raw.commandId, raw.messageId).kind, 'PRIOR');
  assert.deepEqual(restarted.ledger.getEntry(raw.commandId).runtimeCommand, expected());
  await assert.rejects(h.client.acknowledge(expected(), 'STARTED', 3), /EXPIRED/);
  assert.equal(h.acks().length, beforeRestart.length + 1, 'production expiry is not disabled by the fixture clock');
});

test('r2 matches raw complete subject before projection, rejecting nested identity aliases and Runtime/product confusion', () => {
  const p = profile(); const before = fixtureBytes.toString();
  assert.deepEqual(runtimeCommandContext(p, normalizeInboundMessage(fixtureBytes)), expected());
  for (const patch of [{ tenantId: 'foreign' }, { clientId: 'foreign' }, { targetAgentId: 'foreign' },
    { canonicalAgentId: 'foreign' }, { installationId: 'product-installation-on-wrong-command' }]) {
    assert.throws(() => runtimeCommandContext(p, normalizeInboundMessage({ ...fixture(), ...patch })), { code: 'RUNTIME_COMMAND_SCOPE_MISMATCH' });
  }
  for (const field of ['tenantId', 'clientId', 'targetAgentId']) {
    const aliased = fixture(); const value = aliased[field]; delete aliased[field]; aliased.payload[field] = value;
    assert.throws(() => runtimeCommandContext(p, normalizeInboundMessage(aliased)), { code: 'RUNTIME_COMMAND_SCOPE_MISMATCH' });
  }
  const aliasOnly = fixture(); delete aliasOnly.targetAgentId; aliasOnly.receiverAgentId = raw.targetAgentId;
  assert.throws(() => runtimeCommandContext(p, normalizeInboundMessage(aliasOnly)), { code: 'RUNTIME_COMMAND_SCOPE_MISMATCH' });
  const skill = { ...fixture(), commandType: 'SKILL_INSTALL', installationId: 'synthetic-product-installation' };
  const skillContext = runtimeCommandContext(p, normalizeInboundMessage(skill));
  assert.equal(skillContext.installationId, p.runtimeIdentity.installationId);
  assert.equal(skill.installationId, 'synthetic-product-installation');
  assert.throws(() => runtimeCommandContext(p, normalizeInboundMessage({ ...skill, installationId: p.runtimeIdentity.installationId })), { code: 'RUNTIME_COMMAND_INSTALLATION_CONFUSION' });
  assert.throws(() => runtimeCommandContext(p, normalizeInboundMessage({ ...fixture(), runtimeCommand: expected() })), { code: 'RUNTIME_COMMAND_CONTEXT_FORBIDDEN' });
  assert.equal(fixtureBytes.toString(), before, 'projection never amends codec bytes');
});

test('r2 safely normalizes epoch and actual nullable values, never invented references or empty-string work keys', () => {
  for (const expiry of [undefined, null, '3601000', 3.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 8640000000000001]) {
    assert.throws(() => runtimeCommandContext(profile(), normalizeInboundMessage({ ...fixture(), expiresAt: expiry })), { code: 'RUNTIME_COMMAND_EXPIRY_INVALID' });
  }
  for (const patch of [{ workItemId: '' }, { workItemId: 1 }, { payloadReference: '' }, { payloadReference: ' ' }, { payloadReference: {} }]) {
    assert.throws(() => runtimeCommandContext(profile(), normalizeInboundMessage({ ...fixture(), ...patch })));
  }
  for (const value of [null, undefined]) {
    const nullable = fixture(); if (value === undefined) delete nullable.workItemId; else nullable.workItemId = value;
    assert.equal(runtimeCommandContext(profile(), normalizeInboundMessage(nullable)).workItemId, null);
    assert.equal(runtimeCommandContext(profile(), normalizeInboundMessage(nullable)).payloadReference, null);
  }
  const explicit = { ...fixture(), payloadReference: 'actual-source-reference' };
  assert.equal(runtimeCommandContext(profile(), normalizeInboundMessage(explicit)).payloadReference, explicit.payloadReference);
  assert.equal(runtimeCommandContext(profile(), normalizeInboundMessage({ ...fixture(), expiresAt: 8640000000000000 })).expiresAt, '+275760-09-13T00:00:00.000Z');
});

test('raw r2 fingerprint binds epoch/product/source/context; same ID changed payload cannot change original D06 checkpoint', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: frozenClock });
  const h = await httpFixture(t);
  const runtime = checkpoint(t, { root: h.root, ack: (context, status, version) => h.client.acknowledge(context, status, version), run: async () => assert.fail('paused command') });
  await runtime.processor.handle(fixtureBytes); await runtime.processor.runtimeAckTail;
  const before = runtime.ledger.getEntry(raw.commandId);
  const variants = [
    { ...fixture(), expiresAt: raw.expiresAt + 1 },
    { ...fixture(), payloadReference: 'actual-new-reference' },
    { ...fixture(), payload: { ...raw.payload, context: { ...raw.payload.context, referenceIds: [] } } },
    { ...fixture(), payload: { ...raw.payload, context: { ...raw.payload.context, reassignmentId: 'foreign-reassignment' } } }
  ];
  for (const variant of variants) {
    assert.notEqual(CommandFingerprint.compute(normalizeInboundMessage(variant)), before.fingerprint);
    assert.equal((await runtime.processor.handle(variant)).kind, 'rejected');
  }
  const skill = { ...fixture(), commandType: 'SKILL_INSTALL', installationId: 'product-one' };
  assert.notEqual(CommandFingerprint.compute(normalizeInboundMessage(skill)), CommandFingerprint.compute(normalizeInboundMessage({ ...skill, installationId: 'product-two' })));
  assert.deepEqual(runtime.ledger.getEntry(raw.commandId), before); assert.equal(h.acks().length, 1);
  assert.equal(runtime.outbox.pendingEnvelopes().length, 0); assert.deepEqual(h.errors, []);
});

test('r2 queued ACK projection and original raw checkpoint are independently checked BEFORE real HTTP', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: frozenClock });
  for (const mode of ['projection', 'raw-source']) await t.test(mode, async st => {
    const h = await httpFixture(st); let enabled = false;
    const runtime = checkpoint(st, { root: h.root, ack: (...args) => {
      if (!enabled) throw Error('synthetic pre-send hold'); return h.client.acknowledge(...args);
    } });
    await runtime.processor.handle(fixtureBytes); await runtime.processor.runtimeAckTail;
    assert.equal(h.acks().length, 0);
    if (mode === 'projection') {
      const forged = { ...expected(), taskId: 'different-task' };
      const entry = runtime.ledger.getEntry(raw.commandId);
      runtime.ledger._writeEntry(raw.commandId, { ...entry, runtimeCommand: forged });
      const head = runtime.outbox.pendingEnvelopes()[0];
      writeFileSync(resolve(runtime.outbox.acksDir, head.fileName), JSON.stringify({ ...head.record,
        envelope: { ...head.record.envelope, runtimeCommand: forged } }), { mode: 0o600 });
    } else {
      const item = runtime.inbox.commandStateIndex().get(raw.commandId)[0];
      const changed = { ...item.record, rawPayload: { ...raw, payload: { ...raw.payload, context: { ...raw.payload.context, referenceIds: [] } } } };
      writeFileSync(item.path, JSON.stringify(changed), { mode: 0o600 });
    }
    enabled = true; assert.equal(await runtime.processor.replayAcks(), false);
    assert.equal(runtime.processor.failClosedError.code, 'RUNTIME_ACK_CONTEXT_CONFLICT');
    assert.equal(h.acks().length, 0); assert.equal(runtime.outbox.pendingEnvelopes().length, 1); assert.deepEqual(h.errors, []);
  });
});


test('unchanged E05 is rejected for new admission after expiry; only REJECTED reaches local HTTP and no business runs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: raw.expiresAt + 1000 });
  const h = await httpFixture(t);
  const runtime = checkpoint(t, { root: h.root, ack: (context, status, version) => h.client.acknowledge(context, status, version),
    run: async () => assert.fail('expired new work must never execute') });
  const result = await runtime.processor.handle(fixtureBytes);
  assert.equal(result.kind, 'rejected'); assert.equal(result.error.code, 'COMMAND_EXPIRED');
  runtime.processor.resume(); await runtime.processor.waitForIdle(); await runtime.processor.runtimeAckTail;
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.acks().map(row => [row.body.status, row.body.deliveryVersion]), [['REJECTED', null]]);
  assert.equal(runtime.inbox.commandStateIndex().size, 0);
  assert.equal(runtime.ledger.runtimeAckCommit(raw.commandId, raw.messageId).status, 'REJECTED');
  assert.equal(runtime.outbox.pendingEnvelopes().length, 0);
});


test('r2 invalid raw subjects/epochs/contexts cannot create a checkpoint or send any HTTP ACK', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: frozenClock });
  const h = await httpFixture(t);
  const runtime = checkpoint(t, { root: h.root, ack: (context, status, version) => h.client.acknowledge(context, status, version),
    run: async () => assert.fail('invalid dispatch must never execute') });
  const cases = [
    [{ tenantId: 'foreign' }, 'RUNTIME_COMMAND_SCOPE_MISMATCH'],
    [{ clientId: 'foreign' }, 'RUNTIME_COMMAND_SCOPE_MISMATCH'],
    [{ targetAgentId: 'foreign' }, 'TARGET_AGENT_ID_MISMATCH'],
    [{ canonicalAgentId: 'foreign' }, 'RUNTIME_COMMAND_SCOPE_MISMATCH'],
    [{ commandType: undefined, payload: { ...raw.payload, commandType: raw.commandType } }, 'RUNTIME_COMMAND_CONTEXT_REQUIRED'],
    [{ installationId: 'foreign-runtime' }, 'RUNTIME_COMMAND_SCOPE_MISMATCH'],
    [{ commandType: 'SKILL_INSTALL', installationId: manifest().installationId }, 'RUNTIME_COMMAND_INSTALLATION_CONFUSION'],
    [{ expiresAt: Number.MAX_SAFE_INTEGER }, 'RUNTIME_COMMAND_EXPIRY_INVALID'],
    [{ expiresAt: '3601000' }, 'RUNTIME_COMMAND_EXPIRY_INVALID'],
    [{ workItemId: '' }, 'RUNTIME_COMMAND_WORK_INVALID'],
    [{ payloadReference: '' }, 'RUNTIME_COMMAND_CONTEXT_REQUIRED'],
    [{ runtimeCommand: expected() }, 'RUNTIME_COMMAND_CONTEXT_FORBIDDEN'],
    [{ runtimeCommand: null }, 'RUNTIME_COMMAND_CONTEXT_FORBIDDEN'],
    [{ sessionToken: 'synthetic-forbidden-secret' }, 'RUNTIME_WIRE_CREDENTIAL_FORBIDDEN']
  ];
  for (const [patch, code] of cases) {
    const result = await runtime.processor.handle(JSON.stringify({ ...fixture(), ...patch }));
    assert.equal(result.kind, 'rejected'); assert.equal(result.error.code, code);
  }
  await runtime.processor.runtimeAckTail;
  assert.equal(runtime.ledger.listEntries().length, 0); assert.equal(runtime.inbox.commandStateIndex().size, 0);
  assert.equal(runtime.outbox.pendingEnvelopes().length, 0); assert.equal(h.acks().length, 0);
  assert.deepEqual(h.errors, []);
});


test('nullable workItem from canonical DTO reaches HTTP as null, never an empty work key', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: frozenClock });
  const command = { ...fixture(), workItemId: null }; const h = await httpFixture(t, { command }); let runs = 0;
  const runtime = checkpoint(t, { root: h.root, ack: (context, status, version) => h.client.acknowledge(context, status, version),
    run: async message => { runs++; assert.equal(message.rawPayload.workItemId, null); return { status: 'completed' }; } });
  assert.equal((await runtime.processor.handle(command)).kind, 'command');
  runtime.processor.resume(); await runtime.processor.waitForIdle(); await runtime.processor.runtimeAckTail;
  assert.equal(runs, 1); assert.deepEqual(h.errors, []);
  assert.deepEqual(h.acks().map(row => [row.body.status, row.body.workItemId, row.body.payloadReference]),
    [['RECEIVED', null, null], ['STARTED', null, null], ['SUCCEEDED', null, null]]);
  assert.deepEqual(runtime.ledger.getEntry(raw.commandId).runtimeCommand, expected(command));
  assert.equal(runtime.outbox.pendingEnvelopes().length, 0);
});
