import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, sep } from 'node:path'
import test, { afterEach } from 'node:test'

import {
  PLATFORM_SKILL_FAILURE,
  PlatformSkillManager
} from '../platform-skill-manager.mjs'

const roots = []
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }) })
const temporaryDirectory = () => { const path = mkdtempSync(resolve(tmpdir(), 'platform-skill-')); roots.push(path); return path }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const zip = entries => {
  const localParts = []; const centralParts = []; let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8')
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data || '', 'utf8')
    const crc = crc32(data); const flags = 0x0800
    const mode = item.mode ?? (item.name.endsWith('/') ? 0o040755 : 0o100644)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    centralParts.push(central, name); offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centralParts); const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, directory, eocd])
}
const skill = (name = 'archive-maintainer', version = '1.0.0') => `---\nname: ${name}\ndescription: Maintain approved archives.\nmetadata:\n  version: "${version}"\n---\n\n# Archive maintainer\n`
const approvedFixture = readFileSync(new URL('./fixtures/archive-maintainer-1.0.0-approved.zip', import.meta.url))
const validPackage = () => Buffer.from(approvedFixture)

const scope = overrides => ({ scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a',
  agentId: 'agt_a', runtimeInstanceId: 'runtime-a', ...overrides })
const controlledId = installationId => `cmd_controlled_${hash(Buffer.from(['0', 'client-a', 'owner-a', installationId, 'agt_a', 'PLATFORM_SKILL_INSTALL'].join('\0')))}`
const wire = (bytes, overrides = {}) => {
  const { installationId = 'psi_a', challengeId = 'challenge-a', payload: payloadOverrides = {}, ...wireOverrides } = overrides
  const base = { schemaVersion: 1, messageType: 'command.dispatch', messageId: 'message-a', commandId: controlledId(installationId),
    correlationId: installationId, causationId: challengeId, tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a', taskId: installationId,
    workItemId: null, targetAgentId: 'agt_a', commandType: 'PLATFORM_SKILL_INSTALL', issuedAt: 1, expiresAt: 3600001,
    attempt: 1, fencingToken: '1', deliveryEpoch: '1', executionEpoch: '1', payload: { schemaVersion: 1, installationId,
      bindingVersion: '17', skillKey: 'archive-maintainer', skillVersion: '1.0.0', packageSha256: hash(bytes), challengeId,
      packageRef: `/internal/agent/platform-skills/installations/${installationId}/package` } }
  return { ...base, ...wireOverrides, payload: { ...base.payload, ...payloadOverrides } }
}
const receipt = (command, outcome = 'SUCCEEDED', errorCode = null, reclaimableInstallationIds = []) => ({ installationId: command.installationId, agentId: command.targetAgentId,
  bindingVersion: command.bindingVersion, skillKey: command.skillKey, skillVersion: command.skillVersion,
  packageSha256: command.packageSha256, origin: 'PLATFORM_PROVISIONED', state: outcome, errorCode, revision: '2', reclaimableInstallationIds })

const identity = path => {
  const status = lstatSync(path, { bigint: true })
  return { path: resolve(path), dev: status.dev.toString(), ino: status.ino.toString(),
    kind: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : status.isSymbolicLink() ? 'symlink' : 'other' }
}
const sameIdentity = (left, right) => left && right && left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
const fakeAtomic = {
  renameNoReplace(sourcePath, targetPath, expected = {}) {
    try {
      if (expected.sourceParent && !sameIdentity(identity(resolve(sourcePath, '..')), expected.sourceParent)) return { ok: false, code: 'PARENT_CHANGED_ROLLED_BACK', message: 'source parent changed' }
      if (expected.targetParent && !sameIdentity(identity(resolve(targetPath, '..')), expected.targetParent)) return { ok: false, code: 'PARENT_CHANGED_ROLLED_BACK', message: 'target parent changed' }
      if (expected.sourceIdentity && !sameIdentity(identity(sourcePath), expected.sourceIdentity)) return { ok: false, code: 'SOURCE_CHANGED', message: 'source changed' }
      if (existsSync(targetPath)) return { ok: false, code: 'TARGET_EXISTS', message: 'target exists' }
      renameSync(sourcePath, targetPath); return { ok: true, code: 'OK', message: '' }
    } catch (error) { return { ok: false, code: 'IO_ERROR', message: error.message } }
  }
}

const runtime = (settings = {}) => {
  const { root = temporaryDirectory(), bytes = validPackage(), runtimeScope = scope(), stateRoot,
    downloadFn, sendResultFn, atomicFs = fakeAtomic, maxPackageBytes, maxReplayBatch = 32,
    maxNativeCallMs, receiptReplayGraceMs, maxRetainedInstallationCopies, maxInstallationBytes,
    sessionSignal = null, now = () => 1000 } = settings
  const codexHome = resolve(root, 'codex-home'); mkdirSync(codexHome, { recursive: true })
  const selectedStateRoot = stateRoot || resolve(root, 'state')
  let downloads = 0; let sends = 0; let ids = 0
  const options = { profile: { profileId: 'profile-a', agentId: 'agt_a', codexHome }, runtimeScope,
    stateRoot: selectedStateRoot, wsUrl: 'wss://api.example.invalid/ws', atomicFs, now,
    createId: () => `id-${++ids}`, maxPackageBytes, maxReplayBatch, maxNativeCallMs, receiptReplayGraceMs,
    maxRetainedInstallationCopies, maxInstallationBytes, sessionSignal,
    authorizationProvider: async () => `AgentRuntime ${'1'.repeat(32)}`,
    downloadFn: async arguments_ => { downloads++; return downloadFn ? downloadFn(arguments_) : bytes },
    sendResultFn: async arguments_ => { sends++; return sendResultFn ? sendResultFn(arguments_) : receipt(arguments_.command, arguments_.outcome, arguments_.errorCode) } }
  if (Object.hasOwn(settings, 'enabled')) options.enabled = settings.enabled
  else options.enabled = true
  const manager = new PlatformSkillManager(options)
  manager.initialize()
  return { manager, root, codexHome, stateRoot: selectedStateRoot, bytes, counts: () => ({ downloads, sends }) }
}
const installationDirectory = (stateRoot, installationId) => resolve(stateRoot, 'installations', installationId)
const activatedTargets = codexHome => {
  const origin = resolve(codexHome, 'skills', 'platform-provisioned')
  if (!existsSync(origin)) return []
  return readdirSync(origin).flatMap(digest => {
    const version = resolve(origin, digest, 'archive-maintainer', '1.0.0')
    return existsSync(version) ? readdirSync(version).map(installationId => resolve(version, installationId)) : []
  }).filter(path => lstatSync(path).isDirectory()).sort()
}
const isActivationTarget = targetPath => basename(dirname(targetPath)) === '1.0.0' && basename(targetPath).startsWith('psi_')
const deferred = () => {
  let resolvePromise
  const promise = new Promise(resolve_ => { resolvePromise = resolve_ })
  return { promise, resolve: resolvePromise }
}

test('manager is default-off and persists an exact disabled result without downloading', async () => {
  const r = runtime({ enabled: undefined })
  const result = await r.manager.execute(wire(r.bytes))
  assert.equal(result.status, 'failed', result.errorMessage); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.DISABLED, result.errorMessage)
  assert.equal(result.result.attempt, 1); assert.deepEqual(r.counts(), { downloads: 0, sends: 1 })
  assert.deepEqual(activatedTargets(r.codexHome), [])
})

test('non-approved traversal, symlink, duplicate and identity-mismatched ZIPs fail before extraction', async t => {
  const cases = [
    ['traversal', zip([{ name: '../SKILL.md', data: skill() }])],
    ['symlink', zip([{ name: 'SKILL.md', data: 'target', mode: 0o120777 }])],
    ['duplicate', zip([{ name: 'SKILL.md', data: skill() }, { name: 'SKILL.md', data: skill() }])],
    ['identity', zip([{ name: 'SKILL.md', data: skill('other-skill') }])]
  ]
  for (const [name, bytes] of cases) await t.test(name, async () => {
    const r = runtime({ bytes })
    const result = await r.manager.execute(wire(bytes))
    assert.equal(result.status, 'failed'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
    assert.deepEqual(activatedTargets(r.codexHome), [])
  })
})

test('digest mismatch and package oversize are rejected independently of the downloader', async () => {
  const bytes = validPackage()
  const digestRuntime = runtime({ bytes })
  const digestResult = await digestRuntime.manager.execute(wire(bytes, { payload: { packageSha256: '0'.repeat(64) } }))
  assert.equal(digestResult.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
  const oversizeRuntime = runtime({ bytes, maxPackageBytes: bytes.length - 1 })
  const oversizeResult = await oversizeRuntime.manager.execute(wire(bytes))
  assert.equal(oversizeResult.failureCode, PLATFORM_SKILL_FAILURE.PACKAGE_INVALID)
})

test('approved fixture persists all 19 resource proofs and preserves every inode through activation', async () => {
  const r = runtime()
  const result = await r.manager.execute(wire(r.bytes))
  assert.equal(result.status, 'completed', result.errorMessage)
  const prepared = json(resolve(installationDirectory(r.stateRoot, 'psi_a'), 'prepared.json'))
  assert.equal(prepared.formatVersion, 3)
  assert.equal(prepared.packageProof.entries.length, 19)
  assert.equal(prepared.packageProof.packageSha256, hash(r.bytes))
  assert.equal(new Set(prepared.packageProof.entries.map(entry => entry.path)).size, 19)
  for (const entry of prepared.packageProof.entries) {
    const active = identity(resolve(prepared.targetPath, ...entry.path.split('/')))
    assert.equal(active.dev, entry.identity.dev, entry.path)
    assert.equal(active.ino, entry.identity.ino, entry.path)
    assert.equal(active.kind, 'file', entry.path)
  }
})

test('scope and origin are isolated and durable state contains no runtime credential', async () => {
  const r = runtime()
  const foreignScope = wire(r.bytes); foreignScope.ownerJiacn = 'owner-b'
  const scopeResult = await r.manager.execute(foreignScope)
  assert.equal(scopeResult.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT); assert.equal(r.counts().downloads, 0)
  const foreignOrigin = wire(r.bytes); foreignOrigin.origin = 'MARKETPLACE_PURCHASE'
  const originResult = await r.manager.execute(foreignOrigin)
  assert.equal(originResult.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT); assert.equal(r.counts().downloads, 0)
  const stateText = readFileSync(resolve(r.stateRoot, 'scope.json'), 'utf8')
  assert.doesNotMatch(stateText, /AgentRuntime|Authorization|11111111111111111111111111111111/)
})

test('messageId and attempt retransmission replays the original durable result without reinstalling', async () => {
  const r = runtime()
  const first = await r.manager.execute(wire(r.bytes))
  assert.equal(first.status, 'completed'); assert.equal(first.result.attempt, 1)
  const second = await r.manager.execute(wire(r.bytes, { messageId: 'message-b', attempt: 9 }))
  assert.equal(second.status, 'completed'); assert.equal(second.idempotent, true); assert.equal(second.result.attempt, 1)
  const conflicting = await r.manager.execute(wire(r.bytes, { challengeId: 'challenge-b' }))
  assert.equal(conflicting.status, 'failed'); assert.equal(conflicting.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
  const shiftedDeadline = await r.manager.execute(wire(r.bytes, { issuedAt: 2, expiresAt: 3600002 }))
  assert.equal(shiftedDeadline.status, 'failed'); assert.equal(shiftedDeadline.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
  assert.deepEqual(r.counts(), { downloads: 1, sends: 1 })
})

test('lost result response survives restart and replays the exact old attempt without redownload', async () => {
  const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
  const first = runtime({ root, bytes, stateRoot, sendResultFn: async () => { throw new Error('response lost') } })
  const pending = await first.manager.execute(wire(bytes))
  assert.equal(pending.status, 'recovery_required'); assert.equal(pending.result.attempt, 1)
  let posted
  const restarted = runtime({ root, bytes, stateRoot, sendResultFn: async arguments_ => {
    posted = arguments_; return receipt(arguments_.command, arguments_.outcome, arguments_.errorCode)
  } })
  const replayed = await restarted.manager.execute(wire(bytes, { messageId: 'message-retry', attempt: 7 }))
  assert.equal(replayed.status, 'completed'); assert.equal(replayed.result.attempt, 1); assert.equal(posted.command.attempt, 1)
  assert.deepEqual(restarted.counts(), { downloads: 0, sends: 1 })
})

test('success replay verifies the full package and rejects activation or durable record tampering', async t => {
  for (const [name, mutate] of [
    ['resource tamper', target => writeFileSync(resolve(target, 'scripts', 'parse-text.mjs'), 'tampered')],
    ['missing resource', target => unlinkSync(resolve(target, 'schemas', 'content.json'))],
    ['extra resource', target => writeFileSync(resolve(target, 'extra.txt'), 'extra')],
    ['symlink resource', target => { unlinkSync(resolve(target, 'SKILL.md')); symlinkSync('manifest.json', resolve(target, 'SKILL.md')) }]
  ]) await t.test(name, async () => {
    const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
    const first = runtime({ root, bytes, stateRoot, sendResultFn: async () => { throw new Error('lost') } })
    assert.equal((await first.manager.execute(wire(bytes))).status, 'recovery_required')
    mutate(activatedTargets(first.codexHome)[0])
    const restarted = runtime({ root, bytes, stateRoot })
    const result = await restarted.manager.execute(wire(bytes))
    assert.equal(result.status, 'recovery_required'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
    assert.equal(restarted.counts().sends, 0)
  })
  await t.test('result tamper', async () => {
    const r = runtime(); await r.manager.execute(wire(r.bytes))
    const path = resolve(installationDirectory(r.stateRoot, 'psi_a'), 'result.json'); const record = json(path)
    record.result.attempt = 999; writeFileSync(path, JSON.stringify(record))
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'failed'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
  })
  await t.test('receipt tamper', async () => {
    const r = runtime(); await r.manager.execute(wire(r.bytes))
    const path = resolve(installationDirectory(r.stateRoot, 'psi_a'), 'receipt.json'); const record = json(path)
    record.receipt.origin = 'MARKETPLACE_PURCHASE'; writeFileSync(path, JSON.stringify(record))
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'failed'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
  })
})

test('journal publication failure leaves no final or temporary command record', async () => {
  const atomicFs = { renameNoReplace(sourcePath, targetPath, expected) {
    if (basename(targetPath) === 'command.json') return { ok: false, code: 'IO_ERROR', message: 'injected journal fault' }
    return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
  } }
  const r = runtime({ atomicFs })
  const result = await r.manager.execute(wire(r.bytes))
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.IO_FAILED)
  const directory = installationDirectory(r.stateRoot, 'psi_a')
  assert.equal(existsSync(resolve(directory, 'command.json')), false)
  assert.deepEqual(readdirSync(directory).filter(name => name.includes('command.json')), [])
})

test('PREPARED activation fault requires fresh authorized download before restart activation', async () => {
  const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
  const failingAtomic = { renameNoReplace(sourcePath, targetPath, expected) {
    if (isActivationTarget(targetPath)) return { ok: false, code: 'IO_ERROR', message: 'injected activation fault' }
    return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
  } }
  const first = runtime({ root, bytes, stateRoot, atomicFs: failingAtomic })
  const pending = await first.manager.execute(wire(bytes))
  assert.equal(pending.status, 'recovery_required'); assert.equal(first.counts().downloads, 1)
  assert.equal(existsSync(resolve(installationDirectory(stateRoot, 'psi_a'), 'prepared.json')), true)
  const restarted = runtime({ root, bytes, stateRoot })
  const completed = await restarted.manager.execute(wire(bytes))
  assert.equal(completed.status, 'completed', completed.errorMessage); assert.deepEqual(restarted.counts(), { downloads: 1, sends: 1 })
})

test('PREPARED restart denied by rotated server registration remains recovery-required and never activates', async () => {
  const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
  const failingAtomic = { renameNoReplace(sourcePath, targetPath, expected) {
    if (isActivationTarget(targetPath)) return { ok: false, code: 'IO_ERROR', message: 'injected activation fault' }
    return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
  } }
  const first = runtime({ root, bytes, stateRoot, atomicFs: failingAtomic })
  assert.equal((await first.manager.execute(wire(bytes))).status, 'recovery_required')
  const restarted = runtime({ root, bytes, stateRoot, downloadFn: async () => { throw new Error('server registrationHash denied') } })
  const result = await restarted.manager.execute(wire(bytes))
  assert.equal(result.status, 'recovery_required', result.errorMessage)
  assert.equal(result.activationCommitted, false)
  assert.deepEqual(restarted.counts(), { downloads: 1, sends: 0 })
  assert.deepEqual(activatedTargets(restarted.codexHome), [])
})

test('command-only restart reauthorizes the exact package under the original deadline', async () => {
  const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
  const controller = new AbortController()
  const first = runtime({ root, bytes, stateRoot, sessionSignal: controller.signal,
    downloadFn: async () => new Promise(() => {}) })
  const pending = first.manager.execute(wire(bytes))
  await new Promise(resolvePromise => setImmediate(resolvePromise))
  controller.abort(new Error('socket rotated'))
  const fenced = await pending
  assert.equal(fenced.status, 'recovery_required', fenced.errorMessage)
  const directory = installationDirectory(stateRoot, 'psi_a')
  assert.equal(existsSync(resolve(directory, 'command.json')), true)
  assert.equal(existsSync(resolve(directory, 'prepared.json')), false)
  assert.equal(existsSync(resolve(directory, 'result.json')), false)

  const restarted = runtime({ root, bytes, stateRoot })
  const completed = await restarted.manager.execute(wire(bytes))
  assert.equal(completed.status, 'completed', completed.errorMessage)
  assert.deepEqual(restarted.counts(), { downloads: 1, sends: 1 })
})

test('legacy PREPARED durable format fails closed without rewrite or scope migration', async () => {
  const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
  const failingAtomic = { renameNoReplace(sourcePath, targetPath, expected) {
    if (isActivationTarget(targetPath)) return { ok: false, code: 'IO_ERROR', message: 'injected activation fault' }
    return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
  } }
  const first = runtime({ root, bytes, stateRoot, atomicFs: failingAtomic })
  assert.equal((await first.manager.execute(wire(bytes))).status, 'recovery_required')
  const preparedPath = resolve(installationDirectory(stateRoot, 'psi_a'), 'prepared.json')
  const legacy = json(preparedPath); legacy.formatVersion = 2; writeFileSync(preparedPath, JSON.stringify(legacy))
  const before = readFileSync(preparedPath)
  const restarted = runtime({ root, bytes, stateRoot })
  const result = await restarted.manager.execute(wire(bytes))
  assert.equal(result.status, 'failed')
  assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
  assert.deepEqual(readFileSync(preparedPath), before)
  assert.deepEqual(restarted.counts(), { downloads: 0, sends: 0 })
})

test('same installation rejects a different in-flight business fingerprint', async () => {
  const gate = deferred(); const bytes = validPackage()
  const r = runtime({ bytes, downloadFn: async () => { await gate.promise; return bytes } })
  const firstPromise = r.manager.execute(wire(bytes))
  const conflicting = await r.manager.execute(wire(bytes, { challengeId: 'challenge-b' }))
  assert.equal(conflicting.status, 'failed'); assert.equal(conflicting.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
  gate.resolve(); assert.equal((await firstPromise).status, 'completed')
})

test('target and parent races fail closed without replacing foreign content', async t => {
  await t.test('target race', async () => {
    const racingAtomic = { renameNoReplace(sourcePath, targetPath, expected) {
      if (isActivationTarget(targetPath)) {
        mkdirSync(targetPath); writeFileSync(resolve(targetPath, 'foreign.txt'), 'foreign')
        return { ok: false, code: 'TARGET_EXISTS', message: 'target raced' }
      }
      return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
    } }
    const r = runtime({ atomicFs: racingAtomic })
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'recovery_required'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
    const target = activatedTargets(r.codexHome)[0]
    assert.equal(readFileSync(resolve(target, 'foreign.txt'), 'utf8'), 'foreign')
    assert.equal(existsSync(resolve(target, 'SKILL.md')), false)
  })
  await t.test('target-parent race', async () => {
    let movedParent = ''
    const racingAtomic = { renameNoReplace(sourcePath, targetPath, expected) {
      if (isActivationTarget(targetPath)) {
        const parent = dirname(targetPath); movedParent = `${parent}-old`; renameSync(parent, movedParent); mkdirSync(parent)
      }
      return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
    } }
    const r = runtime({ atomicFs: racingAtomic })
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'recovery_required'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
    assert.equal(existsSync(resolve(movedParent, 'psi_a')), false)
    assert.equal(existsSync(resolve(dirname(movedParent), basename(movedParent).replace(/-old$/, ''), 'psi_a')), false)
  })
})

test('foreign symlink namespace is rejected before any recursive write crosses it', async () => {
  const root = temporaryDirectory(); const foreign = resolve(root, 'foreign'); mkdirSync(foreign)
  const codexHome = resolve(root, 'codex-home'); mkdirSync(codexHome)
  symlinkSync(foreign, resolve(codexHome, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
  const r = runtime({ root })
  const result = await r.manager.execute(wire(r.bytes))
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.IO_FAILED)
  assert.deepEqual(readdirSync(foreign), [])
})

test('missing command or result is explicit unknown and replay is bounded with cursor progress', async () => {
  const r = runtime({ maxReplayBatch: 2 })
  for (const name of ['psi_a', 'psi_b', 'psi_c']) mkdirSync(installationDirectory(r.stateRoot, name))
  const first = await r.manager.replayPending(2)
  assert.equal(first.length, 2); assert(first.every(item => item.status === 'unknown'))
  const second = await r.manager.replayPending(2)
  assert.equal(second.length, 1); assert.equal(second[0].status, 'unknown'); assert.equal(second[0].installationId, 'psi_c')

  const root = temporaryDirectory(); const stateRoot = resolve(root, 'state')
  const failResultAtomic = { renameNoReplace(sourcePath, targetPath, expected) {
    if (basename(targetPath) === 'result.json') return { ok: false, code: 'IO_ERROR', message: 'injected result journal fault' }
    return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
  } }
  const incomplete = runtime({ root, stateRoot, enabled: false, atomicFs: failResultAtomic })
  assert.equal((await incomplete.manager.execute(wire(incomplete.bytes, { installationId: 'psi_d' }))).status, 'failed')
  const restarted = runtime({ root, stateRoot, enabled: false })
  const replay = await restarted.manager.replayPending(2)
  assert.equal(replay.length, 1, replay[0]?.errorMessage); assert.equal(replay[0].status, 'recovery_required', replay[0].errorMessage)
})

test('download completion after immutable command expiry cannot create PREPARED or activate', async () => {
  const gate = deferred(); const bytes = validPackage(); let clock = 1000
  const r = runtime({ bytes, now: () => clock, downloadFn: async () => gate.promise })
  const operation = r.manager.execute(wire(bytes))
  await new Promise(resolvePromise => setImmediate(resolvePromise))
  clock = 3600001
  gate.resolve(bytes)
  const result = await operation
  assert.notEqual(result.status, 'completed', result.errorMessage)
  assert.equal(result.result?.outcome, 'FAILED', result.errorMessage)
  assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.IO_FAILED, result.errorMessage)
  assert.equal(existsSync(resolve(installationDirectory(r.stateRoot, 'psi_a'), 'prepared.json')), false)
  assert.deepEqual(activatedTargets(r.codexHome), [])
})

test('expiry is rechecked before PREPARED publication and immediately before atomic activation', async t => {
  await t.test('before PREPARED', async () => {
    let clock = 1000
    const atomicFs = { renameNoReplace(sourcePath, targetPath, expected) {
      const result = fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
      if (result.ok && basename(targetPath) === '.cyf-platform-installation.json') clock = 3600001
      return result
    } }
    const r = runtime({ now: () => clock, atomicFs })
    const result = await r.manager.execute(wire(r.bytes))
    assert.notEqual(result.status, 'completed', result.errorMessage)
    assert.equal(existsSync(resolve(installationDirectory(r.stateRoot, 'psi_a'), 'prepared.json')), false)
    assert.deepEqual(activatedTargets(r.codexHome), [])
  })
  await t.test('before activation', async () => {
    let clock = 1000
    const atomicFs = { renameNoReplace(sourcePath, targetPath, expected) {
      const result = fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
      if (result.ok && basename(targetPath) === 'prepared.json') clock = 3600001
      return result
    } }
    const r = runtime({ now: () => clock, atomicFs })
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'recovery_required', result.errorMessage)
    assert.equal(result.activationCommitted, false)
    assert.equal(existsSync(resolve(installationDirectory(r.stateRoot, 'psi_a'), 'prepared.json')), true)
    assert.deepEqual(activatedTargets(r.codexHome), [])
  })
})

test('never-settling custom download and result POST are bounded and release in-flight state', async t => {
  await t.test('download', async () => {
    const r = runtime({ maxNativeCallMs: 25, downloadFn: async () => new Promise(() => {}) })
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'failed', result.errorMessage)
    assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.IO_FAILED, result.errorMessage)
    assert.equal(r.manager.inFlight.size, 0)
    assert.deepEqual(r.counts(), { downloads: 1, sends: 1 })
    assert.deepEqual(activatedTargets(r.codexHome), [])
  })
  await t.test('result POST', async () => {
    let observedSignal
    const r = runtime({ maxNativeCallMs: 25, sendResultFn: async arguments_ => {
      observedSignal = arguments_.signal
      return new Promise(() => {})
    } })
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'recovery_required', result.errorMessage)
    assert.equal(result.result.outcome, 'SUCCEEDED')
    assert.equal(result.activationCommitted, true)
    assert.equal(observedSignal?.aborted, true)
    assert.equal(r.manager.inFlight.size, 0)
    assert.deepEqual(r.counts(), { downloads: 1, sends: 1 })
  })
})

test('durable success replays the exact old result only within bounded receipt grace', async t => {
  await t.test('inside grace', async () => {
    const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state'); let clock = 1000
    const first = runtime({ root, bytes, stateRoot, now: () => clock, receiptReplayGraceMs: 1000,
      sendResultFn: async () => { throw new Error('response lost') } })
    const pending = await first.manager.execute(wire(bytes))
    assert.equal(pending.status, 'recovery_required', pending.errorMessage)
    clock = 3600500
    let posted
    const restarted = runtime({ root, bytes, stateRoot, now: () => clock, receiptReplayGraceMs: 1000,
      sendResultFn: async arguments_ => { posted = arguments_; return receipt(arguments_.command, arguments_.outcome, arguments_.errorCode) } })
    const [replayed] = await restarted.manager.replayPending(1)
    assert.equal(replayed.status, 'completed', replayed.errorMessage)
    assert.equal(replayed.result.attempt, 1)
    assert.equal(posted.command.attempt, 1)
    assert.equal(posted.command.issuedAt, 1)
    assert.equal(posted.command.expiresAt, 3600001)
    assert.deepEqual(restarted.counts(), { downloads: 0, sends: 1 })
  })
  await t.test('after grace', async () => {
    const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state'); let clock = 1000
    const first = runtime({ root, bytes, stateRoot, now: () => clock, receiptReplayGraceMs: 1000,
      sendResultFn: async () => { throw new Error('response lost') } })
    assert.equal((await first.manager.execute(wire(bytes))).status, 'recovery_required')
    const installation = installationDirectory(stateRoot, 'psi_a')
    const durableSuccess = readFileSync(resolve(installation, 'result.json'))
    clock = 3601001
    const restarted = runtime({ root, bytes, stateRoot, now: () => clock, receiptReplayGraceMs: 1000 })
    const [replayed] = await restarted.manager.replayPending(1)
    assert.equal(replayed.status, 'recovery_required')
    assert.equal(replayed.outcome, 'SUCCEEDED')
    assert.equal(replayed.failureCode, null)
    assert.equal(replayed.errorMessage, `PLATFORM_SKILL_RECEIPT_PENDING: ${PLATFORM_SKILL_FAILURE.IO_FAILED}`)
    assert.equal(replayed.result.outcome, 'SUCCEEDED')
    assert.equal(replayed.activationCommitted, true)
    assert.deepEqual(restarted.counts(), { downloads: 0, sends: 0 })
    assert.equal(existsSync(resolve(installation, 'receipt.json')), false)
    assert.deepEqual(readFileSync(resolve(installation, 'result.json')), durableSuccess)
  })
})

test('same runtime installs a new command after old expiry while fenced old success remains immutable', async () => {
  const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state'); let clock = 1000
  let oldPosts = 0; let newPostedCommand
  const r = runtime({ root, bytes, stateRoot, now: () => clock, sendResultFn: async arguments_ => {
    if (arguments_.command.installationId === 'psi_a') {
      oldPosts++
      if (oldPosts === 1) throw new Error('old result response timed out')
      throw new Error('PLATFORM_SKILL_RESULT_FENCED: old installation result is fenced')
    }
    newPostedCommand = arguments_.command
    return receipt(arguments_.command, arguments_.outcome, arguments_.errorCode)
  } })
  const oldCommand = wire(bytes, { installationId: 'psi_a' })
  const oldPending = await r.manager.execute(oldCommand)
  assert.equal(oldPending.status, 'recovery_required', oldPending.errorMessage)
  assert.equal(oldPending.result.outcome, 'SUCCEEDED')
  const oldDirectory = installationDirectory(stateRoot, 'psi_a')
  const preparedA = json(resolve(oldDirectory, 'prepared.json'))
  const oldMarkerPath = resolve(preparedA.targetPath, '.cyf-platform-installation.json')
  const oldResultPath = resolve(oldDirectory, 'result.json')
  const oldTargetIdentity = identity(preparedA.targetPath)
  const oldMarkerIdentity = identity(oldMarkerPath)
  const oldMarker = readFileSync(oldMarkerPath)
  const oldResult = readFileSync(oldResultPath)
  assert.equal(existsSync(resolve(oldDirectory, 'receipt.json')), false)

  clock = oldCommand.expiresAt + 100
  const newIssuedAt = oldCommand.expiresAt + 1
  const newExpiresAt = newIssuedAt + 3600000
  const newCommand = wire(bytes, { installationId: 'psi_b', challengeId: 'challenge-b', issuedAt: newIssuedAt, expiresAt: newExpiresAt })
  const installed = await r.manager.execute(newCommand)
  assert.equal(installed.status, 'completed', installed.errorMessage)
  assert.equal(newPostedCommand.installationId, 'psi_b')
  assert.equal(newPostedCommand.issuedAt, newIssuedAt)
  assert.equal(newPostedCommand.expiresAt, newExpiresAt)
  const newDirectory = installationDirectory(stateRoot, 'psi_b')
  const preparedB = json(resolve(newDirectory, 'prepared.json'))
  assert.notEqual(preparedA.targetPath, preparedB.targetPath)
  assert.equal(basename(preparedA.targetPath), 'psi_a')
  assert.equal(basename(preparedB.targetPath), 'psi_b')
  const markerB = json(resolve(preparedB.targetPath, '.cyf-platform-installation.json'))
  assert.equal(markerB.challengeId, 'challenge-b')
  assert.equal(markerB.issuedAt, newIssuedAt)
  assert.equal(markerB.expiresAt, newExpiresAt)
  assert.equal(sameIdentity(identity(preparedA.targetPath), oldTargetIdentity), true)
  assert.equal(sameIdentity(identity(oldMarkerPath), oldMarkerIdentity), true)
  assert.deepEqual(readFileSync(oldMarkerPath), oldMarker)

  const replayed = await r.manager.replayPending(2)
  assert.equal(replayed.length, 2)
  assert.equal(replayed[0].outcome, 'SUCCEEDED')
  assert.equal(replayed[0].status, 'recovery_required', replayed[0].errorMessage)
  assert.match(replayed[0].errorMessage, /RESULT_FENCED/)
  assert.equal(replayed[0].result.installationId, 'psi_a')
  assert.equal(replayed[0].result.attempt, 1)
  assert.equal(replayed[1].status, 'completed', replayed[1].errorMessage)
  assert.equal(existsSync(resolve(oldDirectory, 'receipt.json')), false)
  assert.deepEqual(readFileSync(oldResultPath), oldResult)
  assert.equal(json(oldResultPath).result.outcome, 'SUCCEEDED')
  assert.equal(json(resolve(newDirectory, 'receipt.json')).receipt.installationId, 'psi_b')
  assert.equal(sameIdentity(identity(preparedA.targetPath), oldTargetIdentity), true)
  assert.equal(sameIdentity(identity(oldMarkerPath), oldMarkerIdentity), true)
  assert.deepEqual(readFileSync(oldMarkerPath), oldMarker)
  assert.deepEqual(r.counts(), { downloads: 2, sends: 3 })
})

test('same CODEX_HOME isolates new runtime scope and installation in immutable physical namespaces', async () => {
  const root = temporaryDirectory(); const bytes = validPackage()
  const first = runtime({ root, bytes, stateRoot: resolve(root, 'state-a'), runtimeScope: scope({ runtimeInstanceId: 'runtime-a' }) })
  const firstResult = await first.manager.execute(wire(bytes, { installationId: 'psi_a' }))
  assert.equal(firstResult.status, 'completed', firstResult.errorMessage)
  const second = runtime({ root, bytes, stateRoot: resolve(root, 'state-b'), runtimeScope: scope({ runtimeInstanceId: 'runtime-b' }) })
  const secondResult = await second.manager.execute(wire(bytes, { installationId: 'psi_b', challengeId: 'challenge-b' }))
  assert.equal(secondResult.status, 'completed', secondResult.errorMessage)
  const targets = activatedTargets(first.codexHome)
  assert.equal(targets.length, 2); assert.notEqual(targets[0], targets[1])
  const preparedA = json(resolve(installationDirectory(first.stateRoot, 'psi_a'), 'prepared.json'))
  const preparedB = json(resolve(installationDirectory(second.stateRoot, 'psi_b'), 'prepared.json'))
  assert.notEqual(preparedA.targetPath, preparedB.targetPath)
  assert.equal(targets.includes(preparedA.targetPath), true); assert.equal(targets.includes(preparedB.targetPath), true)
  const approvedSkill = readFileSync(resolve(preparedA.targetPath, 'SKILL.md'))
  assert.equal(approvedSkill.length, 1876)
  assert.equal(hash(approvedSkill), 'aeaae95b2343dcc5c7bcdee268db9743023d10539d4b3de77b36b8e47b7ace77')
  const markers = targets.map(target => json(resolve(target, '.cyf-platform-installation.json')))
  assert.deepEqual(new Set(markers.map(marker => marker.runtimeInstanceId)), new Set(['runtime-a', 'runtime-b']))
  assert.notEqual(markers[0].scopeDigest, markers[1].scopeDigest)
  assert(targets.every(target => target.includes(`${sep}skills${sep}platform-provisioned${sep}`)))
})


test('server-authorized reclaim enforces the retained-copy quota using verified real package bytes', async () => {
  const r = runtime({ maxRetainedInstallationCopies: 2, sendResultFn: async arguments_ =>
    receipt(arguments_.command, arguments_.outcome, arguments_.errorCode,
      arguments_.command.installationId === 'psi_c' ? ['psi_a'] : []) })
  for (const installationId of ['psi_a', 'psi_b', 'psi_c']) {
    const result = await r.manager.execute(wire(r.bytes, { installationId, messageId: `message-${installationId}` }))
    assert.equal(result.status, 'completed', result.errorMessage)
  }
  assert.deepEqual(activatedTargets(r.codexHome).map(path => basename(path)), ['psi_b', 'psi_c'])
  assert.equal(existsSync(installationDirectory(r.stateRoot, 'psi_a')), false)
})

test('quota refuses a fourth copy when the server protects every retained installation', async () => {
  const r = runtime({ maxRetainedInstallationCopies: 2 })
  for (const installationId of ['psi_a', 'psi_b', 'psi_c']) {
    const result = await r.manager.execute(wire(r.bytes, { installationId, messageId: `message-${installationId}` }))
    assert.equal(result.status, 'completed', result.errorMessage)
  }
  const refused = await r.manager.execute(wire(r.bytes, { installationId: 'psi_d', messageId: 'message-psi_d' }))
  assert.equal(refused.status, 'failed')
  assert.equal(refused.failureCode, PLATFORM_SKILL_FAILURE.IO_FAILED)
  assert.deepEqual(activatedTargets(r.codexHome).map(path => basename(path)), ['psi_a', 'psi_b', 'psi_c'])
})


test('persisted server reclaim receipt completes registry cleanup after crash removed only the target', async () => {
  const root = temporaryDirectory(); const stateRoot = resolve(root, 'state')
  const first = runtime({ root, stateRoot, maxRetainedInstallationCopies: 3, sendResultFn: async arguments_ =>
    receipt(arguments_.command, arguments_.outcome, arguments_.errorCode,
      arguments_.command.installationId === 'psi_c' ? ['psi_a'] : []) })
  const commands = new Map()
  for (const installationId of ['psi_a', 'psi_b', 'psi_c']) {
    const command = wire(first.bytes, { installationId, messageId: `message-${installationId}` })
    commands.set(installationId, command)
    const result = await first.manager.execute(command)
    assert.equal(result.status, 'completed', result.errorMessage)
  }
  const targetA = activatedTargets(first.codexHome).find(path => basename(path) === 'psi_a')
  assert.ok(targetA); rmSync(targetA, { recursive: true, force: false })
  assert.equal(existsSync(installationDirectory(stateRoot, 'psi_a')), true)

  const restarted = runtime({ root, stateRoot, maxRetainedInstallationCopies: 2 })
  const recovered = await restarted.manager.execute(commands.get('psi_c'))
  assert.equal(recovered.status, 'completed', recovered.errorMessage)
  assert.equal(existsSync(installationDirectory(stateRoot, 'psi_a')), false)
  assert.deepEqual(activatedTargets(restarted.codexHome).map(path => basename(path)), ['psi_b', 'psi_c'])
})


test('reclaim restart uses authorizing C durable receipt when A own successful receipt was lost', async () => {
  const root = temporaryDirectory(); const stateRoot = resolve(root, 'state')
  const first = runtime({ root, stateRoot, maxRetainedInstallationCopies: 3, sendResultFn: async args => {
    if (args.command.installationId === 'psi_a') throw new Error('A success response lost')
    return receipt(args.command, args.outcome, args.errorCode, args.command.installationId === 'psi_c' ? ['psi_a'] : [])
  } })
  const commands = new Map()
  for (const id of ['psi_a', 'psi_b', 'psi_c']) {
    const command = wire(first.bytes, { installationId: id, messageId: `message-${id}` })
    commands.set(id, command)
    const result = await first.manager.execute(command)
    assert.equal(result.status, id === 'psi_a' ? 'recovery_required' : 'completed', result.errorMessage)
    assert.equal(result.result.outcome, 'SUCCEEDED')
  }
  const directoryA = installationDirectory(stateRoot, 'psi_a')
  assert.equal(existsSync(resolve(directoryA, 'receipt.json')), false)
  const preparedA = json(resolve(directoryA, 'prepared.json'))
  // Exact crash window: authorized physical target removed, registry not yet removed.
  rmSync(preparedA.targetPath, { recursive: true, force: false })
  const restarted = runtime({ root, stateRoot, maxRetainedInstallationCopies: 2,
    sendResultFn: async () => { throw new Error('durable C receipt must suffice without network') } })
  const result = await restarted.manager.execute(commands.get('psi_c'))
  assert.equal(result.status, 'completed', result.errorMessage)
  assert.equal(existsSync(directoryA), false)
  assert.deepEqual(activatedTargets(first.codexHome).map(path => basename(path)), ['psi_b', 'psi_c'])
  assert.deepEqual(restarted.counts(), { downloads: 0, sends: 0 })
})

test('missing reclaim target never relaxes authorizing receipt scope or candidate parent proof', async t => {
  for (const mutation of ['C scope', 'A parent proof', 'A command scope']) await t.test(mutation, async () => {
    const root = temporaryDirectory(); const stateRoot = resolve(root, 'state')
    const first = runtime({ root, stateRoot, maxRetainedInstallationCopies: 3, sendResultFn: async args => {
      if (args.command.installationId === 'psi_a') throw new Error('lost A receipt')
      return receipt(args.command, args.outcome, args.errorCode, args.command.installationId === 'psi_c' ? ['psi_a'] : [])
    } })
    let commandC
    for (const id of ['psi_a', 'psi_b', 'psi_c']) {
      const command = wire(first.bytes, { installationId: id, messageId: `message-${id}` })
      const result = await first.manager.execute(command)
      assert.equal(result.status, id === 'psi_a' ? 'recovery_required' : 'completed', result.errorMessage)
      if (id === 'psi_c') commandC = command
    }
    const directoryA = installationDirectory(stateRoot, 'psi_a')
    const preparedPath = resolve(directoryA, 'prepared.json'); const prepared = json(preparedPath)
    rmSync(prepared.targetPath, { recursive: true, force: false })
    if (mutation === 'C scope') {
      const path = resolve(installationDirectory(stateRoot, 'psi_c'), 'receipt.json'); const record = json(path)
      record.scopeDigest = '0'.repeat(64); writeFileSync(path, JSON.stringify(record))
    } else if (mutation === 'A parent proof') {
      prepared.targetParentIdentity.ino = '0'; writeFileSync(preparedPath, JSON.stringify(prepared))
    } else {
      const path = resolve(directoryA, 'command.json'); const record = json(path)
      record.command.ownerJiacn = 'foreign-owner'; writeFileSync(path, JSON.stringify(record))
    }
    const restarted = runtime({ root, stateRoot, maxRetainedInstallationCopies: 2 })
    const result = await restarted.manager.execute(commandC)
    assert.equal(result.status, mutation === 'C scope' ? 'failed' : 'recovery_required', result.errorMessage)
    assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
    assert.equal(existsSync(directoryA), true)
    assert.deepEqual(activatedTargets(first.codexHome).map(path => basename(path)), ['psi_b', 'psi_c'])
  })
})

test('more than 32 real package installations consume progressing bounded server reclaim batches', async () => {
  // This server contract model retains every fenced tombstone and journals each receipt.
  const tombstones = []; const receipts = new Map(); let cursor = 0; let lost35 = false
  const protectedId = 'psi_001'
  const root = temporaryDirectory(); const stateRoot = resolve(root, 'state')
  const sendResultFn = async args => {
    const id = args.command.installationId
    if (receipts.has(id)) return receipts.get(id)
    const candidates = tombstones.filter(candidate => candidate !== protectedId)
    let selected = candidates.slice(cursor, cursor + 32)
    if (!selected.length && candidates.length) { cursor = 0; selected = candidates.slice(0, 32) }
    cursor += selected.length
    const response = receipt(args.command, args.outcome, args.errorCode, selected)
    receipts.set(id, response); tombstones.push(id)
    if (id === 'psi_035' && !lost35) { lost35 = true; throw new Error('server committed 35 receipt; response lost') }
    return response
  }
  let r = runtime({ root, stateRoot, maxRetainedInstallationCopies: 2, sendResultFn })
  for (let index = 1; index <= 40; index++) {
    const id = `psi_${String(index).padStart(3, '0')}`
    const command = wire(r.bytes, { installationId: id, messageId: `message-${id}` })
    let result = await r.manager.execute(command)
    if (index === 35) {
      assert.equal(result.status, 'recovery_required', result.errorMessage)
      assert.equal(result.activationCommitted, true)
      assert.equal(activatedTargets(r.codexHome).length, 3)
      // Before installing 36, restart/replay the exact lost receipt of 35.
      r = runtime({ root, stateRoot, maxRetainedInstallationCopies: 2, sendResultFn })
      result = await r.manager.execute(command)
      assert.deepEqual(r.counts(), { downloads: 0, sends: 1 })
    }
    assert.equal(result.status, 'completed', `${index}: ${result.errorMessage}`)
    assert(result.receipt.reclaimableInstallationIds.length <= 32)
    assert(!result.receipt.reclaimableInstallationIds.includes(protectedId))
    assert(activatedTargets(r.codexHome).length <= 2)
    assert.equal(existsSync(installationDirectory(r.stateRoot, protectedId)), true)
    if (index === 10 || index === 36) {
      r = runtime({ root, stateRoot, maxRetainedInstallationCopies: 2,
        sendResultFn: async () => { throw new Error('durable receipt replay must not request a new batch') } })
      assert.equal((await r.manager.execute(command)).status, 'completed')
      assert.deepEqual(r.counts(), { downloads: 0, sends: 0 })
      r = runtime({ root, stateRoot, maxRetainedInstallationCopies: 2, sendResultFn })
    }
  }
  assert.equal(tombstones.length, 40)
  assert.deepEqual(activatedTargets(r.codexHome).map(path => basename(path)), [protectedId, 'psi_040'])
})


// Kill only this test's child after the real manager fsyncs the registry (empty)
// or its actual createJsonOnce fsyncs the command temporary file (temporary).
// Normal exception unwinding would unlink that temporary file and miss the crash.
const crashBeforeCommandPublication = (r, kind) => {
  const settings = { stateRoot: r.stateRoot, profile: { profileId: 'profile-a', agentId: 'agt_a', codexHome: r.codexHome },
    runtimeScope: scope(), wsUrl: 'wss://api.example.invalid/ws', enabled: true }
  const script = `
    import { PlatformSkillManager } from ${JSON.stringify(new URL('../platform-skill-manager.mjs', import.meta.url).href)};
    import { basename } from 'node:path';
    import { existsSync, renameSync } from 'node:fs';
    const kind = ${JSON.stringify(kind)};
    const crash = () => { process.kill(process.pid, 'SIGKILL'); throw new Error('SIGKILL did not stop child'); };
    const atomicFs = { renameNoReplace(source, target) {
      if (kind === 'temporary' && basename(target) === 'command.json') crash();
      if (existsSync(target)) return { ok: false, code: 'TARGET_EXISTS', message: 'exists' };
      renameSync(source, target); return { ok: true, code: 'OK', message: '' };
    } };
    let ids = 0;
    const manager = new PlatformSkillManager({ ...${JSON.stringify(settings)}, atomicFs, now: () => 1000,
      createId: () => 'crash-' + (++ids),
      authorizationProvider: async () => { throw new Error('crash must precede authorization'); },
      downloadFn: async () => { throw new Error('crash must precede download'); },
      sendResultFn: async () => { throw new Error('crash must precede result'); } });
    manager.initialize();
    if (kind === 'empty') {
      const writeOnce = manager._writeOnce.bind(manager);
      manager._writeOnce = (path, ...args) => {
        if (basename(path) === 'command.json') crash();
        return writeOnce(path, ...args);
      };
    }
    await manager.execute(${JSON.stringify(wire(r.bytes))});
    process.exitCode = 99;
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 15000 })
  assert.equal(child.error, undefined, child.error?.message)
  assert.equal(child.status, null, child.stderr)
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  const directory = installationDirectory(r.stateRoot, 'psi_a')
  assert.equal(lstatSync(directory).isDirectory(), true)
  assert.equal(lstatSync(directory).mode & 0o777, 0o700)
  assert.equal(existsSync(resolve(directory, 'command.json')), false)
  const entries = readdirSync(directory)
  assert.equal(entries.length, kind === 'empty' ? 0 : 1)
  if (kind === 'temporary') {
    assert.match(entries[0], /^\.command\.json\.tmp-[1-9][0-9]*-crash-[1-9][0-9]*$/u)
    assert.equal(json(resolve(directory, entries[0])).command.installationId, 'psi_a')
    assert.equal(lstatSync(resolve(directory, entries[0])).mode & 0o777, 0o600)
  }
  return { directory, entries }
}

test('command publication crash preserves empty or actual fsynced temporary registry unknown while new B installs', async t => {
  for (const kind of ['empty', 'temporary']) await t.test(kind, async () => {
    const first = runtime()
    const { directory, entries } = crashBeforeCommandPublication(first, kind)
    const evidence = entries.map(name => readFileSync(resolve(directory, name)))
    const restarted = runtime({ root: first.root, stateRoot: first.stateRoot })
    const replay = await restarted.manager.replayPending()
    assert.equal(replay.length, 1)
    assert.equal(replay[0].installationId, 'psi_a')
    assert.equal(replay[0].status, 'unknown')
    assert.deepEqual(restarted.counts(), { downloads: 0, sends: 0 })
    const result = await restarted.manager.execute(wire(restarted.bytes, { installationId: 'psi_b', messageId: 'message-b' }))
    assert.equal(result.status, 'completed', result.errorMessage)
    assert.equal(result.result.outcome, 'SUCCEEDED')
    assert.deepEqual(restarted.counts(), { downloads: 1, sends: 1 })
    assert.equal(restarted.manager.getInstallation('psi_a').status, 'unknown')
    assert.equal(existsSync(directory), true)
    assert.deepEqual(readdirSync(directory), entries)
    entries.forEach((name, index) => assert.deepEqual(readFileSync(resolve(directory, name)), evidence[index]))
    assert.deepEqual(activatedTargets(restarted.codexHome).map(path => basename(path)), ['psi_b'])
  })
})

test('commandless registry with unexpected residuals or unsafe temporary proof blocks new B without deleting evidence', async t => {
  for (const mutation of ['result residual', 'temporary symlink', 'temporary hardlink', 'temporary directory',
    'temporary permissions', 'registry permissions', 'foreign temporary scope', 'malformed temporary name', 'corrupt temporary']) await t.test(mutation, async () => {
    const first = runtime()
    const { directory, entries } = crashBeforeCommandPublication(first, 'temporary')
    const temporaryPath = resolve(directory, entries[0])
    const outside = resolve(first.root, 'outside-command.json')
    if (mutation === 'result residual') writeFileSync(resolve(directory, 'result.json'), '{}', { mode: 0o600 })
    else if (mutation === 'temporary symlink') {
      renameSync(temporaryPath, outside); symlinkSync(outside, temporaryPath)
    } else if (mutation === 'temporary hardlink') linkSync(temporaryPath, outside)
    else if (mutation === 'temporary directory') { unlinkSync(temporaryPath); mkdirSync(temporaryPath, { mode: 0o700 }) }
    else if (mutation === 'temporary permissions') chmodSync(temporaryPath, 0o644)
    else if (mutation === 'registry permissions') chmodSync(directory, 0o755)
    else if (mutation === 'foreign temporary scope') {
      const record = json(temporaryPath); record.command.ownerJiacn = 'foreign-owner'; writeFileSync(temporaryPath, JSON.stringify(record))
    } else if (mutation === 'malformed temporary name') renameSync(temporaryPath, resolve(directory, '.command.json.tmp-unproven'))
    else writeFileSync(temporaryPath, '{incomplete')
    const retainedEntries = readdirSync(directory)
    const restarted = runtime({ root: first.root, stateRoot: first.stateRoot })
    const replay = await restarted.manager.replayPending()
    assert.equal(replay[0].status, 'unknown')
    const result = await restarted.manager.execute(wire(restarted.bytes, { installationId: 'psi_b', messageId: 'message-b' }))
    assert.equal(result.status, 'failed', result.errorMessage)
    assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
    assert.deepEqual(restarted.counts(), { downloads: 0, sends: 0 })
    assert.equal(existsSync(directory), true)
    assert.deepEqual(readdirSync(directory), retainedEntries)
    assert.deepEqual(activatedTargets(restarted.codexHome), [])
    if (existsSync(outside)) assert.equal(json(outside).command.installationId, 'psi_a')
  })
})
