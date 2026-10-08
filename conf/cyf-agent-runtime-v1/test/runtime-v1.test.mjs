import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestManifest, validateManifest } from '../lib/manifest.mjs';
import { createLogger, readEnrollmentSecret, readPrivateJson } from '../lib/security.mjs';
import { PERMANENT_RUNTIME_EXIT_STATUS, runtimeExitStatus } from '../agent-runtime.mjs';
import { classifyRuntimeError, RuntimeV1Client, validateCommandForManifest, validateRuntimeAckResult } from '../lib/runtime-client.mjs';

// Wire r1 catalogs pinned to API87c894dc, SHA256 56d7c3d...322adb.
// Synthetic credentials only. HTTP mocked here: NOT cross-end/production evidence.
const token = 'rts1_' + 'a'.repeat(64);
const manifest = () => {
  const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: 'rti_0123456789abcdef0123456789abcdef',
    tenantId: '0', clientId: 'client-fixture', canonicalAgentId: 'agt_0123456789abcdef0123456789abcdef' };
  return { ...unsigned, manifestSha256: digestManifest(unsigned) };
};
const command = () => ({ installationId: manifest().installationId, tenantId: '0', clientId: 'client-fixture', canonicalAgentId: manifest().canonicalAgentId,
  messageId: 'msg-fixture', correlationId: 'correlation-fixture', commandId: 'command-fixture', taskId: 'task-fixture', workItemId: null,
  payloadReference: 'payload-fixture', expiresAt: '2030-01-01T00:00:00Z' });
const session = generation => ({ ...Object.fromEntries(['installationId', 'tenantId', 'clientId', 'canonicalAgentId'].map(k => [k, manifest()[k]])),
  hostId: 'host-fixture', runtimeInstanceId: 'boot-fixture', sessionGeneration: generation, scheme: 'AgentRuntime', sessionToken: token,
  websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' });
const response = data => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ data }) });
async function setup(t, fetchFn) {
  const directory = await mkdtemp(join(tmpdir(), 'ur01-wire-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new RuntimeV1Client({ manifest: manifest(), apiBaseUrl: 'https://api.example.test', stateDir: directory,
    hostId: 'host-fixture', runtimeInstanceId: 'boot-fixture', fetchFn });
  await writeFile(client.authorizationPath(), JSON.stringify({ installationId: manifest().installationId, runtimeAuthorization: 'synthetic-install-token' }), { mode: 0o600 });
  return { directory, client };
}

test('manifest exact explicit identity and SHA remain validated', () => {
  assert.equal(validateManifest(manifest()).canonicalAgentId, manifest().canonicalAgentId);
  assert.throws(() => validateManifest({ ...manifest(), clientId: 'other' }), /SHA-256 mismatch/);
  assert.throws(() => validateManifest({ ...manifest(), runtimeProtocolVersion: 'v0' }), /must be v1/);
});

test('protected secret and authorization reads reject permissions, file/ancestor symlinks', async t => {
  const { directory, client } = await setup(t, async () => response({}));
  const file = join(directory, 'secret'); await writeFile(file, 'synthetic-enroll\n', { mode: 0o600 });
  assert.equal((await readEnrollmentSecret({ CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE: file })).value, 'synthetic-enroll');
  await chmod(file, 0o644);
  await assert.rejects(readEnrollmentSecret({ CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE: file }), /permissions/);
  await chmod(file, 0o600);
  const alias = join(directory, 'alias'); await symlink(file, alias);
  await assert.rejects(readPrivateJson(alias, null), /symlinks/);
  const dirAlias = join(directory, 'diralias'); await symlink(directory, dirAlias);
  await assert.rejects(readPrivateJson(join(dirAlias, 'secret'), null), /symlinks/);
  await assert.rejects(readEnrollmentSecret({}), /protected environment or file/);
  await assert.rejects(readEnrollmentSecret({ CYF_RUNTIME_V1_ENROLLMENT_SECRET: 'x', CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE: file }), /exactly one/);
  await writeFile(client.authorizationPath(), JSON.stringify({ installationId: 'foreign', runtimeAuthorization: 'other' }));
  await assert.rejects(client.loadAuthorization(), /INSTALLATION_AUTH_INVALID/);
});

test('logs redact installation and AgentRuntime credentials including free text', () => {
  const output = [];
  createLogger({ write: line => output.push(line), knownSecrets: ['synthetic-enroll'] })('test', {
    enrollmentSecret: 'synthetic-enroll', sessionToken: token, nested: `AgentRuntime ${token}`, free: token
  });
  for (const secret of [token, 'synthetic-enroll']) assert.equal(output.join('\n').includes(secret), false);
});

test('installation Bearer derives memory-only session; WS/ACK use exactly five proof headers', async t => {
  const requests = []; let version = 0;
  const { directory, client } = await setup(t, async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, options, body });
    if (url.endsWith('/session')) return response(session(7));
    if (url.endsWith('/enroll')) return response({ installationId: manifest().installationId, runtimeAuthorization: 'synthetic-install-token' });
    return response({ kind: 'ADVANCED', status: body.status, deliveryVersion: ++version });
  });
  assert.deepEqual(await client.enroll('synthetic-enroll'), { installationId: manifest().installationId });
  await client.session();
  assert.equal(requests[1].options.headers.Authorization, 'Bearer synthetic-install-token');
  assert.deepEqual(Object.keys(requests[1].body).sort(), ['installationId','tenantId','clientId','canonicalAgentId','manifestVersion','manifestSha256','hostId','runtimeInstanceId'].sort());
  assert.equal(requests[1].body.manifestSha256, manifest().manifestSha256.slice(7));
  const headers = { Authorization: `AgentRuntime ${token}`, 'X-Agent-Id': manifest().canonicalAgentId, 'X-Agent-Installation-Id': manifest().installationId,
    'X-Agent-Host-Id': 'host-fixture', 'X-Agent-Runtime-Id': 'boot-fixture', 'X-Agent-Session-Generation': '7' };
  assert.deepEqual(client.websocketOptions(), { headers, followRedirects: false });
  assert.equal(client.websocketUrl(), 'wss://api.example.test/ws/agent/channel');
  assert.equal(new URL(client.websocketUrl()).search, '');
  const first = await client.acknowledge(command(), 'RECEIVED', null);
  const second = await client.acknowledge(command(), 'STARTED', first.deliveryVersion);
  assert.equal(second.deliveryVersion, 2);
  assert.equal(requests[2].body.deliveryVersion, null); assert.equal(requests[3].body.deliveryVersion, 1);
  assert.deepEqual(requests[2].body, { ...command(), hostId: 'host-fixture', runtimeInstanceId: 'boot-fixture', sessionGeneration: 7, deliveryVersion: null, status: 'RECEIVED' });
  assert.deepEqual(requests[2].options.headers, { 'content-type': 'application/json', ...headers });
  assert.equal(requests[2].options.redirect, 'error');
  assert.deepEqual(await readdir(directory), ['runtime-authorization.json']); // no pending-acks state
  assert.equal((await readFile(client.authorizationPath(), 'utf8')).includes(token), false);
  assert.equal(client.queueAck, undefined); assert.equal(client.flushAcks, undefined);
});

test('malformed or foreign session, old native token, and nonmonotonic generation fail closed', async t => {
  let next = session(7);
  const { client } = await setup(t, async () => response(next));
  for (const patch of [{ tenantId: 'foreign' }, { hostId: 'foreign' }, { runtimeInstanceId: 'foreign' },
    { sessionToken: 'a'.repeat(32) }, { sessionGeneration: 0 }, { sessionGeneration: '7' }, { websocketPath: '/other' }]) {
    next = { ...session(7), ...patch }; await assert.rejects(client.session(), /RUNTIME_SESSION_/); assert.equal(client.currentSession, null);
  }
  next = session(7); await client.session();
  await assert.rejects(client.session(), /RUNTIME_SESSION_PROOF_INVALID/);
  next = session(8); await client.session(); assert.equal(client.lastGeneration, 8);
});

test('response must match status, kind, valid monotonic confirmed version (never predicted CAS)', () => {
  assert.deepEqual(validateRuntimeAckResult({ kind: 'PRIOR', status: 'STARTED', deliveryVersion: 12 }, 'STARTED', 12), { kind: 'PRIOR', status: 'STARTED', deliveryVersion: 12 });
  for (const result of [{ kind: 'PRIOR', status: 'RECEIVED', deliveryVersion: 12 }, { kind: 'ADVANCED', status: 'STARTED', deliveryVersion: 11 },
    { kind: 'ADVANCED', status: 'STARTED', deliveryVersion: 12 }, { kind: 'PRIOR', status: 'STARTED', deliveryVersion: 11 },
    { kind: 'ADVANCED', status: 'STARTED', deliveryVersion: '13' }, { kind: 'IGNORED', status: 'STARTED', deliveryVersion: 13 }]) {
    assert.throws(() => validateRuntimeAckResult(result, 'STARTED', 12), /UNCONFIRMED/);
  }
});

test('ACK transport failure and session rotation racing response cannot confirm commit', async t => {
  let mode = 'session'; let release;
  const { client } = await setup(t, async (url) => {
    if (url.endsWith('/session')) return response(session(mode === 'new-session' ? 8 : 7));
    if (mode === 'network') throw Object.assign(Error('synthetic'), { code: 'ECONNRESET' });
    if (mode === 'auth') return { ...response({}), ok: false, status: 403 };
    return new Promise(resolve => { release = () => resolve(response({ kind: 'ADVANCED', status: 'RECEIVED', deliveryVersion: 1 })); });
  });
  await client.session(); mode = 'network'; await assert.rejects(client.acknowledge(command(), 'RECEIVED'), error => classifyRuntimeError(error).kind === 'transient-network');
  mode = 'auth'; await assert.rejects(client.acknowledge(command(), 'RECEIVED'), error => error.status === 403);
  mode = 'race'; const pending = client.acknowledge(command(), 'RECEIVED');
  mode = 'new-session'; await client.session(); release(); await assert.rejects(pending, /SESSION_CHANGED/);
});

test('expiry blocks new RECEIVED/STARTED, not executed terminal reports; context has no mutable proof', () => {
  const expired = { ...command(), expiresAt: '2000-01-01T00:00:00Z' };
  for (const status of ['RECEIVED', 'STARTED']) assert.throws(() => validateCommandForManifest(expired, manifest(), status), /EXPIRED/);
  for (const status of ['SUCCEEDED', 'FAILED', 'REJECTED']) assert.doesNotThrow(() => validateCommandForManifest(expired, manifest(), status));
  for (const patch of [{ tenantId: 'foreign' }, { installationId: 'foreign' }, { workItemId: undefined }, { sessionToken: token }, { runtimeInstanceId: 'boot' }]) {
    assert.throws(() => validateCommandForManifest({ ...command(), ...patch }, manifest(), 'RECEIVED'));
  }
});

test('native fetch enforces same origin/prefix, appends current session proof and strips old auth', async t => {
  const calls = []; const { client } = await setup(t, async (url, options) => { calls.push({ url, options }); return response(session(7)); });
  await client.session();
  await client.nativeFetch('https://api.example.test/internal/agent/tasks/workspace-executions/commands', { headers: { 'X-API-Key': 'retired', Cookie: 'foreign-cookie', 'Proxy-Authorization': 'foreign-proxy', Authorization: 'retired', Origin: 'foreign', Accept: 'application/json' } });
  const actual = calls[1].options.headers;
  assert.equal(actual.get('Authorization'), `AgentRuntime ${token}`); assert.equal(actual.get('X-Agent-Session-Generation'), '7');
  assert.equal(actual.has('X-API-Key'), false); assert.equal(actual.has('Cookie'), false); assert.equal(actual.has('Proxy-Authorization'), false); assert.equal(actual.has('Origin'), false); assert.equal(calls[1].options.redirect, 'error');
  for (const url of ['https://foreign.test/internal/agent/a', 'https://api.example.test/agent/runtime/v1/session', 'https://user:pass@api.example.test/internal/agent/a']) await assert.rejects(client.nativeFetch(url), /SCOPE_INVALID/);
  client.invalidateSession(); await assert.rejects(client.nativeFetch('https://api.example.test/internal/agent/a'), /SESSION_REQUIRED/);
});

test('credential-bearing base URL and malformed response envelope fail closed', async t => {
  for (const url of ['https://api.example.test?api_key=old', 'https://user:password@api.example.test', 'https://api.example.test/base']) assert.throws(() => new RuntimeV1Client({ manifest: manifest(), apiBaseUrl: url, fetchFn() {} }), /ORIGIN_INVALID/);
  const { client } = await setup(t, async () => ({ ...response({}), json: async () => ({ sessionToken: token }) }));
  await assert.rejects(client.session(), /RESPONSE_INVALID/);
});

test('retry classification does not turn TLS/auth/rebind errors into blind retries', () => {
  for (const code of ['UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','ECONNRESET','ETIMEDOUT','EAI_AGAIN']) assert.equal(classifyRuntimeError(new TypeError('fetch failed', { cause: { code } })).kind, 'transient-network');
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) assert.equal(runtimeExitStatus(new TypeError('TLS', { cause: { code } })), PERMANENT_RUNTIME_EXIT_STATUS);
  assert.equal(runtimeExitStatus(Object.assign(Error('auth'), { status: 403 })), PERMANENT_RUNTIME_EXIT_STATUS);
  assert.equal(runtimeExitStatus(Object.assign(Error('rebind'), { code: 'REBINDS_REQUIRED' })), PERMANENT_RUNTIME_EXIT_STATUS);
  for (const status of [408,429,500,599]) assert.equal(classifyRuntimeError({ status }).kind, 'transient-http');
});

test('source systemd templates suppress permanent exit and back off restarts', async () => {
  for (const path of [new URL('../systemd/cyf-agent-runtime-v1@.service', import.meta.url), new URL('../../../systemd/cyf-agent-runtime-v1@.service', import.meta.url)]) {
    const unit = await readFile(path, 'utf8'); assert.match(unit, /^RestartPreventExitStatus=78$/m); assert.match(unit, /^RestartSec=5s$/m);
  }
});


test('native session rotation aborts only owned transport and rejects late responses from the old proof', async t => {
  let release; let captured; let requests = 0
  const { client } = await setup(t, async (url, options) => {
    if (String(url).endsWith('/session')) return response(session(++requests))
    captured = options; return new Promise(resolve => { release = resolve })
  })
  await client.session()
  const pending = assert.rejects(client.nativeFetch('https://api.example.test/internal/agent/tasks/test'), /RUNTIME_NATIVE_SESSION_CHANGED/)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(captured.signal.aborted, false)
  client.invalidateSession(); assert.equal(captured.signal.aborted, true)
  await client.session(); release(response({ started: true })); await pending
  assert.equal(client.currentSession.sessionGeneration, 2)
})

test('native explicit user cancellation composes with session signal without invalidating peers or the session', async t => {
  let seenSignal
  const { client } = await setup(t, async (url, options) => {
    if (String(url).endsWith('/session')) return response(session(7))
    seenSignal = options.signal; return response({})
  })
  await client.session(); const user = new AbortController()
  await client.nativeFetch('https://api.example.test/internal/agent/tasks/test', { signal: user.signal })
  assert.equal(seenSignal.aborted, false); user.abort(); assert.equal(seenSignal.aborted, true)
  assert.equal(client.currentSession.sessionGeneration, 7)
})
