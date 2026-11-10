import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicKnowledgeStore } from '../lib/public-knowledge-store.mjs';
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'knowledge-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostStateRoot = resolve(root, 'host'), privateRoot = resolve(root, 'agent');
  await mkdir(privateRoot, { mode: 0o700 });
  return { root, hostStateRoot, privateRoot, store: createPublicKnowledgeStore({ hostStateRoot, privateRoots: [privateRoot] }) };
}
const agent = { subjectKey: 'tenant/client/agent' };
const knowledge = { agent, operationId: 'handover', entries: [{ title: 'Atomic writes', guidance: 'Rename a prepared file atomically.' }] };
const event = { costBearer: 'PLATFORM', channel: 'fixture', requestedModel: 'gpt-6-luna', attemptId: 'attempt', receiptId: 'started', phase: 'STARTED', evidence: null };
async function files(root) {
  const found = [];
  for (const child of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, child.name);
    if (child.isDirectory()) found.push(...await files(path)); else found.push(path);
  }
  return found;
}
test('public artifact and platform cost survive deletion of private Agent roots without storing raw source', async t => {
  const { store, hostStateRoot, privateRoot } = await fixture(t);
  await store.publish(knowledge); await store.platformCostSink(agent.subjectKey)(event);
  await rm(privateRoot, { recursive: true });
  const paths = await files(hostStateRoot); assert.equal(paths.length, 2);
  const artifact = paths.find(path => path.includes('/public-knowledge/'));
  assert.deepEqual(JSON.parse(await readFile(artifact, 'utf8')), { formatVersion: 1, entries: knowledge.entries });
  for (const path of paths) assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(artifact, 'utf8')).includes(agent.subjectKey), false);
});
test('same operation replays durably; changed public knowledge and changed cost receipt cannot overwrite facts', async t => {
  const { store, hostStateRoot } = await fixture(t);
  await store.publish(knowledge); await store.publish(knowledge);
  await assert.rejects(store.publish({ ...knowledge, entries: [{ title: 'Changed', guidance: 'Changed' }] }), { code: 'KNOWLEDGE_RETAINED_FACT_CONFLICT' });
  const sink = store.platformCostSink(agent.subjectKey); await sink(event); await sink(event);
  await assert.rejects(sink({ ...event, channel: 'different' }), { code: 'KNOWLEDGE_RETAINED_FACT_CONFLICT' });
  assert.equal((await files(hostStateRoot)).length, 2);
});
test('public root cannot overlap any private root and symlinks cannot redirect public writes', async t => {
  const { root, hostStateRoot, privateRoot, store } = await fixture(t);
  for (const candidate of [privateRoot, resolve(privateRoot, 'nested'), root])
    assert.throws(() => createPublicKnowledgeStore({ hostStateRoot: candidate, privateRoots: [privateRoot] }), { code: 'KNOWLEDGE_STORAGE_PRIVATE_OVERLAP' });
  await mkdir(hostStateRoot, { mode: 0o700 });
  await symlink(privateRoot, resolve(hostStateRoot, 'public-knowledge'));
  await assert.rejects(store.publish(knowledge)); assert.deepEqual(await readdir(privateRoot), []);
});
test('separate Agents do not overwrite each others knowledge or platform receipts; non-platform costs are refused', async t => {
  const { store, hostStateRoot } = await fixture(t);
  await store.publish(knowledge);
  await store.publish({ ...knowledge, agent: { subjectKey: 'tenant/client/other-agent' } });
  await store.platformCostSink(agent.subjectKey)(event);
  await store.platformCostSink('tenant/client/other-agent')(event);
  await assert.rejects(store.platformCostSink(agent.subjectKey)({ ...event, costBearer: 'USER' }));
  assert.equal((await files(hostStateRoot)).length, 4);
});
test('real loopback HTTP extraction and privacy review retain platform usage before public publication', async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createKnowledgeResponsesClient } = await import('../lib/knowledge-responses.mjs');
  const { createPublicKnowledgeExtractor } = await import('../lib/knowledge-extraction.mjs');
  const { store, hostStateRoot, privateRoot } = await fixture(t);
  const requests = []; let source = 'Synthetic private user text: never publish this.';
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const receipts = (await files(resolve(hostStateRoot, 'platform-usage'))).filter(path => path.endsWith('/started.json'));
    assert.equal(receipts.length, requests.length); // the real network call follows durable STARTED
    const value = requests.length === 1 ? { entries: knowledge.entries } : { safe: true, entries: knowledge.entries };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `provider-${requests.length}`, model: 'gpt-6-luna', service_tier: 'default', status: 'completed',
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, total_tokens: 110 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const invoke = createKnowledgeResponsesClient({ endpoint: 'https://fixture.invalid/v1/responses', model: 'gpt-6-luna',
    credential: 'fixture-only', channel: 'fixture', recordAttempt: store.platformCostSink(agent.subjectKey),
    fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, options) });
  const extract = createPublicKnowledgeExtractor({ invoke, readConversations: async () => source, publish: store.publish });
  assert.deepEqual(await extract({ agent, operationId: knowledge.operationId }), { confirmed: true });
  assert.equal(requests.length, 2); assert.equal(requests[0].input, source);
  assert.equal(requests[1].input.includes(source), false);
  await rm(privateRoot, { recursive: true });
  const paths = await files(hostStateRoot); assert.equal(paths.length, 5); // one public artifact, four platform receipts
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    assert.equal(text.includes(source), false); assert.equal(text.includes('fixture-only'), false);
  }
});
