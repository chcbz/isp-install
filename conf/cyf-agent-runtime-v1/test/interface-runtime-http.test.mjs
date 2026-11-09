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
  const { readNativeJson } = await import('../../codex-bridge/native-json.mjs')
  assert.deepEqual(await readNativeJson(result), { state: 'STARTED' })
})

test('engine and Runtime share identical codec source bytes', async () => {
  const { readFile } = await import('node:fs/promises')
  assert.deepEqual(await readFile(new URL('../lib/api-envelope.mjs', import.meta.url)), await readFile(new URL('../../codex-bridge/api-envelope.mjs', import.meta.url)))
})

const nativeClient = fetchFn => {
  const api = client(fetchFn)
  api.currentSession = { installationId: 'i', canonicalAgentId: 'a', hostId: 'h', runtimeInstanceId: 'r', sessionGeneration: '1', sessionToken: `rts1_${'a'.repeat(64)}` }
  api.sessionAbort = new AbortController()
  return api
}
const fileRoutes = [
  ['GET', '/internal/agent/chat/requests/req/turns/turn/materials/inputs/ref/content'],
  ['GET', '/internal/agent/chat/requests/req/turns/turn/inspection/inputs/ref/content'],
  ['GET', '/internal/agent/tasks/task/runs/run/inputs/ref/content'],
  ['POST', '/internal/agent/tasks/task/runs/run/conversation/inputs/ref/content']
]
for (const [method, path] of fileRoutes) {
  test(`native file contract preserves JSON bytes on ${method} ${path}`, async () => {
    // Deliberately not an R envelope, including whitespace that must survive SHA checks.
    const bytes = Buffer.from(' {"data":"previous-turn-artifact", "rows": [1,2]}\n')
    let original
    const api = nativeClient(async (_url, config) => {
      assert.match(config.headers.get('Authorization'), /^AgentRuntime /)
      assert.equal(config.redirect, 'error')
      if (method === 'POST') assert.deepEqual(JSON.parse(config.body).data, { version: '1', token: 'lease-fixture' })
      original = new Response(bytes, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } })
      return original
    })
    const result = await api.nativeFetch(`https://api.test${path}`, { method,
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '1', token: 'lease-fixture' }) } : {}) })
    assert.equal(result, original)
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes)
  })
  test(`native file failures still verify the R envelope on ${path}`, async () => {
    const api = nativeClient(async () => new Response('{"data":"not-an-error-envelope"}', {
      status: 403, headers: { 'Content-Type': 'application/json' }
    }))
    await assert.rejects(api.nativeFetch(`https://api.test${path}`, { method }), { code: 'PROTOCOL_INVALID_RESPONSE' })
    api.fetchFn = async (_url, config) => new Response(JSON.stringify({ protocolVersion: 1,
      requestId: config.headers.get('X-Request-Id'), code: 'RUNTIME_FORBIDDEN', msg: 'denied', data: null }), {
      status: 403, headers: { 'Content-Type': 'application/json', 'X-Request-Id': config.headers.get('X-Request-Id') }
    })
    assert.equal((await api.nativeFetch(`https://api.test${path}`, { method })).status, 403)
  })
}
test('JSON metadata, archive source and uploads are not file response exceptions', async () => {
  const api = nativeClient(async () => new Response('{"rows":[]}', { headers: { 'Content-Type': 'application/json' } }))
  for (const [method, path] of [
    ['GET', '/internal/agent/tasks/task/runs/run/inputs'],
    ['GET', '/internal/archive/v1/jobs/job/source'],
    ['POST', '/internal/agent/tasks/task/runs/run/outputs/output/content']
  ]) await assert.rejects(api.nativeFetch(`https://api.test${path}`, { method }), { code: 'PROTOCOL_INVALID_RESPONSE' })
})
test('raw JSON file response cannot confirm a rotated session', async () => {
  const api = nativeClient(async () => { api.invalidateSession(); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }) })
  await assert.rejects(api.nativeFetch(`https://api.test${fileRoutes[0][1]}`), { code: 'RUNTIME_NATIVE_SESSION_CHANGED' })
})
