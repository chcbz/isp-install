// Explicit Java-owned HTTP/MySQL acceptance driver. Synthetic provider only.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKnowledgeMaintenance } from '../lib/knowledge-maintenance.mjs';
import { RuntimeV1Client } from '../lib/runtime-client.mjs';

if (!process.env.NODE_TEST_CONTEXT) {
  const [apiOrigin, scratch, agentId, installationId] = process.argv.slice(2);
  const agent = { subjectKey: `0/client/${agentId}`, stateRoot: resolve(scratch, 'agent-state'),
    manifest: { installationId, tenantId: '0', clientId: 'client', canonicalAgentId: agentId,
      manifestVersion: '1', manifestSha256: `sha256:${'a'.repeat(64)}` },
    profile: { codexHome: resolve(scratch, 'home'), codexWorkdir: resolve(scratch, 'work') } };
  for (const dir of [agent.stateRoot, agent.profile.codexHome, agent.profile.codexWorkdir]) await mkdir(dir, { mode: 0o700 });
  await writeFile(resolve(agent.stateRoot, 'runtime-authorization.json'), JSON.stringify({ installationId, runtimeAuthorization: `rta1_${'d'.repeat(64)}` }), { mode: 0o600 });
  await mkdir(resolve(agent.profile.codexHome, 'sessions'));
  await writeFile(resolve(agent.profile.codexHome, 'sessions/one.jsonl'), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic private lesson, never upload this text as cost evidence.' }]
  } }) + '\n');
  const hostConfig = { hostId: 'host', stateRoot: resolve(scratch, 'host'), agents: [agent] };
  const context = { agent, operationId: 'handover', leaseId: 'lease' }; let spent = 0;
  const config = (model, usage = true) => ({ hostConfig, apiOrigin, instanceId: 'knowledge-boot',
    knowledgeConfig: { endpoint: 'https://provider.fixture.invalid/responses', credential: 'fixture-provider-secret', model, channel: 'platform', maxInputBytes: 4096 },
    fetchImpl: async () => { spent++; return { ok: true, status: 200, json: async () => ({ id: `synthetic-response-${spent}`, model,
      service_tier: 'default', status: 'completed', ...(usage ? { usage: { input_tokens: 100,
        input_tokens_details: { cached_tokens: 20 }, output_tokens: 10, total_tokens: 110 } } : {}),
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"entries":[]}' }] }] }) }; } });
  const extract = createKnowledgeMaintenance(config('gpt-6-luna'));
  await assert.rejects(extract(context), error => {
    assert.equal(spent, 1, `Expected lost RESPONDED ACK, got ${error.code || error.name} status=${error.status || 'none'} before spend`);
    return true;
  }); // server loses actual RESPONDED reply after committing the ledger
  assert.equal(spent, 1);
  assert.ok((await readFile(resolve(agent.profile.codexHome, 'sessions/one.jsonl'), 'utf8')).includes('Synthetic private lesson'));
  const resumed = createKnowledgeMaintenance(config('gpt-6-luna'));
  await resumed.flushPlatformCosts(context); await resumed.flushPlatformCosts(context);
  assert.equal(spent, 1);
  const client = new RuntimeV1Client({ manifest: agent.manifest, apiBaseUrl: apiOrigin, stateDir: agent.stateRoot,
    hostId: 'host', runtimeInstanceId: 'knowledge-boot' });
  // Ordinary user session is denied for the unavailable original account. Maintenance remains narrow.
  await assert.rejects(client.session(), error => error.status === 400);
  // Independent synthetic observations exercise pending-price and pending-usage under the SAME original handover.
  for (const [batchId, model, usage] of [['unpriced', 'unpriced-model', true], ['missing-usage', 'gpt-6-luna', false]]) {
    const observation = { batchId, stage: 'extract', channel: 'platform', requestedModel: model, requestedTier: 'standard' };
    await client.recordKnowledgeUsage('lease', { handoverId: 'handover', observation: { ...observation, phase: 'STARTED', evidence: null } });
    await client.recordKnowledgeUsage('lease', { handoverId: 'handover', observation: { ...observation, phase: 'RESPONDED', evidence: {
      providerReceiptId: batchId, actualModel: model, serviceTier: 'default',
      ...(usage ? { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10, total_tokens: 110 } } : {})
    } } });
  }
  // Installation forgery never reaches the platform ledger; no native-session fallback.
  await writeFile(resolve(agent.stateRoot, 'runtime-authorization.json'), JSON.stringify({ installationId,
    runtimeAuthorization: `rta1_${'e'.repeat(64)}` }), { mode: 0o600 });
  await assert.rejects(client.recordKnowledgeUsage('lease', { handoverId: 'handover', observation: {
    batchId: 'forged', stage: 'extract', phase: 'STARTED', channel: 'platform', requestedModel: 'gpt-6-luna', requestedTier: 'standard', evidence: null
  } }), error => error.status === 403);
  process.stdout.write(JSON.stringify({ passed: true, providerCalls: spent, realInstallationHttp: true, syntheticAdditionalObservations: 2, privateSourceRetained: true }) + '\n');
}
