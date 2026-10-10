#!/usr/bin/env node
// Local integration fixture ONLY: actual private UDS + HostingControl/RuntimeHost,
// synthetic native enrollment/session/executor; no real API/provider/production.
// Parent keeps stdin open. Send "stop\n" or EOF to close all owned resources.
import { hostingFixture } from './hosting-fixture.mjs';
import { startHostingServer } from '../lib/hosting-server.mjs';
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
  const fixture = await hostingFixture({ after: cleanup => cleanups.push(cleanup) });
  server = await startHostingServer({ control: fixture.control() });
  process.stdout.write(JSON.stringify({ socketPath: fixture.controlConfig.socketPath, uid: process.getuid(), gid: fixture.controlConfig.socketGid,
    hostId: fixture.host().config.hostId, instanceId: fixture.host().instanceId }) + '\n');
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
