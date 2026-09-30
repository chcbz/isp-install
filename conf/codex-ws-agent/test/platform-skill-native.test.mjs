import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { validatePlatformSkillCommand, validatePlatformSkillReceipt, downloadPlatformSkillPackage, sendPlatformSkillResult } from '../platform-skill-native.mjs'
import { LINUX_ATOMIC_FS } from '../skill-install-manager.mjs'
import { runManagedCommand } from '../agent-client.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const scope = { scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a', agentId: 'agt_a', runtimeInstanceId: 'runtime-a' }
const token = `AgentRuntime ${'1'.repeat(32)}`
const wire = () => ({ schemaVersion: 1, messageType: 'command.dispatch', messageId: 'message-a',
  commandId: `cmd_controlled_${hash(Buffer.from(['0', 'client-a', 'owner-a', 'psi_a', 'agt_a', 'PLATFORM_SKILL_INSTALL'].join('\0')))}`,
  correlationId: 'psi_a', causationId: 'challenge-a', tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a',
  taskId: 'psi_a', workItemId: null, targetAgentId: 'agt_a', commandType: 'PLATFORM_SKILL_INSTALL', issuedAt: 1, expiresAt: 3600001,
  attempt: 1, fencingToken: '1', deliveryEpoch: '1', executionEpoch: '1', payload: { schemaVersion: 1, installationId: 'psi_a', bindingVersion: '17',
    skillKey: 'archive-maintainer', skillVersion: '1.0.0', packageSha256: hash(Buffer.from('zip-fixture')), challengeId: 'challenge-a',
    packageRef: '/internal/agent/platform-skills/installations/psi_a/package' } })
const command = () => validatePlatformSkillCommand(wire(), scope, 1000)
const exactResponse = (url, bytes, contentType = 'application/zip') => {
  const r = new Response(bytes, { status: 200, headers: { 'content-length': String(Buffer.byteLength(bytes)), 'content-type': contentType } })
  Object.defineProperty(r, 'url', { value: String(url) }); return r
}
const view = c => ({ installationId: c.installationId, agentId: scope.agentId, bindingVersion: c.bindingVersion, skillKey: c.skillKey,
  skillVersion: c.skillVersion, packageSha256: c.packageSha256, origin: 'PLATFORM_PROVISIONED', state: 'SUCCEEDED', errorCode: null, revision: '2' })
const native = () => ({ wsUrl: 'wss://api.example.invalid/ws', command: command(), runtimeScope: scope, authorization: token })
test('exact wire validates as an independent platform command', () => {
  assert.equal(command().installationId, 'psi_a'); assert.equal(command().attempt, 1)
})
test('foreign scope, package URLs, version coercion and command spoofing fail', () => {
  for (const mutate of [m => { m.ownerJiacn = 'owner-b' }, m => { m.targetAgentId = 'agt_b' }, m => { m.commandId = 'cmd_fake' },
    m => { m.payload.packageRef = 'https://evil.invalid/package' }, m => { m.payload.bindingVersion = 17 }, m => { m.payload.bindingVersion = '017' },
    m => { m.payload.bindingVersion = '9223372036854775808' }, m => { m.payload.runtimeInstanceId = 'fake' }, m => { m.payload.challengeId = '../x' },
    m => { m.payload.installationId = undefined }, m => { m.attempt = '1' }, m => { m.executionEpoch = '2' }, m => { m.orderId = 'order' },
    m => { m.prompt = 'run shell' }, m => { m.expiresAt = 1000 }]) {
    const m = wire(); mutate(m); assert.throws(() => validatePlatformSkillCommand(m, scope, 1000))
  }
  assert.throws(() => validatePlatformSkillCommand(wire(), { ...scope, runtimeInstanceId: undefined }, 1000))
})
test('download uses exact origin and runtime-only headers and verifies bytes', async () => {
  const bytes = await downloadPlatformSkillPackage({ ...native(), fetchFn: async (url, options) => {
    assert.equal(String(url), 'https://api.example.invalid/internal/agent/platform-skills/installations/psi_a/package')
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, token)
    assert.equal(options.headers['X-Agent-Runtime-Id'], 'runtime-a'); assert.equal(options.headers['X-API-Key'], undefined)
    return exactResponse(url, Buffer.from('zip-fixture'))
  } }); assert.equal(bytes.toString(), 'zip-fixture')
})
test('remote cleartext, embedded credentials, redirect and mismatched digest fail', async () => {
  let requests = 0
  for (const wsUrl of ['ws://remote.invalid/ws', 'wss://user:pass@api.example.invalid/ws', 'wss://api.example.invalid/ws?token=x'])
    await assert.rejects(downloadPlatformSkillPackage({ ...native(), wsUrl, fetchFn: async () => { requests++; return {} } }))
  assert.equal(requests, 0)
  await assert.rejects(downloadPlatformSkillPackage({ ...native(), fetchFn: async url => exactResponse(url, Buffer.from('wrong-bytes')) }), { code: 'PLATFORM_SKILL_DIGEST_MISMATCH' })
  await assert.rejects(downloadPlatformSkillPackage({ ...native(), fetchFn: async url => exactResponse('https://evil.invalid/package', Buffer.from('zip-fixture')) }))
})
test('size limits and mismatched content length fail before accepting bytes', async () => {
  await assert.rejects(downloadPlatformSkillPackage({ ...native(), maxPackageBytes: 2, fetchFn: async url => exactResponse(url, Buffer.from('zip-fixture')) }))
  await assert.rejects(downloadPlatformSkillPackage({ ...native(), fetchFn: async url => { const r = exactResponse(url, Buffer.from('zip-fixture')); r.headers.set('content-length', '1'); return r } }))
})
test('result schema is independent and requires exact application receipt', async () => {
  const c = command()
  const receipt = await sendPlatformSkillResult({ ...native(), outcome: 'SUCCEEDED', fetchFn: async (url, options) => {
    assert.equal(String(url), 'https://api.example.invalid/internal/agent/platform-skills/installations/psi_a/result')
    const body = JSON.parse(options.body); assert.equal(body.challengeId, 'challenge-a'); assert.equal(body.ownerJiacn, undefined); assert.equal(body.orderId, undefined)
    return exactResponse(url, JSON.stringify(view(c)), 'application/json')
  } }); assert.equal(receipt.origin, 'PLATFORM_PROVISIONED')
})
test('lost POST is not automatically retried or reported accepted', async () => {
  let requests = 0
  await assert.rejects(sendPlatformSkillResult({ ...native(), outcome: 'SUCCEEDED', fetchFn: async () => { requests++; throw new Error('response lost') } }))
  assert.equal(requests, 1)
  await assert.rejects(sendPlatformSkillResult({ ...native(), outcome: 'SUCCEEDED', fetchFn: async url => exactResponse(url,
    JSON.stringify({ ...view(command()), origin: 'MARKETPLACE_PURCHASE' }), 'application/json') }), { code: 'PLATFORM_SKILL_RECEIPT_UNKNOWN' })
})
test('helpers cannot enable an unverified installer or generic shell fallback', async () => {
  let calls = 0
  const r = await runManagedCommand({ profile: { agentId: scope.agentId }, message: wire(), runCodexFn: async () => { calls++; return { status: 'completed' } } })
  assert.equal(calls, 0); assert.equal(r.status, 'failed'); assert.match(r.errorMessage, /CONTROLLED_COMMAND_UNAVAILABLE/)
})


test('receipt validator requires exact durable platform receipt shape', () => {
  const c = command(); const valid = view(c)
  assert.deepEqual(validatePlatformSkillReceipt(valid, c, scope, 'SUCCEEDED', null), valid)
  for (const mutate of [
    r => { r.extra = true }, r => { delete r.revision }, r => { r.origin = 'MARKETPLACE_PURCHASE' },
    r => { r.agentId = 'agt_b' }, r => { r.installationId = 'psi_b' }, r => { r.packageSha256 = '0'.repeat(64) },
    r => { r.state = 'FAILED' }, r => { r.errorCode = 'PLATFORM_SKILL_INSTALL_IO_FAILED' }, r => { r.revision = '0' }
  ]) {
    const candidate = { ...valid }; mutate(candidate)
    assert.throws(() => validatePlatformSkillReceipt(candidate, c, scope, 'SUCCEEDED', null), { code: 'PLATFORM_SKILL_RECEIPT_UNKNOWN' })
  }
})

test('Linux atomic no-replace works with libc renameat2 or exact syscall fallback', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(resolve(tmpdir(), 'platform-native-atomic-'))
  try {
    const source = resolve(root, 'source'); const target = resolve(root, 'target')
    writeFileSync(source, 'source')
    const moved = LINUX_ATOMIC_FS.renameNoReplace(source, target)
    assert.equal(moved.ok, true, JSON.stringify(moved)); assert.equal(existsSync(source), false); assert.equal(readFileSync(target, 'utf8'), 'source')

    const source2 = resolve(root, 'source-2'); writeFileSync(source2, 'second')
    const collision = LINUX_ATOMIC_FS.renameNoReplace(source2, target)
    assert.equal(collision.ok, false); assert.equal(collision.code, 'TARGET_EXISTS')
    assert.equal(readFileSync(source2, 'utf8'), 'second'); assert.equal(readFileSync(target, 'utf8'), 'source')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
