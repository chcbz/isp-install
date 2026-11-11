// Synthetic ledger transport for source tests; not evidence of real Java/SQL billing.
import { createHash } from 'node:crypto';
export function knowledgeReceipt(manifest, leaseId, body) {
  const { handoverId, observation } = body;
  const source = JSON.stringify([manifest.canonicalAgentId, leaseId, handoverId, observation.batchId, observation.stage]);
  return { handoverId, attemptId: createHash('sha256').update(JSON.stringify(['PUBLIC_KNOWLEDGE_EXTRACTION', source])).digest('hex'),
    revision: observation.phase === 'STARTED' ? '1' : '2', status: 'PENDING_USAGE', costYuan: null };
}
export function knowledgeClientFactory({ sent = [], beforeReply = async () => {}, onClient = () => {} } = {}) {
  return settings => {
    onClient(settings);
    return {
      async session() { throw new Error('Knowledge maintenance must not issue a user session'); },
      async recordKnowledgeUsage(leaseId, body) {
        const receipt = knowledgeReceipt(settings.manifest, leaseId, body);
        sent.push(body); await beforeReply(body, receipt);
        return receipt;
      }
    };
  };
}
