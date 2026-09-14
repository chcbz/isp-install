import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const REQUIRED_FIELDS = [
  'runtimeProtocolVersion', 'manifestVersion', 'installationId',
  'tenantId', 'clientId', 'canonicalAgentId', 'manifestSha256'
];

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function digestManifest(manifest) {
  const { manifestSha256: _ignored, ...unsigned } = manifest;
  return `sha256:${createHash('sha256').update(stableJson(unsigned)).digest('hex')}`;
}

export function validateManifest(manifest) {
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('manifest must be a JSON object');
  for (const key of REQUIRED_FIELDS) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') throw new Error(`manifest requires non-empty ${key}`);
  }
  if (manifest.runtimeProtocolVersion !== 'v1') throw new Error('manifest runtimeProtocolVersion must be v1');
  if (!/^sha256:[0-9a-f]{64}$/.test(manifest.manifestSha256)) {
    throw new Error('manifestSha256 must be sha256: followed by lowercase hex');
  }
  if (digestManifest(manifest) !== manifest.manifestSha256) throw new Error('manifest SHA-256 mismatch');
  return Object.freeze({ ...manifest });
}

export async function readManifest(path) {
  try {
    return validateManifest(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    throw new Error(`unable to read manifest: ${error.message}`);
  }
}
