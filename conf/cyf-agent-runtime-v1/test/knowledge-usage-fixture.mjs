// Synthetic ledger transport for source tests; not evidence of real Java/SQL billing.
import { createHash } from 'node:crypto';
export function knowledgeReceipt(manifest, leaseId, body) {
  const { handoverId, observation } = body;
  const source = JSON.stringify([manifest.canonicalAgentId, leaseId, handoverId, observation.batchId, observation.stage]);
  return { handoverId, attemptId: createHash('sha256').update(JSON.stringify(['PUBLIC_KNOWLEDGE_EXTRACTION', source])).digest('hex'),
    revision: observation.phase === 'STARTED' ? '1' : '2', status: 'PENDING_USAGE', costYuan: null };
}
export function knowledgeClientFactory({ sent = [], beforeReply = async () => {}, onSession = () => {}, onClose = () => {} } = {}) {
  return settings => ({
    async session() { onSession(settings); },
    async nativeFetch(url, options) {
      const body = JSON.parse(options.body); const leaseId = new URL(url).pathname.split('/')[4];
      const receipt = knowledgeReceipt(settings.manifest, leaseId, body);
      sent.push(body); await beforeReply(body, receipt);
      return new Response(JSON.stringify({ protocolVersion: 1, requestId: 'fixture', code: 'E0', msg: 'OK', data: receipt }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'fixture' } });
    },
    invalidateSession() { onClose(); }
  });
}
