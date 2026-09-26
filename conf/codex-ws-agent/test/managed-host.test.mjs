import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createConnection } from 'node:net'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ManagedHost, managedRegistration, preserveManagedProfiles, initializeHostingEngine,
  validateHostingRequest, startManagedHostSocket, MAX_HOST_FRAME } from '../managed-host.mjs'

const AGENT = 'agt_0123456789abcdef0123456789abcdef'
const AGENT_B = 'agt_11111111111111111111111111111111'
const GENERATION = 'hri_00000000-0000-0000-0000-000000000001'
const GENERATION_B = 'hri_00000000-0000-0000-0000-000000000011'
const RUNTIME = '00000000-0000-0000-0000-000000000009'
const request = (overrides = {}) => ({ protocol: '1', method: 'ensure', tenantId: 'Tenant-A', clientId: 'Client-A',
  ownerJiacn: 'Tenant-A', agentId: AGENT, intentId: GENERATION,
  leaseId: 'hrl_00000000-0000-0000-0000-000000000002', bindingId: '17', reservedAt: '1800000000000',
  operationId: GENERATION, requestedAt: '1800000000000', validUntil: null, apiKey: 'fixture-only-key', ...overrides })
const requestB = (overrides = {}) => request({ ownerJiacn: 'Owner-B', agentId: AGENT_B, intentId: GENERATION_B,
  leaseId: 'hrl_00000000-0000-0000-0000-000000000012', bindingId: '18', operationId: GENERATION_B,
  apiKey: 'fixture-owner-b-key', ...overrides })

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mh-test-')); chmodSync(dir, 0o700)
  const root = resolve(dir, 'root'); const seed = resolve(dir, 'seed'); mkdirSync(root, { mode: 0o700 }); mkdirSync(seed, { mode: 0o700 })
  for (const name of ['config.toml', 'auth.json']) writeFileSync(resolve(seed, name), 'fixture only', { mode: 0o600 })
  const executable = resolve(dir, 'fake-codex'); writeFileSync(executable, 'fixture executable, NEVER spawned', { mode: 0o700 })
  const registered = new Set(); const profiles = new Map(); const engines = []
  let engineCalls = 0; let attached = 0; let now = 1800000001000
  const scopeKey = (owner, agent) => `${owner}\0${agent}`
  const defaultInitialize = async profile => {
    engineCalls++
    const engine = { ready: true, closed: false, threadId: `thread-fixture-${engineCalls}`,
      close() { this.ready = false; this.closed = true } }
    engines.push(engine)
    return engine
  }
  const host = new ManagedHost({ root, templateHome: seed, codexBin: executable, runtimeInstanceId: RUNTIME,
    tenantId: 'Tenant-A', clientId: 'Client-A', ownerJiacn: 'Tenant-A', workspacePolicyId: 'fixture-policy',
    attachProfile: async profile => { attached++; profiles.set(profile.agentId, profile); assert.equal(profile.workspacePolicyId, 'fixture-policy') },
    profileState: (owner, agent) => {
      const profile = profiles.get(agent)
      return profile ? { registered: registered.has(scopeKey(owner, agent)), ownerJiacn: profile.managedOwnerJiacn,
        generation: profile.managedGeneration, runtimeInstanceId: RUNTIME } : null
    },
    conflicts: (owner, agent, generation) => {
      const profile = profiles.get(agent)
      return Boolean(profile && (profile.managedOwnerJiacn !== owner || profile.managedGeneration !== generation))
    },
    initializeEngine: defaultInitialize, now: () => now, ...overrides })
  t.after(() => { host.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, root, seed, host, profiles, engines, calls: () => engineCalls, attached: () => attached,
    register: (owner = 'Tenant-A', agent = AGENT) => registered.add(scopeKey(owner, agent)),
    disconnect: (owner = 'Tenant-A', agent = AGENT) => registered.delete(scopeKey(owner, agent)),
    clock: value => { now = value } }
}

test('actual engine and exact authenticated registration are both necessary before SERVICE_READY', async t => {
  const f = fixture(t)
  assert.equal((await f.host.handle(request())).outcome, 'UNKNOWN')
  assert.equal(f.calls(), 1)
  f.register()
  const success = await f.host.handle(request())
  assert.equal(success.outcome, 'SERVICE_READY'); assert.equal(success.engineThreadId, 'thread-fixture-1')
  assert.equal(success.profileRef, `${AGENT}/${GENERATION}`)
  assert.deepEqual(await f.host.handle(request()), success)
  assert.equal(f.calls(), 1)
  const free = request({ operationId: 'hrr-00000000-0000-0000-0000-000000000003', requestedAt: '1800000001000', validUntil: '1802592000000' })
  const reprovision = await f.host.handle(free)
  assert.equal(reprovision.outcome, 'SERVICE_READY'); assert.equal(reprovision.operationId, free.operationId)
  assert.equal(f.calls(), 1); assert.notEqual(reprovision.evidenceRef, success.evidenceRef)
  assert.deepEqual(await f.host.handle(request()), success)
  assert.equal(readFileSync(resolve(f.root, AGENT, GENERATION, 'association.json'), 'utf8').includes('fixture-only-key'), false)
  const credential = resolve(f.root, AGENT, GENERATION, 'credential.json')
  assert.equal(lstatSync(credential).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(credential, 'utf8')).apiKey, 'fixture-only-key')
})

test('restart restores an exact managed profile and engine from a private durable credential', async t => {
  const f = fixture(t)
  await f.host.handle(request())
  f.register()
  assert.equal((await f.host.handle(request())).outcome, 'SERVICE_READY')
  f.host.close()

  const profiles = new Map(); let engineCalls = 0
  const restarted = new ManagedHost({ root: f.root, templateHome: f.seed,
    codexBin: resolve(f.dir, 'fake-codex'), runtimeInstanceId: '00000000-0000-0000-0000-000000000010',
    tenantId: 'Tenant-A', clientId: 'Client-A', ownerJiacn: 'Tenant-A', workspacePolicyId: 'fixture-policy',
    conflicts: () => false, profileState: () => null,
    initializeEngine: async profile => {
      engineCalls++
      assert.equal(profile.apiKey, 'fixture-only-key')
      return { ready: true, closed: false, threadId: 'thread-restored', close() { this.ready = false; this.closed = true } }
    },
    attachProfile: async (profile, engine) => {
      assert.equal(engine.ready, true)
      profiles.set(profile.agentId, profile)
    }
  })
  t.after(() => restarted.close())
  assert.deepEqual(await restarted.restore(), { restored: 1, skipped: 0 })
  assert.equal(engineCalls, 1)
  assert.equal(profiles.get(AGENT).managedGeneration, GENERATION)
  assert.equal(profiles.get(AGENT).codexHome, resolve(f.root, AGENT, GENERATION, 'home'))
})

test('wildcard restart restores each owner-scoped managed profile independently', async t => {
  const f = fixture(t, { ownerJiacn: '*' })
  const a = request({ ownerJiacn: 'Owner-A' }); const b = requestB()
  await f.host.handle(a); await f.host.handle(b)
  f.register('Owner-A', AGENT); f.register('Owner-B', AGENT_B)
  assert.equal((await f.host.handle(a)).outcome, 'SERVICE_READY')
  assert.equal((await f.host.handle(b)).outcome, 'SERVICE_READY')
  f.host.close()

  const restoredProfiles = new Map()
  const restarted = new ManagedHost({ root: f.root, templateHome: f.seed,
    codexBin: resolve(f.dir, 'fake-codex'), runtimeInstanceId: '00000000-0000-0000-0000-000000000010',
    tenantId: 'Tenant-A', clientId: 'Client-A', ownerJiacn: '*', workspacePolicyId: 'fixture-policy',
    conflicts: () => false, profileState: () => null,
    initializeEngine: async profile => ({ ready: true, closed: false, threadId: `thread-${profile.agentId}`,
      close() { this.ready = false; this.closed = true } }),
    attachProfile: async profile => restoredProfiles.set(profile.agentId, profile)
  })
  t.after(() => restarted.close())
  assert.deepEqual(await restarted.restore(), { restored: 2, skipped: 0 })
  assert.equal(restoredProfiles.get(AGENT).managedOwnerJiacn, 'Owner-A')
  assert.equal(restoredProfiles.get(AGENT_B).managedOwnerJiacn, 'Owner-B')
  assert.notEqual(restoredProfiles.get(AGENT).codexHome, restoredProfiles.get(AGENT_B).codexHome)
})

test('restart fails closed when the durable recovery credential is changed', async t => {
  const f = fixture(t)
  await f.host.handle(request())
  const credential = resolve(f.root, AGENT, GENERATION, 'credential.json')
  const stored = JSON.parse(readFileSync(credential, 'utf8'))
  writeFileSync(credential, JSON.stringify({ ...stored, apiKey: 'changed-key' }), { mode: 0o600 })
  const restarted = new ManagedHost({ root: f.root, templateHome: f.seed,
    codexBin: resolve(f.dir, 'fake-codex'), runtimeInstanceId: '00000000-0000-0000-0000-000000000010',
    tenantId: 'Tenant-A', clientId: 'Client-A', ownerJiacn: 'Tenant-A', workspacePolicyId: 'fixture-policy',
    conflicts: () => false, profileState: () => null,
    initializeEngine: async () => { throw new Error('must not initialize') }, attachProfile: async () => {}
  })
  t.after(() => restarted.close())
  assert.deepEqual(await restarted.restore(), { restored: 0, skipped: 0 })
})

test('trusted registration is current authenticated Agent/process acknowledgement, not an online flag', () => {
  const profile = { agentId: AGENT, managedOwnerJiacn: 'Tenant-A', managedGeneration: GENERATION, apiKey: 'fixture-only-key' }
  const frame = { type: 'agent_registered', agentId: AGENT, runtimeInstanceId: RUNTIME, status: 'online', token: 'fixture-token' }
  assert.equal(managedRegistration(frame, profile, RUNTIME), true)
  for (const changed of [{ type: 'agent_status' }, { agentId: 'other' }, { runtimeInstanceId: 'old' }, { token: null }, { status: 'offline' }]) {
    assert.equal(managedRegistration({ ...frame, ...changed }, profile, RUNTIME), false)
  }
  assert.equal(managedRegistration(frame, { ...profile, apiKey: '' }, RUNTIME), false)
  assert.equal(managedRegistration(frame, { ...profile, managedOwnerJiacn: 'Owner/B' }, RUNTIME), false)
})

test('fixed owner remains exact while wildcard accepts exact owners under fixed tenant and client only', async t => {
  const fixed = fixture(t)
  assert.equal((await fixed.host.handle(request({ ownerJiacn: 'Owner-B' }))).outcome, 'UNKNOWN')
  assert.equal((await fixed.host.handle(request({ tenantId: 'Tenant-B' }))).outcome, 'UNKNOWN')
  assert.equal((await fixed.host.handle(request({ clientId: 'Client-B' }))).outcome, 'UNKNOWN')
  assert.equal(fixed.calls(), 0)

  const wildcard = fixture(t, { ownerJiacn: '*' })
  assert.equal((await wildcard.host.handle(request({ ownerJiacn: 'Owner-A' }))).outcome, 'UNKNOWN')
  wildcard.register('Owner-A', AGENT)
  assert.equal((await wildcard.host.handle(request({ ownerJiacn: 'Owner-A' }))).outcome, 'SERVICE_READY')
  assert.equal((await wildcard.host.handle(requestB())).outcome, 'UNKNOWN')
  wildcard.register('Owner-B', AGENT_B)
  assert.equal((await wildcard.host.handle(requestB())).outcome, 'SERVICE_READY')
  assert.equal((await wildcard.host.handle(requestB({ tenantId: 'Tenant-B' }))).outcome, 'UNKNOWN')
  assert.equal((await wildcard.host.handle(requestB({ clientId: 'Client-B' }))).outcome, 'UNKNOWN')
})

test('wildcard owner paths, profiles, homes, workspaces, credentials and engines are isolated', async t => {
  const f = fixture(t, { ownerJiacn: '*' })
  const a = request({ ownerJiacn: 'Owner-A' }); const b = requestB()
  await f.host.handle(a); await f.host.handle(b)
  const profileA = f.profiles.get(AGENT); const profileB = f.profiles.get(AGENT_B)
  assert.notEqual(profileA.profileId, profileB.profileId)
  assert.notEqual(profileA.managedScopeKey, profileB.managedScopeKey)
  assert.notEqual(profileA.codexHome, profileB.codexHome)
  assert.notEqual(profileA.codexWorkdir, profileB.codexWorkdir)
  assert.notEqual(f.host.paths(a).ownerRoot, f.host.paths(b).ownerRoot)
  assert.notEqual(f.host.paths(a).claim, f.host.paths(b).claim)
  assert.notEqual(f.engines[0], f.engines[1])
  assert.equal(readFileSync(f.host.paths(a).manifest, 'utf8').includes(a.apiKey), false)
  assert.equal(readFileSync(f.host.paths(b).manifest, 'utf8').includes(b.apiKey), false)
  writeFileSync(resolve(profileA.codexHome, 'config.toml'), 'owner-a-only', { mode: 0o600 })
  assert.equal(readFileSync(resolve(profileB.codexHome, 'config.toml'), 'utf8'), 'fixture only')
})

test('an Agent identity claimed by one owner cannot collide or be reused by another owner', async t => {
  const f = fixture(t, { ownerJiacn: '*' })
  const ownerA = request({ ownerJiacn: 'Owner-A' })
  await f.host.handle(ownerA)
  const calls = f.calls()
  const collision = request({ ownerJiacn: 'Owner-B', intentId: GENERATION_B, operationId: GENERATION_B,
    leaseId: 'hrl_00000000-0000-0000-0000-000000000012', apiKey: 'other-owner-key' })
  assert.equal((await f.host.handle(collision)).outcome, 'UNKNOWN')
  assert.equal(f.calls(), calls)
  assert.equal(lstatSync(f.host.paths(ownerA).claim).mode & 0o777, 0o600)
  assert.equal(lstatSync(f.host.paths(collision).ownerRoot, { throwIfNoEntry: false }), undefined)
})

test('empty, malformed and traversal-shaped owners are rejected before filesystem effects', () => {
  for (const ownerJiacn of ['', ' Owner-A', 'Owner-A ', '.', '..', '*', '../Owner-A', 'Owner/A', 'Owner\\A', '\ud800']) {
    assert.throws(() => validateHostingRequest(request({ ownerJiacn })), ownerJiacn)
  }
  assert.doesNotThrow(() => validateHostingRequest(request({ ownerJiacn: '租户-A@example.test' })))
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

test('durable historical SERVICE_READY is not replayed while the exact Agent is offline', async t => {
  const f = fixture(t); await f.host.handle(request()); f.register()
  const success = await f.host.handle(request())
  f.disconnect()
  assert.equal((await f.host.handle(request({ method: 'observe' }))).outcome, 'UNKNOWN')
  assert.equal((await f.host.handle(request())).outcome, 'UNKNOWN')
  f.register()
  assert.deepEqual(await f.host.handle(request()), success)
})

test('expired free request and symlink roots cannot start a new engine', async t => {
  const f = fixture(t); await f.host.handle(request()); f.register(); await f.host.handle(request())
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

test('legacy reload preserves managed state without accepting owner, Agent or profile-home collisions', () => {
  const managed = { agentId: AGENT, managedGeneration: GENERATION, managedOwnerJiacn: 'Tenant-A', codexHome: '/private/agent/home' }
  const legacy = { agentId: 'legacy', codexHome: '/legacy/home' }
  assert.deepEqual(preserveManagedProfiles([managed], [legacy]), [legacy, managed])
  assert.throws(() => preserveManagedProfiles([managed], [{ ...legacy, agentId: AGENT }]))
  assert.throws(() => preserveManagedProfiles([managed], [{ ...legacy, codexHome: '/private/agent' }]))
})

test('private socket stays 0660 and serves one bounded frame without becoming world writable', async t => {
  const f = fixture(t); await f.host.handle(request()); f.register()
  const socketPath = resolve(f.dir, 'host.sock')
  const channel = await startManagedHostSocket({ socketPath, host: f.host, timeoutMs: 1000 })
  t.after(() => channel.close())
  assert.equal(lstatSync(socketPath).mode & 0o777, 0o660)
  assert.equal(lstatSync(socketPath).uid, process.getuid())
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
