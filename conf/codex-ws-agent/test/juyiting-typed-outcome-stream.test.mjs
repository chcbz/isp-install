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
