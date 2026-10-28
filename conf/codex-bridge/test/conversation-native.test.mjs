import test from 'node:test'
import assert from 'node:assert/strict'
import { validateNativeConversationOutput, nativeSessionHeaders } from '../conversation-native.mjs'
const sessionProof = (auth, agentId = 'agent-1', runtimeInstanceId = 'instance-1') => ({
  Authorization: auth, 'X-Agent-Id': agentId, 'X-Agent-Runtime-Id': runtimeInstanceId,
  'X-Agent-Installation-Id': 'synthetic-installation', 'X-Agent-Host-Id': 'synthetic-host',
  'X-Agent-Session-Generation': '7'
})
test('multimedia output validator checks bytes rather than filename or declared MIME alone', () => {
  const cases = [
    ['image/webp', Buffer.from('RIFF0000WEBPpayload')],
    ['image/gif', Buffer.from('GIF89a0000')],
    ['audio/mpeg', Buffer.from([0x49, 0x44, 0x33, 4])],
    ['audio/wav', Buffer.from('RIFF0000WAVE')],
    ['audio/ogg', Buffer.from('OggS')],
    ['audio/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    ['text/plain', Buffer.from('你好')],
    ['text/markdown', Buffer.from('# title')],
    ['application/json', Buffer.from('{"ok":true}')],
    ['application/octet-stream', Buffer.from([0, 1, 2])]
  ]
  for (const [mime, content] of cases) assert.equal(validateNativeConversationOutput(mime, content), true, mime)
  assert.equal(validateNativeConversationOutput('application/json', Buffer.from('{bad}')), false)
  assert.equal(validateNativeConversationOutput('text/plain', Buffer.from([0xc3, 0x28])), false)
  assert.equal(validateNativeConversationOutput('audio/wav', Buffer.from('RIFF0000WEBP')), false)
  assert.equal(validateNativeConversationOutput('image/svg+xml', Buffer.from('<svg/>')), false)
})


test('native session proof requires rts1 and all five exact headers; no old-token or partial-proof fallback', () => {
  const valid = sessionProof(`AgentRuntime rts1_${'a'.repeat(64)}`)
  assert.deepEqual(nativeSessionHeaders(valid, 'agent-1', 'instance-1'), valid)
  for (const field of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[field]
    assert.throws(() => nativeSessionHeaders(missing, 'agent-1', 'instance-1'), /CONVERSATION_AUTH_UNAVAILABLE/)
  }
  for (const patch of [{ Authorization: `AgentRuntime ${'a'.repeat(32)}` },
    { Authorization: `AgentRuntime rts1_${'A'.repeat(64)}` }, { 'X-Agent-Id': 'foreign' },
    { 'X-Agent-Runtime-Id': 'foreign' }, { 'X-Agent-Session-Generation': '07' },
    { 'X-Agent-Session-Generation': '9223372036854775808' }, { 'X-API-Key': 'retired' }, { Cookie: 'foreign' }]) {
    assert.throws(() => nativeSessionHeaders({ ...valid, ...patch }, 'agent-1', 'instance-1'), /CONVERSATION_AUTH_UNAVAILABLE/)
  }
})
