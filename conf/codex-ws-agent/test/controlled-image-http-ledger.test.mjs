import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { ControlledImageHttpLedger } from '../controlled-image-http-ledger.mjs'
import { CONTROLLED_IMAGE_MAX_PROFILE_ID_LENGTH } from '../controlled-image-http-config.mjs'

const digest = 'a'.repeat(64)

const managedAgent = 'agt_0123456789abcdef0123456789abcdef'
const managedGeneration = 'hri_00000000-0000-0000-0000-000000000001'
const managedOwner = 'o'.repeat(28)
const managedProfile = `managed:owner-${Buffer.from(managedOwner).toString('base64url')}:${managedAgent}:${managedGeneration}`
const maxManagedProfile = `managed:owner-${Buffer.from('o'.repeat(50)).toString('base64url')}:${managedAgent}:${managedGeneration}`
const claim = overrides => ({ commandId: 'command-1', requestDigest: digest,
  bindingId: 'binding-1', bindingEpoch: '1', modelId: 'image-model', ...overrides })
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-ledger-test-'))
  const ledgerRoot = resolve(root, 'ledger')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, ledgerRoot }
}

test('exclusive durable claim survives restart and blocks a second executor', t => {
  const f = fixture(t)
  const first = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  const created = first.createClaim(claim())
  const record = JSON.parse(readFileSync(created.path, 'utf8'))
  assert.equal(record.state, 'CLAIMED')
  assert.equal(record.commandId, 'command-1')
  const restarted = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  assert.throws(() => restarted.createClaim(claim()), error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
})

test('canonical 130-character and maximum ManagedHost profiles keep full identity through claim replay', t => {
  const f = fixture(t)
  assert.equal(managedProfile.length, 130)
  assert.equal(maxManagedProfile.length, CONTROLLED_IMAGE_MAX_PROFILE_ID_LENGTH)
  for (const [index, profileId] of [managedProfile, maxManagedProfile].entries()) {
    const rootDir = resolve(f.root, `managed-ledger-${index}`)
    const first = new ControlledImageHttpLedger({ rootDir, profileId, agentId: managedAgent })
    const created = first.createClaim(claim({ commandId: 'managed-command' }))
    assert.equal(JSON.parse(readFileSync(created.path, 'utf8')).profileId, profileId)
    const restarted = new ControlledImageHttpLedger({ rootDir, profileId, agentId: managedAgent })
    assert.equal(restarted.claimPath('managed-command'), created.path)
    assert.throws(() => restarted.createClaim(claim({ commandId: 'managed-command' })),
      error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
  }
})

test('managed identity admission rejects truncation substitutes mismatched Agents and unrelated overlong IDs', t => {
  const f = fixture(t)
  for (const [profileId, agentId] of [
    [managedProfile.slice(0, -1), managedAgent],
    [managedProfile, 'agt_11111111111111111111111111111111'],
    [`profile-${'x'.repeat(123)}`, managedAgent],
    [`managed:owner-${Buffer.from(`${managedOwner}x`).toString('base64url')}:${managedAgent}:${managedGeneration}x`, managedAgent]
  ]) assert.throws(() => new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId, agentId }),
    error => error.code === 'CONTROLLED_IMAGE_LEDGER_CONFIG_INVALID')

  const ledger = new ControlledImageHttpLedger({ rootDir: resolve(f.root, 'valid-ledger'),
    profileId: managedProfile, agentId: managedAgent })
  assert.throws(() => ledger.claimPath(`c${'x'.repeat(100)}`),
    error => error.code === 'CONTROLLED_IMAGE_COMMAND_INVALID')
})

test('concurrent ledger instances admit exactly one claim', async t => {
  const f = fixture(t)
  const left = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  const right = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => left.createClaim(claim())),
    Promise.resolve().then(() => right.createClaim(claim()))
  ])
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(value => value.status === 'rejected'
    && value.reason.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED').length, 1)
})

test('corrupt existing claim and changed request remain irreversible no-fetch barriers', t => {
  const f = fixture(t)
  const ledger = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  const path = ledger.createClaim(claim()).path
  writeFileSync(path, '{broken', { mode: 0o600 })
  const restarted = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  assert.throws(() => restarted.createClaim(claim({ requestDigest: 'b'.repeat(64) })),
    error => error.code === 'CONTROLLED_IMAGE_CLAIM_CORRUPT')

  const second = new ControlledImageHttpLedger({ rootDir: resolve(f.root, 'second-ledger'),
    profileId: 'profile-a', agentId: 'agent-a' })
  const secondPath = second.createClaim(claim()).path
  const altered = JSON.parse(readFileSync(secondPath, 'utf8'))
  altered.commandId = 'other-command'
  writeFileSync(secondPath, `${JSON.stringify(altered)}\n`, { mode: 0o600 })
  assert.throws(() => second.createClaim(claim()), error => error.code === 'CONTROLLED_IMAGE_CLAIM_CORRUPT')
})

test('claim identity is stable across binding epochs but isolated by profile and Agent scope', t => {
  const f = fixture(t)
  const first = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  const same = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  const other = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-b', agentId: 'agent-b' })
  assert.equal(first.claimPath('command-1'), same.claimPath('command-1'))
  assert.notEqual(first.claimPath('command-1'), other.claimPath('command-1'))
  first.createClaim(claim({ bindingEpoch: '1' }))
  assert.throws(() => same.createClaim(claim({ bindingEpoch: '2' })),
    error => error.code === 'CONTROLLED_IMAGE_ALREADY_CLAIMED')
})

test('claim contract rejects overlong IDs and epochs outside the server long range', t => {
  const f = fixture(t)
  const ledger = new ControlledImageHttpLedger({ rootDir: f.ledgerRoot, profileId: 'profile-a', agentId: 'agent-a' })
  for (const invalid of [
    claim({ bindingId: `b${'x'.repeat(100)}` }),
    claim({ modelId: `m${'x'.repeat(100)}` }),
    claim({ bindingEpoch: '9223372036854775808' })
  ]) assert.throws(() => ledger.createClaim(invalid), error => error.code === 'CONTROLLED_IMAGE_CLAIM_INVALID')
})

test('symlinked or non-private ledger roots are rejected', t => {
  const f = fixture(t)
  const target = resolve(f.root, 'target')
  mkdirSync(target, { mode: 0o700 })
  const link = resolve(f.root, 'link')
  symlinkSync(target, link)
  assert.throws(() => new ControlledImageHttpLedger({ rootDir: link, profileId: 'profile-a', agentId: 'agent-a' }),
    error => error.code === 'CONTROLLED_IMAGE_LEDGER_UNSAFE')
  const publicRoot = resolve(f.root, 'public')
  mkdirSync(publicRoot, { mode: 0o755 })
  assert.throws(() => new ControlledImageHttpLedger({ rootDir: publicRoot, profileId: 'profile-a', agentId: 'agent-a' }),
    error => error.code === 'CONTROLLED_IMAGE_LEDGER_PERMISSIONS')
})
