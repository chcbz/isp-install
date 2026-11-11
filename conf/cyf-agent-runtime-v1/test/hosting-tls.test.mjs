import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, chmod, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { connect as unixConnect } from 'node:net';
import { hostingFixture, fixtureInventory } from './hosting-fixture.mjs';
import { startHostingServer } from '../lib/hosting-server.mjs';
import { validateHostingConfig, readHostingConfig, readHostingTlsOptions } from '../lib/hosting-config.mjs';
import { eventMessage } from '../lib/message-envelope.mjs';

const openssl = (root, args) => execFileSync('openssl', args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
async function certificates(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'hosting-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  openssl(root, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Fixture control CA', '-days', '1']);
  for (const name of ['server', 'client']) {
    openssl(root, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=fixture-${name}`]);
    await writeFile(resolve(root, `${name}.ext`), name === 'server'
      ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
      : 'extendedKeyUsage=clientAuth\n');
    openssl(root, ['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`]);
  }
  openssl(root, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'unknown.key', '-out', 'unknown.crt', '-subj', '/CN=Unknown client', '-days', '1']);
  const remote = { listenHost: '127.0.0.1', port: 0, certificatePath: resolve(root, 'server.crt'),
    privateKeyPath: resolve(root, 'server.key'), clientCaPath: resolve(root, 'ca.crt') };
  const options = { ca: await readFile(resolve(root, 'ca.crt')), key: await readFile(resolve(root, 'client.key')),
    cert: await readFile(resolve(root, 'client.crt')), rejectUnauthorized: true };
  return { root, remote, options };
}
function exchange(socket, bytes) {
  return new Promise((resolve, reject) => {
    let received = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => { received += chunk; });
    socket.on('error', reject); socket.on('end', () => {
      try { if (!received.endsWith('\n')) throw Error('NO_CONTROL_REPLY'); resolve(JSON.parse(received)); } catch (cause) { reject(cause); }
    });
    socket.on('close', () => { if (!received) reject(Error('NO_CONTROL_REPLY')); });
    socket.write(bytes);
  });
}
const frame = (method, data) => JSON.stringify(eventMessage('tls-request', `hosting.${method}`, 'tls-message', data)) + '\n';
const association = f => ({ tenantId: '0', clientId: 'fixture-client', ownerJiacn: 'fixture-owner',
  canonicalAgentId: f.peers[0].manifest.canonicalAgentId, bindingId: '17', leaseId: 'tls-lease',
  initialIntentId: 'tls-intent', operationId: 'tls-intent', operationKind: 'INITIAL', reservedAt: f.now(), requestedAt: f.now(),
  validUntilAt: null, runtimeInstallationId: f.peers[0].manifest.installationId,
  manifestSha256: f.peers[0].manifest.manifestSha256.slice(7), provisionGeneration: '1' });

test('mTLS and private UDS share one journal; host control survives stopped Agent and enforces scope', async t => {
  const c = await certificates(t), f = await hostingFixture(t, { staticPeers: true, observeInventory: fixtureInventory });
  f.controlConfig.remote = c.remote; validateHostingConfig(f.controlConfig);
  const server = await startHostingServer({ control: f.control() });
  try {
  const address = server.remoteAddress;
  const remote = (method, data, options = c.options) => exchange(tlsConnect({ ...options, host: '127.0.0.1', port: address.port }), frame(method, data));
  const request = association(f);
  const adopted = await remote('adopt', request); assert.equal(adopted.code, 'E0'); assert.equal(adopted.data.outcome, 'ADOPTED');
  const local = await exchange(unixConnect(f.controlConfig.socketPath), frame('adopt', request));
  assert.deepEqual(local.data, adopted.data);
  const wrong = await remote('adopt', { ...request, ownerJiacn: 'untrusted-owner' });
  assert.equal(wrong.code, 'HOSTING_SCOPE_REJECTED');
  assert.equal(f.host().snapshot().agents.filter(agent => agent.ready).length, 3);
  const handover = { ...request, handoverId: 'tls-finish' };
  assert.equal((await remote('quiesce', handover)).data.outcome, 'QUIESCED');
  assert.equal(f.states.get(f.peers[0].subjectKey)[0].closed, 1);
  f.host().flushEvidence = async () => ({ confirmed: true });
  assert.equal((await remote('evidence', handover)).data.outcome, 'EVIDENCE_ACCEPTED');
  assert.equal(f.host().snapshot().agents.filter(agent => agent.ready).length, 2);
  assert.equal(f.enrollmentCount(), 0);
  const oversize = tlsConnect({ ...c.options, host: '127.0.0.1', port: address.port });
  await assert.rejects(exchange(oversize, 'x'.repeat(16385)));
  assert.equal((await remote('adopt', request)).code, 'E0');
  } finally { await server.close(); }
});

test('TLS rejects missing/unknown client certificates and mismatched server identity before control dispatch', async t => {
  const c = await certificates(t), f = await hostingFixture(t, { staticPeers: true });
  f.controlConfig.remote = c.remote;
  const server = await startHostingServer({ control: f.control() });
  try {
  const options = { host: '127.0.0.1', port: server.remoteAddress.port, ca: c.options.ca, rejectUnauthorized: true };
  const bytes = frame('adopt', association(f));
  await assert.rejects(exchange(tlsConnect(options), bytes));
  await assert.rejects(exchange(tlsConnect({ ...options, key: await readFile(resolve(c.root, 'unknown.key')),
    cert: await readFile(resolve(c.root, 'unknown.crt')) }), bytes));
  await assert.rejects(exchange(tlsConnect({ ...options, ...c.options, servername: 'not-this-host.invalid' }), bytes));
  assert.deepEqual(f.control().state.subjects, {});
  assert.equal(f.host().snapshot().agents.filter(agent => agent.ready).length, 3);
  } finally { await server.close(); }
});

test('unsafe operator key fails closed and closes the partially opened private listener', async t => {
  const c = await certificates(t), f = await hostingFixture(t, { staticPeers: true });
  f.controlConfig.remote = c.remote;
  await chmod(c.remote.privateKeyPath, 0o644);
  await assert.rejects(readHostingTlsOptions(c.remote), { code: 'HOSTING_REMOTE_CREDENTIAL_UNSAFE' });
  await assert.rejects(startHostingServer({ control: f.control() }), { code: 'HOSTING_REMOTE_CREDENTIAL_UNSAFE' });
  await assert.rejects(lstat(f.controlConfig.socketPath), { code: 'ENOENT' });
  assert.equal(f.host().snapshot().agents.filter(agent => agent.ready).length, 3);
});


test('operator remote config validates credentials outside Agent roots and refuses path aliases', async t => {
  const c = await certificates(t), f = await hostingFixture(t, { staticPeers: true });
  const config = { ...f.controlConfig, template: null, remote: c.remote };
  const path = resolve(f.root, 'tls-control.json');
  const read = async value => {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return readHostingConfig(path, f.hostConfig);
  };
  assert.deepEqual(await read(config), config);
  for (const change of [{ listenHost: 'operator.example' }, { port: -1 }, { port: 65536 },
    { port: 1.5 }, { certificatePath: 'relative.crt' }, { rejectUnauthorized: false }]) {
    assert.throws(() => validateHostingConfig({ ...config, remote: { ...c.remote, ...change } }),
      { code: 'HOSTING_REMOTE_CONFIG_INVALID' });
  }
  await assert.rejects(read({ ...config, remote: { ...c.remote,
    privateKeyPath: resolve(f.peers[0].profile.codexHome, 'control.key') } }),
    { code: 'HOSTING_REMOTE_CREDENTIAL_ROOT_UNSAFE' });
  const alias = resolve(c.root, 'aliased.key'); await symlink(c.remote.privateKeyPath, alias);
  await assert.rejects(read({ ...config, remote: { ...c.remote, privateKeyPath: alias } }),
    { code: 'HOSTING_CONFIG_PATH_UNSAFE' });
  await chmod(c.remote.clientCaPath, 0o666);
  await assert.rejects(read(config), { code: 'HOSTING_REMOTE_CREDENTIAL_UNSAFE' });
});
