import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
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
const validPackage = () => zip([{ name: 'SKILL.md', data: skill() }])

const scope = overrides => ({ scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a',
  agentId: 'agt_a', runtimeInstanceId: 'runtime-a', ...overrides })
const controlledId = installationId => `cmd_controlled_${hash(Buffer.from(['0', 'client-a', 'owner-a', installationId, 'agt_a', 'PLATFORM_SKILL_INSTALL'].join('\0')))}`
const wire = (bytes, overrides = {}) => {
  const installationId = overrides.installationId || 'psi_a'
  const challengeId = overrides.challengeId || 'challenge-a'
  const base = { schemaVersion: 1, messageType: 'command.dispatch', messageId: 'message-a', commandId: controlledId(installationId),
    correlationId: installationId, causationId: challengeId, tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a', taskId: installationId,
    workItemId: null, targetAgentId: 'agt_a', commandType: 'PLATFORM_SKILL_INSTALL', issuedAt: 1, expiresAt: 3600001,
    attempt: 1, fencingToken: '1', deliveryEpoch: '1', executionEpoch: '1', payload: { schemaVersion: 1, installationId,
      bindingVersion: '17', skillKey: 'archive-maintainer', skillVersion: '1.0.0', packageSha256: hash(bytes), challengeId,
      packageRef: `/internal/agent/platform-skills/installations/${installationId}/package` } }
  const merged = { ...base, ...overrides, payload: { ...base.payload, ...(overrides.payload || {}) } }
  if (overrides.installationId) {
    merged.correlationId = installationId; merged.taskId = installationId; merged.commandId = controlledId(installationId)
    merged.payload.installationId = installationId; merged.payload.packageRef = `/internal/agent/platform-skills/installations/${installationId}/package`
  }
  if (overrides.challengeId) { merged.causationId = challengeId; merged.payload.challengeId = challengeId }
  return merged
}
const receipt = (command, outcome = 'SUCCEEDED', errorCode = null) => ({ installationId: command.installationId, agentId: command.targetAgentId,
  bindingVersion: command.bindingVersion, skillKey: command.skillKey, skillVersion: command.skillVersion,
  packageSha256: command.packageSha256, origin: 'PLATFORM_PROVISIONED', state: outcome, errorCode, revision: '2' })

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

const runtime = ({ root = temporaryDirectory(), bytes = validPackage(), enabled = true, runtimeScope = scope(), stateRoot,
  downloadFn, sendResultFn, atomicFs = fakeAtomic, maxPackageBytes, maxReplayBatch = 32 } = {}) => {
  const codexHome = resolve(root, 'codex-home'); mkdirSync(codexHome, { recursive: true })
  const selectedStateRoot = stateRoot || resolve(root, 'state')
  let downloads = 0; let sends = 0; let ids = 0
  const options = { profile: { profileId: 'profile-a', agentId: 'agt_a', codexHome }, runtimeScope,
    stateRoot: selectedStateRoot, wsUrl: 'wss://api.example.invalid/ws', atomicFs, now: () => 1000,
    createId: () => `id-${++ids}`, maxPackageBytes, maxReplayBatch,
    authorizationProvider: async () => `AgentRuntime ${'1'.repeat(32)}`,
    downloadFn: async arguments_ => { downloads++; return downloadFn ? downloadFn(arguments_) : bytes },
    sendResultFn: async arguments_ => { sends++; return sendResultFn ? sendResultFn(arguments_) : receipt(arguments_.command, arguments_.outcome, arguments_.errorCode) } }
  if (enabled !== undefined) options.enabled = enabled
  const manager = new PlatformSkillManager(options)
  manager.initialize()
  return { manager, root, codexHome, stateRoot: selectedStateRoot, bytes, counts: () => ({ downloads, sends }) }
}
const installationDirectory = (stateRoot, installationId) => resolve(stateRoot, 'installations', installationId)
const activatedTargets = codexHome => {
  const origin = resolve(codexHome, 'skills', 'platform-provisioned')
  if (!existsSync(origin)) return []
  return readdirSync(origin).map(digest => resolve(origin, digest, 'archive-maintainer', '1.0.0')).filter(existsSync).sort()
}
const deferred = () => {
  let resolvePromise
  const promise = new Promise(resolve_ => { resolvePromise = resolve_ })
  return { promise, resolve: resolvePromise }
}

test('manager is default-off and persists an exact disabled result without downloading', async () => {
  const r = runtime({ enabled: undefined })
  const result = await r.manager.execute(wire(r.bytes))
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.DISABLED)
  assert.equal(result.result.attempt, 1); assert.deepEqual(r.counts(), { downloads: 0, sends: 1 })
  assert.deepEqual(activatedTargets(r.codexHome), [])
})

test('malicious traversal, symlink, duplicate and identity-mismatched ZIPs fail closed', async t => {
  const cases = [
    ['traversal', zip([{ name: '../SKILL.md', data: skill() }])],
    ['symlink', zip([{ name: 'SKILL.md', data: 'target', mode: 0o120777 }])],
    ['duplicate', zip([{ name: 'SKILL.md', data: skill() }, { name: 'SKILL.md', data: skill() }])],
    ['identity', zip([{ name: 'SKILL.md', data: skill('other-skill') }])]
  ]
  for (const [name, bytes] of cases) await t.test(name, async () => {
    const r = runtime({ bytes })
    const result = await r.manager.execute(wire(bytes))
    assert.equal(result.status, 'failed'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.PACKAGE_INVALID)
    assert.deepEqual(activatedTargets(r.codexHome), [])
  })
})

test('digest mismatch and package oversize are rejected independently of the downloader', async () => {
  const bytes = validPackage()
  const digestRuntime = runtime({ bytes })
  const digestResult = await digestRuntime.manager.execute(wire(bytes, { payload: { packageSha256: '0'.repeat(64) } }))
  assert.equal(digestResult.failureCode, PLATFORM_SKILL_FAILURE.DIGEST_MISMATCH)
  const oversizeRuntime = runtime({ bytes, maxPackageBytes: bytes.length - 1 })
  const oversizeResult = await oversizeRuntime.manager.execute(wire(bytes))
  assert.equal(oversizeResult.failureCode, PLATFORM_SKILL_FAILURE.PACKAGE_INVALID)
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

test('success replay verifies SKILL.md and rejects activation or durable record tampering', async t => {
  await t.test('SKILL.md tamper', async () => {
    const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
    const first = runtime({ root, bytes, stateRoot, sendResultFn: async () => { throw new Error('lost') } })
    assert.equal((await first.manager.execute(wire(bytes))).status, 'recovery_required')
    writeFileSync(resolve(activatedTargets(first.codexHome)[0], 'SKILL.md'), `${skill()}tampered`)
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

test('PREPARED activation fault resumes after restart without downloading again', async () => {
  const root = temporaryDirectory(); const bytes = validPackage(); const stateRoot = resolve(root, 'state')
  const failingAtomic = { renameNoReplace(sourcePath, targetPath, expected) {
    if (basename(targetPath) === '1.0.0') return { ok: false, code: 'IO_ERROR', message: 'injected activation fault' }
    return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
  } }
  const first = runtime({ root, bytes, stateRoot, atomicFs: failingAtomic })
  const pending = await first.manager.execute(wire(bytes))
  assert.equal(pending.status, 'recovery_required'); assert.equal(first.counts().downloads, 1)
  assert.equal(existsSync(resolve(installationDirectory(stateRoot, 'psi_a'), 'prepared.json')), true)
  const restarted = runtime({ root, bytes, stateRoot })
  const completed = await restarted.manager.execute(wire(bytes))
  assert.equal(completed.status, 'completed'); assert.deepEqual(restarted.counts(), { downloads: 0, sends: 1 })
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
      if (basename(targetPath) === '1.0.0') {
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
      if (basename(targetPath) === '1.0.0') {
        const parent = dirname(targetPath); movedParent = `${parent}-old`; renameSync(parent, movedParent); mkdirSync(parent)
      }
      return fakeAtomic.renameNoReplace(sourcePath, targetPath, expected)
    } }
    const r = runtime({ atomicFs: racingAtomic })
    const result = await r.manager.execute(wire(r.bytes))
    assert.equal(result.status, 'recovery_required'); assert.equal(result.failureCode, PLATFORM_SKILL_FAILURE.CONFLICT)
    assert.equal(existsSync(resolve(movedParent, '1.0.0')), false)
    assert.equal(existsSync(resolve(dirname(movedParent), basename(movedParent).replace(/-old$/, ''), '1.0.0')), false)
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
  assert.equal(replay.length, 1); assert.equal(replay[0].status, 'unknown')
})

test('same CODEX_HOME isolates new runtime scope and installation in immutable physical namespaces', async () => {
  const root = temporaryDirectory(); const bytes = validPackage()
  const first = runtime({ root, bytes, stateRoot: resolve(root, 'state-a'), runtimeScope: scope({ runtimeInstanceId: 'runtime-a' }) })
  assert.equal((await first.manager.execute(wire(bytes, { installationId: 'psi_a' }))).status, 'completed')
  const second = runtime({ root, bytes, stateRoot: resolve(root, 'state-b'), runtimeScope: scope({ runtimeInstanceId: 'runtime-b' }) })
  assert.equal((await second.manager.execute(wire(bytes, { installationId: 'psi_b', challengeId: 'challenge-b' }))).status, 'completed')
  const targets = activatedTargets(first.codexHome)
  assert.equal(targets.length, 2); assert.notEqual(targets[0], targets[1])
  const preparedA = json(resolve(installationDirectory(first.stateRoot, 'psi_a'), 'prepared.json'))
  const preparedB = json(resolve(installationDirectory(second.stateRoot, 'psi_b'), 'prepared.json'))
  assert.notEqual(preparedA.targetPath, preparedB.targetPath)
  assert.equal(targets.includes(preparedA.targetPath), true); assert.equal(targets.includes(preparedB.targetPath), true)
  assert.equal(readFileSync(resolve(preparedA.targetPath, 'SKILL.md'), 'utf8'), skill())
  const markers = targets.map(target => json(resolve(target, '.cyf-platform-installation.json')))
  assert.deepEqual(new Set(markers.map(marker => marker.runtimeInstanceId)), new Set(['runtime-a', 'runtime-b']))
  assert.notEqual(markers[0].scopeDigest, markers[1].scopeDigest)
  assert(targets.every(target => target.includes(`${sep}skills${sep}platform-provisioned${sep}`)))
})
