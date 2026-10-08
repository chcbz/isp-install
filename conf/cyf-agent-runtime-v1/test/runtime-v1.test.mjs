import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestManifest, validateManifest } from '../lib/manifest.mjs';
import { createLogger, readEnrollmentSecret, readPrivateJson } from '../lib/security.mjs';
import { PERMANENT_RUNTIME_EXIT_STATUS, runRuntimeLoop, runtimeExitStatus } from '../agent-runtime.mjs';
import { readFile } from 'node:fs/promises';
import { classifyRuntimeError, RuntimeV1Client, validateCommandForManifest } from '../lib/runtime-client.mjs';

function manifest() {
  const value = {
    runtimeProtocolVersion: 'v1',
    manifestVersion: '1',
    installationId: 'install-1',
    tenantId: 'tenant-a',
    clientId: 'client-a',
    canonicalAgentId: 'agent-a'
  };
  return { ...value, manifestSha256: digestManifest(value) };
}

function command() {
  return {
    messageId: 'message-1', correlationId: 'correlation-1', commandId: 'command-1',
    taskId: 'task-1', workItemId: 'work-1', tenantId: 'tenant-a', clientId: 'client-a',
    canonicalAgentId: 'agent-a', payloadReference: 'context://f01/1', expiresAt: '2030-01-01T00:00:00.000Z'
  };
}

function response(body = {}) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
}

test('manifest SHA validates exact explicit Runtime v1 identity fields', () => {
  const valid = manifest();
  assert.equal(validateManifest(valid).canonicalAgentId, 'agent-a');
  assert.throws(() => validateManifest({ ...valid, clientId: 'other-client' }), /SHA-256 mismatch/);
  assert.throws(() => validateManifest({ ...valid, runtimeProtocolVersion: 'v0' }), /must be v1/);
});

test('enrollment secret accepts only a protected environment or 0600 regular file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyf-runtime-v1-'));
  const secretFile = join(directory, 'enrollment');
  await writeFile(secretFile, 'single-use-secret\n', { mode: 0o600 });
  const fileSecret = await readEnrollmentSecret({ CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE: secretFile });
  assert.equal(fileSecret.value, 'single-use-secret');
  await chmod(secretFile, 0o644);
  await assert.rejects(readEnrollmentSecret({ CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE: secretFile }), /permissions/);
  await assert.rejects(readEnrollmentSecret({}), /protected environment or file/);
  await assert.rejects(readEnrollmentSecret({ CYF_RUNTIME_V1_ENROLLMENT_SECRET: 'a', CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE: secretFile }), /exactly one/);
});

test('redacted logs do not expose enrollment or runtime authorization values', () => {
  const output = [];
  createLogger({ write: line => output.push(line), knownSecrets: ['enroll-secret', 'runtime-token'] })('event', {
    enrollmentSecret: 'enroll-secret', authorization: 'Bearer runtime-token', nested: 'runtime-token'
  });
  assert.equal(output.join('\n').includes('enroll-secret'), false);
  assert.equal(output.join('\n').includes('runtime-token'), false);
  assert.match(output[0], /\[REDACTED\]/);
});

test('HTTP client sends explicit v1 identity, uses bearer authorization, and durable ACK replay is monotonic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyf-runtime-v1-'));
  const requests = [];
  const client = new RuntimeV1Client({
    manifest: manifest(), apiBaseUrl: 'https://api.example.test', stateDir: directory,
    fetchFn: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith('/enroll')) return response({ data: { runtimeAuthorization: 'runtime-token' } });
      if (url.endsWith('/session') || url.endsWith('/heartbeat')) return response({ data: { status: 'ACTIVE' } });
      return response({ data: { kind: 'ADVANCED', status: 'RECEIVED', deliveryVersion: 1 } });
    }
  });
  await client.enroll('enroll-secret');
  assert.equal(requests[0].body.tenantId, 'tenant-a');
  assert.equal(requests[0].body.clientId, 'client-a');
  assert.equal(requests[0].body.canonicalAgentId, 'agent-a');
  assert.equal(requests[0].body.manifestSha256, manifest().manifestSha256.slice('sha256:'.length));
  assert.equal(requests[0].body.enrollmentSecret, 'enroll-secret');

  await client.session();
  await client.heartbeat();
  await client.queueAck(command(), 'RECEIVED');
  await client.queueAck(command(), 'STARTED');
  await client.queueAck(command(), 'SUCCEEDED');
  await client.flushAcks();
  assert.deepEqual(requests.slice(3).map(request => request.body.status), ['RECEIVED', 'STARTED', 'SUCCEEDED']);
  assert.equal(requests[1].options.headers.authorization, 'Bearer runtime-token');
  assert.deepEqual(await client.flushAcks(), { pending: 0 });
  assert.deepEqual(await client.queueAck(command(), 'SUCCEEDED'), { queued: false, completed: true });
  await assert.rejects(client.queueAck({ ...command(), tenantId: 'other' }, 'RECEIVED'), /identity/);
  await assert.rejects(client.queueAck(command(), 'FAILED'), /terminal ACK cannot be changed/);
});

test('legacy URL api_key and expired non-rejected commands are refused', () => {
  assert.throws(() => new RuntimeV1Client({ manifest: manifest(), apiBaseUrl: 'https://api.example.test?api_key=old', stateDir: '/tmp/state', fetchFn: async () => response() }), /legacy api_key/);
  assert.throws(() => validateCommandForManifest({ ...command(), expiresAt: '2000-01-01T00:00:00.000Z' }, manifest(), 'RECEIVED'), /expired/);
  assert.doesNotThrow(() => validateCommandForManifest({ ...command(), expiresAt: '2000-01-01T00:00:00.000Z' }, manifest(), 'REJECTED'));
});


test('retry classification is limited to frozen transient network and HTTP failures', () => {
  assert.deepEqual(classifyRuntimeError(Object.assign(new Error('private ECONNRESET detail'), { code: 'ECONNRESET' })), { kind: 'transient-network' });
  for (const code of ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'EAI_AGAIN']) {
    const nested = new TypeError('fetch failed', { cause: Object.assign(new Error('socket detail'), { cause: { code } }) });
    assert.deepEqual(classifyRuntimeError(nested), { kind: 'transient-network' });
  }
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    const tlsError = new TypeError('fetch failed', { cause: { code } });
    assert.equal(classifyRuntimeError(tlsError).kind, 'permanent');
    assert.equal(runtimeExitStatus(tlsError), PERMANENT_RUNTIME_EXIT_STATUS);
  }
  assert.equal(classifyRuntimeError(new TypeError('TLS wraps socket', { cause: { code: 'UND_ERR_SOCKET', cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } } })).kind, 'permanent');
  for (const status of [408, 429, 500, 599]) assert.deepEqual(classifyRuntimeError(Object.assign(new Error('secret body'), { status })), { kind: 'transient-http', status });
  for (const status of [401, 403]) assert.deepEqual(classifyRuntimeError(Object.assign(new Error('Bearer secret'), { status })), { kind: 'authorization', status });
  const rebind = Object.assign(new Error('rebind'), { code: 'REBINDS_REQUIRED' });
  assert.deepEqual(classifyRuntimeError(rebind), { kind: 'rebind' });
  assert.equal(runtimeExitStatus(Object.assign(new Error('auth'), { status: 401 })), PERMANENT_RUNTIME_EXIT_STATUS);
  assert.equal(runtimeExitStatus(Object.assign(new Error('auth'), { status: 403 })), PERMANENT_RUNTIME_EXIT_STATUS);
  assert.equal(runtimeExitStatus(rebind), PERMANENT_RUNTIME_EXIT_STATUS);
});

test('ACK flush preserves the unsent suffix on transient failure and propagates authorization failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyf-runtime-v1-'));
  let calls = 0;
  let mode = 'transient';
  const client = new RuntimeV1Client({
    manifest: manifest(), apiBaseUrl: 'https://api.example.test', stateDir: directory,
    fetchFn: async (_url, options) => {
      if (options.headers.authorization) {
        calls += 1;
        if (mode === 'transient' && calls === 2) throw Object.assign(new Error('ECONNRESET secret'), { code: 'ECONNRESET' });
        if (mode === 'unauthorized') return { ...response({}), ok: false, status: 401 };
        return response({ data: { kind: 'ADVANCED' } });
      }
      return response({ data: { runtimeAuthorization: 'runtime-token' } });
    }
  });
  await client.enroll('enroll-secret');
  await client.queueAck(command(), 'RECEIVED');
  await client.queueAck(command(), 'STARTED');
  await client.queueAck(command(), 'SUCCEEDED');
  await assert.rejects(client.flushAcks(), error => classifyRuntimeError(error).kind === 'transient-network');
  assert.equal(calls, 2);
  mode = 'success';
  await client.flushAcks();
  assert.deepEqual(await readPrivateJson(client.pendingAcksPath(), null), { version: 1, pending: [], completed: [{ messageId: 'message-1', status: 'SUCCEEDED' }] });

  await client.queueAck({ ...command(), messageId: 'message-2' }, 'RECEIVED');
  mode = 'unauthorized';
  await assert.rejects(client.flushAcks(), error => classifyRuntimeError(error).kind === 'authorization');
});


test('runtime loop retries transient failures with capped delay and fails closed on rebind/auth', async () => {
  const controller = new AbortController();
  const delays = [];
  const logs = [];
  let sessionCalls = 0;
  const client = {
    async session() {
      sessionCalls += 1;
      if (sessionCalls === 1) throw Object.assign(new Error('secret ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (sessionCalls === 2) throw Object.assign(new Error('secret response'), { status: 429 });
      if (sessionCalls === 3) return { status: 'REBINDS_REQUIRED' };
      throw new Error('loop continued after fail-closed response');
    },
    async heartbeat() { assert.fail('must stop at rebind-required session'); },
    async flushAcks() { assert.fail('must not flush on rebind-required session'); }
  };
  await assert.rejects(runRuntimeLoop(client, {
    signal: controller.signal,
    logger: (event, fields) => logs.push({ event, fields }),
    wait: async delay => delays.push(delay)
  }), error => error.code === 'REBINDS_REQUIRED');
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(logs, [
    { event: 'runtime-retry', fields: { category: 'transient-network' } },
    { event: 'runtime-retry', fields: { category: 'transient-http', status: 429 } }
  ]);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('runtime loop waits are promptly cancelled without a second ACK flush', async () => {
  const controller = new AbortController();
  let flushes = 0;
  const client = {
    async session() { return { status: 'ACTIVE' }; },
    async heartbeat() { return { status: 'ACTIVE' }; },
    async flushAcks() { flushes += 1; }
  };
  await runRuntimeLoop(client, {
    signal: controller.signal,
    wait: async (_delay, signal) => { controller.abort(); assert.equal(signal.aborted, true); }
  });
  assert.equal(flushes, 1);
});


test('runtime loop aborts an active request and does not begin heartbeat or ACK flush', async () => {
  const controller = new AbortController();
  let heartbeats = 0;
  let flushes = 0;
  const client = {
    async session(_health, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled with private data'), { name: 'AbortError' })), { once: true });
      });
    },
    async heartbeat() { heartbeats += 1; },
    async flushAcks() { flushes += 1; }
  };
  const running = runRuntimeLoop(client, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await running;
  assert.equal(heartbeats, 0);
  assert.equal(flushes, 0);
});


test('both source systemd templates suppress permanent exit and back off restarts', async () => {
  for (const path of [new URL('../systemd/cyf-agent-runtime-v1@.service', import.meta.url), new URL('../../../systemd/cyf-agent-runtime-v1@.service', import.meta.url)]) {
    const unit = await readFile(path, 'utf8');
    assert.match(unit, /^RestartPreventExitStatus=78$/m);
    assert.equal(unit.match(/^RestartSec=5s$/gm)?.length, 1);
  }
});

test('SIGTERM between loop steps prevents all subsequent network and ACK calls', async () => {
  for (const abortAt of ['session', 'heartbeat']) {
    const controller = new AbortController();
    const calls = [];
    const client = {
      async session() { calls.push('session'); if (abortAt === 'session') controller.abort(); return { status: 'ACTIVE' }; },
      async heartbeat() { calls.push('heartbeat'); if (abortAt === 'heartbeat') controller.abort(); return { status: 'ACTIVE' }; },
      async flushAcks() { calls.push('flushAcks'); }
    };
    await runRuntimeLoop(client, { signal: controller.signal });
    assert.deepEqual(calls, abortAt === 'session' ? ['session'] : ['session', 'heartbeat']);
  }
});


test('SIGTERM during ACK flush stops later ACK sends and retains the durable queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyf-runtime-v1-'));
  const controller = new AbortController();
  const sentStatuses = [];
  const client = new RuntimeV1Client({
    manifest: manifest(), apiBaseUrl: 'https://api.example.test', stateDir: directory,
    fetchFn: async (_url, options) => {
      if (!options.headers.authorization) return response({ data: { runtimeAuthorization: 'runtime-token' } });
      sentStatuses.push(JSON.parse(options.body).status);
      controller.abort();
      return response({ data: { kind: 'ADVANCED' } });
    }
  });
  await client.enroll('enroll-secret');
  await client.queueAck(command(), 'RECEIVED');
  await client.queueAck(command(), 'STARTED');
  await assert.rejects(client.flushAcks({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.deepEqual(sentStatuses, ['RECEIVED']);
  const saved = await readPrivateJson(client.pendingAcksPath(), null);
  assert.deepEqual(saved.pending[0].acks.map(ack => ack.status), ['RECEIVED', 'STARTED']);
});
