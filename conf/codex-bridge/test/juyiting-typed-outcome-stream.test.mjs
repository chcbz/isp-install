import test from 'node:test'
import assert from 'node:assert/strict'
import { TypedOutcomeTextStreamDecoder } from '../juyiting-typed-outcome-stream.mjs'

const decodeChunks = chunks => {
  const decoder = new TypedOutcomeTextStreamDecoder(); let output = ''
  for (const chunk of chunks) output += decoder.push(chunk)
  return { decoder, output }
}

test('decoder emits only top-level text for every single split and arbitrary root field order', () => {
  const raw = '{"proposal":{"text":"nested-secret","sourceRefIds":["source_1"]},"kind":"EXECUTION_PROPOSAL","text":"鲜艳的黄鹂🐦","schemaVersion":1,"clarification":null}'
  for (let split = 0; split <= raw.length; split++) {
    const { decoder, output } = decodeChunks([raw.slice(0, split), raw.slice(split)])
    assert.equal(output, '鲜艳的黄鹂🐦')
    assert.equal(decoder.finish('鲜艳的黄鹂🐦'), '')
  }
})

test('decoder preserves escaped quote, slash, newline and Unicode scalar boundaries across character chunks', () => {
  const raw = '{"schemaVersion":1,"text":"a\\\"b\\\\c\\n\\ud83d\\udc26尾","kind":"ANSWER","clarification":null,"proposal":null}'
  const { decoder, output } = decodeChunks([...raw])
  assert.equal(output, 'a"b\\c\n🐦尾')
  assert.equal(decoder.finish(output), '')
})

test('decoder never emits nested text, raw JSON, schema, proposal or source ids', () => {
  const raw = '{"proposal":{"text":"nested","sourceRefIds":["source_1"]},"schemaVersion":1,"kind":"ANSWER","clarification":null,"text":"visible"}'
  const decoder = new TypedOutcomeTextStreamDecoder()
  assert.equal(decoder.push(raw.slice(0, raw.indexOf('visible'))), '')
  const suffix = decoder.push(raw.slice(raw.indexOf('visible')))
  assert.equal(suffix, 'visible')
  assert.equal(suffix.includes('source_1'), false)
  assert.equal(suffix.includes('{'), false)
})

test('final may add only an exact suffix and rejects prefix rewrite or broken Unicode', () => {
  const decoder = new TypedOutcomeTextStreamDecoder()
  assert.equal(decoder.push('{"text":"hello'), 'hello')
  assert.equal(decoder.finish('hello world'), ' world')
  assert.throws(() => decoder.finish('rewritten'), error => error.code === 'TYPED_STREAM_FINAL_PREFIX_MISMATCH')
  assert.throws(() => new TypedOutcomeTextStreamDecoder().push('{"text":"\\ud800x"}'), error => error.code === 'TYPED_STREAM_INVALID_UNICODE')
})

import { TypedUserReplyStreamDecoder } from '../juyiting-typed-outcome-stream.mjs'

test('user reply streams before final once a complete root kind is known', () => {
  for (const kind of ['ANSWER', 'CLARIFY']) {
    const d = new TypedUserReplyStreamDecoder()
    assert.equal(d.push(`{"kind":"${kind.slice(0, 2)}`), '')
    assert.equal(d.push(`${kind.slice(2)}","text":"你好`), '你好')
    assert.equal(d.kind, kind)
    assert.equal(d.push('，请补充'), '，请补充')
    assert.equal(d.push('时间"}'), '时间')
    assert.equal(d.finish('你好，请补充时间', kind), '')
  }
})

test('control types never publish text even in the final suffix', () => {
  for (const kind of ['ACTION_REQUEST', 'REVISION_REQUEST', 'SUBMISSION_REQUEST', 'EXECUTION_PROPOSAL', 'UNKNOWN']) {
    const raw = JSON.stringify({ kind, text: '请生成一张鸟的图片。', action: { instruction: 'private' } })
    for (let split = 0; split <= raw.length; split++) {
      const d = new TypedUserReplyStreamDecoder()
      assert.equal(d.push(raw.slice(0, split)), '')
      assert.equal(d.push(raw.slice(split)), '')
      assert.equal(d.finish('请生成一张鸟的图片。', kind), '')
    }
  }
})

test('late kind buffers text; nested kind and escaped prose do not declare purpose', () => {
  const d = new TypedUserReplyStreamDecoder()
  assert.equal(d.push('{"action":{"kind":"ANSWER"},"text":"秘密'), '')
  assert.equal(d.push('指令","kind":"ACTION_REQUEST"}'), '')
  assert.equal(d.finish('秘密指令', 'ACTION_REQUEST'), '')
  const reply = new TypedUserReplyStreamDecoder()
  assert.equal(reply.push('{"text":"用户答复","kind":"ANS'), '')
  assert.equal(reply.push('WER","action":null}'), '用户答复')
  assert.equal(reply.finish('用户答复', 'ANSWER'), '')
})

test('arbitrary splits and unicode remain exact with root purpose metadata', () => {
  const raw = '{"kind":"ANSWER","text":"a\\\"b\\n\\ud83d\\udc26尾"}'
  for (let split = 0; split <= raw.length; split++) {
    const d = new TypedUserReplyStreamDecoder()
    assert.equal(d.push(raw.slice(0, split)) + d.push(raw.slice(split)), 'a"b\n🐦尾')
    assert.equal(d.finish('a"b\n🐦尾', 'ANSWER'), '')
  }
})

test('final validates purpose and text; no delta can still finish without duplicating output', () => {
  const d = new TypedUserReplyStreamDecoder()
  assert.equal(d.push('{"kind":"ANSWER","text":"hello'), 'hello')
  assert.throws(() => d.finish('hello', 'ACTION_REQUEST'), { code: 'TYPED_STREAM_KIND_CONFLICT' })
  assert.throws(() => d.finish('changed', 'ANSWER'), { code: 'TYPED_STREAM_FINAL_PREFIX_MISMATCH' })
  assert.equal(d.finish('hello world', 'ANSWER'), ' world')
  const absent = new TypedUserReplyStreamDecoder()
  assert.equal(absent.finish('final reply', 'ANSWER'), 'final reply')
  assert.equal(absent.finish('final reply', 'ANSWER'), '')
})
