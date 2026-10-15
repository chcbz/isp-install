import { eventMessage, validateMessage } from '../lib/message-envelope.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./hosting-java-bridge-fixture.mjs', import.meta.url));
const wire = JSON.parse(await readFile(new URL('./fixtures/gss-hosting-control-v1.json', import.meta.url)));
const exchange = (path, internal) => new Promise((resolve, reject) => {
  const { protocol, method, ...data } = internal;
  if (Object.hasOwn(data, 'validUntil')) { data.validUntilAt = data.validUntil; delete data.validUntil; }
  if (Object.hasOwn(data, 'installationId')) { data.runtimeInstallationId = data.installationId; delete data.installationId; }
  if (Object.hasOwn(data, 'provisionGeneration')) data.provisionGeneration = String(data.provisionGeneration);
  const input = eventMessage('bridge-request', `hosting.${method}`, 'bridge-message', data);
  const socket = connect(path); let response = '';
  socket.on('connect', () => socket.write(JSON.stringify(input) + '\n')); socket.on('error', reject);
  socket.on('data', chunk => { response += chunk; }); socket.on('end', () => { try { const reply = validateMessage(JSON.parse(response)); assert.equal(reply.correlationId, input.messageId); assert.equal(reply.requestId, input.requestId); assert.equal(reply.code, 'E0'); resolve(reply.data); } catch (error) { reject(error); } });
});
async function bridge(t) {
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) child.stdin.end(); await exited; });
  const metadata = await new Promise((resolve, reject) => {
    let buffer = ''; child.on('error', reject);
    child.stdout.on('data', bytes => { buffer += bytes; if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0])); });
    child.once('exit', () => { if (!buffer.includes('\n')) reject(Error('synthetic fixture exited before metadata')); });
  });
  assert.deepEqual(Object.keys(metadata).sort(), ['gid', 'hostId', 'instanceId', 'socketPath', 'uid']);
  return { child, metadata, exited, stderr: () => stderr };
}

test('Java bridge entry actual UDS/controller initial/replay/free reprovision and stop-with-open-stdin cleanup', { timeout: 15000 }, async t => {
  const b = await bridge(t); const call = request => exchange(b.metadata.socketPath, request);
  async function ready(request) {
    const candidate = await call(request); assert.equal(candidate.outcome, 'PREPARED'); assert.deepEqual(await call(request), candidate);
    const operation = { ...request, method: 'ensure', ...{ installationId: candidate.runtimeInstallationId, manifestSha256: candidate.manifestSha256, provisionGeneration: Number(candidate.provisionGeneration) } };
    await call(operation); operation.method = 'observe';
    for (let i = 0; i < 1000; i++) {
      const response = await call(operation); if (response.outcome === 'SERVICE_READY') return { candidate, response };
      assert.equal(response.outcome, 'UNKNOWN'); await new Promise(done => setTimeout(done, 1));
    }
    assert.fail('synthetic subject did not become ready');
  }
  const initial = await ready(wire.prepareRequest); const repro = await ready({ ...wire.reprovisionPrepareRequest, requestedAt: wire.reprovisionPrepareRequest.reservedAt });
  assert.equal(initial.candidate.runtimeInstallationId, repro.candidate.runtimeInstallationId); assert.equal(initial.response.sessionGeneration, '1'); assert.equal(repro.response.sessionGeneration, '2');
  assert.equal(repro.response.hostId, b.metadata.hostId); assert.equal(repro.response.runtimeInstanceId, b.metadata.instanceId);
  b.child.stdin.write('stop\n'); const [exit] = await b.exited; assert.equal(exit, 0, b.stderr());
  await assert.rejects(lstat(dirname(dirname(b.metadata.socketPath))), cause => cause.code === 'ENOENT');
});

test('Java bridge EOF closes listener and all exclusively owned roots', { timeout: 15000 }, async t => {
  const b = await bridge(t); const response = await exchange(b.metadata.socketPath, wire.capabilitiesRequest); assert.equal(response.available, true);
  b.child.stdin.end(); const [exit] = await b.exited; assert.equal(exit, 0, b.stderr());
  await assert.rejects(lstat(dirname(dirname(b.metadata.socketPath))), cause => cause.code === 'ENOENT');
});
