import test from 'node:test';
import { knowledgeClientFactory } from './knowledge-usage-fixture.mjs';
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
  const agent = { manifest: { canonicalAgentId: 'agent' }, subjectKey: 'tenant/client/agent', stateRoot: resolve(root, 'agent-state'),
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
  agent.profile.typedInspectionStateRoot = resolve(agent.stateRoot, 'typed-state');
  for (const root of [hostConfig.stateRoot, agent.stateRoot, agent.profile.codexHome, agent.profile.typedInspectionStateRoot])
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
  const extract = createKnowledgeMaintenance({ hostConfig, knowledgeConfig, apiOrigin: 'https://fixture.invalid', instanceId: 'boot', clientFactory: knowledgeClientFactory(), fetchImpl: async (_url, options) => {
    calls++; const sent = JSON.parse(options.body);
    assert.equal(sent.model, 'gpt-6-luna'); assert.equal(options.headers.Authorization, 'Bearer fixture-platform-secret');
    assert.equal(sent.input.includes('private fixture lesson source'), calls === 1);
    const entries = [{ title: 'Atomic persistence', guidance: 'Sync data before publishing its durable receipt.' }];
    return { ok: true, status: 200, json: async () => ({ id: `response-${calls}`, model: sent.model, status: 'completed',
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }, output: [{ type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: JSON.stringify(calls === 1 ? { entries } : { safe: true, entries }) }
      ] }] }) };
  } });
  assert.deepEqual(await extract({ agent, leaseId: 'lease', operationId: 'handover', ownerJiacn: 'not-in-provider-request' }), { confirmed: true });
  assert.equal(calls, 2);
  assert.equal((await readdir(resolve(hostConfig.stateRoot, 'public-knowledge'))).length, 1);
  assert.equal((await readdir(resolve(hostConfig.stateRoot, 'platform-usage'))).length, 1);
});
test('artifact install and validation inventories include the complete runtime entry import graph', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, relative } = await import('node:path');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const inventory = async name => {
    const text = await readFile(resolve(root, name), 'utf8'); const files = new Set();
    for (const match of text.matchAll(/for file in ([\s\S]*?); do/g))
      for (const token of match[1].replaceAll('\\\n', ' ').split(/\s+/)) if (token) files.add(token);
    return files;
  };
  const installed = await inventory('install.sh'), validated = await inventory('validate.sh'), seen = new Set();
  async function visit(path) {
    const name = relative(root, path); if (name.startsWith('..') || seen.has(name)) return;
    seen.add(name);
    assert.ok(installed.has(name), `installer must copy ${name}`);
    assert.ok(validated.has(name), `artifact validator must require ${name}`);
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/\b(?:from\s*|import\s*\()\s*['"](\.[^'"]+\.mjs)['"]/g))
      await visit(resolve(dirname(path), match[1]));
  }
  await visit(resolve(root, 'agent-runtime.mjs'));
  assert.ok(seen.has('lib/knowledge-maintenance.mjs')); assert.ok(seen.has('lib/evidence-handover.mjs'));
});

test('installation HTTP roundtrip acknowledges STARTED before spend without issuing a user session', async t => {
  const { createServer } = await import('node:http'), { once } = await import('node:events');
  const { knowledgeReceipt } = await import('./knowledge-usage-fixture.mjs');
  const { configPath, hostConfig, agent } = await fixture(t);
  Object.assign(agent.manifest, { installationId: 'install', tenantId: 'tenant', clientId: 'client', manifestVersion: 1, manifestSha256: `sha256:${'a'.repeat(64)}` });
  hostConfig.hostId = 'host';
  await writeFile(resolve(agent.stateRoot, 'runtime-authorization.json'), JSON.stringify({ installationId: 'install', runtimeAuthorization: `rta1_${'b'.repeat(64)}` }), { mode: 0o600 });
  await mkdir(resolve(agent.profile.codexHome, 'sessions'));
  await writeFile(resolve(agent.profile.codexHome, 'sessions/one.jsonl'), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic lesson.' }]
  } }) + '\n');
  const seen = []; let sessions = 0;
  const server = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const q = JSON.parse(text); assert.equal(q.protocolVersion, 1); assert.equal(q.requestId, request.headers['x-request-id']);
      let data;
      if (request.url === '/agent/runtime/v1/session') {
        sessions++; assert.equal(request.headers.authorization, `Bearer rta1_${'b'.repeat(64)}`);
        assert.equal(q.data.runtimeInstanceId, 'same-runtime-boot');
        data = { ...q.data, scheme: 'AgentRuntime', sessionToken: `rts1_${'c'.repeat(64)}`, sessionGeneration: '1', status: 'CHANNEL_PENDING', websocketPath: '/ws/agent/channel' };
      } else {
        assert.equal(request.url, '/internal/agent/hosting-leases/lease/knowledge-usage');
        assert.equal(request.headers.authorization, `Bearer rta1_${'b'.repeat(64)}`);
        assert.equal(request.headers['x-agent-runtime-id'], undefined);
        assert.equal(q.data.observation.requestedTier, 'standard');
        assert.equal('ownerJiacn' in q.data, false); assert.equal('taskId' in q.data, false);
        seen.push(q.data); data = knowledgeReceipt(agent.manifest, 'lease', q.data);
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': q.requestId });
      response.end(JSON.stringify({ protocolVersion: 1, requestId: q.requestId, code: 'E0', msg: 'OK', data }));
    } catch (error) { response.writeHead(500); response.end('fixture failed'); server.fixtureError = error; }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const extract = createKnowledgeMaintenance({ hostConfig, knowledgeConfig: await readKnowledgeMaintenanceConfig(configPath, hostConfig),
    apiOrigin: `http://127.0.0.1:${server.address().port}`, instanceId: 'same-runtime-boot', fetchImpl: async () => {
      assert.equal(seen.length, 1); assert.equal(seen[0].observation.phase, 'STARTED');
      return { ok: true, status: 200, json: async () => ({ id: 'response', model: 'gpt-6-luna', service_tier: 'default', status: 'completed',
        usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, total_tokens: 5 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"entries":[]}' }] }] }) };
    } });
  const context = { agent, operationId: 'handover', leaseId: 'lease' };
  await extract(context); await extract.flushPlatformCosts(context);
  assert.ifError(server.fixtureError); assert.equal(sessions, 0); assert.equal(seen.length, 2);
  assert.equal(seen[1].observation.evidence.usage.total_tokens, 5);
});

test('failed STARTED acknowledgement never calls provider; empty history creates no client or model spend', async t => {
  const { configPath, hostConfig, agent } = await fixture(t);
  let spent = 0, clients = 0;
  const extract = createKnowledgeMaintenance({ hostConfig, knowledgeConfig: await readKnowledgeMaintenanceConfig(configPath, hostConfig),
    apiOrigin: 'https://fixture.invalid', instanceId: 'boot', fetchImpl: async () => { spent++; },
    clientFactory: knowledgeClientFactory({ onClient: () => clients++, beforeReply: async () => { throw new Error('start unacknowledged'); } }) });
  const context = { agent, operationId: 'handover', leaseId: 'lease' };
  await extract(context); await extract.flushPlatformCosts(context);
  assert.equal(clients, 0); assert.equal(spent, 0);
  await mkdir(resolve(agent.profile.codexHome, 'sessions'));
  await writeFile(resolve(agent.profile.codexHome, 'sessions/one.jsonl'), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic.' }]
  } }) + '\n');
  await assert.rejects(extract(context), /start unacknowledged/);
  assert.equal(spent, 0); assert.equal(clients, 1);
});
