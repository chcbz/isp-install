import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestManifest, validateManifest } from '../lib/manifest.mjs';
import { createLogger, readEnrollmentSecret } from '../lib/security.mjs';
import { RuntimeV1Client, validateCommandForManifest } from '../lib/runtime-client.mjs';

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
