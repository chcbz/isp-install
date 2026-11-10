import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readKnowledgeMaintenanceConfig, createKnowledgeMaintenance } from '../lib/knowledge-maintenance.mjs';
const route = { configVersion: 1, endpoint: 'https://fixture.invalid/v1/responses', model: 'gpt-6-luna',
  channel: 'platform-maintenance', credential: 'fixture-platform-secret', maxInputBytes: 4096 };
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'knowledge-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = { subjectKey: 'tenant/client/agent', stateRoot: resolve(root, 'agent-state'),
    profile: { codexHome: resolve(root, 'home'), codexWorkdir: resolve(root, 'work') } };
  for (const dir of [agent.stateRoot, agent.profile.codexHome, agent.profile.codexWorkdir]) await mkdir(dir, { mode: 0o700 });
  const hostConfig = { stateRoot: resolve(root, 'host'), agents: [agent] };
  const configPath = resolve(root, 'operator.json'); await writeFile(configPath, JSON.stringify(route), { mode: 0o600 });
  return { root, agent, hostConfig, configPath };
}
test('reads immutable platform route outside private roots and never falls back to user HOME credentials', async t => {
  const { configPath, hostConfig, agent } = await fixture(t);
  const value = await readKnowledgeMaintenanceConfig(configPath, hostConfig);
  assert.deepEqual(value, route); assert.equal(Object.isFrozen(value), true);
  assert.equal(await readKnowledgeMaintenanceConfig(undefined, hostConfig), null);
  assert.equal(createKnowledgeMaintenance({ hostConfig, knowledgeConfig: null }), undefined);
  for (const root of [hostConfig.stateRoot, agent.stateRoot, agent.profile.codexHome])
    await assert.rejects(readKnowledgeMaintenanceConfig(resolve(root, 'operator.json'), hostConfig), { code: 'KNOWLEDGE_OPERATOR_CONFIG_PATH_INVALID' });
});
test('unsafe configuration permissions and input-controlled extra keys are rejected without exposing credentials', async t => {
  const { configPath, hostConfig } = await fixture(t);
  await writeFile(configPath, JSON.stringify({ ...route, ownerJiacn: 'user' }));
  await assert.rejects(readKnowledgeMaintenanceConfig(configPath, hostConfig), { code: 'KNOWLEDGE_OPERATOR_CONFIG_INVALID' });
  await writeFile(configPath, JSON.stringify(route));
  const { chmod } = await import('node:fs/promises'); await chmod(configPath, 0o644);
  await assert.rejects(readKnowledgeMaintenanceConfig(configPath, hostConfig), error => !error.message.includes(route.credential));
});
test('configured adapter reads actual stopped session files and retains public knowledge and platform costs', async t => {
  const { configPath, hostConfig, agent } = await fixture(t);
  await mkdir(resolve(agent.profile.codexHome, 'sessions'), { mode: 0o755 }); // protected by HOME, not an extra 0700 rule
  await writeFile(resolve(agent.profile.codexHome, 'sessions/one.jsonl'), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private fixture lesson source' }]
  } }) + '\n');
  const knowledgeConfig = await readKnowledgeMaintenanceConfig(configPath, hostConfig);
  let calls = 0;
  const extract = createKnowledgeMaintenance({ hostConfig, knowledgeConfig, fetchImpl: async (_url, options) => {
    calls++; const sent = JSON.parse(options.body);
    assert.equal(sent.model, 'gpt-6-luna'); assert.equal(options.headers.Authorization, 'Bearer fixture-platform-secret');
    assert.equal(sent.input.includes('private fixture lesson source'), calls === 1);
    const entries = [{ title: 'Atomic persistence', guidance: 'Sync data before publishing its durable receipt.' }];
    return { ok: true, status: 200, json: async () => ({ id: `response-${calls}`, model: sent.model, status: 'completed',
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }, output: [{ type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: JSON.stringify(calls === 1 ? { entries } : { safe: true, entries }) }
      ] }] }) };
  } });
  assert.deepEqual(await extract({ agent, operationId: 'handover', ownerJiacn: 'not-in-provider-request' }), { confirmed: true });
  assert.equal(calls, 2);
  assert.equal((await readdir(resolve(hostConfig.stateRoot, 'public-knowledge'))).length, 1);
  assert.equal((await readdir(resolve(hostConfig.stateRoot, 'platform-usage'))).length, 1);
});
