import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test, { afterEach } from 'node:test'
import { ACK_STATUS, AckOutbox, buildAckEnvelope } from '../agent-client.mjs'
import { canonicalSha256 } from '../chat-runtime.mjs'
import { migrateAckHighWater } from '../migrate-ack-high-water.mjs'

const profile = { profileId: 'checkpoint-profile', agentId: 'checkpoint-agent' }
const dirs = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }) })
function fixture(initialize = true) {
  const directory = mkdtempSync(resolve(tmpdir(), 'ack-checkpoint-'))
  dirs.push(directory)
  const rootDir = resolve(directory, 'profile')
  const outbox = new AckOutbox({ rootDir, profile })
  if (initialize) outbox.initialize()
  return { directory, rootDir, outbox, backupPath: resolve(directory, 'backup.jsonl.gz') }
}
const enqueue = (outbox, status = ACK_STATUS.RECEIVED, id = 'command') =>
  outbox.enqueue(buildAckEnvelope(profile, status, { commandId: id }), { kind: 'none' })
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
const seal = value => { const { digest, ...payload } = value; return { ...payload, digest: canonicalSha256(payload) } }
const failIO = () => { const error = new Error('injected I/O failure'); error.code = 'EIO'; throw error }
function legacyFixture(count = 6, pending = false) {
  const f = fixture(false)
  for (const directory of [f.outbox.acksDir, f.outbox.quarantineDir, f.outbox.highWaterDir]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  write(f.outbox.highWaterInitializedPath, { formatVersion: 1, agentId: profile.agentId, initializedAt: 1 })
  write(f.outbox.sequencePath, { formatVersion: 1, lastSequence: count })
  for (let sequence = 1; sequence <= count; sequence++) {
    write(resolve(f.outbox.highWaterDir, `${String(sequence).padStart(20, '0')}.json`),
      { formatVersion: 1, agentId: profile.agentId, queueSequence: sequence, allocatedAt: sequence })
  }
  if (pending && count) write(resolve(f.outbox.acksDir, `${String(count).padStart(20, '0')}-pending.json`), {
    formatVersion: 1, queueSequence: count, envelope: buildAckEnvelope(profile, ACK_STATUS.STARTED, { commandId: 'legacy-pending' }),
    marker: { kind: 'none' }, createdAt: 1, attempts: 0
  })
  return f
}
function injectRename(outbox, target, when = 'before') {
  const original = outbox.fs.renameSync
  let fired = false
  outbox.fs.renameSync = (source, destination) => {
    const match = !fired && target(destination)
    if (match && when === 'before') { fired = true; failIO() }
    const result = original(source, destination)
    if (match) { fired = true; failIO() }
    return result
  }
  return () => { outbox.fs.renameSync = original; assert.equal(fired, true, 'fault selector must fire') }
}

test('high-water retention stays at two files as committed ACKs accumulate', t => {
  const { rootDir, outbox } = fixture()
  for (let i = 0; i < 128; i++) outbox.dequeue(enqueue(outbox, ACK_STATUS.RECEIVED, `bounded-${i}`).fileName)
  assert.deepEqual(readdirSync(outbox.highWaterDir).sort(), ['checkpoint.json', 'initialized.json'])
  assert.equal(read(outbox.sequencePath).lastSequence, 128)
  assert.equal(read(outbox.highWaterCheckpointPath).digest, read(outbox.sequencePath).digest)
  const evidenceStats = readdirSync(outbox.highWaterDir).map(name => statSync(resolve(outbox.highWaterDir, name)))
  t.diagnostic(JSON.stringify({ allocatedSequences: 128, highWaterFiles: evidenceStats.length,
    highWaterLogicalBytes: evidenceStats.reduce((sum, item) => sum + item.size, 0),
    highWaterAllocatedBytes: evidenceStats.reduce((sum, item) => sum + item.blocks * 512, 0),
    counterAllocatedBytes: statSync(outbox.sequencePath).blocks * 512 }))
  const restarted = new AckOutbox({ rootDir, profile }); assert.equal(restarted.initialize().corruptions, 0)
  assert.equal(enqueue(restarted).record.queueSequence, 129)
})

for (const phase of ['intent', 'checkpoint', 'ack', 'counter', 'cleanup']) {
  for (const when of ['before', 'after']) {
    test(`enqueue recovers exact certified transaction after ${when} ${phase}`, () => {
      const { rootDir, outbox } = fixture()
      const targets = { intent: outbox.highWaterIntentPath, checkpoint: outbox.highWaterCheckpointPath, counter: outbox.sequencePath }
      let restore
      if (phase === 'cleanup') {
        const original = outbox.fs.unlinkSync; let fired = false
        outbox.fs.unlinkSync = path => {
          if (path !== outbox.highWaterIntentPath || fired) return original(path)
          fired = true
          if (when === 'before') failIO()
          original(path); failIO()
        }
        restore = () => { outbox.fs.unlinkSync = original; assert.equal(fired, true) }
      } else restore = injectRename(outbox, path => phase === 'ack' ? dirname(path) === outbox.acksDir : path === targets[phase], when)
      assert.throws(() => enqueue(outbox), /injected I\/O/)
      restore()
      const restarted = new AckOutbox({ rootDir, profile })
      assert.equal(restarted.initialize().corruptions, 0)
      const pending = restarted.pendingEnvelopes()
      const unpublished = phase === 'intent' && when === 'before'
      assert.equal(pending.length, unpublished ? 0 : 1)
      if (!unpublished) {
        assert.equal(pending[0].record.queueSequence, 1)
        assert.equal(pending[0].envelope.ackStatus, ACK_STATUS.RECEIVED)
      }
      assert.equal(enqueue(restarted, ACK_STATUS.STARTED).record.queueSequence, unpublished ? 1 : 2)
      assert.equal(existsSync(restarted.highWaterIntentPath), false)
      assert.deepEqual(readdirSync(restarted.highWaterDir).sort(), ['checkpoint.json', 'initialized.json'])
    })
  }
}

for (const phase of ['intent', 'checkpoint', 'counter', 'initialized']) {
  for (const when of ['before', 'after']) {
    test(`bootstrap recovers ${when} ${phase} without resetting existing state`, () => {
      const { rootDir, outbox } = fixture(false)
      const target = { intent: outbox.highWaterIntentPath, checkpoint: outbox.highWaterCheckpointPath,
        counter: outbox.sequencePath, initialized: outbox.highWaterInitializedPath }[phase]
      const restore = injectRename(outbox, path => path === target, when)
      assert.throws(() => outbox.initialize(), /injected I\/O/); restore()
      const restarted = new AckOutbox({ rootDir, profile })
      assert.equal(restarted.initialize().corruptions, 0)
      assert.equal(enqueue(restarted).record.queueSequence, 1)
      assert.deepEqual(readdirSync(restarted.highWaterDir).sort(), ['checkpoint.json', 'initialized.json'])
    })
  }
}

for (const phase of ['intent', 'checkpoint', 'ack', 'counter']) {
  test(`file fsync failure during ${phase} does not lose a certified ACK`, () => {
    const { rootDir, outbox } = fixture()
    const descriptors = new Map()
    const open = outbox.fs.openSync, close = outbox.fs.closeSync, sync = outbox.fs.fsyncSync
    const target = { intent: outbox.highWaterIntentPath, checkpoint: outbox.highWaterCheckpointPath, counter: outbox.sequencePath }[phase]
    let fired = false
    outbox.fs.openSync = (path, ...args) => { const fd = open(path, ...args); descriptors.set(fd, path); return fd }
    outbox.fs.closeSync = fd => { descriptors.delete(fd); return close(fd) }
    outbox.fs.fsyncSync = fd => {
      const path = descriptors.get(fd)
      if (!fired && path && (phase === 'ack' ? dirname(path) === outbox.acksDir : path.startsWith(`${target}.tmp-`))) {
        fired = true; failIO()
      }
      return sync(fd)
    }
    assert.throws(() => enqueue(outbox), /injected I\/O/); assert.equal(fired, true)
    const restarted = new AckOutbox({ rootDir, profile }); assert.equal(restarted.initialize().corruptions, 0)
    assert.equal(restarted.pendingEnvelopes().length, phase === 'intent' ? 0 : 1)
  })
}

test('committed leftover and restored intents never resurrect an already dequeued ACK', () => {
  const { rootDir, outbox } = fixture()
  const unlink = outbox.fs.unlinkSync
  let captured
  outbox.fs.unlinkSync = path => {
    if (path === outbox.highWaterIntentPath) { captured = read(path); failIO() }
    return unlink(path)
  }
  assert.throws(() => enqueue(outbox), /injected I\/O/)
  outbox.fs.unlinkSync = unlink
  const restarted = new AckOutbox({ rootDir, profile }); restarted.initialize()
  const queued = restarted.pendingEnvelopes()[0]; restarted.dequeue(queued.fileName)
  write(restarted.highWaterIntentPath, captured)
  const again = new AckOutbox({ rootDir, profile }); assert.equal(again.initialize().corruptions, 0)
  assert.equal(again.pendingEnvelopes().length, 0)
  assert.equal(enqueue(again).record.queueSequence, 2)
})

for (const scenario of ['missing-checkpoint', 'checksum', 'identity', 'counter-rollback', 'checkpoint-rollback', 'epoch']) {
  test(`corrupt ${scenario} fails closed without a fallback checkpoint`, () => {
    const { rootDir, outbox } = fixture()
    const old = read(outbox.highWaterCheckpointPath)
    outbox.dequeue(enqueue(outbox).fileName)
    const latest = read(outbox.highWaterCheckpointPath)
    if (scenario === 'missing-checkpoint') rmSync(outbox.highWaterCheckpointPath)
    if (scenario === 'checksum') write(outbox.highWaterCheckpointPath, { ...latest, lastSequence: 5 })
    if (scenario === 'identity') write(outbox.highWaterCheckpointPath, seal({ ...latest, agentId: 'other-agent' }))
    if (scenario === 'counter-rollback') write(outbox.sequencePath, old)
    if (scenario === 'checkpoint-rollback') write(outbox.highWaterCheckpointPath, old)
    if (scenario === 'epoch') write(outbox.highWaterInitializedPath, seal({ ...read(outbox.highWaterInitializedPath), storageId: 'different-epoch' }))
    const restarted = new AckOutbox({ rootDir, profile })
    assert.ok(restarted.initialize().corruptions > 0)
    assert.throws(() => enqueue(restarted), error => error.code === 'ACK_OUTBOX_CORRUPT')
  })
}

test('initialized observer detects a coordinated local rollback within its lifetime', () => {
  const { outbox } = fixture()
  const old = read(outbox.highWaterCheckpointPath)
  outbox.dequeue(enqueue(outbox).fileName)
  write(outbox.highWaterCheckpointPath, old); write(outbox.sequencePath, old)
  assert.throws(() => outbox.pendingEnvelopes(), error => error.code === 'ACK_OUTBOX_SEQUENCE_CORRUPT')
})

test('corrupt journal payload is quarantined before ACK reconstruction', () => {
  const { rootDir, outbox } = fixture()
  const restore = injectRename(outbox, path => path === outbox.highWaterCheckpointPath)
  assert.throws(() => enqueue(outbox), /injected I\/O/); restore()
  const intent = read(outbox.highWaterIntentPath)
  intent.record.envelope.commandId = 'tampered'
  write(outbox.highWaterIntentPath, intent)
  const restarted = new AckOutbox({ rootDir, profile })
  assert.ok(restarted.initialize().corruptions > 0)
  assert.equal(readdirSync(outbox.acksDir).length, 0)
})

test('certified intent cannot overwrite a different pending payload', () => {
  const { rootDir, outbox } = fixture()
  const restore = injectRename(outbox, path => path === outbox.sequencePath)
  assert.throws(() => enqueue(outbox), /injected I\/O/); restore()
  const intent = read(outbox.highWaterIntentPath)
  const record = read(resolve(outbox.acksDir, intent.fileName)); record.envelope.commandId = 'different'
  write(resolve(outbox.acksDir, intent.fileName), record)
  const restarted = new AckOutbox({ rootDir, profile }); assert.ok(restarted.initialize().corruptions > 0)
  assert.equal(read(outbox.sequencePath).lastSequence, 0)
})

test('two initialized instances allocate FIFO after recovering a shared unfinished intent', () => {
  const { rootDir, outbox } = fixture()
  const observer = new AckOutbox({ rootDir, profile }); observer.initialize()
  const restore = injectRename(outbox, path => path === outbox.highWaterCheckpointPath)
  assert.throws(() => enqueue(outbox, ACK_STATUS.RECEIVED), /injected I\/O/); restore()
  assert.equal(enqueue(observer, ACK_STATUS.STARTED).record.queueSequence, 2)
  assert.equal(enqueue(outbox, ACK_STATUS.SUCCEEDED).record.queueSequence, 3)
  assert.deepEqual(outbox.pendingEnvelopes().map(x => x.envelope.ackStatus), [ACK_STATUS.RECEIVED, ACK_STATUS.STARTED, ACK_STATUS.SUCCEEDED])
})

test('independent child processes allocate unique FIFO sequences under the existing lock', async () => {
  const { rootDir, outbox } = fixture()
  const module = new URL('../agent-client.mjs', import.meta.url).href
  const script = `import {AckOutbox,buildAckEnvelope,ACK_STATUS} from ${JSON.stringify(module)};
    const profile=${JSON.stringify(profile)}; const outbox=new AckOutbox({rootDir:process.argv[1],profile,lockTimeoutMs:10000});
    outbox.initialize(); for(let i=0;i<8;i++)outbox.enqueue(buildAckEnvelope(profile,ACK_STATUS.RECEIVED,{commandId:process.argv[2]+'-'+i}),{kind:'none'});`
  const run = id => new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, rootDir, id], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(new Error(stderr)))
  })
  await Promise.all([run('a'), run('b')])
  assert.deepEqual(outbox.pendingEnvelopes().map(x => x.record.queueSequence), Array.from({ length: 16 }, (_, i) => i + 1))
})

test('a real abrupt child exit leaves the lock owned and requires explicit offline reconciliation', async () => {
  const { rootDir, outbox } = fixture()
  const module = new URL('../agent-client.mjs', import.meta.url).href
  const script = `import {AckOutbox,buildAckEnvelope,ACK_STATUS} from ${JSON.stringify(module)};
    const profile=${JSON.stringify(profile)}; const outbox=new AckOutbox({rootDir:process.argv[1],profile});outbox.initialize();
    const rename=outbox.fs.renameSync;outbox.fs.renameSync=(source,target)=>{const result=rename(source,target);if(target===outbox.highWaterCheckpointPath)process.exit(73);return result};
    outbox.enqueue(buildAckEnvelope(profile,ACK_STATUS.RECEIVED,{commandId:'crash'}),{kind:'none'});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, rootDir], { stdio: 'ignore' })
  const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', accept) })
  assert.equal(code, 73)
  const owner = read(outbox.lockOwnerPath); assert.equal(owner.pid, child.pid)
  const restarted = new AckOutbox({ rootDir, profile, lockTimeoutMs: 0 })
  assert.throws(() => restarted.initialize(), error => error.code === 'ACK_OUTBOX_LOCK_TIMEOUT')
  assert.equal(existsSync(outbox.lockPath), true)
  // Only this test's exited child owns this disposable fixture; never do this on live storage.
  rmSync(outbox.lockPath, { recursive: true })
  restarted.initialize(); assert.equal(restarted.pendingEnvelopes().length, 1)
})

test('legacy format requires explicit migration and runtime never deletes old evidence', () => {
  const { outbox } = legacyFixture()
  const before = readdirSync(outbox.highWaterDir)
  assert.throws(() => outbox.initialize(), error => error.code === 'ACK_OUTBOX_MIGRATION_REQUIRED')
  assert.deepEqual(readdirSync(outbox.highWaterDir), before)
  assert.equal(read(outbox.sequencePath).formatVersion, 1)
})

test('offline migration creates a compressed verified backup and preserves pending FIFO', async () => {
  const f = legacyFixture(32, true)
  const pendingBefore = readFileSync(resolve(f.outbox.acksDir, readdirSync(f.outbox.acksDir)[0]), 'utf8')
  const result = await migrateAckHighWater(f.outbox, { backupPath: f.backupPath })
  assert.equal(result.lastSequence, 32); assert.equal(result.legacyMarkers, 32)
  assert.equal(statSync(f.backupPath).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(f.outbox.highWaterDir).sort(), ['checkpoint.json', 'initialized.json'])
  assert.equal(readFileSync(resolve(f.outbox.acksDir, readdirSync(f.outbox.acksDir)[0]), 'utf8'), pendingBefore)
  const restarted = new AckOutbox({ rootDir: f.rootDir, profile }); restarted.initialize()
  assert.equal(enqueue(restarted).record.queueSequence, 33)
  assert.deepEqual(restarted.pendingEnvelopes().map(x => x.record.queueSequence), [32, 33])
  assert.equal((await migrateAckHighWater(restarted, { backupPath: f.backupPath })).alreadyMigrated, true)
})

for (const phase of ['backup-verified', 'checkpoint', 'counter', 'initialized', 'legacy-marker-removed']) {
  test(`offline migration resumes after interruption at ${phase}`, async () => {
    const f = legacyFixture(6, true)
    let fired = false
    await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: f.backupPath, onPhase: current => {
      if (!fired && current === phase) { fired = true; failIO() }
    } }), /injected I\/O/)
    assert.equal(fired, true); assert.equal(existsSync(f.backupPath), true)
    const runtime = new AckOutbox({ rootDir: f.rootDir, profile })
    assert.throws(() => runtime.initialize(), error => error.code === 'ACK_OUTBOX_MIGRATION_REQUIRED')
    const result = await migrateAckHighWater(runtime, { backupPath: f.backupPath })
    assert.equal(result.lastSequence, 6)
    assert.deepEqual(readdirSync(runtime.highWaterDir).sort(), ['checkpoint.json', 'initialized.json'])
    runtime.initialize(); assert.equal(enqueue(runtime).record.queueSequence, 7)
  })
}

test('migration refuses rollback, unknown identity and future pending records before deleting evidence', async () => {
  for (const kind of ['rollback', 'identity', 'pending']) {
    const f = legacyFixture(4, true)
    if (kind === 'rollback') write(f.outbox.sequencePath, { formatVersion: 1, lastSequence: 2 })
    if (kind === 'identity') {
      const path = resolve(f.outbox.highWaterDir, '00000000000000000003.json')
      write(path, { ...read(path), agentId: 'other' })
    }
    if (kind === 'pending') {
      const file = readdirSync(f.outbox.acksDir)[0]
      const record = read(resolve(f.outbox.acksDir, file)); record.queueSequence = 8
      write(resolve(f.outbox.acksDir, file), record)
    }
    await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: f.backupPath }))
    assert.equal(readdirSync(f.outbox.highWaterDir).filter(name => /^\d{20}\.json$/.test(name)).length, 4)
    assert.equal(existsSync(f.outbox.highWaterCheckpointPath), false)
  }
})

test('migration resumes an already published matching backup before its intent was written', async () => {
  const f = legacyFixture()
  const original = f.outbox._writeIntent
  f.outbox._writeIntent = () => failIO()
  await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: f.backupPath }), /injected I\/O/)
  assert.equal(existsSync(f.backupPath), true)
  f.outbox._writeIntent = original
  const result = await migrateAckHighWater(f.outbox, { backupPath: f.backupPath })
  assert.equal(result.lastSequence, 6)
})

test('migration rejects a corrupt compressed backup without deleting remaining source', async () => {
  const f = legacyFixture()
  await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: f.backupPath, onPhase: phase => { if (phase === 'checkpoint') failIO() } }))
  writeFileSync(f.backupPath, 'not gzip', { mode: 0o600 })
  await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: f.backupPath }))
  assert.equal(readdirSync(f.outbox.highWaterDir).filter(name => /^\d{20}\.json$/.test(name)).length, 6)
})

test('migration backup must be outside the profile root', async () => {
  const f = legacyFixture()
  await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: resolve(f.rootDir, 'bad-backup.gz') }), /outside/)
  assert.equal(read(f.outbox.sequencePath).formatVersion, 1)
})

for (const directorySyncPhase of ['intent', 'checkpoint', 'ack', 'counter']) {
  test(`directory fsync failure after ${directorySyncPhase} publication has a recoverable prefix`, () => {
    const { rootDir, outbox } = fixture()
    const rename = outbox.fs.renameSync, open = outbox.fs.openSync, close = outbox.fs.closeSync, sync = outbox.fs.fsyncSync
    const descriptors = new Map()
    const target = { intent: outbox.highWaterIntentPath, checkpoint: outbox.highWaterCheckpointPath, counter: outbox.sequencePath }[directorySyncPhase]
    let armed = false, fired = false
    outbox.fs.renameSync = (source, destination) => {
      const result = rename(source, destination)
      if (directorySyncPhase === 'ack' ? dirname(destination) === outbox.acksDir : destination === target) armed = true
      return result
    }
    outbox.fs.openSync = (path, ...args) => { const fd = open(path, ...args); descriptors.set(fd, path); return fd }
    outbox.fs.closeSync = fd => { descriptors.delete(fd); return close(fd) }
    outbox.fs.fsyncSync = fd => {
      const path = descriptors.get(fd)
      const directory = directorySyncPhase === 'ack' ? outbox.acksDir : dirname(target)
      if (armed && !fired && path === directory) { fired = true; failIO() }
      return sync(fd)
    }
    assert.throws(() => enqueue(outbox), /injected I\/O/); assert.equal(fired, true)
    const restarted = new AckOutbox({ rootDir, profile }); assert.equal(restarted.initialize().corruptions, 0)
    assert.equal(restarted.pendingEnvelopes().length, 1)
    assert.equal(enqueue(restarted).record.queueSequence, 2)
  })
}

test('unknown high-water evidence cannot bootstrap or disappear during migration', async () => {
  const fresh = fixture(false)
  mkdirSync(fresh.outbox.highWaterDir, { recursive: true })
  write(resolve(fresh.outbox.highWaterDir, 'unknown.json'), { unexpected: true })
  assert.ok(fresh.outbox.initialize().corruptions > 0)
  assert.equal(existsSync(fresh.outbox.highWaterCheckpointPath), false)
  const old = legacyFixture()
  write(resolve(old.outbox.highWaterDir, 'unknown.json'), { unexpected: true })
  await assert.rejects(migrateAckHighWater(old.outbox, { backupPath: old.backupPath }), /Unexpected legacy/)
  assert.equal(existsSync(old.backupPath), false)
})

test('empty and sparse legacy evidence migrate without changing the maximum', async () => {
  for (const count of [0, 9]) {
    const f = legacyFixture(count)
    if (count) for (let n = 1; n < count; n++) rmSync(resolve(f.outbox.highWaterDir, `${String(n).padStart(20, '0')}.json`))
    const result = await migrateAckHighWater(f.outbox, { backupPath: f.backupPath })
    assert.equal(result.lastSequence, count)
    f.outbox.initialize(); assert.equal(enqueue(f.outbox).record.queueSequence, count + 1)
  }
})

test('durable quarantine blocks recovery of a valid unfinished intent', () => {
  const { rootDir, outbox } = fixture()
  const restore = injectRename(outbox, path => path === outbox.highWaterCheckpointPath)
  assert.throws(() => enqueue(outbox), /injected I\/O/); restore()
  write(resolve(outbox.quarantineDir, 'other-instance.json'), { reason: 'needs reconciliation' })
  const restarted = new AckOutbox({ rootDir, profile }); assert.equal(restarted.initialize().corruptions, 1)
  assert.equal(read(outbox.sequencePath).lastSequence, 0)
  assert.equal(read(outbox.highWaterCheckpointPath).lastSequence, 0)
  assert.equal(readdirSync(outbox.acksDir).length, 0)
  assert.equal(existsSync(outbox.highWaterIntentPath), true)
})

test('old committed intent conflicts with a newer high-water instead of replaying its ACK', () => {
  const { rootDir, outbox } = fixture()
  const unlink = outbox.fs.unlinkSync
  let captured
  outbox.fs.unlinkSync = path => { if (path === outbox.highWaterIntentPath) { captured = read(path); failIO() }; return unlink(path) }
  assert.throws(() => enqueue(outbox), /injected I\/O/); outbox.fs.unlinkSync = unlink
  outbox.pendingEnvelopes().forEach(item => outbox.dequeue(item.fileName))
  outbox.dequeue(enqueue(outbox).fileName)
  write(outbox.highWaterIntentPath, captured)
  const restarted = new AckOutbox({ rootDir, profile }); assert.ok(restarted.initialize().corruptions > 0)
  assert.equal(readdirSync(outbox.acksDir).length, 0)
})

test('migration rejects symlink aliases for the backup and legacy marker sources', async () => {
  const f = legacyFixture()
  const alias = resolve(f.directory, 'profile-alias'); symlinkSync(f.rootDir, alias)
  await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: resolve(alias, 'backup.gz') }), /outside/)
  const source = resolve(f.outbox.highWaterDir, '00000000000000000001.json')
  const outside = resolve(f.directory, 'outside.json'); writeFileSync(outside, readFileSync(source))
  rmSync(source); symlinkSync(outside, source)
  await assert.rejects(migrateAckHighWater(f.outbox, { backupPath: f.backupPath }), /regular legacy marker/)
  assert.equal(existsSync(f.backupPath), false)
  assert.equal(read(f.outbox.sequencePath).formatVersion, 1)
})
