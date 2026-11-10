// Called only under RuntimeHost's QUIESCED subject gate, before relationship release.
// Authentication stays with the original installation; no engine, WS registration,
// lease, task result or provider invocation is created by this path.
import { resolve } from 'node:path';
import { PersistentChatInbox } from '../../codex-bridge/chat-runtime.mjs';
import { ChatUsageDelivery } from '../../codex-bridge/chat-usage-delivery.mjs';
import { SkillUsageDelivery } from '../../codex-bridge/skill-usage-delivery.mjs';
import { RuntimeV1Client } from './runtime-client.mjs';

export async function flushStoppedUsage({ agent, ownerJiacn, apiOrigin, hostId, instanceId,
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
    return { confirmed: chat.confirmed && native.confirmed, chat, native };
  } finally {
    client.invalidateSession(); // No heartbeat/socket or credentials survive the drain attempt.
  }
}
