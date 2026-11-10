// Trusted RuntimeHost adapter. No public input may select roots or preserved files.
import { cleanStoppedCodexHome, validateStoppedHomeCleanup } from './private-home-cleanup.mjs';
import { cleanStoppedRuntimeState, validateStoppedStateCleanup } from './private-state-cleanup.mjs';
import { cleanStoppedMaterials, stoppedMaterialRoots } from './private-material-cleanup.mjs';

export async function cleanStoppedPrivateData(options) {
  // Resolve the public baseline and all root classifications before ANY erasure.
  await validateStoppedHomeCleanup(options);
  await validateStoppedStateCleanup(options);
  await stoppedMaterialRoots(options);
  if (typeof options.recordKnowledgeStatus !== 'function')
    throw Object.assign(new Error('RUNTIME_KNOWLEDGE_JOURNAL_REQUIRED'), { code: 'RUNTIME_KNOWLEDGE_JOURNAL_REQUIRED' });
  if (typeof options.flushPlatformCosts !== 'function')
    throw Object.assign(new Error('RUNTIME_PLATFORM_COST_FLUSH_REQUIRED'), { code: 'RUNTIME_PLATFORM_COST_FLUSH_REQUIRED' });
  let knowledgeStatus = options.knowledgeStatus;
  if (!['EXTRACTED', 'FAILED'].includes(knowledgeStatus)) {
    if (knowledgeStatus === 'REQUESTED') {
      // A prior call has an unknown outcome. Do not spend again or claim success.
      knowledgeStatus = 'FAILED';
    } else {
      if (typeof options.extractKnowledge !== 'function')
        throw Object.assign(new Error('RUNTIME_KNOWLEDGE_ADAPTER_REQUIRED'), { code: 'RUNTIME_KNOWLEDGE_ADAPTER_REQUIRED' });
      await options.recordKnowledgeStatus('REQUESTED'); // before any provider call
      knowledgeStatus = 'FAILED';
      try {
        const result = await options.extractKnowledge({ agent: options.agent, ownerJiacn: options.ownerJiacn, operationId: options.operationId, leaseId: options.leaseId });
        if (result?.confirmed === true) knowledgeStatus = 'EXTRACTED';
      } catch { /* Never persist provider errors containing private material. */ }
    }
    await options.recordKnowledgeStatus(knowledgeStatus); // before any private erasure
  }
  // Failed extraction may already have spent platform money. A missing/failed
  // cost drain must not erase the original native credential needed to retry it.
  const costs = await options.flushPlatformCosts({ agent: options.agent, operationId: options.operationId, leaseId: options.leaseId });
  if (costs?.confirmed !== true)
    throw Object.assign(new Error('RUNTIME_PLATFORM_COST_FLUSH_PENDING'), { code: 'RUNTIME_PLATFORM_COST_FLUSH_PENDING' });
  // Retirement is the first destructive step and may refuse pending management
  // results. Do not erase HOME or inputs before this ownership decision succeeds.
  await cleanStoppedRuntimeState(options);
  await cleanStoppedMaterials(options);
  await cleanStoppedCodexHome(options);
  return { confirmed: true, knowledgeStatus };
}
