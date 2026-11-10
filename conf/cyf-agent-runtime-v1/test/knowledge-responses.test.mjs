import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeResponsesClient } from '../lib/knowledge-responses.mjs';

const schema = { type: 'object', properties: { knowledge: { type: 'string' } }, required: ['knowledge'], additionalProperties: false };
const request = { attemptId: 'agent:handover:extract', instructions: 'Extract generic public knowledge only.',
  input: 'Private synthetic conversation.', schema, schemaName: 'public_knowledge' };
const success = { id: 'response-1', model: 'gpt-6-luna', service_tier: 'default', status: 'completed',
  usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 7, total_tokens: 37 },
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"knowledge":"Use atomic writes."}' }] }] };
const config = { endpoint: 'https://provider.invalid/v1/responses', model: 'gpt-6-luna', credential: 'fixture-secret', channel: 'fixture' };
function fixture(body = success, status = 200) {
  const receipts = [], calls = [];
  const client = createKnowledgeResponsesClient({ ...config, recordAttempt: async event => { receipts.push(event); },
    fetchImpl: async (url, options) => { assert.equal(receipts.length, 1); calls.push({ url, options });
      return { ok: status >= 200 && status < 300, status, json: async () => body }; } });
  return { client, receipts, calls };
}
test('platform usage starts before the paid request and is retained before public output validation', async () => {
  const { client, receipts, calls } = fixture();
  assert.deepEqual(await client(request), { knowledge: 'Use atomic writes.' });
  assert.equal(calls.length, 1);
  assert.deepEqual(receipts.map(x => [x.phase, x.costBearer]), [['STARTED', 'PLATFORM'], ['RESPONDED', 'PLATFORM']]);
  assert.deepEqual(receipts[1].evidence.usage, success.usage);
  assert.equal(receipts[1].evidence.actualModel, 'gpt-6-luna');
  assert.equal(receipts[1].attemptId, request.attemptId);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.store, false); assert.equal(sent.stream, false); assert.deepEqual(sent.tools, []);
  assert.equal(sent.previous_response_id, undefined); assert.equal(sent.metadata, undefined);
  assert.deepEqual(sent.text.format, { type: 'json_schema', name: 'public_knowledge', strict: true, schema });
  assert.equal(calls[0].options.redirect, 'error');
  const recorded = JSON.stringify(receipts);
  for (const privateText of [request.input, request.instructions, 'fixture-secret', 'Use atomic writes.'])
    assert.equal(recorded.includes(privateText), false);
});
test('unavailable platform ledger prevents model spend', async () => {
  let calls = 0;
  const client = createKnowledgeResponsesClient({ ...config, recordAttempt: async () => { throw new Error('ledger unavailable'); },
    fetchImpl: async () => { calls++; } });
  await assert.rejects(client(request), /ledger unavailable/); assert.equal(calls, 0);
});
test('ambiguous network result leaves started usage pending without retry or private error disclosure', async () => {
  const receipts = []; let calls = 0;
  const client = createKnowledgeResponsesClient({ ...config, recordAttempt: async value => receipts.push(value),
    fetchImpl: async () => { calls++; throw new Error('fixture-secret private response'); } });
  await assert.rejects(client(request), error => error.code === 'KNOWLEDGE_PROVIDER_RESULT_UNKNOWN'
    && !error.message.includes('fixture-secret'));
  assert.equal(calls, 1); assert.equal(receipts.length, 1); assert.equal(receipts[0].evidence, null);
});
test('refused incomplete invalid and HTTP error outputs still retain original usage', async () => {
  for (const [body, status] of [
    [{ ...success, status: 'incomplete' }, 200],
    [{ ...success, output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'private detail' }] }] }, 200],
    [{ ...success, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not json' }] }] }, 200],
    [{ ...success, error: { message: 'private error' } }, 500]
  ]) {
    const { client, receipts, calls } = fixture(body, status);
    await assert.rejects(client(request));
    assert.equal(calls.length, 1); assert.deepEqual(receipts[1].evidence.usage, success.usage);
    assert.equal(JSON.stringify(receipts).includes('private'), false);
  }
});
test('missing provider counters and model stay unknown rather than borrowing requested model or zero', async () => {
  const body = { ...success }; delete body.usage; delete body.model; delete body.service_tier;
  const { client, receipts } = fixture(body); await client(request);
  assert.equal(receipts[1].evidence.usage, null); assert.equal(receipts[1].evidence.actualModel, null);
  assert.equal(receipts[1].evidence.serviceTier, null);
});
test('lost terminal cost acknowledgement cannot publish output or retry provider', async () => {
  let calls = 0;
  const client = createKnowledgeResponsesClient({ ...config, recordAttempt: async event => {
    if (event.phase === 'RESPONDED') throw new Error('terminal ledger unavailable');
  }, fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => success }; } });
  await assert.rejects(client(request), /terminal ledger unavailable/); assert.equal(calls, 1);
});
test('operator endpoint and durable sink required; untrusted redirects cannot receive credentials', () => {
  for (const endpoint of ['http://provider.invalid/responses', 'https://user:pass@provider.invalid/responses', 'https://provider.invalid/responses?token=x'])
    assert.throws(() => createKnowledgeResponsesClient({ ...config, endpoint, recordAttempt: async () => {} }));
  assert.throws(() => createKnowledgeResponsesClient(config));
});

test('source whitespace is preserved rather than rejected as an identity field', async () => {
  const { client, calls } = fixture();
  const input = '\n  Original user message with trailing newline.\n';
  await client({ ...request, input });
  assert.equal(JSON.parse(calls[0].options.body).input, input);
});
