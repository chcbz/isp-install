import { readHostingConfig } from './hosting-config.mjs';
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

// UR-01 local configuration catalog: configVersion, hostId, stateRoot, agents;
// agent entries reference manifestPath/profilePath/stateRoot. Not an API schema.
// Config validation has no mkdir, chmod, migration, enrollment or engine effects.
export function runtimeSubjectKey(manifest) {
  return createHash('sha256').update(stableJson({ tenantId: manifest.tenantId,
    clientId: manifest.clientId, canonicalAgentId: manifest.canonicalAgentId })).digest('hex');
}

const mutableProfilePaths = ['codexHome', 'codexWorkdir', 'chatWorkdir', 'workspaceFallbackWorkdir',
  'workspaceFileRootDir', 'typedInspectionRootDir', 'typedInspectionStateRoot',
  'controlledImageHttpLedgerRoot'];
const configError = code => Object.assign(new Error(code), { code });
const exact = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const rejectLegacyCredentials = value => {
  if (!object(value)) throw configError('RUNTIME_PROFILE_INVALID');
  for (const [key, item] of Object.entries(value)) {
    if (['apiKey', 'workspaceFileRuntimeAuthHeader', 'runtimeAuthorization', 'enrollmentSecret',
      'runtimeIdentity', 'runtimeInstanceId', 'runtimeStateRoot', 'runtimeSubjectKey', 'runtimeProviderEnvironment', 'runtimeSend'].includes(key)) throw configError('RUNTIME_PROFILE_CREDENTIAL_FORBIDDEN');
    if (object(item)) rejectLegacyCredentials(item);
    if (Array.isArray(item)) item.filter(object).forEach(rejectLegacyCredentials);
  }
};

export async function readRuntimeHostConfig(configPath) {
  const { constants, lstat, open, realpath } = await import('node:fs/promises');
  const { dirname, isAbsolute, relative, resolve, sep } = await import('node:path');
  async function canonicalPath(path) {
    if (!exact(path) || !isAbsolute(path) || resolve(path) !== path) throw configError('RUNTIME_PATH_INVALID');
    // Validate every ancestor, including missing leaf roots, without creating it.
    let cursor = path;
    while (true) {
      try {
        if ((await lstat(cursor)).isSymbolicLink() || await realpath(cursor) !== cursor) throw configError('RUNTIME_PATH_SYMLINK');
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return path;
  }
  async function jsonFile(path) {
    await canonicalPath(path);
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await descriptor.stat({ bigint: true });
      if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n) !== 0n) throw configError('RUNTIME_CONFIG_FILE_UNSAFE');
      const bytes = await descriptor.readFile('utf8');
      await canonicalPath(path);
      const current = await lstat(path, { bigint: true });
      const after = await descriptor.stat({ bigint: true });
      if (current.dev !== stat.dev || current.ino !== stat.ino || after.size !== stat.size
          || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw configError('RUNTIME_CONFIG_FILE_CHANGED');
      return JSON.parse(bytes);
    } finally { await descriptor.close(); }
  }
  const path = resolve(configPath);
  const config = await jsonFile(path);
  if (!object(config) || !['agents,configVersion,hostId,stateRoot', 'agents,configVersion,hostId,hostingControlPath,stateRoot'].includes(Object.keys(config).sort().join(','))
      || config.configVersion !== 1 || !exact(config.hostId) || !Array.isArray(config.agents) || !config.agents.length) throw configError('RUNTIME_HOST_CONFIG_INVALID');
  await canonicalPath(config.stateRoot);
  const subjects = new Set(); const installations = new Set(); const roots = [];
  const contains = (left, right) => { const tail = relative(left, right); return tail === '' || (!tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail)); };
  function addRoot(path, subjectKey) {
    for (const root of roots) {
      if (root.subjectKey !== subjectKey && (contains(root.path, path) || contains(path, root.path))) throw configError('RUNTIME_AGENT_ROOTS_OVERLAP');
    }
    if (contains(config.stateRoot, path) || contains(path, config.stateRoot)) throw configError('RUNTIME_HOST_ROOT_OVERLAP');
    roots.push({ path, subjectKey });
  }
  const agents = [];
  for (const entry of config.agents) {
    if (!object(entry) || Object.keys(entry).sort().join(',') !== 'manifestPath,profilePath,stateRoot') throw configError('RUNTIME_AGENT_CONFIG_INVALID');
    const manifest = validateManifest(await jsonFile(entry.manifestPath));
    for (const field of ['installationId', 'tenantId', 'clientId', 'canonicalAgentId']) if (!exact(manifest[field])) throw configError('RUNTIME_AGENT_IDENTITY_INVALID');
    const subjectKey = runtimeSubjectKey(manifest);
    if (subjects.has(subjectKey)) throw configError('RUNTIME_AGENT_IDENTITY_DUPLICATE');
    if (installations.has(manifest.installationId)) throw configError('RUNTIME_INSTALLATION_DUPLICATE');
    subjects.add(subjectKey); installations.add(manifest.installationId);
    const profile = await jsonFile(entry.profilePath); rejectLegacyCredentials(profile);
    if (!exact(profile.profileId) || profile.agentId !== manifest.canonicalAgentId || profile.enabled === false
        || !exact(profile.codexHome) || !exact(profile.codexWorkdir) || !exact(profile.codexBin)) throw configError('RUNTIME_PROFILE_IDENTITY_INVALID');
    const stateRoot = await canonicalPath(entry.stateRoot); addRoot(stateRoot, subjectKey);
    for (const field of mutableProfilePaths) if (profile[field]) addRoot(await canonicalPath(profile[field]), subjectKey);
    // Model/CLI policy remains the existing executor's responsibility. No persona,
    // API key or host-environment fallback is used to synthesize an identity.
    agents.push({ manifestPath: entry.manifestPath, profilePath: entry.profilePath, manifest, profile, stateRoot, subjectKey });
  }
  const result = { configVersion: 1, hostId: config.hostId, stateRoot: config.stateRoot, agents };
  if (Object.hasOwn(config, 'hostingControlPath')) result.hostingControl = await readHostingConfig(await canonicalPath(config.hostingControlPath), result);
  return deepFreeze(result);
}
