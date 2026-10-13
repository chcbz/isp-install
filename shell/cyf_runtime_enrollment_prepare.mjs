#!/usr/bin/env node
// Offline preparation only: no HTTP, enrollment, service mutation or old-state adoption.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestManifest, runtimeSubjectKey, validateManifest } from '../conf/cyf-agent-runtime-v1/lib/manifest.mjs';

const fail = code => Object.assign(new Error(code), { code });
const exact = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const hex = value => createHash('sha256').update(value).digest('hex');

export function parseArguments(argv) {
  const args = {};
  const keys = ['--tenant-id', '--client-id', '--agent-id', '--output', '--expires-at'];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!keys.includes(key) || value === undefined || value.startsWith('--') || Object.hasOwn(args, key)) throw fail('PREPARE_ARGUMENT_INVALID');
    args[key] = value;
  }
  if (keys.some(key => !Object.hasOwn(args, key))) throw fail('PREPARE_ARGUMENT_REQUIRED');
  if (!/^\d+$/.test(args['--expires-at'])) throw fail('PREPARE_EXPIRY_INVALID');
  return { tenantId: args['--tenant-id'], clientId: args['--client-id'], canonicalAgentId: args['--agent-id'], output: args['--output'], expiresAt: Number(args['--expires-at']) };
}

export async function prepareEnrollment({ tenantId, clientId, canonicalAgentId, output, expiresAt }, now = Date.now()) {
  if (!exact(tenantId, 50) || !exact(clientId, 50) || !exact(canonicalAgentId, 100)) throw fail('PREPARE_SCOPE_INVALID');
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw fail('PREPARE_EXPIRY_INVALID');
  if (!exact(output, 4096) || !isAbsolute(output) || resolve(output) !== output) throw fail('PREPARE_PATH_INVALID');
  const parent = dirname(output);
  // No symlink in any ancestor; do not chmod or create an operator's parent.
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cursor) !== cursor) throw fail('PREPARE_PARENT_UNSAFE');
    if (dirname(cursor) === cursor) break;
  }
  const parentStat = await lstat(parent);
  if (parentStat.uid !== process.getuid() || (parentStat.mode & 0o022) !== 0) throw fail('PREPARE_PARENT_UNSAFE');
  // mkdir is exclusive: an existing directory/file/symlink is never adopted.
  await mkdir(output, { mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  const manifest = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: `rti_${randomBytes(16).toString('hex')}`, tenantId, clientId, canonicalAgentId };
  manifest.manifestSha256 = digestManifest(manifest);
  validateManifest(manifest);
  const request = { installationId: manifest.installationId, canonicalAgentId, manifestVersion: manifest.manifestVersion,
    manifestSha256: manifest.manifestSha256.slice('sha256:'.length), enrollmentSecretSha256: hex(secret), enrollmentExpiresAt: expiresAt };
  const files = {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'enrollment-secret': secret + '\n',
    'installation-request.json': JSON.stringify(request, null, 2) + '\n',
    'handoff.json': JSON.stringify({ scope: { tenantId, clientId, canonicalAgentId }, request }, null, 2) + '\n',
    'subject-key.txt': runtimeSubjectKey(manifest) + '\n'
  };
  for (const [name, data] of Object.entries(files)) await writeFile(`${output}/${name}`, data, { flag: 'wx', mode: 0o600 });
  return { prepared: true, registered: false, enrolled: false, installationId: manifest.installationId, output, files: Object.keys(files) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await prepareEnrollment(parseArguments(process.argv.slice(2))))); }
  catch (error) {
    // Never serialize inputs, file contents or secrets into diagnostic output.
    console.error(JSON.stringify({ prepared: false, code: typeof error.code === 'string' ? error.code : 'PREPARE_FAILED' }));
    process.exitCode = 1;
  }
}
