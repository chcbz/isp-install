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
