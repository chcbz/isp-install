import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  computeTaskContextPackDigest,
  TASK_CONTEXT_PACK_FAILURE,
  TaskContextPackHttpAdapter
} from '../task-context-pack.mjs'

const TENANT = 'tenant-a'
const CLIENT = 'client-a'
const ACTOR = 'agt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TOKEN = (() => {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ jiacn: TENANT, client_id: CLIENT, sub: ACTOR })}.signature`
})()

const safeText = (value, overrides = {}) => ({ value, redacted: false, truncated: false, ...overrides })

const contextPack = (overrides = {}) => {
  const pack = {
    schemaVersion: 'f01-context-pack-v1',
    provenance: {
      tenantId: TENANT,
      clientId: CLIENT,
      taskId: 'task-a',
      actorAgentId: ACTOR,
      taskVersion: '3',
      currentEventVersion: '7'
    },
    taskDescription: {
      title: safeText('Bounded task'),
      description: safeText(REDACTED_TEXT, { redacted: true }),
      status: 'AVAILABLE',
      truncated: false
    },
    members: {
      items: [{ agentId: ACTOR, role: 'worker', status: 'working', version: '2' }],
      status: 'AVAILABLE',
      truncated: false
    },
    workItems: {
      items: [{
        workItemId: 'work-a',
        title: safeText('Implement adapter'),
        description: safeText('Metadata only'),
        workType: 'implementation',
        assigneeAgentId: ACTOR,
        status: 'running',
        priority: 10,
        requiredItem: true,
        dependencyIds: ['work-prerequisite'],
        dependenciesTruncated: false,
        version: '4'
      }],
      status: 'AVAILABLE',
      truncated: false
    },
    authoritativeArtifacts: {
      items: [{
        artifactId: 'artifact-a',
        workItemId: 'work-a',
        producerAgentId: ACTOR,
        artifactType: 'analysis',
        title: safeText('Accepted metadata'),
        contentHash: 'a'.repeat(64),
        artifactVersion: '1',
        visibility: 'task_members',
        createdAt: '1000',
        outcomeState: 'accepted',
        outcomeVersion: '1',
        decisionId: 'decision-a',
        decidedByAgentId: ACTOR,
        decidedAt: '1100'
      }],
      status: 'AVAILABLE',
      truncated: false
    },
    openRequests: {
      items: [{
        requestId: 'request-a',
        workItemId: 'work-a',
        requesterAgentId: ACTOR,
        targetType: 'role',
        targetId: 'reviewer',
        requestType: 'review',
        status: 'open',
        priority: 5,
        title: safeText('Review'),
        description: safeText('Check bounded contract'),
        dueAt: '1200',
        version: '1'
      }],
      status: 'AVAILABLE',
      truncated: false
    },
    recentEvents: {
      items: [
        { version: '6', redacted: true },
        {
          version: '7', redacted: false, eventType: 'WORK_ITEM_STARTED', actorType: 'agent',
          actorId: ACTOR, aggregateType: 'work_item', aggregateId: 'work-a', occurredAt: '1300'
        }
      ],
      reason: 'ACCEPTED_ARTIFACT_EVENT_FILTER',
      status: 'AVAILABLE',
      truncated: false
    },
    conversation: {
      reason: 'CONVERSATION_SOURCE_NOT_INSTALLED',
      contentOmitted: true,
      status: 'UNAVAILABLE',
      truncated: false
    },
    digestAlgorithm: 'SHA-256',
    digest: null
  }
  Object.assign(pack, overrides)
  pack.digest = computeTaskContextPackDigest(pack)
  return pack
}

const REDACTED_TEXT = '[REDACTED_SENSITIVE_TEXT]'

const streamedResponse = ({ url, status = 200, value, chunks = null, headers = {}, redirected = false }) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  const parts = chunks || [bytes]
  return {
    status,
    url: String(url),
    redirected,
    headers: new Headers({
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'private, no-store',
      ...(chunks ? {} : { 'content-length': String(bytes.length) }),
      ...headers
    }),
    body: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(Buffer.from(part))
        controller.close()
      }
    })
  }
}

const binding = overrides => ({
  tenantId: TENANT,
  clientId: CLIENT,
  taskId: 'task-a',
  actorAgentId: ACTOR,
  expectedVersion: '7',
  ...overrides
})

const adapter = overrides => new TaskContextPackHttpAdapter({
  wsUrl: 'wss://api.example.test/ws/agent/channel?api_key=must-not-propagate',
  tokenProvider: () => TOKEN,
  timeoutMs: 1000,
  ...overrides
})

const expectCode = async (promise, code) => assert.rejects(promise,
  error => error?.code === code && error.message === code)

test('authenticated fake transport uses the fixed encoded path, one optional query and no WS credential', async () => {
  const calls = []
  const taskId = 'task/alpha ?#%'
  const pack = contextPack({ provenance: { ...contextPack().provenance, taskId } })
  pack.digest = computeTaskContextPackDigest(pack)
  const reader = adapter({
    fetchFn: async (url, options) => {
      calls.push({ url, options })
      return streamedResponse({ url, value: pack })
    }
  })

  const result = await reader.readForDispatch(binding({ taskId }))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.origin, 'https://api.example.test')
  assert.equal(calls[0].url.pathname, '/agent/tasks/task%2Falpha%20%3F%23%25/context-pack')
  assert.deepEqual([...calls[0].url.searchParams], [['expectedVersion', '7']])
  assert.equal(calls[0].url.searchParams.has('actorAgentId'), false)
  assert.equal(calls[0].url.href.includes('api_key'), false)
  assert.deepEqual(calls[0].options.headers, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' })
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.body, undefined)
  assert.equal(result.taskDescription.description.redacted, true)
  assert.equal(result.conversation.status, 'UNAVAILABLE')
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.workItems.items), true)
})

test('non-TLS WS origins fail closed while explicit loopback maps to HTTP', async () => {
  assert.throws(
    () => adapter({ wsUrl: 'ws://api.example.test/ws', fetchFn: async () => assert.fail('no request') }),
    error => error.code === TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID
  )
  let called = 0
  const reader = adapter({
    wsUrl: 'ws://127.0.0.1:18080/ws',
    fetchFn: async url => {
      called += 1
      assert.equal(url.origin, 'http://127.0.0.1:18080')
      return streamedResponse({ url, value: contextPack() })
    }
  })
  await reader.readForDispatch(binding())
  assert.equal(called, 1)
})

test('JWT scope is the request authority and mismatched dispatch scope never reaches transport', async () => {
  for (const change of [
    { tenantId: 'other-tenant' },
    { clientId: 'other-client' },
    { actorAgentId: 'agt_cccccccccccccccccccccccccccccccc' }
  ]) {
    let calls = 0
    const reader = adapter({ fetchFn: async () => { calls += 1 } })
    await expectCode(reader.readForDispatch(binding(change)), TASK_CONTEXT_PACK_FAILURE.SCOPE_MISMATCH)
    assert.equal(calls, 0)
  }
})

test('foreign tenant client task or actor provenance is rejected after exactly one request', async () => {
  const corruptions = [
    provenance => { provenance.tenantId = 'other-tenant' },
    provenance => { provenance.clientId = 'other-client' },
    provenance => { provenance.taskId = 'other-task' },
    provenance => { provenance.actorAgentId = 'agt_cccccccccccccccccccccccccccccccc' }
  ]
  for (const corrupt of corruptions) {
    let calls = 0
    const pack = contextPack()
    corrupt(pack.provenance)
    pack.digest = computeTaskContextPackDigest(pack)
    const reader = adapter({ fetchFn: async url => {
      calls += 1
      return streamedResponse({ url, value: pack })
    } })
    await expectCode(reader.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.SCOPE_MISMATCH)
    assert.equal(calls, 1)
  }
})

test('expectedVersion is only an optional fence and never overwrites authoritative response versions', async () => {
  let calls = 0
  const stalePack = contextPack({
    provenance: { ...contextPack().provenance, taskVersion: '99', currentEventVersion: '8' }
  })
  stalePack.digest = computeTaskContextPackDigest(stalePack)
  const staleReader = adapter({ fetchFn: async url => {
    calls += 1
    return streamedResponse({ url, value: stalePack })
  } })
  await expectCode(staleReader.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.STALE)
  assert.equal(calls, 1)

  const currentReader = adapter({ fetchFn: async url => streamedResponse({ url, value: stalePack }) })
  const current = await currentReader.readForDispatch(binding({ expectedVersion: null }))
  assert.equal(current.provenance.taskVersion, '99')
  assert.equal(current.provenance.currentEventVersion, '8')

  let invalidCalls = 0
  const invalidReader = adapter({ fetchFn: async () => { invalidCalls += 1 } })
  await expectCode(invalidReader.readForDispatch(binding({ expectedVersion: 7 })),
    TASK_CONTEXT_PACK_FAILURE.REQUEST_INVALID)
  assert.equal(invalidCalls, 0)
})

test('schema drift, digest mismatch, unredacted secret and unbounded section fail closed', async () => {
  const corruptions = [
    pack => { pack.schemaVersion = 'f01-context-pack-v2' },
    pack => { pack.digest = '0'.repeat(64) },
    pack => { pack.taskDescription.description = safeText('password=raw-secret') },
    pack => { pack.members.items = Array.from({ length: 101 }, (_, index) => ({
      agentId: `agent-${index}`, role: 'worker', status: 'working', version: '1'
    })) },
    pack => { pack.workItems.items = Array.from({ length: 26 }, (_, index) => ({
      ...pack.workItems.items[0], workItemId: `work-${index}`
    })) },
    pack => { pack.workItems.items[0].dependencyIds = Array.from({ length: 26 }, (_, index) => `dep-${index}`) },
    pack => { pack.authoritativeArtifacts.items = Array.from({ length: 51 }, (_, index) => ({
      ...pack.authoritativeArtifacts.items[0], artifactId: `artifact-${index}`
    })) },
    pack => { pack.openRequests.items = Array.from({ length: 26 }, (_, index) => ({
      ...pack.openRequests.items[0], requestId: `request-${index}`
    })) },
    pack => { pack.recentEvents.items = Array.from({ length: 101 }, (_, index) => ({
      version: String(index + 1), redacted: true
    })) },
    pack => { pack.authoritativeArtifacts.items[0].outcomeState = 'draft' },
    pack => { pack.conversation.contentOmitted = false }
  ]
  for (const corrupt of corruptions) {
    const pack = contextPack()
    corrupt(pack)
    if (!/^0{64}$/.test(pack.digest)) pack.digest = computeTaskContextPackDigest(pack)
    const reader = adapter({ fetchFn: async url => streamedResponse({ url, value: pack }) })
    await expectCode(reader.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.RESPONSE_INVALID)
  }
})

test('valid chunked body is assembled under the one MiB bound', async () => {
  const bytes = Buffer.from(JSON.stringify(contextPack()))
  const chunks = [bytes.subarray(0, 17), bytes.subarray(17, 113), bytes.subarray(113)]
  const reader = adapter({ fetchFn: async url => streamedResponse({ url, value: bytes, chunks }) })
  const result = await reader.readForDispatch(binding())
  assert.equal(result.digestAlgorithm, 'SHA-256')
})

test('declared and chunked oversized responses are rejected without retry', async () => {
  let declaredCalls = 0
  const declared = adapter({ fetchFn: async url => {
    declaredCalls += 1
    return streamedResponse({
      url,
      value: '{}',
      headers: { 'content-length': String(1024 * 1024 + 1) }
    })
  } })
  await expectCode(declared.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.RESPONSE_TOO_LARGE)
  assert.equal(declaredCalls, 1)

  let chunkedCalls = 0
  const chunked = adapter({ fetchFn: async url => {
    chunkedCalls += 1
    return streamedResponse({
      url,
      value: '',
      chunks: [Buffer.alloc(700_000), Buffer.alloc(400_000)]
    })
  } })
  await expectCode(chunked.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.RESPONSE_TOO_LARGE)
  assert.equal(chunkedCalls, 1)
})

test('caller abort and transport timeout terminate one request without retry', async () => {
  let abortCalls = 0
  const abortController = new AbortController()
  const abortReader = adapter({ fetchFn: async () => {
    abortCalls += 1
    return new Promise(() => {})
  } })
  const aborted = abortReader.readForDispatch(binding(), { signal: abortController.signal })
  while (abortCalls < 1) await new Promise(resolvePromise => setImmediate(resolvePromise))
  abortController.abort()
  await expectCode(aborted, TASK_CONTEXT_PACK_FAILURE.ABORTED)
  assert.equal(abortCalls, 1)

  let timeoutCalls = 0
  const timeoutReader = adapter({
    timeoutMs: 5,
    fetchFn: async () => {
      timeoutCalls += 1
      return new Promise(() => {})
    }
  })
  await expectCode(timeoutReader.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.TIMEOUT)
  assert.equal(timeoutCalls, 1)
})

test('redirects, URL changes, missing no-store and non-JSON responses are rejected', async () => {
  const responses = [
    (url, pack) => streamedResponse({ url, value: pack, redirected: true }),
    (url, pack) => streamedResponse({ url: 'https://other.example.test/context-pack', value: pack }),
    (url, pack) => streamedResponse({ url, value: pack, headers: { 'cache-control': 'private' } }),
    (url, pack) => streamedResponse({ url, value: pack, headers: { 'content-type': 'text/plain' } })
  ]
  for (const makeResponse of responses) {
    let calls = 0
    const reader = adapter({ fetchFn: async url => {
      calls += 1
      return makeResponse(url, contextPack())
    } })
    await expectCode(reader.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.RESPONSE_INVALID)
    assert.equal(calls, 1)
  }
})

test('HTTP absence and auth failures never become context success or disclose response bodies', async () => {
  for (const [status, code] of [
    [401, TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE],
    [403, TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE],
    [404, TASK_CONTEXT_PACK_FAILURE.NOT_FOUND],
    [409, TASK_CONTEXT_PACK_FAILURE.STALE],
    [503, TASK_CONTEXT_PACK_FAILURE.UNAVAILABLE]
  ]) {
    let calls = 0
    const reader = adapter({ fetchFn: async url => {
      calls += 1
      return streamedResponse({ url, status, value: { code: 'SERVER_CODE', raw: 'raw-secret-token' } })
    } })
    await assert.rejects(reader.readForDispatch(binding()), error => {
      assert.equal(error.code, code)
      assert.equal(error.message, code)
      assert.equal(String(error).includes('raw-secret-token'), false)
      assert.equal(String(error).includes(TOKEN), false)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('protected local JWT file is accepted and loose permissions fail before transport', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'task-context-pack-token-'))
  try {
    const tokenFile = resolve(root, 'agent.jwt')
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
    let calls = 0
    const reader = new TaskContextPackHttpAdapter({
      wsUrl: 'wss://api.example.test/ws',
      bearerTokenFile: tokenFile,
      timeoutMs: 1000,
      fetchFn: async url => {
        calls += 1
        return streamedResponse({ url, value: contextPack() })
      }
    })
    await reader.readForDispatch(binding())
    assert.equal(calls, 1)

    chmodSync(tokenFile, 0o644)
    await expectCode(reader.readForDispatch(binding()), TASK_CONTEXT_PACK_FAILURE.AUTH_UNAVAILABLE)
    assert.equal(calls, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
