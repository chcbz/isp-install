import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKnowledgeExtractor } from '../lib/knowledge-extraction.mjs';
const agent = { subjectKey: 'tenant/client/agent' };
const operationId = 'handover-1';
const privateText = 'PRIVATE OWNER AND CONVERSATION';
const draft = { entries: [{ title: 'Draft', guidance: 'Potentially private guidance.' }] };
const reviewed = { safe: true, entries: [{ title: 'Atomic updates', guidance: 'Write to a temporary file, then rename atomically.' }] };
function fixture(results = [draft, reviewed], source = privateText) {
  const calls = [], published = [];
  const extract = createPublicKnowledgeExtractor({ readConversations: () => [{ batchId: "0", text: source }],
    invoke: async request => { calls.push(request); return results[calls.length - 1]; },
    publish: async value => { published.push(value); } });
  return { calls, published, extract };
}
test('only reviewed generic knowledge is published; original owner and conversation do not enter artifact', async () => {
  const { calls, published, extract } = fixture();
  assert.deepEqual(await extract({ agent, operationId, ownerJiacn: 'private-owner' }), { confirmed: true });
  assert.equal(calls.length, 2); assert.equal(calls[0].input, privateText);
  assert.equal(calls[1].input, JSON.stringify(draft));
  assert.equal(JSON.stringify(calls[1]).includes(privateText), false);
  assert.deepEqual(calls.map(x => JSON.parse(x.attemptId)), [[agent.subjectKey, operationId, '0', 'extract'], [agent.subjectKey, operationId, '0', 'privacy-review']]);
  assert.deepEqual(published, [{ agent, operationId: JSON.stringify([operationId, "0"]), entries: reviewed.entries }]);
  assert.equal(JSON.stringify(published).includes('private-owner'), false);
});
test('empty sources spend nothing and empty extraction does not invoke privacy review', async () => {
  const empty = fixture([], ''); await empty.extract({ agent, operationId });
  assert.equal(empty.calls.length, 0); assert.equal(empty.published.length, 0);
  const noLessons = fixture([{ entries: [] }]); await noLessons.extract({ agent, operationId });
  assert.equal(noLessons.calls.length, 1); assert.equal(noLessons.published.length, 0);
});
test('privacy rejection never publishes draft or review content', async () => {
  const value = fixture([draft, { safe: false, entries: draft.entries }]);
  await assert.rejects(value.extract({ agent, operationId }), { code: 'KNOWLEDGE_PRIVACY_REJECTED' });
  assert.equal(value.published.length, 0);
});
test('invalid model schema and self-authorizing extra fields cannot publish knowledge', async () => {
  for (const results of [[{ ...draft, authorized: true }], [{ entries: [{ title: 'x', guidance: 1 }] }],
    [draft, { ...reviewed, rawConversation: privateText }], [draft, { safe: 'true', entries: reviewed.entries }]]) {
    const value = fixture(results);
    await assert.rejects(value.extract({ agent, operationId }), { code: 'KNOWLEDGE_SCHEMA_INVALID' });
    assert.equal(value.published.length, 0);
  }
});
test('publication failure is not reported as extracted and cannot trigger an implicit model retry', async () => {
  let calls = 0;
  const extract = createPublicKnowledgeExtractor({ readConversations: () => [{ batchId: "0", text: privateText }],
    invoke: async () => [draft, reviewed][calls++], publish: async () => { throw new Error('disk failure'); } });
  await assert.rejects(extract({ agent, operationId }), /disk failure/); assert.equal(calls, 2);
});
