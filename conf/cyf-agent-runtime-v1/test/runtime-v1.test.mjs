import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readdir, rm, symlink, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestManifest, validateManifest } from '../lib/manifest.mjs';
import { createLogger, readEnrollmentSecret, readPrivateJson } from '../lib/security.mjs';
import { PERMANENT_RUNTIME_EXIT_STATUS, runtimeExitStatus } from '../agent-runtime.mjs';
import { classifyRuntimeError, RuntimeV1Client, validateCommandForManifest, validateRuntimeAckResult, validateEnrollmentResult } from '../lib/runtime-client.mjs';

// Wire r1 catalogs pinned to API87c894dc, SHA256 56d7c3d...322adb.
// Synthetic credentials only. HTTP mocked here: NOT cross-end/production evidence.
const token = 'rts1_' + 'a'.repeat(64);
const installationToken = 'rta1_' + 'b'.repeat(64);
const enrollment = () => ({ installation: { ...Object.fromEntries(['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'manifestVersion'].map(k => [k, manifest()[k]])),
  manifestSha256: manifest().manifestSha256.slice(7), enrollmentExpiresAt: 3601000, status: 'ACTIVE', lastHeartbeatAt: null }, runtimeAuthorization: installationToken });
const manifest = () => {
  const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: 'rti_0123456789abcdef0123456789abcdef',
    tenantId: '0', clientId: 'client-fixture', canonicalAgentId: 'agt_0123456789abcdef0123456789abcdef' };
  return { ...unsigned, manifestSha256: digestManifest(unsigned) };
};
const command = () => ({ installationId: manifest().installationId, tenantId: '0', clientId: 'client-fixture', canonicalAgentId: manifest().canonicalAgentId,
  messageId: 'msg-fixture', correlationId: 'correlation-fixture', commandId: 'command-fixture', taskId: 'task-fixture', workItemId: null,
  payloadReference: null, expiresAt: '2030-01-01T00:00:00Z' });
const session = generation => ({ ...Object.fromEntries(['installationId', 'tenantId', 'clientId', 'canonicalAgentId'].map(k => [k, manifest()[k]])),
  hostId: 'host-fixture', runtimeInstanceId: 'boot-fixture', sessionGeneration: generation, scheme: 'AgentRuntime', sessionToken: token,
  websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' });
const response = data => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ data }) });
async function setup(t, fetchFn, { authorization = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ur01-wire-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new RuntimeV1Client({ manifest: manifest(), apiBaseUrl: 'https://api.example.test', stateDir: directory,
    hostId: 'host-fixture', runtimeInstanceId: 'boot-fixture', fetchFn });
  if (authorization) await writeFile(client.authorizationPath(), JSON.stringify({ installationId: manifest().installationId, runtimeAuthorization: 'synthetic-install-token' }), { mode: 0o600 });
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
    if (url.endsWith('/enroll')) return response(enrollment());
    return response({ kind: 'ADVANCED', status: body.status, deliveryVersion: ++version });
  }, { authorization: false });
  assert.deepEqual(await client.enroll('synthetic-enroll'), { installationId: manifest().installationId });
  await client.session();
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${installationToken}`);
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
  assert.deepEqual((await readdir(directory)).sort(), ['runtime-authorization.json', 'runtime-enrollment-attempt.json']); // no pending-acks state
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

test('r2 ACK nullable reference/work item is explicit; absent, blank, forged identity or extra proof is not an ACL fallback', () => {
  assert.deepEqual(validateCommandForManifest(command(), manifest(), 'RECEIVED').payloadReference, null);
  for (const patch of [{ payloadReference: undefined }, { payloadReference: '' }, { payloadReference: ' ' }, { payloadReference: {} },
    { workItemId: '' }, { workItemId: 1 }, { installationId: 'synthetic-product-installation' }, { targetAgentId: manifest().canonicalAgentId }]) {
    assert.throws(() => validateCommandForManifest({ ...command(), ...patch }, manifest(), 'RECEIVED'));
  }
  assert.equal(validateCommandForManifest({ ...command(), payloadReference: 'actual-wire-reference' }, manifest(), 'RECEIVED').payloadReference, 'actual-wire-reference');
});


const e05LeaseUrl = (suffix = '', actor = manifest().canonicalAgentId) =>
  `https://api.example.test/agent/tasks/task-1/work-items/work-1/reassignments/rsn_${'c'.repeat(64)}/lease${suffix}?actorAgentId=${encodeURIComponent(actor)}`;

test('E05 native scope permits exactly existing POST lease/read-start-heartbeat shapes and manifest-bound actor; no wire change', async t => {
  const calls = []; const { client } = await setup(t, async (url, options) => { calls.push({ url, options }); return response(session(7)); });
  await client.session(); calls.length = 0;
  for (const suffix of ['', '/start', '/heartbeat']) {
    const body = JSON.stringify({ commandId: 'fixture-command', expectedWorkItemVersion: 5 });
    await client.nativeFetch(e05LeaseUrl(suffix), { method: 'POST', body,
      headers: { Authorization: 'retired', 'X-API-Key': 'retired', Cookie: 'foreign', 'X-Agent-Id': 'frame-foreign',
        'X-Agent-Installation-Id': 'product-installation', 'X-Agent-Session-Generation': '999', 'content-type': 'application/json' } });
    const call = calls.at(-1); const endpoint = new URL(call.url);
    assert.deepEqual([...endpoint.searchParams], [['actorAgentId', manifest().canonicalAgentId]]);
    for (const [key, value] of Object.entries(client.sessionHeaders())) assert.equal(call.options.headers.get(key), value);
    assert.equal(call.options.headers.has('x-api-key'), false); assert.equal(call.options.headers.has('cookie'), false);
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.body, body);
  }
  await client.nativeFetch(e05LeaseUrl().replace('task-1', encodeURIComponent('任务')), { method: 'POST' });
  assert.equal(calls.length, 4); // transport-scope fixture, not a business lease response
});

test('E05 native wrong/missing/duplicate actor, methods, broad routes and encoded aliases fail before fetch', async t => {
  let calls = 0; const { client } = await setup(t, async () => { calls++; return response(session(7)); });
  await client.session(); const initial = calls; const url = e05LeaseUrl();
  const denied = [
    e05LeaseUrl('', 'frame-foreign'), url.split('?')[0], `${url}&actorAgentId=${manifest().canonicalAgentId}`,
    `${url}&extra=1`, `${url}&token=secret`, url.replace('actorAgentId=', 'agentId='),
    url.replace('task-1', 'task%2Fforeign'), url.replace('work-1', 'work%5Cforeign'),
    url.replace('task-1', 'task%252Fforeign'), url.replace('work-1', 'work%00foreign'),
    url.replace('work-1', 'work%3Fforeign'), url.replace('task-1', '%20task'), url.replace('task-1', 'task%'),
    url.replace('task-1', 't'.repeat(101)), url.replace('/lease?', '/lease/read?'),
    url.replace('/lease?', '/lease/start/extra?'), url.replace('/lease?', '/lease//start?'),
    url.replace('/lease?', '/lease/commit?'), url.replace('/lease?', '/result?'),
    url.replace('/lease?', '/lease/?'), url.replace('/work-items/', '/anything/'),
    'https://api.example.test/agent/tasks', 'https://api.example.test/agent/runtime/v1/session',
    'https://api.example.test/agent/tasks/task-1/formal-deliveries',
    url.replace('api.example.test', 'foreign.test'), url.replace('https://', 'https://user:password@'), `${url}#fragment`
  ];
  for (const deniedUrl of denied) await assert.rejects(client.nativeFetch(deniedUrl, { method: 'POST' }), /RUNTIME_NATIVE_SCOPE_INVALID/);
  for (const method of [undefined, 'GET', 'PUT', 'DELETE', 'PATCH']) await assert.rejects(client.nativeFetch(url, { method }), /RUNTIME_NATIVE_SCOPE_INVALID/);
  assert.equal(calls, initial);
});

test('E05 native lease route is still session-fenced: invalidate aborts transport and a late old-proof response cannot confirm', async t => {
  let release; let seen; let generation = 0;
  const { client } = await setup(t, async (url, options) => {
    if (String(url).endsWith('/session')) return response(session(++generation));
    seen = options; return new Promise(resolve => { release = resolve; });
  });
  await client.session();
  const pending = assert.rejects(client.nativeFetch(e05LeaseUrl('/start'), { method: 'POST' }), /RUNTIME_NATIVE_SESSION_CHANGED/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(seen.signal.aborted, false);
  client.invalidateSession(); assert.equal(seen.signal.aborted, true);
  await client.session(); release(response({})); await pending;
  assert.equal(client.currentSession.sessionGeneration, 2);
  client.invalidateSession(); await assert.rejects(client.nativeFetch(e05LeaseUrl(), { method: 'POST' }), /RUNTIME_SESSION_REQUIRED/);
});


test('enrollment uses actual b47 nested record fixture only, with synthetic authorization rather than REDACTED markers', async () => {
  const wire = JSON.parse(await readFile(new URL('./fixtures/unified-runtime-wire-v2.redacted.json', import.meta.url), 'utf8')).enrollment;
  assert.equal(wire.responseEnvelope, 'JsonResult.data'); assert.equal(Object.hasOwn(wire.response, 'installationId'), false);
  const nested = wire.response.installation;
  const trusted = { runtimeProtocolVersion: 'v1', ...Object.fromEntries(['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'manifestVersion'].map(key => [key, nested[key]])), manifestSha256: `sha256:${nested.manifestSha256}` };
  assert.deepEqual(validateEnrollmentResult({ ...wire.response, runtimeAuthorization: installationToken }, trusted), { installationId: trusted.installationId, runtimeAuthorization: installationToken });
  assert.throws(() => validateEnrollmentResult(wire.response, trusted), /RUNTIME_ENROLLMENT_RESPONSE_INVALID/);
});

test('enrollment nested installation requires exact full subject, manifest, ACTIVE state and nullable heartbeat; no top-level fallback', () => {
  for (const field of ['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'manifestVersion', 'manifestSha256']) {
    const data = enrollment(); data.installation[field] = 'foreign';
    assert.throws(() => validateEnrollmentResult(data, manifest()), /RUNTIME_ENROLLMENT_RESPONSE_INVALID/);
  }
  for (const patch of [{ status: 'PENDING' }, { status: 'REVOKED' }, { status: 'ONLINE' }, { status: undefined },
    { lastHeartbeatAt: undefined }, { lastHeartbeatAt: '1000' }, { lastHeartbeatAt: Number.MAX_SAFE_INTEGER },
    { enrollmentExpiresAt: undefined }, { enrollmentExpiresAt: '1000' }, { enrollmentExpiresAt: Number.MAX_SAFE_INTEGER },
    { enrollmentExpiresAt: 1.1 }, { sessionToken: token }]) {
    assert.throws(() => validateEnrollmentResult({ ...enrollment(), installation: { ...enrollment().installation, ...patch } }, manifest()), /RUNTIME_ENROLLMENT_RESPONSE_INVALID/);
  }
  for (const authorization of ['', 'REDACTED_INSTALLATION_AUTHORIZATION', token, installationToken + '\n', ['rta1_' + 'b'.repeat(64)], { token: installationToken }]) {
    assert.throws(() => validateEnrollmentResult({ ...enrollment(), runtimeAuthorization: authorization }, manifest()), /RUNTIME_ENROLLMENT_RESPONSE_INVALID/);
  }
  for (const data of [{ installationId: manifest().installationId, runtimeAuthorization: installationToken },
    { ...enrollment(), installationId: manifest().installationId }, { ...enrollment(), installation: [] },
    { ...enrollment(), installation: null }]) assert.throws(() => validateEnrollmentResult(data, manifest()), /RUNTIME_ENROLLMENT_RESPONSE_INVALID/);
  assert.doesNotThrow(() => validateEnrollmentResult({ ...enrollment(), installation: { ...enrollment().installation, lastHeartbeatAt: 2000 } }, manifest()));
});

test('enrollment successful authorization is private atomic persisted/read back; public return and attempt record have no credential', async t => {
  let calls = 0;
  const { client, directory } = await setup(t, async () => { calls++; return response(enrollment()); }, { authorization: false });
  assert.deepEqual(await client.enroll('one-time-synthetic-secret'), { installationId: manifest().installationId });
  assert.equal(calls, 1); assert.equal(await client.loadAuthorization(), installationToken);
  assert.equal((await stat(client.authorizationPath())).mode & 0o777, 0o600); assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const attempted = await readFile(client.enrollmentAttemptPath(), 'utf8');
  for (const value of ['one-time-synthetic-secret', installationToken, 'runtimeAuthorization', 'sessionToken']) assert.equal(attempted.includes(value), false);
  const saved = await readFile(client.authorizationPath(), 'utf8');
  await assert.rejects(client.enroll('one-time-synthetic-secret'), /RUNTIME_ENROLLMENT_AUTHORIZATION_EXISTS/);
  assert.equal(await readFile(client.authorizationPath(), 'utf8'), saved); assert.equal(calls, 1);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('lost enrollment response or invalid envelope is recovery-required, nonretryable across process restart and never secret-bearing', async t => {
  for (const mode of ['lost-response', 'bad-envelope', 'legacy-shape', 'foreign-subject', '503']) {
    let calls = 0;
    const { client, directory } = await setup(t, async () => {
      calls++;
      if (mode === 'lost-response') throw new Error('do not disclose one-time-synthetic-secret');
      if (mode === 'bad-envelope') return { ...response({}), json: async () => ({ installationId: manifest().installationId }) };
      if (mode === 'legacy-shape') return response({ installationId: manifest().installationId, runtimeAuthorization: installationToken });
      if (mode === 'foreign-subject') return response({ ...enrollment(), installation: { ...enrollment().installation, canonicalAgentId: 'foreign' } });
      return { ...response({}), ok: false, status: 503 };
    }, { authorization: false });
    await assert.rejects(client.enroll('one-time-synthetic-secret'), error => {
      assert.equal(error.code, 'RUNTIME_ENROLLMENT_RECOVERY_REQUIRED'); assert.equal(error.recoveryRequired, true);
      assert.equal(error.retryable, false); assert.equal(classifyRuntimeError(error).kind, 'recovery-required');
      assert.equal(String(error).includes('one-time-synthetic-secret'), false); assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(await readPrivateJson(client.authorizationPath(), null), null);
    await assert.rejects(client.enroll('one-time-synthetic-secret'), /RUNTIME_ENROLLMENT_RECOVERY_REQUIRED/);
    const restarted = new RuntimeV1Client({ manifest: manifest(), apiBaseUrl: client.apiBaseUrl, stateDir: directory,
      fetchFn: () => assert.fail('restart may not repeat an enrollment attempt') });
    await assert.rejects(restarted.enroll('one-time-synthetic-secret'), /RUNTIME_ENROLLMENT_RECOVERY_REQUIRED/);
    assert.equal(calls, 1);
  }
});

test('enrollment cannot report success after authorization persistence failure or silently overwrite preexisting credentials', async t => {
  let calls = 0; let selectedDirectory;
  const { client, directory } = await setup(t, async () => { calls++; await chmod(selectedDirectory, 0o755); return response(enrollment()); }, { authorization: false });
  selectedDirectory = directory;
  try { await assert.rejects(client.enroll('one-time-synthetic-secret'), /RUNTIME_ENROLLMENT_RECOVERY_REQUIRED/); }
  finally { await chmod(directory, 0o700); }
  assert.equal(await readPrivateJson(client.authorizationPath(), null), null);
  await assert.rejects(client.enroll('one-time-synthetic-secret'), /RUNTIME_ENROLLMENT_RECOVERY_REQUIRED/); assert.equal(calls, 1);
  const existing = await setup(t, () => assert.fail('preexisting auth must not send HTTP'));
  const before = await readFile(existing.client.authorizationPath(), 'utf8');
  await assert.rejects(existing.client.enroll('one-time-synthetic-secret'), /RUNTIME_ENROLLMENT_AUTHORIZATION_EXISTS/);
  assert.equal(await readFile(existing.client.authorizationPath(), 'utf8'), before);
});

test('enrollment exclusive durable attempt fences simultaneous independent clients: exactly one HTTP request', async t => {
  let calls = 0;
  const { client, directory } = await setup(t, async () => { calls++; return response(enrollment()); }, { authorization: false });
  const peer = new RuntimeV1Client({ manifest: manifest(), apiBaseUrl: client.apiBaseUrl, stateDir: directory,
    fetchFn: async () => { calls++; return response(enrollment()); } });
  const results = await Promise.allSettled([client.enroll('one-time-synthetic-secret'), peer.enroll('one-time-synthetic-secret')]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1); assert.equal(calls, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'RUNTIME_ENROLLMENT_RECOVERY_REQUIRED');
  assert.equal(await client.loadAuthorization(), installationToken);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('enrollment invalid secret and unsafe attempt path reject before HTTP and preserve private files', async t => {
  const { client, directory } = await setup(t, () => assert.fail('invalid preflight cannot send HTTP'), { authorization: false });
  await assert.rejects(client.enroll(' invalid '), /RUNTIME_ENROLLMENT_SECRET_INVALID/);
  const privateFile = join(directory, 'owned-secret'); await writeFile(privateFile, 'preserve', { mode: 0o600 });
  await symlink(privateFile, client.enrollmentAttemptPath());
  await assert.rejects(client.enroll('one-time-synthetic-secret'), /symlinks/);
  assert.equal(await readFile(privateFile, 'utf8'), 'preserve');
});
