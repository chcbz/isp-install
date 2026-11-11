// Only trusted, per-subject profile roots. Shared workspace policies/repositories
// are supplied separately as public roots; never sweep a workspace policy root.
import { constants, open, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireOwnedPrivateRoot } from './runtime-host.mjs';
const contains = (a, b) => a === b || b.startsWith(`${a}/`);
const overlaps = (a, b) => contains(a, b) || contains(b, a);
const fail = code => { throw Object.assign(new Error(code), { code }); };
export async function stoppedMaterialRoots({ agent, publicRepositoryRoots = [] }) {
  const profile = agent.profile, roots = [];
  for (const root of publicRepositoryRoots)
    if (typeof root !== 'string' || resolve(root) !== root) fail('RUNTIME_PUBLIC_REPOSITORY_ROOT_INVALID');
  const candidates = [
    ...['codexWorkdir', 'chatWorkdir', 'workspaceFallbackWorkdir'].map(field => [profile[field], true]),
    ...['workspaceFileRootDir', 'controlledImageHttpLedgerRoot'].map(field => [profile[field], false]),
    ...['typedInspectionRootDir', 'typedInspectionStateRoot', 'nativeExecutionRootDir', 'nativeExecutionStateRoot'].map(field => [profile[field]
      ? resolve(profile[field], Buffer.from(String(profile.agentId), 'utf8').toString('hex')) : null, false])
  ];
  for (const [root, mayBePublic] of candidates) {
    if (!root) continue;
    if (typeof root !== 'string' || resolve(root) !== root) fail('RUNTIME_PRIVATE_MATERIAL_ROOT_INVALID');
    if (publicRepositoryRoots.some(publicRoot => overlaps(root, publicRoot))) {
      if (mayBePublic && publicRepositoryRoots.some(publicRoot => contains(publicRoot, root))) continue;
      fail('RUNTIME_PRIVATE_MATERIAL_PUBLIC_OVERLAP');
    }
    // HOME and state have their own selective cleanup; a configured ancestor must
    // not erase public skills, the control journal, or writer ownership.
    if ([profile.codexHome, agent.stateRoot].some(owned => contains(root, owned))) fail('RUNTIME_PRIVATE_MATERIAL_CONTROL_OVERLAP');
    if ([profile.codexHome, agent.stateRoot].some(owned => contains(owned, root))) continue;
    try { await requireOwnedPrivateRoot(root); }
    catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    roots.push(root);
  }
  return [...new Set(roots)].filter(root => !roots.some(other => other !== root && contains(other, root)));
}
export async function cleanStoppedMaterials(options) {
  const roots = await stoppedMaterialRoots(options); // validate ALL roots before deletion
  for (const root of roots) {
    for (const name of await readdir(root)) await rm(resolve(root, name), { recursive: true, force: true });
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  return { materialsCleaned: true };
}
