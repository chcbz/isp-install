// Called only under RuntimeHost's QUIESCED subject gate, before relationship release.
// Authentication stays with the original installation; no engine, WS registration,
// lease, task result or provider invocation is created by this path.
import { resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { SkillInstallManager, defaultSkillInstallStateRoot } from '../../codex-bridge/skill-install-manager.mjs';
import { PersistentChatInbox } from '../../codex-bridge/chat-runtime.mjs';
import { ChatUsageDelivery } from '../../codex-bridge/chat-usage-delivery.mjs';
import { SkillUsageDelivery } from '../../codex-bridge/skill-usage-delivery.mjs';
import { RuntimeV1Client } from './runtime-client.mjs';

// Both evidence delivery and retirement must locate the exact live manager journal.
export function stoppedSkillManager({ agent, apiOrigin, instanceId }) {
  const origin = new URL(apiOrigin); origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  const manager = new SkillInstallManager({ profile: agent.profile, runtimeInstanceId: instanceId,
    stateRoot: defaultSkillInstallStateRoot(resolve(agent.stateRoot, 'inbox'), agent.profile, origin.origin), wsUrl: origin.origin });
  try { lstatSync(manager.statePath); return manager; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function flushStoppedEvidence({ agent, ownerJiacn, apiOrigin, hostId, instanceId,
  clientFactory = options => new RuntimeV1Client(options) }) {
  const client = clientFactory({ manifest: agent.manifest, apiBaseUrl: apiOrigin,
    stateDir: agent.stateRoot, hostId, runtimeInstanceId: instanceId });
  try {
    await client.session(); // Existing authorization only; never reenroll or register.
    const inbox = new PersistentChatInbox({ rootDir: resolve(agent.stateRoot, 'inbox'), profile: agent.profile });
    // Do not initialize the live inbox: that would reconcile business commands and GC history.
    const chat = await new ChatUsageDelivery({ inbox, apiOrigin,
      nativeFetch: (url, options) => client.nativeFetch(url, options) }).flush();
    const { workspaceFileRootDir, workspaceFileApiOrigin } = agent.profile;
    const native = workspaceFileRootDir ? await new SkillUsageDelivery({
      apiOrigin: workspaceFileApiOrigin, rootDir: workspaceFileRootDir,
      agentId: agent.manifest.canonicalAgentId, runtimeInstanceId: instanceId,
      scope: { tenantId: agent.manifest.tenantId, clientId: agent.manifest.clientId,
        ownerJiacn, agentId: agent.manifest.canonicalAgentId },
      getRuntimeHeaders: () => client.sessionHeaders(), fetchFn: (url, options) => client.nativeFetch(url, options)
    }).flush() : { confirmed: true, pending: 0, errors: [] };
    const manager = stoppedSkillManager({ agent, apiOrigin, instanceId });
    let management = { confirmed: true, pending: 0, errors: [] };
    if (manager) {
      // Existing marker-only recovery observes accepted installation work; never runs it.
      manager.initialize();
      const identity = { tenantId: agent.manifest.tenantId, clientId: agent.manifest.clientId,
        ownerJiacn, agentId: agent.manifest.canonicalAgentId, runtimeInstallationId: agent.manifest.installationId };
      await manager.finalizeStoppedResults({ identity });
      management = await manager.flushResults({ identity, apiOrigin, nativeFetch: (url, options) => client.nativeFetch(url, options) });
    }
    return { confirmed: chat.confirmed && native.confirmed && management.confirmed, chat, native, management };
  } finally {
    client.invalidateSession(); // No heartbeat/socket or credentials survive the drain attempt.
  }
}
