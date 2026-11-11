#!/usr/bin/env node
// Local integration fixture ONLY: actual private UDS + HostingControl/RuntimeHost,
// synthetic native enrollment/session/executor; no real API/provider/production.
// Parent keeps stdin open. Send "stop\n" or EOF to close all owned resources.
import { hostingFixture } from './hosting-fixture.mjs';
import { cleanStoppedPrivateData } from '../lib/private-data-cleanup.mjs';
import { startHostingServer } from '../lib/hosting-server.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const cleanups = [];
let server; let stopPromise;
const stop = () => stopPromise ||= (async () => {
  try { await server?.close(); }
  finally {
    const results = await Promise.allSettled(cleanups.reverse().map(cleanup => cleanup()));
    process.stdin.pause();
    if (results.some(result => result.status === 'rejected')) throw Error('SYNTHETIC_CLEANUP_FAILED');
  }
})();
// node --test discovers every .mjs under test/. Do not start an interactive
// fixture as a test-runner child; explicit Java/CLI spawn remains the entry.
if (!process.env.NODE_TEST_CONTEXT) {
try {
  const staticPeers = process.env.CYF_GSS_STATIC_ADOPTION === '1';
  const fixture = await hostingFixture({ after: cleanup => cleanups.push(cleanup) }, { staticPeers });
  if (process.env.CYF_GSS_INVENTORY_CODEX_BIN) {
    const peer = fixture.peers[0];
    peer.profile.codexBin = process.env.CYF_GSS_INVENTORY_CODEX_BIN;
    for (const name of ['manual-fixture', 'disabled-fixture']) {
      const directory = resolve(peer.profile.codexHome, 'skills', name);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Public inventory integration fixture.\n---\n`);
    }
    await writeFile(resolve(peer.profile.codexHome, 'config.toml'),
      `[[skills.config]]\npath = ${JSON.stringify(resolve(peer.profile.codexHome, 'skills/disabled-fixture/SKILL.md'))}\nenabled = false\n`);
  }
  // Evidence transport fixture only: real stop/gate/journal; provider delivery is synthetic.
  let attempts = 0;
  fixture.host().flushEvidence = async () => ({ confirmed: ++attempts > 1 });
  // Actual storage aggregate; only the knowledge provider is synthetic here.
  fixture.host().cleanPrivateData = options => cleanStoppedPrivateData({ ...options,
    apiOrigin: 'https://example.test', instanceId: fixture.host().instanceId,
    publicFiles: options.agent.publicFiles, flushPlatformCosts: async () => ({ confirmed: true }), extractKnowledge: async () => ({ confirmed: true }) });
  if (process.env.CYF_GSS_TLS_CONFIG) fixture.controlConfig.remote = JSON.parse(await readFile(process.env.CYF_GSS_TLS_CONFIG, 'utf8'));
  const control = fixture.control(), handle = control.handle.bind(control);
  control.handle = async request => {
    const started = performance.now();
    try {
      const result = await handle(request);
      process.stderr.write(JSON.stringify({ fixtureControl: request.method, outcome: result.outcome ?? null, elapsedMs: performance.now() - started }) + '\n');
      return result;
    } catch (cause) {
      process.stderr.write(JSON.stringify({ fixtureControl: request.method, errorCode: cause.code ?? 'UNKNOWN', elapsedMs: performance.now() - started }) + '\n');
      throw cause;
    }
  };
  server = await startHostingServer({ control });
  process.stdout.write(JSON.stringify({ socketPath: fixture.controlConfig.socketPath, uid: process.getuid(), gid: fixture.controlConfig.socketGid,
    ...(server.remoteAddress ? { remoteAddress: server.remoteAddress } : {}), hostId: fixture.host().config.hostId, instanceId: fixture.host().instanceId,
    ...(staticPeers ? { adoptionSubject: fixture.peers[0].manifest } : {}) }) + '\n');
  let input = '';
  const close = () => { void stop().catch(() => { process.stderr.write('SYNTHETIC_FIXTURE_STOP_FAILED\n'); process.exitCode = 1; }); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', bytes => { input += bytes; if (input.split(/\r?\n/).some(line => line === 'stop')) close(); });
  process.stdin.on('end', close); process.stdin.on('error', close);
  process.once('SIGTERM', close); process.once('SIGINT', close);
  process.stdin.resume();
} catch {
  await stop().catch(() => {});
  process.stderr.write('SYNTHETIC_FIXTURE_START_FAILED\n'); process.exitCode = 1;
}

}
