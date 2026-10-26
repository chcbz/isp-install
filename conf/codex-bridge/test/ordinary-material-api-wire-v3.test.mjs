import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, lstatSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseControlledImageV3ConversationCommand } from '../conversation-controlled-image-v3.mjs'
import { parseControlledImageV3Inputs, materializeControlledImageV3Inputs } from '../conversation-reference-inputs-v3.mjs'

const bytes = readFileSync(resolve(import.meta.dirname, 'fixtures/ordinary-material-api-wire-v3.json'))
const provenance = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/ordinary-material-api-wire-v3.provenance.json')))
const cases = JSON.parse(bytes)
const sha = value => createHash('sha256').update(value).digest('hex')
const privateRun = t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ordinary-material-wire-'))
  mkdirSync(resolve(directory, 'inputs'), { mode: 0o700 })
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('fixture is the exact API-emitted wire with source provenance, not a client-built snapshot', () => {
  assert.equal(sha(bytes), provenance.fixtureSha256)
  assert.match(provenance.apiCommit, /^[a-f0-9]{40}$/)
  assert.match(provenance.apiTree, /^[a-f0-9]{40}$/)
  assert.deepEqual(cases.map(item => item.caseId), ['mixed-generation', 'workspace-edit', 'asset-generation'])
})

for (const item of cases) {
  test(`API wire ${item.caseId}: parse independent digest and materialize original sources/bytes privately`, async t => {
    const command = parseControlledImageV3ConversationCommand(item.command)
    const snapshot = parseControlledImageV3Inputs(item.inputSnapshot, command, 1)
    assert.equal(sha(snapshot.canonicalUtf8), item.command.inputSnapshotDigest)
    const runDirectory = privateRun(t)
    const expectedBytes = Buffer.from(item.inputBytesBase64, 'base64')
    const requested = []
    const materialized = await materializeControlledImageV3Inputs({ inputs: snapshot.inputs, runDirectory,
      readInput: async input => { requested.push(input.inputRef); return expectedBytes } })
    assert.deepEqual(requested, item.inputSnapshot.inputs.map(input => input.inputRef))
    assert.deepEqual(materialized.map(input => input.source), item.inputSnapshot.inputs.map(input => input.source))
    for (const input of materialized) {
      const path = resolve(runDirectory, input.relativePath)
      assert.deepEqual(readFileSync(path), expectedBytes)
      assert.equal(lstatSync(path).mode & 0o777, 0o600)
      assert.equal(sha(readFileSync(path)), input.sha256)
      if (input.source.kind === 'TASK_LINKED_WORKSPACE_VERSION') assert.equal(input.source.purpose, 'INPUT')
    }
  })
}

test('API wire role, revision, foreign conversation or digest mutation is rejected before materialization', () => {
  const item = cases[0], command = parseControlledImageV3ConversationCommand(item.command)
  for (const mutate of [
    snapshot => { snapshot.inputs[0].source.purpose = 'REFERENCE' },
    snapshot => { snapshot.inputs[0].source.version = '3' },
    snapshot => { snapshot.inputs[1].source.conversationId = 'foreign' },
    snapshot => { snapshot.inputs[1].source.assetRevision = '2' },
    snapshot => { snapshot.inputs[0].sha256 = 'a'.repeat(64) }
  ]) {
    const snapshot = structuredClone(item.inputSnapshot)
    mutate(snapshot)
    assert.throws(() => parseControlledImageV3Inputs(snapshot, command, 1), /CONTROLLED_IMAGE_V3_INPUTS_UNAVAILABLE/)
  }
})

test('API wire byte corruption leaves no materialized input file', async t => {
  const item = cases[1], command = parseControlledImageV3ConversationCommand(item.command)
  const snapshot = parseControlledImageV3Inputs(item.inputSnapshot, command, 1)
  const runDirectory = privateRun(t)
  const corrupt = Buffer.from(item.inputBytesBase64, 'base64'); corrupt[corrupt.length - 1] ^= 1
  await assert.rejects(materializeControlledImageV3Inputs({ inputs: snapshot.inputs, runDirectory,
    readInput: async () => corrupt }), /CONTROLLED_IMAGE_V3_INPUTS_UNAVAILABLE/)
  assert.deepEqual(readdirSync(resolve(runDirectory, 'inputs')), [])
})
