import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createCodexKnowledgeReader } from '../lib/knowledge-sessions.mjs';
const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'knowledge-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = resolve(root, 'home'); await mkdir(home, { mode: 0o700 });
  return { root, home, agent: { profile: { codexHome: home } } };
}
async function session(home, file, events) {
  const path = resolve(home, file); await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
}
async function collect(reader, agent) { const result = []; for await (const batch of reader(agent)) result.push(batch); return result; }
test('reads active and archived text in deterministic order without metadata tool results or image attachments', async t => {
  const { home, agent } = await fixture(t);
  await session(home, 'sessions/2026/first.jsonl', [{ type: 'session_meta', payload: { cwd: '/private/path', id: 'secret-session' } },
    message('user', 'Question'), message('assistant', 'Answer'), message('system', 'Secret system instruction'),
    { type: 'response_item', payload: { type: 'function_call_output', output: 'Secret tool result' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'secret-image' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } }]);
  await session(home, 'archived_sessions/old.jsonl', [message('assistant', 'Archived answer')]);
  const read = createCodexKnowledgeReader({ maxInputBytes: 1024 });
  const actual = await collect(read, agent);
  assert.deepEqual(actual, [{ batchId: '0', text: 'USER:\nQuestion\nASSISTANT:\nAnswer' }, { batchId: '1', text: 'ASSISTANT:\nArchived answer' }]);
  assert.deepEqual(await collect(read, agent), actual);
});
test('oversized messages are split without losing multibyte characters and each input fits its configured capacity', async t => {
  const { home, agent } = await fixture(t); const text = '中文🙂abcd'.repeat(200);
  await session(home, 'sessions/large.jsonl', [message('assistant', text)]);
  const actual = await collect(createCodexKnowledgeReader({ maxInputBytes: 47 }), agent);
  assert.ok(actual.length > 10);
  assert.ok(actual.every(batch => Buffer.byteLength(batch.text) <= 47 && !batch.text.includes('\ufffd')));
  assert.equal(actual.map(batch => batch.text.replace(/^ASSISTANT:\n/, '')).join(''), text);
  assert.deepEqual(actual.map(batch => batch.batchId), actual.map((_, index) => String(index)));
});
test('empty histories spend no input and symlinked session roots cannot read another HOME', async t => {
  const { home, root, agent } = await fixture(t); const read = createCodexKnowledgeReader({ maxInputBytes: 100 });
  assert.deepEqual(await collect(read, agent), []);
  const other = resolve(root, 'other'); await mkdir(other, { mode: 0o700 });
  await writeFile(resolve(other, 'secret.jsonl'), JSON.stringify(message('user', 'Other user data')));
  await symlink(other, resolve(home, 'sessions'));
  await assert.rejects(collect(read, agent));
});
test('nested symlinks are not traversed and malformed sessions fail without publishing partial source as knowledge', async t => {
  const { home, root, agent } = await fixture(t);
  await session(home, 'sessions/normal.jsonl', [message('user', 'Allowed')]);
  const other = resolve(root, 'other'); await mkdir(other, { mode: 0o700 });
  await writeFile(resolve(other, 'secret.jsonl'), JSON.stringify(message('user', 'Other data')));
  await symlink(other, resolve(home, 'sessions/link')); await symlink(resolve(other, 'secret.jsonl'), resolve(home, 'sessions/link.jsonl'));
  const read = createCodexKnowledgeReader({ maxInputBytes: 100 });
  assert.equal((await collect(read, agent)).map(x => x.text).join(''), 'USER:\nAllowed');
  await writeFile(resolve(home, 'sessions/broken.jsonl'), '{not-json');
  await assert.rejects(collect(read, agent), { code: 'KNOWLEDGE_SESSION_JSON_INVALID' });
});
test('operator capacity is required rather than guessing model context limits', () => {
  for (const maxInputBytes of [undefined, 0, 15, NaN, Infinity, 2.5])
    assert.throws(() => createCodexKnowledgeReader({ maxInputBytes }), { code: 'KNOWLEDGE_INPUT_CAPACITY_REQUIRED' });
});
