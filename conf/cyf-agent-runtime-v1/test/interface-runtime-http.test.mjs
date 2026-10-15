import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeV1Client } from '../lib/runtime-client.mjs'

const client = fetchFn => new RuntimeV1Client({ manifest: {}, apiBaseUrl: 'https://api.test', stateDir: '/unused',
  hostId: 'h', runtimeInstanceId: 'r', fetchFn })
const response = (config, data, status = 200, code = 'E0') => new Response(JSON.stringify({
  protocolVersion: 1, requestId: config.headers['X-Request-Id'], code, msg: 'result', data
}), { status, headers: { 'content-type': 'application/json', 'x-request-id': config.headers['X-Request-Id'] } })

test('Runtime HTTP sends exact Q and decodes exactly one R', async () => {
  const api = client(async (url, config) => {
    assert.equal(url, 'https://api.test/agent/runtime/v1/session')
    const request = JSON.parse(config.body)
    assert.deepEqual(Object.keys(request).sort(), ['data', 'protocolVersion', 'requestId'])
    assert.equal(request.requestId, config.headers['X-Request-Id'])
    assert.deepEqual(request.data, { installationId: 'test-domain-field' })
    return response(config, { data: 'business-field' })
  })
  assert.deepEqual(await api.request('/agent/runtime/v1/session', { installationId: 'test-domain-field' }), { data: 'business-field' })
})

test('Runtime preserves business rejection and real HTTP status', async () => {
  const api = client(async (_url, config) => response(config, null, 403, 'RUNTIME_FORBIDDEN'))
  await assert.rejects(api.request('/agent/runtime/v1/session', {}), error => error.code === 'RUNTIME_FORBIDDEN' && error.status === 403)
})

test('Runtime never accepts the old data-only response', async () => {
  const api = client(async () => new Response('{"data":{"sessionToken":"not-a-real-credential"}}', {
    headers: { 'content-type': 'application/json' }
  }))
  await assert.rejects(api.request('/agent/runtime/v1/session', {}), { code: 'PROTOCOL_INVALID_RESPONSE' })
})

test('Runtime rejects header/body mismatch rather than switching identity', async () => {
  const api = client(async (_url, config) => {
    const result = response(config, {})
    result.headers.set('x-request-id', 'other')
    return result
  })
  await assert.rejects(api.request('/agent/runtime/v1/session', {}), { code: 'PROTOCOL_INVALID_RESPONSE' })
})

test('native transport wraps once, verifies correlation, and preserves Response/body', async () => {
  let original
  const api = client(async (_url, config) => {
    const body = JSON.parse(config.body)
    assert.deepEqual(body.data, { commandId: 'cmd', messageId: 'm' })
    assert.equal(body.requestId, config.headers.get('X-Request-Id'))
    assert.match(config.headers.get('Authorization'), /^AgentRuntime /)
    assert.equal(config.headers.has('cookie'), false)
    original = new Response(JSON.stringify({ protocolVersion: 1, requestId: body.requestId, code: 'E0', msg: 'ok', data: { state: 'STARTED' } }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': body.requestId }
    })
    return original
  })
  api.currentSession = { installationId: 'i', canonicalAgentId: 'a', hostId: 'h', runtimeInstanceId: 'r', sessionGeneration: '1', sessionToken: `rts1_${'a'.repeat(64)}` }
  api.sessionAbort = new AbortController()
  const result = await api.nativeFetch('https://api.test/internal/agent/tasks/task/runs/run/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'untrusted' }, body: JSON.stringify({ commandId: 'cmd', messageId: 'm' }) })
  assert.equal(result, original)
  const { readNativeJson } = await import('../../codex-ws-agent/native-json.mjs')
  assert.deepEqual(await readNativeJson(result), { state: 'STARTED' })
})

test('engine and Runtime share identical codec source bytes', async () => {
  const { readFile } = await import('node:fs/promises')
  assert.deepEqual(await readFile(new URL('../lib/api-envelope.mjs', import.meta.url)), await readFile(new URL('../../codex-ws-agent/api-envelope.mjs', import.meta.url)))
})
