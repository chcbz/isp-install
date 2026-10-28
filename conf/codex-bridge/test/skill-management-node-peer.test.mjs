import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replyMessage } from '../message-envelope.mjs'
import { fromAgentWire } from '../agent-message-wire.mjs'
import { validateManagement } from '../skill-management-wire.mjs'
import { packageFixture, command, activate, policy, binding } from './fixtures/skill-management-fixture.mjs'

const peer = async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'smc1-java-node-peer-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/skill-management-node-peer.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise(done => child.once('exit', done)), diagnostics = []
  child.stderr.on('data', bytes => diagnostics.push(bytes.toString()))
  let current, nextId = 0
  child.once('exit', code => { if (current) { current.reject(new Error(`Node peer exited: ${code}`)); current = null } })
  createInterface({ input: child.stdout }).on('line', line => {
    const row = JSON.parse(line)
    assert.ok(current, line); current.rows.push(row)
    if (row.kind === 'done' || row.kind === 'error') { const done = current.resolve; const rows = current.rows; current = null; done(rows) }
  })
  t.after(async () => { child.stdin.end(); await closed; assert.deepEqual(diagnostics, []); rmSync(root, { recursive: true, force: true }) })
  const send = input => new Promise((resolveRows, reject) => {
    assert.ok(!current)
    current = { resolve: resolveRows, reject, rows: [] }; child.stdin.write(`${JSON.stringify({ ...input, id: `control_${++nextId}` })}\n`)
  })
  const receive = envelope => send({ op: 'receive', wireBase64: Buffer.from(typeof envelope === 'string' ? envelope : JSON.stringify(envelope)).toString('base64') })
  return { root, send, receive }
}
const envelopes = rows => rows.filter(row => ['ack', 'result'].includes(row.kind)).map(row => fromAgentWire(Buffer.from(row.wireBase64, 'base64').toString('utf8')))
const resultFor = (rows, command) => envelopes(rows).find(row => row.messageType === 'work.result' && row.data.commandId === command.data.commandId)
const catalog = rows => { const row = rows.find(row => row.kind === 'catalog'); assert.ok(row, JSON.stringify(rows)); return row.value }

test('stdin/stdout peer runs real Node install/upgrade/policy, retains old task package and replays original boot bytes without any network/model', async t => {
  const p = await peer(t), first = packageFixture(), second = packageFixture({ version: '2.0.0' })
  const init = await p.send({ op: 'init', root: p.root, apiOrigin: 'https://api.example.test', profileId: 'java-node-bridge', ...binding,
    testExecutableReadiness: false, packages: [first, second].map(pkg => ({ skillInstallationId: pkg.target.skillInstallationId, base64: pkg.bytes.toString('base64') })) })
  assert.equal(init[0].kind, 'ready'); assert.equal(init[0].dependencyBoundary, 'NO_EXECUTABLE_RUNNERS'); assert.equal(catalog(init).skillExecution.skills.length, 0)
  const prepare = command(first.target), prepared = await p.receive(prepare)
  assert.equal(envelopes(prepared)[0].messageType, 'command.ack'); assert.equal(resultFor(prepared, prepare).data.evidence.outcome, 'PREPARED')
  const activation = activate(prepare), applied = await p.receive(activation), fact = resultFor(applied, activation)
  assert.equal(fact.data.evidence.outcome, 'APPLIED'); validateManagement('CapabilityAdapterInput', catalog(applied))
  assert.equal(catalog(applied).skillExecution.skills[0].readiness, 'NOT_EXECUTABLE')
  const upgrade = command(second.target, { action: 'UPGRADE', source: first.target, skillChangeId: 'sc_upgrade', skillRevision: '2', fencingToken: '2' })
  assert.equal(resultFor(await p.receive(upgrade), upgrade).data.evidence.outcome, 'PREPARED')
  assert.equal(catalog(await p.receive(activate(upgrade))).skillExecution.skills[0].skillInstallationId, second.target.skillInstallationId)
  const disabled = await p.receive(policy(second.target, 3, false)); assert.equal(catalog(disabled).skillExecution.skills[0].enabled, false)
  const taskSkillBinding = { executionId: 'old_execution', taskGrantId: 'old_grant', taskGrantVersion: '1', agentId: binding.scope.agentId,
    skillKey: prepare.data.skillKey, ...Object.fromEntries(['skillInstallationId', 'productVersionId', 'skillVersion', 'packageSha256', 'manifestSha256'].map(key => [key, first.target[key]])),
    approvedPermissionsSha256: prepare.data.approvedPermissionsSha256 }
  const old = await p.send({ op: 'resolveNativeTask', taskSkillBinding }); assert.equal(old[0].value.skillInstallationId, first.target.skillInstallationId)
  assert.equal(old[0].value.approvedPermissionsSha256, prepare.data.approvedPermissionsSha256)
  await p.send({ op: 'restart', fence: { ...binding.fence, runtimeInstanceId: 'boot_after_java_restart', sessionGeneration: '2' } })
  const replay = await p.send({ op: 'replay' }), originalBytes = applied.find(row => row.kind === 'result' && fromAgentWire(Buffer.from(row.wireBase64, 'base64').toString()).messageId === fact.messageId).wireBase64
  assert.ok(replay.some(row => row.kind === 'result' && row.wireBase64 === originalBytes)); assert.equal(resultFor(replay, activation).data.executionRuntimeInstanceId, 'boot_demo')
  const receipt = replyMessage(fact, 'work.result.receipt', 'java_committed_receipt', 'E0', 'ok', { schemaVersion: 2,
    skillChangeId: fact.data.skillChangeId, commandId: fact.data.commandId, attempt: fact.data.attempt, receiptStatus: 'ACCEPTED' })
  await p.receive(receipt)
  assert.equal(envelopes(await p.send({ op: 'replay' })).some(row => row.messageId === fact.messageId), false)
  const malformed = JSON.stringify(command(first.target)).replace('"attempt":1', '"attempt":1e0')
  const rejected = await p.receive(malformed); assert.equal(rejected[0].kind, 'error'); assert.equal(envelopes(rejected).length, 0)
})
