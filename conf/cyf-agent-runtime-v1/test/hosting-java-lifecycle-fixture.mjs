#!/usr/bin/env node
// Disposable real HostingControl/RuntimeHost + API enrollment/session integration.
// Executor registration/channel is synthetic; no provider or production filesystem access.
import { hostingFixture } from './hosting-fixture.mjs';
import { cleanStoppedPrivateData } from '../lib/private-data-cleanup.mjs';
import { createExecutionAdapterFactory } from '../lib/execution-adapter.mjs';
import { startHostingServer } from '../lib/hosting-server.mjs';
const cleanups = [];
if (!process.env.NODE_TEST_CONTEXT) {
  const apiOrigin = process.argv[2];
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin)) throw Error('LOOPBACK_API_REQUIRED');
  const fixture = await hostingFixture({ after: fn => cleanups.push(fn) }, { apiOrigin, clock: Date.now,
    scopes: ['owner', 'next-owner'].map(ownerJiacn => ({ tenantId: 'tenant', clientId: 'client', ownerJiacn })) });
  fixture.controlConfig.template.profile.codexBin = process.env.CYF_GSS_INVENTORY_CODEX_BIN;
  if (!fixture.controlConfig.template.profile.codexBin) throw Error('EXPLICIT_CODEX_REQUIRED');
  // Registration/execution remains synthetic, but relationship readmission must
  // use the production manager + engine identity transition (never a success stub).
  // This adapter has no attached executor, as on a process-recovery admission;
  // hosting-readmission-integration covers closing an attached real executor.
  const adapters = await createExecutionAdapterFactory({ config: fixture.hostConfig,
    instanceId: fixture.host().instanceId, apiOrigin });
  cleanups.push(() => adapters.close());
  fixture.host().admitRelationship = adapters.admitRelationship;
  fixture.host().flushEvidence = async () => ({ confirmed: true });
  fixture.host().cleanPrivateData = options => cleanStoppedPrivateData({ ...options, apiOrigin,
    instanceId: fixture.host().instanceId, publicFiles: options.agent.publicFiles,
    flushPlatformCosts: async () => ({ confirmed: true }), extractKnowledge: async () => ({ confirmed: true }) });
  // Preserve the real observer and expose only method/timing/error codes, never
  // request bodies or provider credentials, when a Java transport probe fails.
  const control = fixture.control(); const handle = control.handle.bind(control);
  control.handle = async request => {
    const started = performance.now();
    try { const result = await handle(request);
      console.error(JSON.stringify({ method: request.method, elapsedMs: performance.now() - started, outcome: result.outcome || 'OK' }));
      return result;
    } catch (error) {
      console.error(JSON.stringify({ method: request.method, elapsedMs: performance.now() - started, errorCode: error.code || error.name }));
      throw error;
    }
  };
  const server = await startHostingServer({ control });
  process.stdout.write(JSON.stringify({ socketPath: fixture.controlConfig.socketPath, uid: process.getuid(),
    gid: process.getgid(), root: fixture.root, hostId: fixture.host().config.hostId }) + '\n');
  let stopped;
  const stop = () => stopped ||= (async () => { await server.close();
    for (const cleanup of cleanups.reverse()) await cleanup(); process.stdin.pause(); })();
  process.stdin.resume(); process.stdin.on('end', () => stop().catch(() => { process.exitCode = 1; }));
  process.on('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
}
