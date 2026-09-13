import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { RegistrationAckObserver } from '../registration-ack.mjs'
import { ACK_STATUS, AckOutbox, AgentMessageProcessor, DurableDedupeLedger, PersistentCommandInbox,
  createProfileTaskAccess, normalizeInboundMessage, runManagedCommand, runCodex } from '../agent-client.mjs'
import { computeTaskContextPackDigest } from '../task-context-pack.mjs'

// Exact server wire shapes; no JWT issuer, network, process, secret file or paid provider.
const A = 'agt_' + 'a'.repeat(32), B = 'agt_' + 'b'.repeat(32)
const LEGACY = 'jyt-fixture-client-wuyong'
const TOKEN = '1'.repeat(32), TOKEN2 = '2'.repeat(32)
const FIXTURE_NOW = Date.now()
const R = 'runtime-a', PREVIOUS = 'cmd_hall_action_' + 'a'.repeat(64)
const COMMAND = 'cmd_hall_action_' + 'b'.repeat(64), REASSIGNMENT = 'rsn_' + 'c'.repeat(64)
const receipt = (overrides = {}) => ({ type: 'agent_registered', channel: 'openclaw', messageId: 'reg-a',
  agentId: A, runtimeInstanceId: R, status: 'online', token: TOKEN,
  runtimeAuth: { scheme: 'native-runtime-v1', tenantId: 'tenant-a', clientId: 'client-a',
    agentId: A, runtimeInstanceId: R, contextPackEnabled: true }, ...overrides })
const observer = (agentId = A, runtimeInstanceId = R) => new RegistrationAckObserver({ agentId, runtimeInstanceId,
  schedule: () => 1, cancel: () => {}, logger: { log() {}, warn() {} } })
const profile = (overrides = {}) => ({ profileId: 'runtime-auth', agentId: A,
  apiKey: 'must-never-be-http-bearer', taskContextPackMode: 'auto', taskContextPackTimeoutMs: 1000,
  codexBin: '/never-spawn', codexWorkdir: process.cwd(), codexSandbox: 'workspace-write',
  codexApproval: 'never', codexSessionMode: 'new', codexTimeoutMs: 0, ...overrides })
const command = (overrides = {}) => normalizeInboundMessage(JSON.stringify({ schemaVersion: 1,
  messageType: 'command.dispatch', messageId: 'msg-a', commandId: 'command-a', commandType: 'TASK_EXECUTE',
  targetAgentId: A, taskId: 'task-a', tenantId: 'tenant-a', clientId: 'client-a',
  payload: { instruction: 'Only perform this dispatch.' }, ...overrides }))
const pack = (scope = {}) => {
  const empty = () => ({ items: [], status: 'AVAILABLE', truncated: false })
  const result = { schemaVersion: 'f01-context-pack-v1', provenance: { tenantId: 'tenant-a', clientId: 'client-a',
    taskId: 'task-a', actorAgentId: A, taskVersion: '3', currentEventVersion: '7', ...scope },
  taskDescription: { title: { value: 'Native task', redacted: false, truncated: false },
    description: { value: '[REDACTED_SENSITIVE_TEXT]', redacted: true, truncated: false }, status: 'AVAILABLE', truncated: false },
  members: empty(), workItems: empty(), authoritativeArtifacts: empty(), openRequests: empty(), recentEvents: empty(),
  conversation: { reason: 'CONVERSATION_SOURCE_NOT_INSTALLED', contentOmitted: true, status: 'UNAVAILABLE', truncated: false },
  digestAlgorithm: 'SHA-256', digest: null }
  result.digest = computeTaskContextPackDigest(result)
  return result
}
const response = (url, value, status = 200) => {
  const result = new Response(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })
  Object.defineProperty(result, 'url', { value: String(url) })
  return result
}
const fixture = ({ ack = receipt(), prof = profile(), fetchFn = async url => response(url, pack()) } = {}) => {
  const registration = observer(prof.agentId, ack.runtimeInstanceId)
  registration.begin(ack.messageId)
  assert.equal(registration.observe(ack), 'registered')
  const access = createProfileTaskAccess({ profile: prof, registration,
    runtimeInstanceId: ack.runtimeInstanceId, wsUrl: 'wss://api.example.test/ws/agent/channel?api_key=never-forward', fetchFn })
  const execute = (message = command(), runCodexFn = async () => ({ status: 'completed' })) => runManagedCommand({
    profile: prof, message, ...access, skillInstallManager: { execute: async () => ({ status: 'installed' }) }, runCodexFn })
  return { ...access, registration, execute }
}

test('actual registration -> profile access -> F01 dispatch uses runtime token and server scope for opaque and legacy canonical agents', async () => {
  for (const [agent, suffix, token] of [[A, 'a', TOKEN], [B, 'b', TOKEN2], [LEGACY, 'legacy', TOKEN]]) {
    const auth = { ...receipt().runtimeAuth, agentId: agent, tenantId: 'tenant-' + suffix,
      clientId: 'client-' + suffix, runtimeInstanceId: 'runtime-' + suffix }
    let requests = 0, runs = 0
    const f = fixture({ prof: profile({ agentId: agent }), ack: receipt({ agentId: agent,
      runtimeInstanceId: auth.runtimeInstanceId, token, runtimeAuth: auth }), fetchFn: async (url, options) => {
      requests++
      assert.equal(url.origin, 'https://api.example.test')
      assert.equal(url.pathname, '/agent/tasks/task-a/context-pack')
      assert.equal(url.search, '', 'neither identity queries nor invented expectedVersion')
      assert.equal(options.headers.Authorization, 'AgentRuntime ' + token)
      assert.equal(options.headers['X-Agent-Id'], agent)
      assert.equal(options.headers['X-Agent-Runtime-Id'], auth.runtimeInstanceId)
      assert.equal(options.redirect, 'error')
      assert.equal(options.cache, 'no-store')
      assert.equal(options.credentials, 'omit')
      return response(url, pack({ tenantId: auth.tenantId, clientId: auth.clientId, actorAgentId: agent }))
    } })
    const result = await f.execute(command({ targetAgentId: agent, tenantId: auth.tenantId, clientId: auth.clientId }),
      async (_profile, _message, _mode, opts) => {
        runs++; assert.equal(opts.taskContextPack.provenance.currentEventVersion, '7')
        assert.equal(opts.taskContextPack.taskDescription.description.redacted, true)
        assert.equal(opts.taskContextPack.conversation.status, 'UNAVAILABLE')
        assert.equal(Object.isFrozen(opts.taskContextPack), true)
        assert.equal(opts.abortSignal.aborted, false)
        return { status: 'completed' }
      })
    assert.equal(result.status, 'completed'); assert.equal(result.taskContextPackStatus, 'retrieved')
    assert.equal(requests, 1); assert.equal(runs, 1)
    assert.equal(JSON.stringify(result).includes(token), false)
    f.registration.disconnect()
  }
})

test('receipt correlation, explicit runtime scope shape and rotation never expose secrets in snapshots/logs', () => {
  const logs = []
  const o = observer(); o.logger = { log: s => logs.push(s), warn: s => logs.push(s) }
  let invalidations = 0
  o.onInvalidated = () => { invalidations++ }
  o.begin('reg-a')
  for (const change of [{ messageId: 'foreign' }, { agentId: B }, { runtimeInstanceId: 'foreign' }]) {
    assert.equal(o.observe(receipt(change)), null); assert.equal(o.runtimeCredential(), null)
  }
  assert.equal(o.observe(receipt()), 'registered')
  const old = o.runtimeCredential()
  o.begin('reg-new'); assert.equal(old.signal.aborted, true)
  assert.equal(o.observe(receipt({ messageId: 'reg-new', token: TOKEN2 })), 'registered')
  old.invalidate(); assert.equal(o.runtimeCredential().token, TOKEN2, 'old request cannot revoke new generation')
  assert.equal(invalidations, 0)
  o.runtimeCredential().invalidate(); assert.equal(invalidations, 1)
  assert.equal(o.registered, false)
  for (const bad of [ { ...receipt().runtimeAuth, tenantId: '' }, { ...receipt().runtimeAuth, actorAgentId: B },
    { ...receipt().runtimeAuth, agentId: B }, { ...receipt().runtimeAuth, runtimeInstanceId: 'wrong' } ]) {
    o.begin('reg-a'); assert.equal(o.observe(receipt({ runtimeAuth: bad })), 'rejected')
    assert.equal(o.runtimeCredential(), null)
  }
  o.begin('reg-a'); assert.equal(o.observe(receipt({ token: 'jwt.not.registration' })), 'rejected')
  assert.doesNotMatch(JSON.stringify([o.snapshot(), logs]), new RegExp(TOKEN + '|' + TOKEN2 + '|' + A))
})

test('wrong command tenant/client/actor invalidates even when F01 is not enabled; message tokens are ignored', async () => {
  for (const enabled of [true, false]) {
    for (const wrong of [{ tenantId: 'tenant-b' }, { clientId: 'client-b' }, { targetAgentId: B }]) {
      const f = fixture({ ack: receipt({ runtimeAuth: { ...receipt().runtimeAuth, contextPackEnabled: enabled } }),
        fetchFn: async () => assert.fail('scope rejected before HTTP') })
      const previous = f.registration.runtimeCredential()
      const result = await f.execute(command({ ...wrong, token: TOKEN2, apiKey: TOKEN2 }), async () => assert.fail('no dispatch'))
      assert.equal(result.failureCode, 'TASK_CONTEXT_PACK_SCOPE_MISMATCH')
      assert.equal(previous.signal.aborted, true); assert.equal(f.registration.registered, false)
      const next = await f.execute(command(), async () => assert.fail('no silent legacy downgrade after invalidation'))
      assert.equal(next.failureCode, 'TASK_CONTEXT_PACK_AUTH_UNAVAILABLE')
    }
  }
})

test('legacy auto remains compatible without pretending to have context; required and enabled capability fail closed', async () => {
  for (const ack of [receipt({ runtimeAuth: undefined }), receipt({ runtimeAuth: { ...receipt().runtimeAuth, contextPackEnabled: false } })]) {
    const auto = fixture({ ack, fetchFn: async () => assert.fail('not negotiated') })
    assert.equal((await auto.execute()).taskContextPackStatus, 'not_negotiated')
    const required = fixture({ ack, prof: profile({ taskContextPackMode: 'required' }), fetchFn: async () => assert.fail('no credential/capability') })
    assert.equal((await required.execute(command(), async () => assert.fail('no run'))).status, 'failed')
  }
  const enabled = fixture({ fetchFn: async url => response(url, { code: 'UNAVAILABLE' }, 503) })
  assert.equal((await enabled.execute(command(), async () => assert.fail('no fallback'))).status, 'failed')
  enabled.registration.disconnect()
  const chat = await enabled.execute({ commandType: 'OTHER', payload: { instruction: 'legacy non-task' } })
  assert.equal(chat.status, 'completed')
  assert.equal((await enabled.execute({ commandType: 'SKILL_INSTALL' })).status, 'installed')
})

test('HTTP revoked token, foreign response scope and protocol identity rejection invalidate; no body/token leak', async () => {
  for (const status of [401, 403]) {
    const f = fixture({ fetchFn: async url => response(url, { raw: TOKEN + 'sensitive-debug' }, status) })
    const current = f.registration.runtimeCredential()
    const result = await f.execute(command(), async () => assert.fail('no execution'))
    assert.equal(result.status, 'failed'); assert.equal(current.signal.aborted, true)
    assert.equal(f.registration.runtimeCredential(), null)
    assert.doesNotMatch(JSON.stringify(result), /sensitive-debug|11111111111111111111111111111111/)
    assert.equal((await f.execute(command(), async () => assert.fail('no downgrade'))).status, 'failed')
  }
  for (const scope of [{ tenantId: 'tenant-b' }, { clientId: 'client-b' }, { actorAgentId: B }, { taskId: 'foreign' }]) {
    const f = fixture({ fetchFn: async url => response(url, pack(scope)) })
    assert.equal((await f.execute(command(), async () => assert.fail('foreign pack'))).failureCode, 'TASK_CONTEXT_PACK_SCOPE_MISMATCH')
    assert.equal(f.registration.runtimeCredential(), null)
  }
  const f = fixture(); const current = f.registration.runtimeCredential()
  assert.equal(f.registration.observe({ type: 'protocol_error', code: 'RUNTIME_INSTANCE_ID_MISMATCH', runtimeInstanceId: 'wrong' }), 'rejected')
  assert.equal(current.signal.aborted, true)
})

test('runtime lane preserves optional expectedVersion and digest validation, never treating input version as authoritative', async () => {
  let requests = 0
  const stale = fixture({ fetchFn: async (url) => {
    requests++; assert.equal(url.searchParams.get('expectedVersion'), '7')
    return response(url, pack({ currentEventVersion: '8' }))
  } })
  await assert.rejects(stale.taskContextPack.readForDispatch({ tenantId: 'tenant-a', clientId: 'client-a',
    taskId: 'task-a', actorAgentId: A, expectedVersion: '7' }), { code: 'TASK_CONTEXT_PACK_STALE' })
  assert.equal(requests, 1)
  const tampered = fixture({ fetchFn: async url => {
    const body = pack(); body.taskDescription.title.value = 'changed after digest'
    return response(url, body)
  } })
  assert.equal((await tampered.execute(command(), async () => assert.fail('bad digest'))).failureCode,
    'TASK_CONTEXT_PACK_RESPONSE_INVALID')
})

test('matched offline acknowledgement invalidates without accepting another Agent status or later presence as registration', () => {
  const f = fixture(); const current = f.registration.runtimeCredential()
  const ack = { type: 'agent_status_updated', agentId: A, runtimeInstanceId: R, status: 'offline' }
  assert.equal(f.registration.observe({ ...ack, agentId: B }), null)
  assert.equal(current.signal.aborted, false)
  assert.equal(f.registration.observe(ack), 'rejected')
  assert.equal(current.signal.aborted, true)
  assert.equal(f.registration.observe({ ...ack, status: 'online' }), null)
  assert.equal(f.registration.registered, false)
})

test('disconnect/rotation discards in-flight F01 response and aborts actual dispatch; new generation survives', async () => {
  for (const rotate of [false, true]) {
    let started, release
    const entered = new Promise(resolve => { started = resolve })
    const wait = new Promise(resolve => { release = resolve })
    const f = fixture({ fetchFn: async url => { started(); await wait; return response(url, pack()) } })
    const pending = f.execute(command(), async () => assert.fail('stale response must never execute'))
    await entered
    if (rotate) {
      f.registration.begin('new'); f.registration.observe(receipt({ messageId: 'new', token: TOKEN2 }))
    } else f.registration.disconnect()
    release()
    assert.equal((await pending).status, 'failed')
    if (rotate) assert.equal(f.registration.runtimeCredential().token, TOKEN2)
  }
  const f = fixture()
  const result = await f.execute(command(), async (_p, _m, _mode, { abortSignal }) => {
    f.registration.disconnect(); assert.equal(abortSignal.aborted, true)
    return { status: 'completed' } // even an uncooperative runner cannot claim success
  })
  assert.equal(result.status, 'recovery_required')
})

const reassignedCommand = () => command({ commandId: COMMAND, commandType: 'WORK_ITEM_EXECUTE', workItemId: 'work-a',
  correlationId: 'task-a', causationId: 'evt-e05', intentId: 'rsi_' + 'd'.repeat(64),
  issuedAt: 1000, expiresAt: 9999999999999, attempt: 1,
  payload: { actionType: 'work_item_execute', instruction: 'Execute reassigned work item', conversationType: 'juyiting',
    reason: 'lease_expired_reassignment', conversationId: null, triggerEventId: 'evt-e05', autonomyLevel: 'autonomous',
    requiresApproval: false, context: { taskTitle: null, workItemTitle: 'Implement E05', requestSummary: null, reviewSummary: null,
      contextVersion: '5', referenceIds: [PREVIOUS], tags: ['lease-expired', 'reassignment'],
      bindingVersion: 'e05-reassignment-v1', reassignmentId: REASSIGNMENT } } })
const leaseBody = version => ({ reassignmentId: REASSIGNMENT, commandId: COMMAND, taskId: 'task-a', workItemId: 'work-a',
  agentId: A, status: version === 5 ? 'claimed' : 'running', leaseToken: 'fixture-lease-token',
  leaseUntil: FIXTURE_NOW + 300000 + version * 1000, workItemVersion: version, attemptCount: 1, maxAttempts: 3, changedAt: FIXTURE_NOW + version })

test('real F01 + E05 coordinator dispatch reads/starts/heartbeats using the matched native runtime (no new version protocol)', async () => {
  const calls = []
  const f = fixture({ fetchFn: async (url, options) => {
    calls.push(url.pathname)
    assert.equal(options.headers.Authorization, 'AgentRuntime ' + TOKEN)
    assert.equal(options.headers['X-Agent-Runtime-Id'], R)
    if (url.pathname.endsWith('context-pack')) return response(url, pack())
    assert.equal(url.searchParams.get('actorAgentId'), A) // frozen E05 target consistency query; F01 has none
    const body = JSON.parse(options.body)
    assert.equal(body.commandId, COMMAND)
    const version = url.pathname.endsWith('/start') ? 6 : url.pathname.endsWith('/heartbeat') ? 7 : 5
    assert.equal(body.expectedWorkItemVersion, version === 5 ? 5 : version - 1)
    if (version === 7) assert.equal(body.leaseDurationMillis, 300000)
    return response(url, leaseBody(version))
  } })
  const result = await f.execute(reassignedCommand(), async (_p, _m, _mode, options) => {
    assert.equal(calls.length, 4); assert.equal(options.abortSignal.aborted, false)
    return { status: 'completed' }
  })
  assert.equal(result.status, 'completed', result.errorMessage); assert.equal(result.taskContextPackStatus, 'retrieved')
  assert.deepEqual(calls.map(path => path.split('/').at(-1)), ['context-pack', 'lease', 'start', 'heartbeat'])
})

test('E05 non-JSON auth rejection and disconnect invalidate without retry or execution', async () => {
  let requests = 0
  const f = fixture({ ack: receipt({ runtimeAuth: { ...receipt().runtimeAuth, contextPackEnabled: false } }),
    fetchFn: async () => { requests++; return new Response('secret-server-body', { status: 401 }) } })
  const result = await f.execute(reassignedCommand(), async () => assert.fail('lease denied'))
  assert.equal(result.status, 'recovery_required'); assert.equal(requests, 1)
  assert.equal(f.registration.registered, false); assert.equal(f.registration.runtimeCredential(), null)
  assert.doesNotMatch(JSON.stringify(result), /secret-server-body|11111111111111111111111111111111/)
})

test('E05 hanging transport, chunked oversized body and redirect cannot retain an invalid runtime or start work', async () => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const ack = receipt({ runtimeAuth: { ...receipt().runtimeAuth, contextPackEnabled: false } })
  const hanging = fixture({ ack, fetchFn: () => { entered(); return new Promise(() => {}) } })
  const pending = hanging.execute(reassignedCommand(), async () => assert.fail('no execution'))
  await started
  hanging.registration.disconnect()
  assert.equal((await pending).status, 'recovery_required', 'abort settles even an uncooperative fake transport')
  let cancelled = false
  for (const kind of ['chunked', 'redirect']) {
    const f = fixture({ ack, fetchFn: async url => {
      if (kind === 'redirect') {
        const result = response(url, leaseBody(5))
        Object.defineProperty(result, 'redirected', { value: true })
        return result
      }
      return { status: 200, redirected: false, url: String(url),
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32 * 1024)) },
          cancel() { cancelled = true } }) }
    } })
    assert.equal((await f.execute(reassignedCommand(), async () => assert.fail('no execution'))).status, 'recovery_required')
  }
  assert.equal(cancelled, true)
})

test('actual Codex spawn receives bounded context through stdin, not argv, and never executes credentials as instructions', async () => {
  const f = fixture()
  let input = '', args
  const result = await f.execute(command(), async (p, m, mode, overrides) => runCodex(p, m, mode, {
    ...overrides, workspaceManager: { acquireCommandWorkspace: () => ({ workspace: { workspacePath: process.cwd() }, release() {} }) },
    sendStatusFn: () => {}, sendLegacyFn: () => {},
    spawnFn: (_bin, actualArgs, opts) => {
      args = actualArgs; assert.equal(opts.stdio[0], 'pipe')
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.stdin.on('data', b => { input += b.toString() }); child.kill = () => true
      queueMicrotask(() => child.emit('close', 0))
      return child
    }
  }))
  assert.equal(result.status, 'completed'); assert.equal(args.at(-1), '-')
  assert.match(input, /untrusted metadata-only reference data/)
  assert.ok(input.endsWith('Only perform this dispatch.'))
  assert.doesNotMatch(JSON.stringify(args) + input, /must-never-be-http-bearer|11111111111111111111111111111111/)
})

test('live handler registration readiness is observer-gated and installer retains both auth adapter dependencies', () => {
  const source = readFileSync(new URL('../agent-client.mjs', import.meta.url), 'utf8')
  assert.match(source, /registrationResult === 'registered' && profile.managedGeneration/)
  assert.match(source, /registrationResult === 'registered' && !profile.managedGeneration/)
  assert.match(source, /taskContextPack, runtimeCredentialProvider\s*\n?\s*\}/)
  const installer = readFileSync(new URL('../../../shell/codex_ws_agent_install.sh', import.meta.url), 'utf8')
  assert.match(installer, /task-context-pack\.mjs/); assert.match(installer, /registration-ack\.mjs/)
})


// These fixtures model authenticated server receipts; registry authority is tested by the API suite.
test('legacy canonical receipt runs F01 and the complete E05 lease/start/heartbeat path without ID rewriting', async () => {
  const calls = []
  const ack = receipt({ agentId: LEGACY, runtimeAuth: { ...receipt().runtimeAuth, agentId: LEGACY } })
  const f = fixture({ ack, prof: profile({ agentId: LEGACY }), fetchFn: async (url, options) => {
    calls.push(url.pathname)
    assert.equal(options.headers.Authorization, 'AgentRuntime ' + TOKEN)
    assert.equal(options.headers['X-Agent-Id'], LEGACY)
    assert.equal(options.headers['X-Agent-Runtime-Id'], R)
    if (url.pathname.endsWith('context-pack')) return response(url, pack({ actorAgentId: LEGACY }))
    assert.equal(url.searchParams.get('actorAgentId'), LEGACY)
    const body = JSON.parse(options.body)
    assert.equal(body.commandId, COMMAND)
    const version = url.pathname.endsWith('/start') ? 6 : url.pathname.endsWith('/heartbeat') ? 7 : 5
    assert.equal(body.expectedWorkItemVersion, version === 5 ? 5 : version - 1)
    return response(url, { ...leaseBody(version), agentId: LEGACY })
  } })
  let executed = 0
  const result = await f.execute({ ...reassignedCommand(), targetAgentId: LEGACY }, async (_p, _m, _mode, options) => {
    executed++
    assert.equal(options.taskContextPack.provenance.actorAgentId, LEGACY)
    assert.equal(options.abortSignal.aborted, false)
    return { status: 'completed' }
  })
  assert.equal(result.status, 'completed', result.errorMessage)
  assert.equal(result.taskContextPackStatus, 'retrieved')
  assert.equal(executed, 1)
  assert.deepEqual(calls.map(path => path.split('/').at(-1)), ['context-pack', 'lease', 'start', 'heartbeat'])
  f.registration.disconnect()
})

test('legacy receipt still requires exact request, configured identity, runtime, fixed fields and bounded ID syntax', () => {
  const valid = receipt({ agentId: LEGACY, runtimeAuth: { ...receipt().runtimeAuth, agentId: LEGACY } })
  for (const changes of [{ messageId: 'wrong' }, { agentId: LEGACY.toUpperCase() }, { runtimeInstanceId: 'stale' }]) {
    const o = observer(LEGACY); o.begin('reg-a')
    assert.equal(o.observe({ ...valid, ...changes }), null)
    assert.equal(o.runtimeCredential(), null)
    o.disconnect()
  }
  for (const change of [{ agentId: A }, { runtimeInstanceId: 'stale' }, { canonicalType: 'LEGACY_CANONICAL' }]) {
    const o = observer(LEGACY); o.begin('reg-a')
    assert.equal(o.observe({ ...valid, runtimeAuth: { ...valid.runtimeAuth, ...change } }), 'rejected')
    assert.equal(o.runtimeCredential(), null)
  }
  for (const invalid of ['../jyt-fixture', 'jyt/fixture', 'jyt%2ffixture', 'jyt?fixture', 'jyt#fixture',
    'jyt fixture', 'jyt\nfixture', 'jyt-\u007ffixture', 'jyt-典籍', 'x'.repeat(101)]) {
    const o = observer(invalid); o.begin('reg-a')
    assert.notEqual(o.observe(receipt({ agentId: invalid, runtimeAuth: { ...valid.runtimeAuth, agentId: invalid } })), 'registered')
    assert.equal(o.runtimeCredential(), null)
    o.disconnect()
  }
})

test('legacy canonical commands cannot cross actor or scope and invalidated receipts cannot execute', async () => {
  const ack = receipt({ agentId: LEGACY, runtimeAuth: { ...receipt().runtimeAuth, agentId: LEGACY, contextPackEnabled: false } })
  for (const wrong of [{ tenantId: 'tenant-other' }, { clientId: 'client-other' }, { targetAgentId: A },
    { targetAgentId: 'jyt-fixture-client-lujunyi' }]) {
    const f = fixture({ ack, prof: profile({ agentId: LEGACY }), fetchFn: async () => assert.fail('no HTTP') })
    const previous = f.registration.runtimeCredential()
    const result = await f.execute({ ...reassignedCommand(), targetAgentId: LEGACY, ...wrong }, async () => assert.fail('no execution'))
    assert.equal(result.failureCode, 'TASK_CONTEXT_PACK_SCOPE_MISMATCH')
    assert.equal(previous.signal.aborted, true)
    assert.equal(f.registration.runtimeCredential(), null)
  }
  const f = fixture({ ack, prof: profile({ agentId: LEGACY }), fetchFn: async () => assert.fail('no HTTP') })
  const previous = f.registration.runtimeCredential()
  f.registration.disconnect()
  assert.equal(previous.signal.aborted, true)
  const result = await f.execute({ ...reassignedCommand(), targetAgentId: LEGACY }, async () => assert.fail('no execution'))
  assert.equal(result.failureCode, 'TASK_CONTEXT_PACK_AUTH_UNAVAILABLE')
})

test('legacy E05 rejects a lease reply for another Agent and server revocation without accepting a terminal result', async () => {
  for (const revoked of [true, false]) {
    let calls = 0
    const ack = receipt({ agentId: LEGACY, runtimeAuth: { ...receipt().runtimeAuth, agentId: LEGACY, contextPackEnabled: false } })
    const f = fixture({ ack, prof: profile({ agentId: LEGACY }), fetchFn: async url => {
      calls++
      return revoked ? new Response('denied', { status: 401 }) : response(url, leaseBody(5))
    } })
    const result = await f.execute({ ...reassignedCommand(), targetAgentId: LEGACY }, async () => assert.fail('no execution'))
    assert.equal(result.status, 'recovery_required')
    assert.equal(calls, 1)
    if (revoked) assert.equal(f.registration.runtimeCredential(), null)
    f.registration.disconnect()
  }
})


test('legacy F01/E05 execution durably records terminal ACK and replays after reconnect without duplicate execution', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-native-legacy-ack-'))
  const prof = profile({ agentId: LEGACY })
  const storage = resolve(root, Buffer.from(LEGACY).toString('hex'))
  const ack = receipt({ agentId: LEGACY, runtimeAuth: { ...receipt().runtimeAuth, agentId: LEGACY } })
  let calls = 0, executions = 0
  const f = fixture({ ack, prof, fetchFn: async (url, options) => {
    calls++
    assert.equal(options.headers['X-Agent-Id'], LEGACY)
    if (url.pathname.endsWith('context-pack')) return response(url, pack({ actorAgentId: LEGACY }))
    const version = url.pathname.endsWith('/start') ? 6 : url.pathname.endsWith('/heartbeat') ? 7 : 5
    return response(url, { ...leaseBody(version), agentId: LEGACY })
  } })
  const processors = []
  t.after(() => { processors.forEach(p => p.stop()); f.registration.disconnect(); rmSync(root, { recursive: true, force: true }) })
  const ledger = new DurableDedupeLedger({ rootDir: storage, profile: prof })
  const outbox = new AckOutbox({ rootDir: storage, profile: prof })
  ledger.initialize(); outbox.initialize()
  const processor = new AgentMessageProcessor({ profile: prof,
    inbox: new PersistentCommandInbox({ rootDir: root, profile: prof }), ledger, ackOutbox: outbox,
    validateCommand: message => f.workItemLease.preflight(message), runChat: async () => assert.fail('no chat'),
    runCommand: message => f.execute(message, async () => { executions++; return { status: 'completed', exitCode: 0 } }),
    sendFn: envelope => envelope.ackStatus !== ACK_STATUS.SUCCEEDED })
  processors.push(processor); processor.start()
  const message = { ...reassignedCommand(), targetAgentId: LEGACY }
  await processor.handle(message)
  await processor.waitForIdle()
  assert.equal(ledger.getEntry(COMMAND).status, ACK_STATUS.SUCCEEDED)
  assert.equal(executions, 1); assert.equal(calls, 4)
  processor.stop()
  // A fresh file-backed reader, not the in-memory entry, proves terminal persistence.
  const reopened = new DurableDedupeLedger({ rootDir: storage, profile: prof })
  const replayOutbox = new AckOutbox({ rootDir: storage, profile: prof })
  reopened.initialize(); replayOutbox.initialize()
  assert.equal(reopened.getEntry(COMMAND).status, ACK_STATUS.SUCCEEDED)
  const replayed = []
  const resumed = new AgentMessageProcessor({ profile: prof,
    inbox: new PersistentCommandInbox({ rootDir: root, profile: prof }), ledger: reopened, ackOutbox: replayOutbox,
    validateCommand: message => f.workItemLease.preflight(message), runChat: async () => assert.fail('no chat'),
    runCommand: async () => assert.fail('a persisted completed command must not run again'),
    sendFn: envelope => { replayed.push(envelope); return true } })
  processors.push(resumed); resumed.start()
  resumed.replayAcks()
  await resumed.handle(message)
  await resumed.waitForIdle()
  const terminal = replayed.filter(item => item.commandId === COMMAND && item.ackStatus === ACK_STATUS.SUCCEEDED)
  assert.ok(terminal.length >= 1)
  assert.equal(executions, 1); assert.equal(calls, 4)
  assert.doesNotMatch(JSON.stringify(terminal), new RegExp(TOKEN + '|must-never-be-http-bearer'))
})
