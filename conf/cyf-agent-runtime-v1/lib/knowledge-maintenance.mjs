// Operator-only platform model route. No original user's HOME/auth/environment is
// used to select credentials; no control request can change endpoint or filesystem.
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

export function createKnowledgeMaintenance({ hostConfig, knowledgeConfig, fetchImpl }) {
  if (!knowledgeConfig) return undefined;
  const store = createPublicKnowledgeStore({ hostStateRoot: hostConfig.stateRoot, privateRoots: privateRoots(hostConfig) });
  const readConversations = createCodexKnowledgeReader(knowledgeConfig);
  return async ({ agent, operationId }) => {
    // Dynamic managed Agents are protected by the containing managedRoot checked
    // at configuration time; static roots are already admitted by the host manifest.
    const invoke = createKnowledgeResponsesClient({ ...knowledgeConfig, fetchImpl,
      recordAttempt: store.platformCostSink(agent.subjectKey) });
    const extract = createPublicKnowledgeExtractor({ invoke, readConversations, publish: store.publish });
    return extract({ agent, operationId });
  };
}
