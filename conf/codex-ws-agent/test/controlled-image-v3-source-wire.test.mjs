import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  buildControlledImageBountyExecutionV3Declaration,
  controlledImageBountyExecutionV3Enabled
} from '../controlled-image-bounty-v3-capability.mjs'
import { parseControlledImageV3ConversationCommand } from '../conversation-controlled-image-v3.mjs'
import { parseControlledImageConversationCommand } from '../conversation-controlled-image.mjs'
import { controlledImageV3InputDigest, parseControlledImageV3Inputs } from '../conversation-reference-inputs-v3.mjs'

const fixturePath = resolve(import.meta.dirname, 'fixtures/controlled-image-v3-source-wire-v1.json')
const bytes = readFileSync(fixturePath)
const fixture = JSON.parse(bytes)
const clone = value => JSON.parse(JSON.stringify(value))

test('frozen v3 fixture and fail-closed declaration remain byte-exact without real readiness', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'fdb9d863982b50e923ffd8761143cba159262f9ca7abed60849a7dbabc46386d')
  assert.deepEqual(buildControlledImageBountyExecutionV3Declaration({ ready: true }), fixture.disabledDeclaration)
  assert.equal(fixture.validCases.every(item => item.status === 'NOT_RUN'), true)
  assert.equal(fixture.negativeCases.every(item => item.status === 'NOT_RUN'), true)
})

test('v3 readiness requires exact live profile, runtime, Provider policy, executor, and poll lane', () => {
  const profile = {
    enabled: true, status: '', controlledImageHttpEnabled: true,
    controlledImageHttpBindingId: 'binding-1', controlledImageHttpBindingEpoch: '7',
    controlledImageHttpModelId: 'operator-model'
  }
  const runtime = {
    adapterKind: 'CONTROLLED_IMAGE_HTTP_V1', configReady: true, credentialReady: true,
    httpPollEnabled: true, controlledImageV3Ready: true, executor: () => {}, pollProtocol: { poll() {} },
    controlledConfig: { enabled: true, providerLane: 'CONTROLLED_IMAGE_HTTP_V1', bindingId: 'binding-1',
      bindingEpoch: '7', modelId: 'operator-model', maxInputItems: 16,
      maxOutboundRequestAttempts: 1, precallFenceVersion: 1 }
  }
  assert.equal(controlledImageBountyExecutionV3Enabled({ profile, runtime, online: true }), true)
  const enabled = buildControlledImageBountyExecutionV3Declaration({ profile, runtime, online: true })
  assert.equal(enabled.enabled, true)
  assert.deepEqual(enabled.operations.map(item => item.operation), ['GENERATE_IMAGE', 'EDIT_IMAGE'])
  for (const readiness of [
    { profile, runtime, online: false },
    { profile: { ...profile, status: 'offline' }, runtime, online: true },
    { profile: { ...profile, controlledImageHttpBindingId: 'other-binding' }, runtime, online: true },
    { profile, runtime: { ...runtime, controlledImageV3Ready: false }, online: true },
    { profile, runtime: { ...runtime, credentialReady: false }, online: true },
    { profile, runtime: { ...runtime, executor: null }, online: true },
    { profile, runtime: { ...runtime, pollProtocol: null }, online: true },
    { profile, runtime: { ...runtime, controlledConfig: { ...runtime.controlledConfig, maxOutboundRequestAttempts: 2 } }, online: true }
  ]) {
    const declaration = buildControlledImageBountyExecutionV3Declaration(readiness)
    assert.equal(declaration.enabled, false)
    assert.deepEqual(declaration.operations, [])
  }
})

test('all valid fixture commands, source snapshots, canonical bytes, and digests parse exactly', () => {
  for (const item of fixture.validCases) {
    const command = parseControlledImageV3ConversationCommand(item.command)
    const snapshot = parseControlledImageV3Inputs(item.inputSnapshot, command, item.startReceipt.leaseVersion)
    assert.equal(snapshot.canonicalUtf8, item.inputDigestCanonicalUtf8, item.caseId)
    assert.equal(createHash('sha256').update(snapshot.canonicalUtf8).digest('hex'), item.inputDigestSha256, item.caseId)
    assert.equal(snapshot.inputSnapshotDigest, item.command.inputSnapshotDigest, item.caseId)
  }
})

test('v2 and v3 command parsers remain disjoint and exact-field strict', () => {
  const v3 = fixture.validCases[0].command
  const oldFixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/controlled-image-bridge-v1.json')))
  assert.throws(() => parseControlledImageConversationCommand(v3), /CONTROLLED_IMAGE_COMMAND_INVALID/)
  assert.throws(() => parseControlledImageV3ConversationCommand(oldFixture.wire.command), /CONTROLLED_IMAGE_V3_COMMAND_INVALID/)
  for (const mutation of [
    { ...v3, extra: true },
    Object.fromEntries(Object.entries(v3).filter(([key]) => key !== 'operation')),
    { ...v3, operation: 'UPSCALE_IMAGE' },
    { ...v3, inputSnapshotDigest: 'A'.repeat(64) },
    { ...v3, executionId: '' }
  ]) assert.throws(() => parseControlledImageV3ConversationCommand(mutation), /CONTROLLED_IMAGE_V3_COMMAND_INVALID/)
})

test('source union, decimal longs, operation cardinality, and duplicate sources fail closed', () => {
  const workspace = fixture.validCases.find(item => item.caseId === 'generate_workspace')
  const edit = fixture.validCases.find(item => item.caseId === 'edit_exact_asset')
  const mutations = []
  for (const value of [1, '0', '01', '9223372036854775808']) {
    const changed = clone(workspace.inputSnapshot); changed.inputs[0].byteLength = value; mutations.push([workspace.command, changed])
  }
  {
    const changed = clone(workspace.inputSnapshot); changed.inputs[0].source.extra = true; mutations.push([workspace.command, changed])
  }
  {
    const changed = clone(workspace.inputSnapshot); changed.inputs[0].source.purpose = 'INPUT'; mutations.push([workspace.command, changed])
  }
  {
    const changed = clone(edit.inputSnapshot); changed.inputs[0].source.conversationId = 'conversation_other'; mutations.push([edit.command, changed])
  }
  {
    const changed = clone(edit.inputSnapshot); changed.inputs = []; changed.noReferencedMaterials = true; mutations.push([edit.command, changed])
  }
  {
    const changed = clone(workspace.inputSnapshot); changed.inputs.push(clone(changed.inputs[0])); changed.inputs[1].inputRef = 'input_2'; mutations.push([workspace.command, changed])
  }
  for (const [rawCommand, snapshot] of mutations) {
    const command = parseControlledImageV3ConversationCommand(rawCommand)
    assert.throws(() => parseControlledImageV3Inputs(snapshot, command, 1), /CONTROLLED_IMAGE_V3_INPUTS_UNAVAILABLE/)
  }
})

test('workspace, conversation, and asset source revisions are bound into the input snapshot digest', () => {
  const workspace = fixture.validCases.find(item => item.caseId === 'generate_workspace')
  const edit = fixture.validCases.find(item => item.caseId === 'edit_exact_asset')
  const changedDigests = []
  for (const [item, field] of [
    [workspace, 'version'],
    [edit, 'conversationGeneration'],
    [edit, 'assetRevision']
  ]) {
    const changed = clone(item.inputSnapshot)
    changed.inputs[0].source[field] = String(BigInt(changed.inputs[0].source[field]) + 1n)
    const digest = controlledImageV3InputDigest({
      command: item.command,
      noReferencedMaterials: changed.noReferencedMaterials,
      inputs: changed.inputs
    }).sha256
    assert.notEqual(digest, item.command.inputSnapshotDigest, field)
    changedDigests.push(digest)
    const command = parseControlledImageV3ConversationCommand(item.command)
    assert.throws(() => parseControlledImageV3Inputs(changed, command, item.startReceipt.leaseVersion),
      /CONTROLLED_IMAGE_V3_INPUTS_UNAVAILABLE/)
  }
  assert.equal(new Set(changedDigests).size, changedDigests.length)
})
