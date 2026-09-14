#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readManifest } from './lib/manifest.mjs';
import { createLogger, readEnrollmentSecret } from './lib/security.mjs';
import { RuntimeV1Client } from './lib/runtime-client.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function runtimeOptions(options, env) {
  const manifestPath = resolve(options.manifest || 'manifest.json');
  const stateDir = resolve(options['state-dir'] || 'runtime-state');
  const apiBaseUrl = options['api-base-url'] || env.CYF_RUNTIME_V1_API_BASE_URL;
  if (!apiBaseUrl) throw new Error('CYF_RUNTIME_V1_API_BASE_URL is required');
  return { manifestPath, stateDir, apiBaseUrl };
}

function isRebindRequired(response) {
  return response?.status === 'REBINDS_REQUIRED' || response?.sessionStatus === 'REBINDS_REQUIRED';
}

function intervalMs(env) {
  const raw = env.CYF_RUNTIME_V1_HEARTBEAT_INTERVAL_MS || '60000';
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error('CYF_RUNTIME_V1_HEARTBEAT_INTERVAL_MS must be a positive integer');
  return Number(raw);
}

const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));

async function readCommand(path) {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`unable to read command: ${error.message}`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, options } = parseArgs(argv);
  const logger = createLogger();
  if (command === 'validate') {
    const manifest = await readManifest(resolve(options.manifest || 'manifest.json'));
    process.stdout.write(`${JSON.stringify({ valid: true, installationId: manifest.installationId, manifestSha256: manifest.manifestSha256 })}\n`);
    return 0;
  }

  const { manifestPath, stateDir, apiBaseUrl } = runtimeOptions(options, env);
  const manifest = await readManifest(manifestPath);
  const client = new RuntimeV1Client({ manifest, apiBaseUrl, stateDir });

  if (command === 'enroll') {
    const enrollment = await readEnrollmentSecret(env);
    await client.enroll(enrollment.value);
    logger('enrolled', { installationId: manifest.installationId, secretSource: enrollment.source });
    return 0;
  }
  if (command === 'session') {
    const response = await client.session(options.health || 'HEALTHY');
    if (isRebindRequired(response)) throw new Error('rebind required');
    logger('session-established', { installationId: manifest.installationId });
    return 0;
  }
  if (command === 'heartbeat') {
    const response = await client.heartbeat(options.health || 'HEALTHY');
    if (isRebindRequired(response)) throw new Error('rebind required');
    logger('heartbeat-sent', { installationId: manifest.installationId });
    return 0;
  }
  if (command === 'ack') {
    if (!options.command || !options.status) throw new Error('ack requires --command and --status');
    await client.queueAck(await readCommand(options.command), options.status);
    await client.flushAcks();
    logger('ack-flush-complete', { installationId: manifest.installationId });
    return 0;
  }
  if (command === 'run') {
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      await client.loadAuthorization();
    } catch (error) {
      if (error.message !== 'Runtime v1 enrollment is required') throw error;
      const enrollment = await readEnrollmentSecret(env);
      await client.enroll(enrollment.value);
      logger('enrolled', { installationId: manifest.installationId, secretSource: enrollment.source });
    }
    while (!stopping) {
      const session = await client.session(options.health || 'HEALTHY');
      if (isRebindRequired(session)) throw new Error('rebind required');
      const heartbeat = await client.heartbeat(options.health || 'HEALTHY');
      if (isRebindRequired(heartbeat)) throw new Error('rebind required');
      await client.flushAcks();
      if (!stopping) await sleep(intervalMs(env));
    }
    logger('stopped', { installationId: manifest.installationId });
    return 0;
  }
  throw new Error('usage: agent-runtime.mjs <validate|enroll|session|heartbeat|ack|run> [options]');
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    // Do not print exception text: configuration, headers, and enrollment input must stay out of logs.
    console.error(JSON.stringify({ event: 'runtime-v1-error' }));
    process.exitCode = 1;
  });
}
