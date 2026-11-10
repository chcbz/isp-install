// Called under the stopped subject gate after original evidence is acknowledged.
// Keeps only lifecycle control and retired public skill facts, not old credentials.
import { constants, lstat, open, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireOwnedPrivateRoot } from './runtime-host.mjs';
import { stoppedSkillManager } from './evidence-handover.mjs';

const contains = (root, child) => root === child || child.startsWith(`${root}/`);
const fail = code => { throw Object.assign(new Error(code), { code }); };
export async function validateStoppedStateCleanup({ agent, apiOrigin, instanceId, ownerJiacn, operationId, publicRepositoryRoots = [] }) {
  const root = agent.stateRoot;
  await requireOwnedPrivateRoot(root);
  for (const repository of publicRepositoryRoots) {
    if (typeof repository !== 'string' || resolve(repository) !== repository) fail('RUNTIME_PUBLIC_REPOSITORY_ROOT_INVALID');
    if (contains(root, repository) || contains(repository, root)) fail('RUNTIME_STATE_PUBLIC_REPOSITORY_OVERLAP');
  }
  return root;
}
export async function cleanStoppedRuntimeState(options) {
  const { agent, apiOrigin, instanceId, ownerJiacn, operationId } = options;
  const root = await validateStoppedStateCleanup(options);
  const retained = [resolve(root, '.runtime-writer.lock'), resolve(root, 'handover.json')];
  const manager = stoppedSkillManager({ agent, apiOrigin, instanceId });
  if (manager) {
    manager.initialize();
    await manager.retireRelationship({ operationId, identity: {
      tenantId: agent.manifest.tenantId, clientId: agent.manifest.clientId, ownerJiacn,
      agentId: agent.manifest.canonicalAgentId, runtimeInstallationId: agent.manifest.installationId
    } });
    retained.push(manager.stateRoot);
  }
  // Descend only along the path to public skill facts. A blanket inbox deletion
  // would discard the retained packages; keeping the whole inbox leaks old chats.
  async function clear(directory) {
    for (const name of await readdir(directory)) {
      const child = resolve(directory, name);
      if (retained.includes(child)) continue;
      if (retained.some(path => contains(child, path))) {
        const stat = await lstat(child);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RUNTIME_STATE_PUBLIC_PATH_UNSAFE');
        await clear(child);
      } else await rm(child, { recursive: true, force: true });
    }
    const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await descriptor.sync(); } finally { await descriptor.close(); }
  }
  await clear(root);
  return { stateCleaned: true }; // Not a final cleanup or relationship-release receipt.
}
