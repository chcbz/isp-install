// Operator-only platform model route. No original user's HOME/auth/environment is
// used to select credentials; no control request can change endpoint or filesystem.
import { createHash } from 'node:crypto';
import { RuntimeV1Client } from './runtime-client.mjs';
import { resolve } from 'node:path';
import { readPrivateJson } from './security.mjs';
import { mutableProfilePaths } from './manifest.mjs';
import { createCodexKnowledgeReader } from './knowledge-sessions.mjs';
import { createKnowledgeResponsesClient } from './knowledge-responses.mjs';
import { createPublicKnowledgeExtractor } from './knowledge-extraction.mjs';
import { createPublicKnowledgeStore } from './public-knowledge-store.mjs';
const failure = code => Object.assign(new Error(code), { code });
const contains = (root, child) => root === child || child.startsWith(`${root}/`);
const privateRoots = config => [...config.agents.flatMap(agent => [agent.stateRoot,
  ...mutableProfilePaths.map(name => agent.profile[name]).filter(Boolean)]), ...(config.hostingControl ? [config.hostingControl.managedRoot] : [])];

export async function readKnowledgeMaintenanceConfig(path, hostConfig) {
  if (!path) return null; // Missing route does not enable production cleanup with a fake extractor.
  const roots = [hostConfig.stateRoot, ...privateRoots(hostConfig)];
  if (typeof path !== 'string' || resolve(path) !== path || roots.some(root => contains(root, path)))
    throw failure('KNOWLEDGE_OPERATOR_CONFIG_PATH_INVALID');
  let value;
  try { value = await readPrivateJson(path, null); } catch { throw failure('KNOWLEDGE_OPERATOR_CONFIG_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'channel,configVersion,credential,endpoint,maxInputBytes,model'
      || value.configVersion !== 1) throw failure('KNOWLEDGE_OPERATOR_CONFIG_INVALID');
  // Validate without I/O or a paid call. These are the same constructors used below.
  createCodexKnowledgeReader(value);
  createKnowledgeResponsesClient({ ...value, recordAttempt: async () => {} });
  return Object.freeze({ ...value });
}

export function createKnowledgeMaintenance({ hostConfig, knowledgeConfig, apiOrigin, instanceId, fetchImpl,
  clientFactory = settings => new RuntimeV1Client(settings) }) {
  if (!knowledgeConfig) return undefined;
  const store = createPublicKnowledgeStore({ hostStateRoot: hostConfig.stateRoot, privateRoots: privateRoots(hostConfig) });
  const readConversations = createCodexKnowledgeReader(knowledgeConfig);
  const withDelivery = async ({ agent, operationId, leaseId }, action) => {
    const journal = store.platformCostJournal({ subjectKey: agent.subjectKey, leaseId, operationId });
    let client;
    const deliver = async event => {
      const attempt = JSON.parse(event.attemptId);
      if (!Array.isArray(attempt) || attempt.length !== 4 || attempt[0] !== agent.subjectKey || attempt[1] !== operationId)
        throw failure('KNOWLEDGE_COST_BINDING_INVALID');
      if (!client) {
        client = clientFactory({ manifest: agent.manifest, apiBaseUrl: apiOrigin,
          stateDir: agent.stateRoot, hostId: hostConfig.hostId, runtimeInstanceId: instanceId });
      }
      const receipt = await client.recordKnowledgeUsage(leaseId, { handoverId: operationId,
        observation: { batchId: attempt[2], stage: attempt[3], phase: event.phase, channel: event.channel,
          requestedModel: event.requestedModel, requestedTier: 'standard', evidence: event.evidence } });
      // Same digest as the central usage journal; neither owner nor task is part of platform billing.
      const sourceAttemptId = JSON.stringify([agent.manifest.canonicalAgentId, leaseId, operationId, attempt[2], attempt[3]]);
      const expected = createHash('sha256').update(JSON.stringify(['PUBLIC_KNOWLEDGE_EXTRACTION', sourceAttemptId])).digest('hex');
      if (receipt?.handoverId !== operationId || receipt.attemptId !== expected
          || receipt.revision !== (event.phase === 'STARTED' ? '1' : '2')
          || !['PENDING_USAGE', 'PENDING_PRICE', 'PRICED'].includes(receipt.status)
          || (receipt.status === 'PRICED' ? typeof receipt.costYuan !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(receipt.costYuan) : receipt.costYuan !== null))
        throw failure('KNOWLEDGE_COST_ACK_INVALID');
      await journal.acknowledge(event, receipt);
    };
    return action(journal, deliver);
  };
  const extract = context => withDelivery(context, async (journal, deliver) => {
    const invoke = createKnowledgeResponsesClient({ ...knowledgeConfig, fetchImpl,
      recordAttempt: async event => { await journal.record(event); await deliver(event); } });
    return createPublicKnowledgeExtractor({ invoke, readConversations, publish: store.publish })(context);
  });
  // Runs even after failed/unknown extraction. Persisted evidence may be replayed,
  // but the model request never is. A failed flush retains original credentials.
  extract.flushPlatformCosts = context => withDelivery(context, async (journal, deliver) => {
    for await (const event of journal.pending()) await deliver(event);
    return { confirmed: true };
  });
  return extract;
}
