import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createConnection } from 'node:net'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ManagedHost, managedRegistration, preserveManagedProfiles, initializeHostingEngine,
  validateHostingRequest, startManagedHostSocket, MAX_HOST_FRAME } from '../managed-host.mjs'

const AGENT = 'agt_0123456789abcdef0123456789abcdef'
const GENERATION = 'hri_00000000-0000-0000-0000-000000000001'
const RUNTIME = '00000000-0000-0000-0000-000000000009'
const request = (overrides = {}) => ({ protocol: '1', method: 'ensure', tenantId: 'Tenant-A', clientId: 'Client-A',
  ownerJiacn: 'Tenant-A', agentId: AGENT, intentId: GENERATION,
  leaseId: 'hrl_00000000-0000-0000-0000-000000000002', bindingId: '17', reservedAt: '1800000000000',
  operationId: GENERATION, requestedAt: '1800000000000', validUntil: null, apiKey: 'fixture-only-key', ...overrides })
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mh-test-')); chmodSync(dir, 0o700)
  const root = resolve(dir, 'root'); const seed = resolve(dir, 'seed'); mkdirSync(root, { mode: 0o700 }); mkdirSync(seed, { mode: 0o700 })
  for (const name of ['config.toml', 'auth.json']) writeFileSync(resolve(seed, name), 'fixture only', { mode: 0o600 })
  const executable = resolve(dir, 'fake-codex'); writeFileSync(executable, 'fixture executable, NEVER spawned', { mode: 0o700 })
  let registered = false; let engineCalls = 0; let attached = 0; let now = 1800000001000
  const engine = { ready: true, closed: false, threadId: 'thread-fixture', close() { this.ready = false; this.closed = true } }
  const host = new ManagedHost({ root, templateHome: seed, codexBin: executable, runtimeInstanceId: RUNTIME,
    tenantId: 'Tenant-A', clientId: 'Client-A', ownerJiacn: 'Tenant-A', workspacePolicyId: 'fixture-policy',
    attachProfile: async profile => { attached++; assert.equal(profile.codexHome, resolve(root, AGENT, GENERATION, 'home')); assert.equal(profile.workspacePolicyId, 'fixture-policy') },
    profileState: () => ({ registered, generation: GENERATION, runtimeInstanceId: RUNTIME }), conflicts: () => false,
    initializeEngine: async () => { engineCalls++; return engine }, now: () => now, ...overrides })
  t.after(() => { host.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, root, seed, host, engine, calls: () => engineCalls, attached: () => attached,
    register: () => { registered = true }, clock: value => { now = value } }
}

test('actual engine and exact registration are both necessary; durable ready replay and free operation are distinct', async t => {
  const f = fixture(t)
  assert.equal((await f.host.handle(request())).outcome, 'UNKNOWN')
  assert.equal(f.calls(), 1)
  f.register()
  const success = await f.host.handle(request())
  assert.equal(success.outcome, 'SERVICE_READY'); assert.equal(success.engineThreadId, 'thread-fixture')
  assert.equal(success.profileRef, `${AGENT}/${GENERATION}`)
  assert.deepEqual(await f.host.handle(request()), success)
  assert.equal(f.calls(), 1)
  const free = request({ operationId: 'hrr-00000000-0000-0000-0000-000000000003', requestedAt: '1800000001000', validUntil: '1802592000000' })
  const reprovision = await f.host.handle(free)
  assert.equal(reprovision.outcome, 'SERVICE_READY'); assert.equal(reprovision.operationId, free.operationId)
  assert.equal(f.calls(), 1); assert.notEqual(reprovision.evidenceRef, success.evidenceRef)
  assert.deepEqual(await f.host.handle(request()), success) // paid-order receipt never changes
  assert.equal(readFileSync(resolve(f.root, AGENT, GENERATION, 'association.json'), 'utf8').includes('fixture-only-key'), false)
})

test('trusted registration is current Agent/process and server acknowledgement, not online status', () => {
  const profile = { agentId: AGENT }
  const frame = { type: 'agent_registered', agentId: AGENT, runtimeInstanceId: RUNTIME, status: 'online', token: 'fixture-token' }
  assert.equal(managedRegistration(frame, profile, RUNTIME), true)
  for (const changed of [{ type: 'agent_status' }, { agentId: 'other' }, { runtimeInstanceId: 'old' }, { token: null }, { status: 'offline' }]) {
    assert.equal(managedRegistration({ ...frame, ...changed }, profile, RUNTIME), false)
  }
})

test('preflight confirmed no-effect is durable, but any failure after STARTED stays unknown across retry', async t => {
  const f = fixture(t)
  rmSync(resolve(f.seed, 'auth.json'))
  const failed = await f.host.handle(request())
  assert.equal(failed.outcome, 'FAILED_NO_EFFECT'); assert.equal(f.calls(), 0); assert.equal(f.attached(), 0)
  writeFileSync(resolve(f.seed, 'auth.json'), 'restored fixture', { mode: 0o600 })
  assert.deepEqual(await f.host.handle(request()), failed)
  const g = fixture(t, { initializeEngine: async () => { throw new Error('uncertain engine outcome') } })
  assert.equal((await g.host.handle(request())).outcome, 'UNKNOWN')
  rmSync(resolve(g.seed, 'auth.json'))
  assert.equal((await g.host.handle(request())).outcome, 'UNKNOWN')
  assert.equal(JSON.parse(readFileSync(resolve(g.root, AGENT, GENERATION, `${GENERATION}.json`))).state, 'STARTED')
})

test('unknown engine termination, concurrent ensure and mismatched durable association never create duplicate generations', async t => {
  let finish
  let calls = 0
  const engine = { ready: false, closed: false, close() {} }
  const f = fixture(t, { initializeEngine: () => { calls++; return new Promise((resolveInit, reject) => { finish = () => reject(Object.assign(new Error('timeout'), { engine })) }) } })
  const pending = f.host.handle(request())
  assert.equal((await f.host.handle(request())).outcome, 'UNKNOWN')
  finish(); await pending
  assert.equal((await f.host.handle(request())).outcome, 'UNKNOWN'); assert.equal(calls, 1)
  assert.equal((await f.host.handle(request({ bindingId: '18' }))).outcome, 'UNKNOWN')
  assert.equal((await f.host.handle(request({ apiKey: 'different-key' }))).outcome, 'UNKNOWN')
  assert.equal((await f.host.handle(request({ tenantId: 'Tenant-B' }))).outcome, 'UNKNOWN')
})

test('restart observes immutable proof; expired free request and symlink roots cannot start a new engine', async t => {
  const f = fixture(t); f.register()
  const success = await f.host.handle(request())
  f.host.engines.clear() // New runner memory does not replace durable operation truth.
  assert.deepEqual(await f.host.handle(request({ method: 'observe' })), success)
  assert.deepEqual(await f.host.handle(request()), success)
  const free = request({ operationId: 'hrr-00000000-0000-0000-0000-000000000004', requestedAt: '1800000000100', validUntil: '1800000000900' })
  assert.equal((await f.host.handle(free)).outcome, 'UNKNOWN'); assert.equal(f.calls(), 1)
  const g = fixture(t)
  const other = resolve(g.dir, 'other'); mkdirSync(other, { mode: 0o700 }); symlinkSync(other, resolve(g.root, AGENT))
  assert.equal((await g.host.handle(request())).outcome, 'UNKNOWN'); assert.equal(g.calls(), 0)
})

test('unassociated existing generation data is not adopted or overwritten', async t => {
  const f = fixture(t)
  const generation = resolve(f.root, AGENT, GENERATION)
  mkdirSync(generation, { recursive: true, mode: 0o700 })
  const data = resolve(generation, 'unrelated.txt'); writeFileSync(data, 'preserve me', { mode: 0o600 })
  assert.equal((await f.host.handle(request())).outcome, 'UNKNOWN')
  assert.equal(readFileSync(data, 'utf8'), 'preserve me'); assert.equal(f.calls(), 0)
})

test('legacy reload preserves managed state without accepting collisions or profile home overlap', () => {
  const managed = { agentId: AGENT, managedGeneration: GENERATION, codexHome: '/private/agent/home' }
  const legacy = { agentId: 'legacy', codexHome: '/legacy/home' }
  assert.deepEqual(preserveManagedProfiles([managed], [legacy]), [legacy, managed])
  assert.throws(() => preserveManagedProfiles([managed], [{ ...legacy, agentId: AGENT }]))
  assert.throws(() => preserveManagedProfiles([managed], [{ ...legacy, codexHome: '/private/agent' }]))
})

test('private socket serves bounded ensure/observe frames and closes oversize requests (no extra service)', async t => {
  const f = fixture(t); f.register()
  const socketPath = resolve(f.dir, 'host.sock')
  const channel = await startManagedHostSocket({ socketPath, host: f.host, timeoutMs: 1000 })
  t.after(() => channel.close())
  const exchange = frame => new Promise((resolveResult, reject) => {
    const socket = createConnection(socketPath); let data = ''
    socket.setTimeout(2000, () => socket.destroy(new Error('fixture deadline')))
    socket.on('error', reject); socket.on('connect', () => socket.write(frame))
    socket.on('data', chunk => { data += chunk }); socket.on('close', () => resolveResult(data))
  })
  const reply = JSON.parse(await exchange(`${JSON.stringify(request())}\n`))
  assert.equal(reply.outcome, 'SERVICE_READY')
  assert.equal(await exchange('x'.repeat(MAX_HOST_FRAME + 1)), '')
})

test('strict wire rejects body identity/path extras and non-string epochs', () => {
  assert.throws(() => validateHostingRequest(request({ reservedAt: 1800000000000 })))
  assert.throws(() => validateHostingRequest(request({ codexHome: '/other' })))
  assert.throws(() => validateHostingRequest(request({ agentId: '../../other' })))
  assert.throws(() => validateHostingRequest(request({ validUntil: '0' })))
})

test('real engine initialization protocol requires account and thread success, never sends a model turn', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
  const sent = []
  child.stdin.on('data', buffer => {
    for (const line of buffer.toString().trim().split('\n')) {
      const message = JSON.parse(line); sent.push(message)
      const result = message.id === 1 ? { userAgent: 'fixture' } : message.id === 2 ? { account: { type: 'apiKey' } } : { thread: { id: 'thread-fixture' } }
      if (message.id) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`))
    }
  })
  const profile = { codexBin: '/fixture/codex', codexHome: '/fixture/home', codexWorkdir: '/fixture/work' }
  const engine = await initializeHostingEngine(profile, { spawnFn: (bin, args, options) => {
    assert.equal(bin, profile.codexBin); assert.deepEqual(args, ['app-server']); assert.equal(options.shell, false)
    assert.equal(options.env.CODEX_HOME, profile.codexHome); assert.equal(options.cwd, profile.codexWorkdir); return child
  } })
  assert.equal(engine.ready, true)
  assert.deepEqual(sent.map(message => message.method), ['initialize', 'initialized', 'account/read', 'thread/start'])
  child.emit('exit', 0); assert.equal(engine.ready, false)
})
