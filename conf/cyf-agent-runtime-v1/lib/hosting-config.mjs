// Operator-only local config. No control request can select these paths or keys.
import { constants, lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readPrivateJson } from './security.mjs';

export const hostingError = code => Object.assign(new Error(code), { code });
export const exactHostingId = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
export const MANAGED_PROFILE_FIELDS = Object.freeze(['codexBin', 'codexModel', 'codexSandbox', 'codexApproval', 'codexSessionMode',
  'chatEngine', 'chatModel', 'chatReasoningEffort', 'chatSandbox', 'chatToolPolicy', 'fastChatEnabled', 'appServerEnabled',
  'appServerSchemaContractId', 'trueDeltaEnabled', 'typedDeliberationEnabled', 'workspacePolicyId', 'workspaceRole',
  'workspaceNoTaskPolicy', 'workspaceNonCodingCommandTypes', 'executionReportCommandTypes', 'nativeConversationHttpPollEnabled',
  'abilities', 'skills']);
// Distinct operator-managed provider environment. Never inherit HOME/auth/session.
export const managedProviderKey = key => /^CYF_MANAGED_PROVIDER_[A-Z][A-Z0-9_]*$/.test(key);
export async function canonicalHostingPath(path) {
  if (!exactHostingId(path) || !isAbsolute(path) || resolve(path) !== path) throw hostingError('HOSTING_CONFIG_PATH_INVALID');
  let cursor = path;
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink() || await realpath(cursor) !== cursor) throw hostingError('HOSTING_CONFIG_PATH_UNSAFE'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const parent = dirname(cursor); if (parent === cursor) return path; cursor = parent;
  }
}
export function validateHostingConfig(value) {
  if (!fields(value, ['configVersion', 'socketPath', 'socketGid', 'managedRoot', 'scopes', 'template', 'enrollmentTtlMs'])
      || value.configVersion !== 1 || !Number.isSafeInteger(value.socketGid) || value.socketGid < 0
      || !Number.isSafeInteger(value.enrollmentTtlMs) || value.enrollmentTtlMs < 1
      || !Array.isArray(value.scopes) || !value.scopes.length
      || !fields(value.template, ['profile', 'codexConfig', 'providerEnvironment'])) throw hostingError('HOSTING_CONFIG_INVALID');
  const seen = new Set();
  for (const scope of value.scopes) {
    if (!fields(scope, ['tenantId', 'clientId', 'ownerJiacn']) || !Object.values(scope).every(exactHostingId)) throw hostingError('HOSTING_CONFIG_SCOPE_INVALID');
    const key = JSON.stringify([scope.tenantId, scope.clientId, scope.ownerJiacn]);
    if (seen.has(key)) throw hostingError('HOSTING_CONFIG_SCOPE_DUPLICATE'); seen.add(key);
  }
  const { profile, codexConfig, providerEnvironment } = value.template;
  if (!object(profile) || Object.keys(profile).some(key => !MANAGED_PROFILE_FIELDS.includes(key))
      || !exactHostingId(profile.codexBin) || !isAbsolute(profile.codexBin)
      || typeof codexConfig !== 'string' || !codexConfig.trim() || codexConfig.includes('\0')
      || !object(providerEnvironment) || !Object.keys(providerEnvironment).length
      || Object.entries(providerEnvironment).some(([key, secret]) => !managedProviderKey(key) || !exactHostingId(secret))) throw hostingError('HOSTING_TEMPLATE_INVALID');
  // Deliberately small TOML subset, not a second general-purpose TOML parser.
  // Exactly one provider table and scalar allowlists exclude includes, alternate
  // credential stores, headers, duplicate settings and multiline auth fallback.
  const top = {}; const provider = {}; let selectedTable = null;
  const topKeys = new Set(['model', 'model_provider', 'model_reasoning_effort', 'disable_response_storage']);
  const providerKeys = new Set(['name', 'base_url', 'wire_api', 'env_key', 'requires_openai_auth']);
  for (const raw of codexConfig.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const table = /^\[model_providers\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (table) {
      if (selectedTable !== null) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
      selectedTable = table[1]; continue;
    }
    const match = /^([a-z_]+)\s*=\s*("(?:[^"\\\r\n]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4})*"|true|false)$/.exec(line);
    const target = selectedTable === null ? top : provider;
    if (!match || !(selectedTable === null ? topKeys : providerKeys).has(match[1]) || Object.hasOwn(target, match[1])) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
    let scalar;
    try { scalar = JSON.parse(match[2]); } catch { throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED'); }
    if (typeof scalar === 'string' && !exactHostingId(scalar)) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
    target[match[1]] = scalar;
  }
  let providerUrl; try { providerUrl = new URL(provider.base_url); } catch {}
  if (!exactHostingId(top.model_provider) || selectedTable !== top.model_provider || selectedTable === 'openai'
      || !managedProviderKey(provider.env_key) || !Object.hasOwn(providerEnvironment, provider.env_key)
      || providerUrl?.protocol !== 'https:' || providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash
      || provider.requires_openai_auth !== false || provider.wire_api !== undefined && provider.wire_api !== 'responses'
      || Object.entries(top).some(([key, scalar]) => key === 'disable_response_storage' ? typeof scalar !== 'boolean' : typeof scalar !== 'string')
      || Object.entries(provider).some(([key, scalar]) => key === 'requires_openai_auth' ? typeof scalar !== 'boolean' : typeof scalar !== 'string')) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
  return value;
}
export async function readHostingConfig(path, hostConfig) {
  await canonicalHostingPath(path);
  const value = validateHostingConfig(await readPrivateJson(path, null));
  await canonicalHostingPath(value.socketPath); await canonicalHostingPath(value.managedRoot);
  const overlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const roots = [hostConfig.stateRoot, ...hostConfig.agents.flatMap(agent => [agent.stateRoot,
    ...['codexHome', 'codexWorkdir', 'chatWorkdir', 'workspaceFallbackWorkdir', 'workspaceFileRootDir', 'typedInspectionRootDir',
      'typedInspectionStateRoot', 'controlledImageHttpLedgerRoot'].map(key => agent.profile[key]).filter(Boolean)])];
  if (roots.some(root => overlap(root, value.managedRoot)) || overlap(dirname(value.socketPath), value.managedRoot)) throw hostingError('HOSTING_CONFIG_ROOTS_OVERLAP');
  const managed = await lstat(value.managedRoot);
  if (!managed.isDirectory() || managed.uid !== process.getuid() || managed.mode & 0o077) throw hostingError('HOSTING_CONFIG_ROOT_UNSAFE');
  const parent = await lstat(dirname(value.socketPath));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.gid !== value.socketGid
      || ![0o710, 0o750].includes(parent.mode & 0o777)) throw hostingError('HOSTING_SOCKET_PARENT_UNSAFE');
  // Require an explicit, present binary; do not execute it here or create roots.
  await canonicalHostingPath(value.template.profile.codexBin);
  const binary = await open(value.template.profile.codexBin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await binary.stat();
    if (!stat.isFile() || !(stat.mode & 0o111) || stat.mode & 0o022 || ![0, process.getuid()].includes(stat.uid)) throw hostingError('HOSTING_TEMPLATE_BINARY_UNSAFE');
  } finally { await binary.close(); }
  const { normalizeProfile, profileConfigurationErrors } = await import('../../codex-ws-agent/agent-client.mjs');
  try {
    const profile = normalizeProfile({ ...value.template.profile, profileId: 'managed-template-validation', agentId: 'managed-template-validation',
      codexHome: resolve(value.managedRoot, '.template-home'), codexWorkdir: resolve(value.managedRoot, '.template-work') }, {}, 0, { isolated: true });
    if (profileConfigurationErrors(profile).length) throw hostingError('HOSTING_TEMPLATE_PROFILE_INVALID');
  } catch { throw hostingError('HOSTING_TEMPLATE_PROFILE_INVALID'); }
  return value;
}
