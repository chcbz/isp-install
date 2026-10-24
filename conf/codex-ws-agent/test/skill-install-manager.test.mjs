import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SkillInstallManager } from '../skill-install-manager.mjs'
import { replyMessage } from '../message-envelope.mjs'
import { packageFixture, command, activate, binding, profile, headers } from './fixtures/skill-management-fixture.mjs'

const setup = (t, options = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-smc1-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = resolve(root, 'home'); mkdirSync(home)
  let downloads = 0; const emitted = [], packages = new Map()
  const settings = { profile: profile(home), stateRoot: resolve(root, 'state'), wsUrl: 'ws://127.0.0.1:8080/ws/agent/channel',
    enabled: true, runtimeInstanceId: 'boot_demo', getRuntimeHeaders: () => headers(binding),
    fetchFn: async url => { downloads++; const bytes = packages.get(url.pathname); assert.ok(bytes, url.pathname)
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' } }) },
    sendResultFn: msg => { emitted.push(structuredClone(msg)); return true }, ...options }
  const manager = new SkillInstallManager(settings); manager.initialize(); manager.bindSession(binding)
  manager.verifyCandidate = async () => ({ readiness: 'READY' })
  const add = fixture => { packages.set(`/internal/agent/skill-installations/${fixture.target.skillInstallationId}/package`, fixture.bytes); return fixture }
  return { root, home, manager, settings, emitted, add, downloads: () => downloads }
}

test('SM-C1 real ZIP PREPARE → ACTIVATE, durable ACK/result, receipt retirement and exact instruction declaration', async t => {
  const f = setup(t), pkg = f.add(packageFixture()), prepare = command(pkg.target)
  const result = await f.manager.handle(prepare)
  assert.equal(result.resultEnvelope.data.evidence.outcome, 'PREPARED')
  assert.equal(f.emitted[0].messageType, 'command.ack')
  assert.equal(existsSync(resolve(f.home, 'skills/repo-test')), false)
  assert.equal(f.manager.listInstalledSkills().length, 0)
  const activation = activate(prepare), applied = (await f.manager.handle(activation)).resultEnvelope
  assert.equal(applied.data.evidence.outcome, 'APPLIED')
  assert.equal(applied.data.evidence.readiness, 'NOT_EXECUTABLE')
  assert.equal(applied.data.executionRuntimeInstanceId, 'boot_demo')
  assert.equal(Object.hasOwn(applied, 'code'), false)
  assert.equal(f.manager.listInstalledSkills()[0].manifest, null)
  assert.ok(readFileSync(resolve(f.home, 'skills/repo-test/SKILL.md'), 'utf8').includes('1.0.0'))
  assert.equal(f.downloads(), 1)
  await f.manager.handle(activation); assert.equal(f.downloads(), 1)
  const receipt = replyMessage(applied, 'work.result.receipt', 'receipt_1', 'E0', 'committed', {
    schemaVersion: 2, skillChangeId: applied.data.skillChangeId, commandId: applied.data.commandId, attempt: applied.data.attempt, receiptStatus: 'ACCEPTED' })
  f.manager.acknowledgeResultReceipt(receipt)
  assert.equal(f.manager.pendingResults().some(row => row.envelope.messageId === applied.messageId), false)
})

// Safety and recovery regressions migrated from the retired schema1 installer.
// These deliberately exercise the existing extractor, Linux renameat2 and journal,
// not a substitute management state machine.
import { writeFileSync, symlinkSync, linkSync, renameSync, readdirSync, utimesSync, lstatSync } from 'node:fs'
import { buildSkillDownloadUrl, LINUX_ATOMIC_FS, SKILL_INSTALL_FAILURE } from '../skill-install-manager.mjs'
import { managementDigest } from '../skill-management-wire.mjs'
import { SkillRegistry } from '../skill-registry.mjs'
import { executeSkill } from '../skill-executor.mjs'
import { policy, reconcile, zip, skillDocument, hash } from './fixtures/skill-management-fixture.mjs'
const outcome = result => result.resultEnvelope.data.evidence.outcome
const receiptFor = result => replyMessage(result, 'work.result.receipt', `receipt_${result.messageId}`, 'E0', 'committed', {
  schemaVersion: 2, skillChangeId: result.data.skillChangeId, commandId: result.data.commandId, attempt: result.data.attempt, receiptStatus: 'ACCEPTED' })
const restart = (f, options = {}) => {
  const manager = new SkillInstallManager({ ...f.settings, ...options }); manager.initialize()
  manager.bindSession({ ...binding, fence: { ...binding.fence, runtimeInstanceId: options.runtimeInstanceId || f.settings.runtimeInstanceId } })
  manager.verifyCandidate = async () => ({ readiness: 'READY' }); return manager
}
const installed = async f => {
  const pkg = f.add(packageFixture()), prepare = command(pkg.target)
  assert.equal(outcome(await f.manager.handle(prepare)), 'PREPARED')
  const activation = activate(prepare); assert.equal(outcome(await f.manager.handle(activation)), 'APPLIED')
  return { pkg, prepare, activation }
}
const crashed = name => (stage => { if (stage === name) throw Object.assign(new Error(`crash:${name}`), { simulatedCrash: true }) })

test('management disabled, strict target/path/hash/size and API-key rejection precede fetch/ACK', async t => {
  const f = setup(t, { enabled: false }), c = command(packageFixture().target)
  await assert.rejects(f.manager.handle(c), { code: 'SKILL_INSTALL_DISABLED' })
  assert.equal(f.emitted.length, 0); assert.equal(f.downloads(), 0)
  f.manager.enabled = true
  for (const patch of [{ downloadPath: '/internal/agent/skill-installations/other/package' },
    { target: { ...c.data.target, byteLength: '01' } }, { target: { ...c.data.target, skillInstallationId: '../escape' } },
    { target: { ...c.data.target, manifestSha256: 'x' } }, { taskId: 'order_not_task' }]) {
    await assert.rejects(f.manager.handle(command(c.data.target, patch)))
  }
  assert.equal(f.emitted.length, 0); assert.equal(f.downloads(), 0)
  assert.throws(() => new SkillInstallManager({ ...f.settings, apiKey: 'no-legacy-auth' }), /legacy API-key/)
})

test('same-origin TLS/loopback package URL rules retain exact canonical path protection', () => {
  const path = '/internal/agent/skill-installations/si_1/package'
  assert.equal(buildSkillDownloadUrl('wss://api.example.test/ws', path).protocol, 'https:')
  for (const url of ['ws://localhost:8080/ws', 'ws://127.0.0.1/ws', 'ws://127.255.0.1/ws', 'ws://[::1]/ws'])
    assert.equal(buildSkillDownloadUrl(url, path).protocol, 'http:')
  for (const url of ['ws://api.example.test/ws', 'ws://0.0.0.0/ws', 'ws://192.168.1.3/ws', 'ws://localhost.example/ws'])
    assert.throws(() => buildSkillDownloadUrl(url, path), { code: 'SKILL_DOWNLOAD_FORBIDDEN' })
  for (const bad of ['https://evil.test/pkg', `${path}?x=1`, `${path}#x`, '/internal/agent/skill-installations/%2e%2e/package'])
    assert.throws(() => buildSkillDownloadUrl('wss://api.example.test/ws', bad))
})

test('download exact length/hash/content-type/redirect and complete session proof fail before extraction', async t => {
  const pkg = packageFixture()
  for (const [name, opts, reason] of [
    ['digest', { bytes: Buffer.from('x'.repeat(pkg.bytes.length)) }, 'PACKAGE_DIGEST_MISMATCH'],
    ['short-body', { bytes: pkg.bytes.subarray(0, -1), noLength: true }, 'PREPARATION_FAILED'],
    ['long-body', { bytes: Buffer.concat([pkg.bytes, Buffer.from('x')]), noLength: true }, 'PREPARATION_FAILED'],
    ['length-header', { length: '1' }, 'PREPARATION_FAILED'],
    ['content-type', { type: 'text/plain' }, 'DOWNLOAD_FORBIDDEN'],
    ['redirect', { redirected: true }, 'DOWNLOAD_FORBIDDEN'],
    ['foreign-final-url', { url: 'https://evil.test/package' }, 'DOWNLOAD_FORBIDDEN'],
    ['incomplete-proof', { proof: { Authorization: headers(binding).Authorization } }, 'DOWNLOAD_FORBIDDEN']
  ]) await t.test(name, async t => {
    let fetched = 0
    const f = setup(t, { getRuntimeHeaders: () => opts.proof || headers(binding), fetchFn: async (_url, request) => {
      fetched++; assert.equal(request.redirect, 'error'); assert.equal(Object.hasOwn(request.headers, 'X-Api-Key'), false)
      const response = new Response(opts.bytes || pkg.bytes, { headers: { 'content-type': opts.type || 'application/octet-stream',
        ...(opts.noLength ? {} : { 'content-length': opts.length || String(pkg.bytes.length) }) } })
      if (opts.redirected) Object.defineProperty(response, 'redirected', { value: true })
      if (opts.url) Object.defineProperty(response, 'url', { value: opts.url })
      return response
    } })
    const result = await f.manager.handle(command(pkg.target))
    assert.equal(outcome(result), 'FAILED'); assert.equal(result.resultEnvelope.data.evidence.reasonCode, reason)
    assert.equal(f.manager.getInstallation(pkg.target.skillInstallationId), null)
    assert.equal(existsSync(resolve(f.home, 'skills/repo-test')), false)
    if (opts.proof) assert.equal(fetched, 0)
  })
})

test('real ZIP traversal, symlink/special files, duplicate/prefix and Unicode aliases never escape staging', async t => {
  const doc = { name: 'SKILL.md', data: skillDocument() }
  const cases = [
    ['dotdot', [{ name: '../outside', data: 'bad' }]], ['absolute', [{ name: '/tmp/outside', data: 'bad' }]],
    ['backslash', [{ name: 'a\\b', data: 'bad' }]], ['symlink', [{ name: 'link', data: '/tmp', mode: 0o120777 }]],
    ['fifo', [{ name: 'fifo', data: '', mode: 0o010644 }]], ['duplicate', [doc]],
    ['file-prefix', [{ name: 'a', data: 'file' }, { name: 'a/b', data: 'nested' }]],
    ['case', [{ name: 'skill.md', data: 'alias' }]],
    ['NFC', [{ name: 'é.txt', data: 'a' }, { name: 'e\u0301.txt', data: 'b' }]],
    ['case-fold', [{ name: 'Σ.txt', data: 'a' }, { name: 'ς.txt', data: 'b' }]],
    ['ancestor-case', [{ name: 'Docs/a', data: 'a' }, { name: 'docs/b', data: 'b' }]],
    ['directory-metadata', [{ name: 'dir/', mode: 0o100644 }]]
  ]
  for (const [name, extra] of cases) await t.test(name, async t => {
    const f = setup(t), pkg = f.add(packageFixture({ entries: [doc, ...extra] }))
    const result = await f.manager.handle(command(pkg.target))
    assert.equal(outcome(result), 'FAILED'); assert.equal(result.resultEnvelope.data.evidence.reasonCode, 'ARCHIVE_INVALID')
    assert.equal(f.manager.listInstalledSkills().length, 0); assert.equal(existsSync(resolve(f.root, 'outside')), false)
  })
})

test('bounded frontmatter identities and archive expansion/entry limits remain enforced', async t => {
  for (const [name, data, options] of [
    ['wrong-name', skillDocument('other'), {}], ['wrong-version', skillDocument('repo-test', '2.0.0'), {}],
    ['missing-version', '---\nname: repo-test\ndescription: x\n---\n', {}],
    ['duplicate-name', skillDocument().replace('name: repo-test', 'name: repo-test\nname: repo-test'), {}],
    ['conflicting-version', skillDocument().replace('metadata:', 'version: "2.0.0"\nmetadata:'), {}],
    ['yaml-alias', skillDocument().replace('"1.0.0"', '*untrusted'), {}],
    ['entry-limit', skillDocument(), { maxEntries: 0 }], ['expanded-limit', skillDocument(), { maxExtractedBytes: 1 }],
    ['file-limit', skillDocument(), { maxEntryBytes: 1 }]
  ]) await t.test(name, async t => {
    const f = setup(t, options), pkg = f.add(packageFixture({ entries: [{ name: 'SKILL.md', data }] }))
    assert.equal(outcome(await f.manager.handle(command(pkg.target))), 'FAILED')
    assert.equal(f.manager.listInstalledSkills().length, 0)
  })
  // Keep the actual accepted frontmatter parser, not a test-only identity projection.
  const f = setup(t), pkg = f.add(packageFixture({ entries: [{ name: 'SKILL.md', data: skillDocument().replace('"1.0.0"', "'1.0.0' # approved") }] }))
  assert.equal(outcome(await f.manager.handle(command(pkg.target))), 'PREPARED')
})

test('identity is durably installation/owner/tenant/client/profile/origin bound across boots', async t => {
  const f = setup(t); const { prepare } = await installed(f)
  const next = restart(f, { runtimeInstanceId: 'boot_next' }); assert.equal(next.isHealthy(), true)
  for (const scopePatch of [{ ownerJiacn: 'foreign' }, { tenantId: 'foreign' }, { clientId: 'foreign' }])
    assert.throws(() => next.bindSession({ scope: { ...binding.scope, ...scopePatch }, fence: { ...binding.fence, runtimeInstanceId: 'boot_next' } }), /durable subject/)
  assert.throws(() => next.bindSession({ scope: binding.scope, fence: { ...binding.fence, runtimeInstanceId: 'boot_next', installationId: 'foreign' } }), /durable subject/)
  for (const options of [{ wsUrl: 'wss://different.test/ws' }, { profile: { ...f.settings.profile, profileId: 'other' } }])
    assert.throws(() => restart(f, options), /integrity\/scope/)
  const wrong = command(prepare.data.target, { tenantId: 'foreign' }); await assert.rejects(next.handle(wrong), /authenticated subject/)
  assert.equal(f.downloads(), 1)
})

test('cross-boot deliveryEpoch fencing preserves original ACK/result bytes; only exact committed receipt retires', async t => {
  const f = setup(t), pkg = f.add(packageFixture()), c = command(pkg.target)
  const result = (await f.manager.handle(c)).resultEnvelope, bytes = JSON.stringify(result)
  const ack = f.emitted.find(msg => msg.messageType === 'command.ack'), ackBytes = JSON.stringify(ack)
  const m = restart(f, { runtimeInstanceId: 'boot_next' }), resent = []
  assert.equal(m.replayAcks(msg => { resent.push(JSON.stringify(msg)); return true }), 1)
  assert.equal(resent[0], ackBytes)
  const redelivery = { ...c, messageId: 'message_next', data: { ...c.data, deliveryEpoch: '2' } }
  assert.equal(JSON.stringify((await m.handle(redelivery)).resultEnvelope), bytes)
  assert.equal(result.data.executionRuntimeInstanceId, 'boot_demo'); assert.equal(f.downloads(), 1)
  await assert.rejects(m.handle({ ...c, messageId: 'old_epoch' }), /newer authorized epoch/)
  await assert.rejects(m.handle(command(pkg.target, { ...c.data, desiredEnabled: !c.data.desiredEnabled })), /identity conflict|changed bytes/)
  const receipt = receiptFor(result)
  for (const bad of [{ ...receipt, requestId: 'other' }, { ...receipt, correlationId: 'other' },
    { ...receipt, data: { ...receipt.data, attempt: 2 } }, { ...receipt, data: { ...receipt.data, skillChangeId: 'other' } }])
    assert.throws(() => m.acknowledgeResultReceipt(bad), /uncorrelated/)
  const replayed = []; m.replayResults(msg => { replayed.push(JSON.stringify(msg)); return true }); assert.deepEqual(replayed, [bytes])
  m.acknowledgeResultReceipt(receipt); m.acknowledgeResultReceipt(receipt)
  assert.equal(restart(f, { runtimeInstanceId: 'boot_third' }).pendingResults().length, 0)
  // Corrupting acknowledged evidence, even with a recomputed container hash, cannot invent a receipt correlation.
  const state = JSON.parse(readFileSync(m.statePath)); const record = Object.values(state.commands)[0]
  record.receipt.correlationId = 'forged'; delete state.journalSha256; state.journalSha256 = managementDigest('cyf.skill.journal.v2', state)
  writeFileSync(m.statePath, JSON.stringify(state)); assert.throws(() => restart(f), /receipt integrity/)
})

test('ACK follows durable receive, reconnect resumes only proven RECEIVED; unknown READ never reexecutes', async t => {
  const f = setup(t), pkg = f.add(packageFixture()), c = command(pkg.target)
  let seenAck = false
  f.manager.sendResultFn = msg => {
    if (msg.messageType === 'command.ack') {
      const state = JSON.parse(readFileSync(f.manager.statePath)); assert.equal(Object.values(state.commands)[0].state, 'RECEIVED'); seenAck = true
    }
    return true
  }
  f.manager._receive(c); assert.equal(seenAck, true); assert.equal(f.downloads(), 0)
  const m = restart(f, { runtimeInstanceId: 'boot_next' }); await m.resumePendingCommands()
  assert.equal(f.downloads(), 1); assert.equal(m.pendingResults()[0].envelope.data.executionRuntimeInstanceId, 'boot_next')
  const missing = command(pkg.target, { commandId: 'never_seen' }), read = reconcile(missing)
  const result = await m.handle(read); assert.equal(outcome(result), 'UNKNOWN')
  assert.equal(result.resultEnvelope.data.evidence.observedCommandId, 'never_seen'); assert.equal(f.downloads(), 1)
  await m.resumePendingCommands(); assert.equal(f.downloads(), 1)
})

test('PREPARED / activation intent / switched view / persisted result crashes recover by observation only', async t => {
  for (const point of ['intent-persisted', 'prepared-persisted', 'activation-intent-persisted', 'view-switched', 'result-persisted'])
    await t.test(point, async t => {
      const f = setup(t), pkg = f.add(packageFixture()), prepare = command(pkg.target)
      let c = prepare
      if (point === 'activation-intent-persisted' || point === 'view-switched') {
        await f.manager.handle(prepare); c = activate(prepare)
      }
      f.manager.checkpoint = crashed(point)
      await assert.rejects(f.manager.handle(c), /crash:/)
      const count = f.downloads(), m = restart(f, { runtimeInstanceId: 'boot_next' })
      assert.equal(f.downloads(), count)
      const read = await m.handle(reconcile(c)), fact = read.resultEnvelope.data.evidence
      assert.equal(fact.observedCommandId, c.data.commandId)
      assert.equal(fact.outcome, ['intent-persisted', 'activation-intent-persisted'].includes(point) ? 'UNKNOWN' : point === 'view-switched' ? 'APPLIED' : 'PREPARED')
      assert.equal(read.resultEnvelope.data.executionRuntimeInstanceId, 'boot_demo')
      await m.handle(c); await m.resumePendingCommands(); assert.equal(f.downloads(), count)
      if (point === 'activation-intent-persisted') assert.equal(existsSync(resolve(f.home, 'skills/repo-test')), false)
    })
})

test('33+ immutable results drain bounded batches once per connection; receipts do not starve later records', async t => {
  const f = setup(t, { maxReplayBatch: 4 }), pkg = f.add(packageFixture()), c = command(pkg.target)
  await f.manager.handle(c)
  // Produce real READ journal/results (no install or provider) rather than fabricating outbox files.
  for (let i = 0; i < 33; i++) await f.manager.handle(reconcile(c))
  const sent = [], token = {}; let count
  do { count = f.manager.replayResults(msg => { sent.push(msg.messageId); return true }, { replayToken: token }) } while (count === 4)
  assert.equal(sent.length, 34); assert.equal(new Set(sent).size, 34)
  assert.equal(f.manager.replayResults(() => true, { replayToken: token }), 0)
  assert.equal(f.manager.replayResults(() => true, { replayToken: {} }), 4)
  const result = f.manager.pendingResults()[10].envelope; f.manager.acknowledgeResultReceipt(receiptFor(result))
  assert.equal(f.manager.pendingResults().length, 33); assert.equal(f.downloads(), 1)
})

test('upgrade and policy keep old tasks on exact immutable installation/package/permissions, not current or management fence', async t => {
  const f = setup(t), pkg1 = f.add(packageFixture({ executable: true })), prepare1 = command(pkg1.target)
  await f.manager.handle(prepare1); await f.manager.handle(activate(prepare1))
  const old = f.manager.listInstalledSkills()[0], runner = { probe: () => ({ ready: true, digest: 'a'.repeat(64) }), run: async ({ descriptor }) => {
    assert.equal(descriptor.packageRoot, old.packageRoot); assert.equal(descriptor.approvedPermissionsSha256, old.approvedPermissionsSha256)
    assert.ok(readFileSync(resolve(descriptor.packageRoot, 'SKILL.md'), 'utf8').includes('1.0.0'))
    return { data: { answer: 'old' }, artifacts: [], inputReceipts: [] }
  } }
  const registry = new SkillRegistry({ scope: binding.scope, loadInstalled: () => f.manager.listInstalledSkills(),
    loadRetained: () => f.manager.listInstalledSkills({ includeRetained: true }), runnerRegistry: new Map([['native-model', runner]]) })
  registry.setSession(binding.fence)
  const item1 = (await registry.refresh()).skills[0]; assert.equal(item1.readiness, 'READY')
  const taskBinding = { executionId: 'execution_old', taskGrantId: 'grant_old', taskGrantVersion: '1', agentId: binding.scope.agentId,
    skillKey: old.skillKey, skillInstallationId: old.skillInstallationId, productVersionId: old.productVersionId,
    skillVersion: old.skillVersion, packageSha256: old.packageSha256, manifestSha256: old.manifestSha256, approvedPermissionsSha256: old.approvedPermissionsSha256 }
  const pkg2 = f.add(packageFixture({ version: '2.0.0', executable: true })), upgrade = command(pkg2.target, { action: 'UPGRADE', source: pkg1.target,
    skillChangeId: 'sc_upgrade', skillRevision: '2', fencingToken: '2' })
  // Preparation must not block/replace historical execution lookup, even while the installer lock is held.
  f.manager.verifyCandidate = async () => {
    assert.equal((await registry.requireExact(item1, { taskBinding })).descriptor.packageRoot, old.packageRoot)
    return { readiness: 'READY' }
  }
  assert.equal(outcome(await f.manager.handle(upgrade)), 'PREPARED')
  assert.equal((await registry.refresh()).skills[0].skillInstallationId, old.skillInstallationId)
  assert.equal(outcome(await f.manager.handle(activate(upgrade))), 'APPLIED')
  assert.equal((await registry.refresh()).skills[0].skillVersion, '2.0.0')
  assert.deepEqual(readdirSync(resolve(f.home, 'skills')), ['repo-test'])
  assert.equal(outcome(await f.manager.handle(policy(pkg2.target, 3, false))), 'APPLIED')
  const disabled = (await registry.refresh()).skills[0]; assert.equal(disabled.enabled, false)
  assert.deepEqual(readdirSync(resolve(f.home, 'skills')), [])
  await assert.rejects(registry.requireExact(disabled), /SKILL_EXECUTION_BINDING_CHANGED/)
  const task = { executionProtocolVersion: 4, executionId: taskBinding.executionId, taskId: 'task_old', runId: 'run_old', conversationId: 'conv_old',
    conversationGeneration: '1', commandId: 'cmd_task_old', messageId: 'msg_task_old', snapshotDigest: 'f'.repeat(64), taskSkillBinding: taskBinding,
    skill: { key: old.skillKey, version: old.skillVersion, packageSha256: old.packageSha256, manifestSha256: old.manifestSha256 },
    instruction: 'authorized old task', parameters: {}, inputRefs: [], outputs: old.manifest.outputs }
  let calls = 0, persisted = null
  const ctx = { registry, runners: new Map([['native-model', { ...runner, run: async context => { calls++; return runner.run(context) } }]]),
    claimOrResume: async () => ({}), loadResult: async () => persisted, materializeAuthorizedInputs: async () => [],
    validateAndPersistResult: async (_command, _descriptor, result) => (persisted = { schemaVersion: 1, executionId: task.executionId, snapshotDigest: task.snapshotDigest, result }),
    commitResult: async () => ({ state: 'RESULT_COMMITTED' }), persistReceipt: async () => {} }
  await executeSkill(task, ctx); await executeSkill(task, ctx); assert.equal(calls, 1)
  await assert.rejects(registry.requireExact(item1, { taskBinding: { ...taskBinding, approvedPermissionsSha256: 'e'.repeat(64) } }), /SKILL_EXECUTION_BINDING_CHANGED/)
  assert.equal(outcome(await f.manager.handle(policy(pkg2.target, 4, true))), 'APPLIED')
  const lateDisable = policy(pkg2.target, 3, false)
  assert.equal(outcome(await f.manager.handle(lateDisable)), 'FAILED')
  assert.equal(f.manager.listInstalledSkills()[0].enabled, true)
  assert.equal(f.manager.listInstalledSkills({ includeRetained: true }).length, 2); assert.equal(f.downloads(), 2)
})

test('retained manifest/marker/hardlink/symlink tampering cannot override trusted package identity', async t => {
  for (const kind of ['manifest', 'marker', 'hardlink', 'symlink', 'view']) await t.test(kind, async t => {
    const f = setup(t), pkg = f.add(packageFixture({ executable: true })), prepare = command(pkg.target)
    await f.manager.handle(prepare); await f.manager.handle(activate(prepare))
    const row = f.manager.listInstalledSkills()[0], path = resolve(row.packageRoot, 'SKILL.md')
    if (kind === 'manifest') writeFileSync(resolve(row.packageRoot, 'manifest.json'), '{}')
    if (kind === 'marker') writeFileSync(resolve(row.packageRoot, '.cyf-installation.json'), '{}')
    if (kind === 'hardlink') linkSync(path, resolve(f.root, 'external-hardlink'))
    if (kind === 'symlink') { renameSync(path, resolve(f.root, 'outside')); symlinkSync(resolve(f.root, 'outside'), path) }
    if (kind === 'view') writeFileSync(resolve(f.home, 'skills/repo-test/SKILL.md'), 'unmanaged change')
    assert.throws(() => f.manager.listInstalledSkills())
    if (kind !== 'view') assert.throws(() => f.manager.listInstalledSkills({ includeRetained: true }))
  })
})

test('publication target/parent inode races preserve foreign content and persist UNKNOWN, never false failure', async t => {
  for (const kind of ['target', 'parent']) await t.test(kind, async t => {
    const f = setup(t), pkg = f.add(packageFixture())
    const c = command(pkg.target); await f.manager.handle(c)
    let injected = false
    f.manager.atomicFs = { ...LINUX_ATOMIC_FS, renameNoReplace(source, target, expected) {
      if (!injected && target === resolve(f.home, 'skills/repo-test')) {
        injected = true
        if (kind === 'target') { mkdirSync(target); writeFileSync(resolve(target, 'foreign'), 'preserved') }
        else { const root = resolve(f.home, 'skills'); renameSync(root, `${root}-old`); mkdirSync(root); writeFileSync(resolve(root, 'foreign'), 'preserved') }
      }
      return LINUX_ATOMIC_FS.renameNoReplace(source, target, expected)
    } }
    const result = await f.manager.handle(activate(c)); assert.equal(outcome(result), 'UNKNOWN')
    assert.equal(readFileSync(resolve(f.home, kind === 'target' ? 'skills/repo-test/foreign' : 'skills/foreign'), 'utf8'), 'preserved')
    assert.equal(f.downloads(), 1)
  })
})

test('installer locks reject live/legacy owners, reclaim dead/incomplete generations and fence release bytes', async t => {
  const f = setup(t), m = f.manager
  m._acquireLock('live-test')
  const contender = new SkillInstallManager(f.settings)
  assert.throws(() => contender.initialize(), /another live process/)
  m._releaseLock()
  for (const owner of [{ formatVersion: 1, pid: process.pid },
    { formatVersion: 2, ownerToken: 'dead', pid: 99999999, processStartToken: 'gone', bootId: 'gone', operation: 'old', runtimeInstanceId: 'old', acquiredAt: 1 }, null]) {
    mkdirSync(m.lockPath)
    if (owner) writeFileSync(m.lockOwnerPath, JSON.stringify(owner))
    utimesSync(m.lockPath, new Date(0), new Date(0))
    if (owner?.pid === process.pid) { assert.throws(() => contender.initialize(), /legacy process/); rmSync(m.lockPath, { recursive: true }); continue }
    contender.unownedLockStaleMs = 0; assert.equal(contender.initialize().healthy, true)
  }
  assert.equal(readdirSync(m.staleLocksDir).length, 2)
  m._acquireLock('release-test')
  const original = readFileSync(m.lockOwnerPath, 'utf8'); writeFileSync(m.lockOwnerPath, original + ' ')
  assert.throws(() => m._releaseLock(), /ownership fence mismatch/); assert.equal(existsSync(m.lockPath), true)
})

test('concurrent stale reclaim loser cannot archive or remove the winning generation', t => {
  const f = setup(t), seed = f.manager
  mkdirSync(seed.lockPath); writeFileSync(seed.lockOwnerPath, JSON.stringify({ formatVersion: 2, ownerToken: 'stale', pid: 99999999,
    processStartToken: 'old', bootId: 'old', operation: 'old', runtimeInstanceId: 'old', acquiredAt: 1 }))
  const options = { ...f.settings, lockOwnerAliveFn: owner => owner.operation === 'winner' }
  const winner = new SkillInstallManager(options); let won = false
  const loser = new SkillInstallManager({ ...options, atomicFs: { ...LINUX_ATOMIC_FS, exchangeIfMatch: (...args) => {
    if (!won) { winner._acquireLock('winner'); won = true }
    return LINUX_ATOMIC_FS.exchangeIfMatch(...args)
  } } })
  assert.throws(() => loser._acquireLock('loser'), /another live process/)
  assert.equal(JSON.parse(readFileSync(seed.lockOwnerPath)).ownerToken, winner.lockOwner.ownerToken)
  winner._releaseLock()
})

test('HOME/state symlink aliases and journal hardlinks fail closed; arbitrary HOME packages never become capabilities', async t => {
  const f = setup(t), outside = resolve(f.root, 'outside'); mkdirSync(outside)
  mkdirSync(resolve(f.home, 'skills/unmanaged'), { recursive: true }); writeFileSync(resolve(f.home, 'skills/unmanaged/SKILL.md'), skillDocument())
  assert.equal(f.manager.listInstalledSkills().length, 0)
  const alias = resolve(f.root, 'alias'); symlinkSync(f.home, alias)
  // A PREPARE may use managed state only; publishing through an aliased HOME is forbidden.
  const m = new SkillInstallManager({ ...f.settings, profile: profile(alias), stateRoot: resolve(f.root, 'alias-state') }); m.initialize(); m.bindSession(binding)
  const pkg = f.add(packageFixture()), c = command(pkg.target); await m.handle(c)
  assert.equal(outcome(await m.handle(activate(c))), 'FAILED')
  linkSync(f.manager.statePath, resolve(outside, 'journal-link')); assert.equal(f.manager.isHealthy(), false)
  const stateLink = resolve(f.root, 'state-link'); symlinkSync(outside, stateLink)
  assert.throws(() => new SkillInstallManager({ ...f.settings, stateRoot: stateLink }).initialize(), /real|unsafe|symlink|canonical/)
  assert.equal(existsSync(resolve(outside, 'management-v2')), false)
})

test('lost failure-result persistence stays UNKNOWN; receipt persisted before crash is retired across restart', async t => {
  const f = setup(t, { getRuntimeHeaders: () => ({}) }), c = command(packageFixture().target)
  const save = f.manager._save.bind(f.manager)
  f.manager._save = state => {
    if (Object.values(state.commands).some(row => row.result?.data.evidence.outcome === 'FAILED')) throw new Error('injected failed-result persistence loss')
    return save(state)
  }
  await assert.rejects(f.manager.handle(c), /persistence loss/)
  const m = restart(f); const result = await m.handle(reconcile(c)); assert.equal(outcome(result), 'UNKNOWN'); assert.equal(f.downloads(), 0)
  const observed = m.pendingResults().find(row => row.envelope.data.commandId === c.data.commandId).envelope
  m.checkpoint = crashed('receipt-persisted'); assert.throws(() => m.acknowledgeResultReceipt(receiptFor(observed)), /crash:/)
  const next = restart(f); assert.equal(next.pendingResults().some(row => row.envelope.messageId === observed.messageId), false)
  assert.equal(next.acknowledgedResults().some(row => row.envelope.messageId === observed.messageId), true)
})

test('frozen six W08 metadata.version packages retain exact ZIP, SKILL.md and scoped marker identity under SM-C1', async t => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/w08-metadata-version-packages.json', import.meta.url)))
  assert.equal(fixture.sourceCommit, '6619aae27fd8a31c9ea1dec429a738236ea8a252')
  assert.equal(fixture.sourceTree, '0b869eb0acf78068a97790785f50228da06431ff')
  assert.equal(fixture.packages.length, 6)
  for (const item of fixture.packages) await t.test(item.skillKey, async t => {
    const bytes = Buffer.from(item.packageBase64, 'base64'); assert.equal(bytes.toString('base64'), item.packageBase64)
    assert.equal(String(bytes.length), item.packageSize); assert.equal(`sha256:${hash(bytes)}`, item.packageDigest)
    const target = { skillInstallationId: `si_${item.skillKey}`, productVersionId: `spv_${item.skillKey}`, skillVersion: item.skillVersion,
      packageSha256: hash(bytes), manifestSha256: null, byteLength: String(bytes.length), kind: 'INSTRUCTION' }
    const f = setup(t); f.add({ target, bytes }); const c = command(target, { skillKey: item.skillKey })
    assert.equal(outcome(await f.manager.handle(c)), 'PREPARED'); assert.equal(outcome(await f.manager.handle(activate(c))), 'APPLIED')
    assert.equal(hash(readFileSync(resolve(f.home, 'skills', item.skillKey, 'SKILL.md'))), item.skillMdSha256)
    const marker = JSON.parse(readFileSync(resolve(f.home, 'skills', item.skillKey, '.cyf-installation.json')))
    assert.deepEqual(marker.target, target); assert.equal(restart(f).listInstalledSkills()[0].skillKey, item.skillKey)
    assert.equal(f.downloads(), 1)
  })
})

test('executable malformed manifest, manifest identity and package-local script entrypoint cannot be fabricated', async t => {
  const parsed = packageFixture({ executable: true }), raw = JSON.parse(readFileSync(new URL('./fixtures/skill-manifest-contract-v1.json', import.meta.url))).cases.find(c => c.id === 'image-edit')
  for (const kind of ['malformed', 'wrong-identity', 'missing-entrypoint', 'dependency-unavailable']) await t.test(kind, async t => {
    const doc = JSON.parse(raw.json); doc.skillKey = 'repo-test'; doc.skillVersion = '1.0.0'
    if (kind === 'wrong-identity') doc.skillVersion = '9.0.0'
    if (kind === 'missing-entrypoint') { doc.runner = 'local-script'; doc.entrypoint = 'scripts/missing.py'; doc.requirements = {} }
    const text = kind === 'malformed' ? '{invalid' : JSON.stringify(doc)
    const bytes = zip([{ name: 'SKILL.md', data: skillDocument() }, { name: 'manifest.json', data: text }])
    const target = { ...parsed.target, byteLength: String(bytes.length), packageSha256: hash(bytes), manifestSha256: hash(text) }
    const f = setup(t); f.add({ target, bytes });
    if (kind === 'dependency-unavailable') f.manager.verifyCandidate = async () => ({ readiness: 'PROVIDER_UNBOUND', reasonCode: 'PROVIDER_UNBOUND' })
    const result = await f.manager.handle(command(target)); assert.equal(outcome(result), 'FAILED')
    assert.equal(f.manager.listInstalledSkills().length, 0)
  })
})

test('prepared real SE2 archives require measured native/provider readiness; no readiness probe calls a provider', async t => {
  const { createNativeModelRunner } = await import('../skill-runners/native-model.mjs')
  const { createImageProviderRunner } = await import('../skill-runners/image-provider.mjs')
  const inputs = JSON.parse(readFileSync(new URL('../toolchain/skill-packages-se2/release-inputs.json', import.meta.url)))
  for (const item of inputs.packages) await t.test(item.skillKey, async t => {
    const bytes = readFileSync(new URL(`../toolchain/skill-packages-se2/${item.packageFile}`, import.meta.url))
    assert.equal(bytes.length, item.packageByteLength); assert.equal(hash(bytes), item.packageSha256)
    const f = setup(t), target = { skillInstallationId: `si_${item.skillKey}`, productVersionId: `spv_${item.skillKey}`, skillVersion: item.skillVersion,
      packageSha256: item.packageSha256, manifestSha256: item.manifestSha256, byteLength: String(bytes.length), kind: 'EXECUTABLE' }
    f.add({ target, bytes })
    const registry = new SkillRegistry({ scope: binding.scope, loadInstalled: () => f.manager.listInstalledSkills(), runnerRegistry: new Map() }); registry.setSession(binding.fence)
    f.manager.verifyCandidate = async row => (await registry.measureInstallation(row)).item
    assert.equal(outcome(await f.manager.handle(command(target, { skillKey: item.skillKey }))), 'FAILED'); assert.equal(f.manager.listInstalledSkills().length, 0)
    const noCall = () => assert.fail('install/readiness must not invoke provider/model')
    if (item.runner === 'provider-operation') {
      const bindings = { resolve: async () => ({ ready: true, scope: binding.scope, bindingId: 'test-provider', revision: '1', digest: 'a'.repeat(64) }) }
      registry.runners.set(item.runner, createImageProviderRunner({ bindings, scope: binding.scope, fetchFn: noCall }))
      registry.resolveBinding = () => bindings.resolve()
    } else registry.runners.set(item.runner, createNativeModelRunner({ probeModel: async () => ({ ready: true, digest: 'a'.repeat(64), supportedMimeTypes: ['image/png'] }), runModel: noCall }))
    const c = command(target, { skillKey: item.skillKey, skillRevision: '2', fencingToken: '2', attempt: 2 })
    assert.equal(outcome(await f.manager.handle(c)), 'PREPARED'); assert.equal(outcome(await f.manager.handle(activate(c))), 'APPLIED')
    const descriptor = f.manager.listInstalledSkills()[0]; assert.equal(descriptor.manifest.entrypoint, item.entrypoint)
    assert.equal((await registry.refresh()).skills[0].readiness, 'READY')
  })
})

test('failed upgrade preparation preserves old exact view; explicit new attempt can prepare without replaying failure', async t => {
  const f = setup(t), { pkg: original } = await installed(f), pkg = f.add(packageFixture({ version: '2.0.0', executable: true }))
  const oldBytes = readFileSync(resolve(f.home, 'skills/repo-test/SKILL.md'))
  f.manager.verifyCandidate = async () => ({ readiness: 'DEPENDENCY_MISSING', reasonCode: 'DEPENDENCY_MISSING' })
  const first = command(pkg.target, { action: 'UPGRADE', source: original.target, skillChangeId: 'sc_retry', skillRevision: '2', fencingToken: '2' })
  const failure = await f.manager.handle(first); assert.equal(outcome(failure), 'FAILED'); assert.equal(failure.resultEnvelope.data.evidence.reasonCode, 'DEPENDENCY_MISSING')
  assert.deepEqual(readFileSync(resolve(f.home, 'skills/repo-test/SKILL.md')), oldBytes)
  assert.equal(f.manager.listInstalledSkills()[0].skillVersion, '1.0.0')
  await f.manager.handle(first); assert.equal(f.downloads(), 2)
  f.manager.verifyCandidate = async () => ({ readiness: 'READY' })
  const next = command(pkg.target, { ...first.data, commandId: 'cmd_retry_next', attempt: 2, skillRevision: '3', fencingToken: '3' })
  assert.equal(outcome(await f.manager.handle(next)), 'PREPARED'); assert.equal(outcome(await f.manager.handle(activate(next))), 'APPLIED')
  assert.equal(f.manager.listInstalledSkills()[0].skillVersion, '2.0.0'); assert.equal(f.downloads(), 3)
})

test('upgrading a disabled skill preserves disabled discovery/policy until explicit higher ENABLE', async t => {
  const f = setup(t), { pkg } = await installed(f)
  assert.equal(outcome(await f.manager.handle(policy(pkg.target, 2, false))), 'APPLIED')
  const next = f.add(packageFixture({ version: '2.0.0' })), c = command(next.target, { action: 'UPGRADE', source: pkg.target,
    desiredEnabled: false, skillChangeId: 'sc_disabled_upgrade', skillRevision: '3', fencingToken: '3' })
  assert.equal(outcome(await f.manager.handle(c)), 'PREPARED'); assert.equal(outcome(await f.manager.handle(activate(c))), 'APPLIED')
  const m = restart(f); assert.equal(m.listInstalledSkills()[0].enabled, false)
  assert.equal(existsSync(resolve(f.home, 'skills/repo-test')), false)
  assert.equal(outcome(await m.handle(policy(next.target, 4, true))), 'APPLIED')
  assert.ok(readFileSync(resolve(f.home, 'skills/repo-test/SKILL.md'), 'utf8').includes('2.0.0'))
  assert.equal(m.listInstalledSkills({ includeRetained: true }).length, 2); assert.equal(f.downloads(), 2)
})

test('READ can prove a formerly UNKNOWN switch from restored exact marker without changing old result bytes or switching again', async t => {
  const f = setup(t), pkg = f.add(packageFixture()), prepare = command(pkg.target); await f.manager.handle(prepare)
  const view = resolve(f.home, 'skills/repo-test'), markerPath = resolve(view, '.cyf-installation.json')
  let marker, switches = 0
  f.manager.atomicFs = { ...LINUX_ATOMIC_FS, renameNoReplace(source, target, expected) {
    const result = LINUX_ATOMIC_FS.renameNoReplace(source, target, expected)
    if (target === view && result.ok) { switches++; marker = readFileSync(markerPath); writeFileSync(markerPath, '{}') }
    return result
  } }
  const activation = activate(prepare), result = (await f.manager.handle(activation)).resultEnvelope, original = JSON.stringify(result)
  assert.equal(result.data.evidence.outcome, 'UNKNOWN')
  writeFileSync(markerPath, marker)
  const read = await f.manager.handle(reconcile(activation)); assert.equal(outcome(read), 'APPLIED')
  assert.equal(JSON.stringify((await f.manager.handle(activation)).resultEnvelope), original)
  assert.equal(f.manager.listInstalledSkills()[0].skillInstallationId, pkg.target.skillInstallationId)
  assert.equal(switches, 1); assert.equal(f.downloads(), 1)
})

test('concurrent local delivery and result receipt queue behind the exact async installer lock without releasing or losing its journal', async t => {
  const f = setup(t), pkg = f.add(packageFixture()), c = command(pkg.target)
  const prior = (await f.manager.handle(reconcile(c))).resultEnvelope
  let release, started, downloads = 0
  const ready = new Promise(done => { started = done }), blocked = new Promise(done => { release = done })
  f.manager.fetchFn = async () => {
    downloads++; started(); await blocked
    return new Response(pkg.bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(pkg.bytes.length) } })
  }
  const first = f.manager.handle(c); await ready
  const ownerBytes = readFileSync(f.manager.lockOwnerPath, 'utf8')
  // Direct re-entry is rejected without releasing the outer async operation's lock.
  assert.throws(() => f.manager._receive(c), /another operation/)
  assert.equal(readFileSync(f.manager.lockOwnerPath, 'utf8'), ownerBytes)
  const pendingReceipt = f.manager.handle(receiptFor(prior)), redelivery = f.manager.handle(c)
  await new Promise(done => setImmediate(done))
  assert.equal(readFileSync(f.manager.lockOwnerPath, 'utf8'), ownerBytes)
  assert.equal(f.manager.pendingResults().some(row => row.envelope.messageId === prior.messageId), true)
  release()
  const result = (await first).resultEnvelope
  assert.equal(result.data.evidence.outcome, 'PREPARED')
  await pendingReceipt; assert.deepEqual((await redelivery).resultEnvelope, result)
  assert.equal(downloads, 1); assert.equal(f.manager.isHealthy(), true)
  assert.equal(f.manager.pendingResults().some(row => row.envelope.messageId === prior.messageId), false)
  assert.equal(restart(f).pendingResults().length, 1)
})

test('same-revision conflicting policy intent cannot reverse a durably applied DISABLE', async t => {
  const f = setup(t), { pkg } = await installed(f), disable = policy(pkg.target, 2, false)
  assert.equal(outcome(await f.manager.handle(disable)), 'APPLIED')
  const conflicting = command(pkg.target, { ...disable.data, commandId: 'same_revision_conflict', action: 'ENABLE', desiredEnabled: true })
  const failure = await f.manager.handle(conflicting)
  assert.equal(outcome(failure), 'FAILED'); assert.equal(failure.resultEnvelope.data.evidence.reasonCode, 'STATE_CHANGED')
  assert.equal(existsSync(resolve(f.home, 'skills/repo-test')), false)
  assert.equal(f.manager.listInstalledSkills()[0].enabled, false); assert.equal(f.downloads(), 1)
})

test('real authenticated session loss during download prevents package publication and does not reexecute on later delivery', async t => {
  const f = setup(t), pkg = f.add(packageFixture()), c = command(pkg.target)
  let release, started, downloads = 0
  const ready = new Promise(done => { started = done }), blocked = new Promise(done => { release = done })
  f.manager.fetchFn = async () => { downloads++; started(); await blocked
    return new Response(pkg.bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(pkg.bytes.length) } }) }
  const pending = f.manager.handle(c); await ready
  f.manager.bindSession(null); release()
  const result = await pending; assert.equal(outcome(result), 'FAILED')
  assert.equal(f.manager.getInstallation(pkg.target.skillInstallationId), null)
  assert.equal(existsSync(resolve(f.home, 'skills/repo-test')), false)
  f.manager.bindSession(binding); assert.deepEqual(await f.manager.handle(c), result)
  assert.equal(downloads, 1)
})

test('POLICY intent and switched-view crashes recover by READ only; disabled and staged copies never remain in skills discovery', async t => {
  for (const enabled of [false, true]) for (const point of ['policy-intent-persisted', 'view-switched'])
    await t.test(`${enabled ? 'enable' : 'disable'}:${point}`, async t => {
      const f = setup(t), { pkg } = await installed(f)
      if (enabled) await f.manager.handle(policy(pkg.target, 2, false))
      const c = policy(pkg.target, enabled ? 3 : 2, enabled)
      f.manager.checkpoint = crashed(point); await assert.rejects(f.manager.handle(c), /crash:/)
      const m = restart(f, { runtimeInstanceId: 'boot_after_policy' })
      m.verifyCandidate = () => assert.fail('READ must not probe an engine or provider')
      const read = await m.handle(reconcile(c))
      assert.equal(outcome(read), point === 'view-switched' ? 'APPLIED' : 'UNKNOWN')
      assert.equal(read.resultEnvelope.data.executionRuntimeInstanceId, 'boot_demo')
      const before = readdirSync(resolve(f.home, 'skills'))
      assert.deepEqual(before, point === 'view-switched' ? enabled ? ['repo-test'] : [] : enabled ? [] : ['repo-test'])
      await m.handle(c); await m.resumePendingCommands()
      assert.deepEqual(readdirSync(resolve(f.home, 'skills')), before); assert.equal(f.downloads(), 1)
      assert.equal(readdirSync(resolve(f.home, '.cyf-skill-view-staging')).length > 0, enabled || point === 'view-switched')
    })
})

test('startup and READ do not recreate a missing discovery parent or repeat an uncertain activation', async t => {
  const f = setup(t), pkg = f.add(packageFixture()), c = command(pkg.target)
  await f.manager.handle(c); const activation = activate(c)
  f.manager.checkpoint = crashed('activation-intent-persisted')
  await assert.rejects(f.manager.handle(activation), /crash:/)
  const root = resolve(f.home, 'skills'); rmSync(root, { recursive: true })
  const m = restart(f); assert.equal(existsSync(root), false)
  assert.equal(outcome(await m.handle(reconcile(activation))), 'UNKNOWN')
  assert.equal(existsSync(root), false); assert.equal(f.downloads(), 1)
})

test('cross-parent upgrade exchange treats package owner.json as ordinary bytes, not installer-lock evidence', async t => {
  const f = setup(t), first = f.add(packageFixture({ entries: [{ name: 'SKILL.md', data: skillDocument() },
    { name: 'owner.json', data: 'untrusted package content'.repeat(50000) }] })), prepare = command(first.target)
  await f.manager.handle(prepare); assert.equal(outcome(await f.manager.handle(activate(prepare))), 'APPLIED')
  const next = f.add(packageFixture({ version: '2.0.0' })), upgrade = command(next.target, { action: 'UPGRADE', source: first.target,
    skillChangeId: 'sc_upgrade', skillRevision: '2', fencingToken: '2' })
  assert.equal(outcome(await f.manager.handle(upgrade)), 'PREPARED')
  assert.equal(outcome(await f.manager.handle(activate(upgrade))), 'APPLIED')
  assert.deepEqual(readdirSync(resolve(f.home, 'skills')), ['repo-test'])
  assert.equal(f.manager.listInstalledSkills()[0].skillVersion, '2.0.0'); assert.equal(f.downloads(), 2)
})


test('archive file count is not limited to 256 when paths and approved bytes are valid', async t => {
  const f = setup(t)
  const pkg = f.add(packageFixture({ entries: [{ name: 'SKILL.md', data: skillDocument() },
    ...Array.from({ length: 260 }, (_, i) => ({ name: `docs/item-${i}.txt`, data: 'ok' }))] }))
  assert.equal(outcome(await f.manager.handle(command(pkg.target))), 'PREPARED')
})

test('default package and single-entry limits no longer reject 16MiB while aggregate extraction remains bounded', async t => {
  const f = setup(t)
  assert.ok(f.manager.maxPackageBytes > 16 * 1024 * 1024)
  assert.equal(f.manager.maxEntryBytes, Infinity)
  assert.equal(f.manager.maxExtractedBytes, 64 * 1024 * 1024)
})
