#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRuntimeHostConfig } from './lib/manifest.mjs';
import { createLogger, readEnrollmentSecret } from './lib/security.mjs';
import { classifyRuntimeError, RuntimeV1Client } from './lib/runtime-client.mjs';
import { RuntimeHost } from './lib/runtime-host.mjs';
import { createExecutionAdapterFactory } from './lib/execution-adapter.mjs';
import { createHostingControlServer } from './lib/hosting-server.mjs';
export const PERMANENT_RUNTIME_EXIT_STATUS = 78;

export function runtimeExitStatus(error) {
  return ['transient-network', 'transient-http'].includes(classifyRuntimeError(error).kind)
    ? 1
    : PERMANENT_RUNTIME_EXIT_STATUS;
}


const failure = code => Object.assign(new Error(code), { code });
function parseArgs(argv) {
  const [command, ...rest] = argv; const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--config', '--subject', '--api-base-url', '--workspace-policies'].includes(rest[i]) || !rest[i + 1]
        || rest[i + 1].startsWith('--') || Object.hasOwn(options, rest[i].slice(2))) throw failure('RUNTIME_ARGUMENT_INVALID');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (!options.config || !['validate', 'enroll', 'run'].includes(command)) throw failure('RUNTIME_CONFIG_REQUIRED');
  return { command, options };
}
const wait = (ms, signal) => new Promise(resolveWait => {
  if (signal.aborted) return resolveWait();
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolveWait(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});

// One lifetime host; enrollment is an explicit per-subject management operation.
// No sidecar heartbeat-only run mode, legacy API-key entry or second ACK queue.
export async function runUnifiedRuntime({ config, apiOrigin, instanceId = randomUUID(), signal,
  createAdapters = createExecutionAdapterFactory, workspacePolicies, providerEnvironments, logger = () => {},
  heartbeatIntervalMs = 30000, waitFn = wait, createControl = createHostingControlServer } = {}) {
  const adapters = await createAdapters({ config, instanceId, apiOrigin, workspacePolicies, providerEnvironments, logger });
  const host = new RuntimeHost({ config, instanceId, createExecutor: adapters.createExecutor, logger });
  let controlServer = null;
  try {
    await host.start();
    if (config.hostingControl) controlServer = await createControl({ host, config: config.hostingControl, apiOrigin, workspacePolicies, logger });
    const activate = config.agents.map(agent => {
      if (host.agents.get(agent.subjectKey).phase !== 'INITIALIZED') return Promise.resolve();
      return host.activate(agent.subjectKey).catch(error => logger('runtime-agent-isolated', { subjectKey: agent.subjectKey, category: classifyRuntimeError(error).kind }));
    });
    // Activation may wait for a directed registration, but SIGTERM must still
    // reach each transport/owned engine, not queue behind the lifecycle gate.
    const stop = () => { void controlServer?.close().catch(() => {}); void adapters.close().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (signal.aborted) stop();
      // Per-Agent registration is independent from the host heartbeat loop.
      // Every activation has its own rejection handler above.
      void Promise.allSettled(activate);
      while (!signal.aborted) { await adapters.heartbeat(); if (!signal.aborted) await waitFn(heartbeatIntervalMs, signal); }
    } finally { signal.removeEventListener('abort', stop); }
  } finally {
    try { await controlServer?.close(); await host.stop(); await adapters.close(); }
    finally { if (!host.releaseHost) await controlServer?.control.releaseOwnership(); }
  }
  return host.snapshot();
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, options } = parseArgs(argv);
  const config = await readRuntimeHostConfig(resolve(options.config));
  const logger = createLogger();
  if (command === 'validate') {
    process.stdout.write(`${JSON.stringify({ valid: true, hostId: config.hostId, agentCount: config.agents.length })}\n`); return 0;
  }
  const apiOrigin = options['api-base-url'] || env.CYF_RUNTIME_V1_API_BASE_URL;
  if (!apiOrigin) throw failure('RUNTIME_API_ORIGIN_REQUIRED');
  if (command === 'enroll') {
    const agent = config.agents.find(agent => agent.subjectKey === options.subject);
    if (!agent) throw failure('RUNTIME_EXACT_SUBJECT_REQUIRED');
    const client = new RuntimeV1Client({ manifest: agent.manifest, apiBaseUrl: apiOrigin, stateDir: agent.stateRoot });
    await client.enroll((await readEnrollmentSecret(env)).value);
    logger('runtime-enrolled', { subjectKey: agent.subjectKey }); return 0;
  }
  const policyFile = options['workspace-policies'] || env.CYF_RUNTIME_WORKSPACE_POLICIES_FILE;
  const workspacePolicies = policyFile ? (await import('../codex-ws-agent/workspace-manager.mjs')).loadWorkspacePolicies({ CODEX_WORKSPACE_POLICIES_FILE: policyFile }) : new Map();
  const interval = Number(env.CYF_RUNTIME_V1_HEARTBEAT_INTERVAL_MS || 30000);
  if (!Number.isSafeInteger(interval) || interval < 1) throw failure('RUNTIME_HEARTBEAT_INTERVAL_INVALID');
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { await runUnifiedRuntime({ config, apiOrigin, signal: controller.signal, logger, workspacePolicies, heartbeatIntervalMs: interval }); return 0; }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  const category = classifyRuntimeError(error);
  console.error(JSON.stringify({ event: 'runtime-error', category: category.kind, ...(category.status ? { status: category.status } : {}) }));
  process.exitCode = runtimeExitStatus(error);
});
