// Owned offline integration fixture for the Java production UDS adapter. No
// Provider or production API connection; real HostingControl/RuntimeHost/server.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { hostingFixture, candidateRequest } from './hosting-fixture.mjs';
import { startHostingServer } from '../lib/hosting-server.mjs';
const cleanups = [];
const f = await hostingFixture({ after(fn) { cleanups.push(fn); } }, { rootParent: process.env.CYF_HOSTING_TEST_TMP_ROOT });
let server;
try {
  const wire = JSON.parse(await readFile(new URL('./fixtures/gss-hosting-control-v1.json', import.meta.url)));
  const candidate = await f.control().handle(wire.prepareRequest);
  await f.control().handle(candidateRequest(wire.prepareRequest, candidate, 'ensure')); await f.settle();
  server = await startHostingServer({ control: f.control() });
  process.stdout.write(JSON.stringify({ socketPath: f.controlConfig.socketPath, candidate }) + '\n');
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) { if (line === 'stop') break; }
  lines.close();
  const states = f.host().snapshot().agents;
  process.stdout.write(JSON.stringify({ quiesced: states.filter(s => s.phase === 'QUIESCED').length,
    readyPeers: states.filter(s => s.ready).length }) + '\n');
} finally {
  await server?.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
