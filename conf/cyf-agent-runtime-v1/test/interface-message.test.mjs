import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeMessage, eventMessage, replyMessage } from '../lib/message-envelope.mjs'
test('event and reply have closed roots and explicit correlation', () => {
  const request = eventMessage('r', 'agent.register', 'm', { runtimeInstallationId: 'i', sessionGeneration: '9007199254740993' })
  assert.deepEqual(decodeMessage(JSON.stringify(request)), request)
  const reply = replyMessage(request, 'agent.registered', 'reply', 'E0', 'ok', null)
  assert.equal(reply.correlationId, 'm'); assert.equal(reply.requestId, 'r'); assert.equal(reply.data, null)
  assert.equal(Object.hasOwn(request, 'code'), false)
})
test('legacy aliases, partial replies, duplicates and missing data are rejected', () => {
  const request = eventMessage('r', 'agent.register', 'm', null)
  for (const value of [{ ...request, code: 'E0' }, { ...request, messageType: 'agent_registered' }, { ...request, protocolVersion: 2 }]) assert.throws(() => decodeMessage(JSON.stringify(value)))
  assert.throws(() => decodeMessage('{"protocolVersion":1,"requestId":"r","messageType":"agent.register","messageId":"m"}'))
  assert.throws(() => decodeMessage('{"protocolVersion":1,"requestId":"r","messageType":"agent.register","messageId":"m","data":null,"data":{}}'))
})

import { decodeMessage as decodeEngineMessage } from '../../codex-ws-agent/message-envelope.mjs'
import { decodeHttpResponse as decodeEngineResponse } from '../../codex-ws-agent/api-envelope.mjs'
test('engine consumers share additive metadata behavior with the host', () => {
  const request = eventMessage('r', 'agent.register', 'm', null)
  assert.deepEqual(decodeEngineMessage(JSON.stringify({ ...request, trace: 'next' })), request)
  assert.deepEqual(decodeEngineResponse(JSON.stringify({ protocolVersion: 1, requestId: 'r', code: 'E0', msg: 'ok', data: { ok: true }, trace: 'next' }), { status: 200, requestId: 'r' }).value, { ok: true })
})
