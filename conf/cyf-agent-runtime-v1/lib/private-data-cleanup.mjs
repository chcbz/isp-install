// Trusted RuntimeHost adapter. No public input may select roots or preserved files.
import { cleanStoppedCodexHome, validateStoppedHomeCleanup } from './private-home-cleanup.mjs';
import { cleanStoppedRuntimeState, validateStoppedStateCleanup } from './private-state-cleanup.mjs';
import { cleanStoppedMaterials, stoppedMaterialRoots } from './private-material-cleanup.mjs';

export async function cleanStoppedPrivateData(options) {
  // Resolve the public baseline and all root classifications before ANY erasure.
  await validateStoppedHomeCleanup(options);
  await validateStoppedStateCleanup(options);
  await stoppedMaterialRoots(options);
  if (typeof options.extractKnowledge !== 'function')
    throw Object.assign(new Error('RUNTIME_KNOWLEDGE_ADAPTER_REQUIRED'), { code: 'RUNTIME_KNOWLEDGE_ADAPTER_REQUIRED' });
  // Extraction is operation-idempotent and publishes only sanitized generic facts.
  // Failure is deliberately nonblocking, but never recorded as successful extraction.
  let knowledgeStatus = 'FAILED';
  try {
    const result = await options.extractKnowledge({ agent: options.agent, ownerJiacn: options.ownerJiacn, operationId: options.operationId });
    if (result?.confirmed === true) knowledgeStatus = 'EXTRACTED';
  } catch { /* Do not persist raw error text which could contain private material. */ }
  // Retirement is the first destructive step and may refuse pending management
  // results. Do not erase HOME or inputs before this ownership decision succeeds.
  await cleanStoppedRuntimeState(options);
  await cleanStoppedMaterials(options);
  await cleanStoppedCodexHome(options);
  return { confirmed: true, knowledgeStatus };
}
