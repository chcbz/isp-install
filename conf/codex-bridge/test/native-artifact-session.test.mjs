import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { NativeArtifactSession } from '../native-artifact-session.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { validateNativeOutputSnapshot } from '../native-output-format.mjs'
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-native-artifacts-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const command = { executionProtocolVersion: 5, executionId: 'execution1', snapshotDigest: 'a'.repeat(64), inputRefs: [], outputs: { dataSchema: null, mimeTypes: ['text/plain', 'text/html'], multiple: true, artifactsRequired: true } }
  const store = new SkillExecutionStore({ rootDirectory: root, scope: { agentId: 'agent1' }, command })
  const session = new NativeArtifactSession({ store, checkActive() {}, validateSnapshot: validateNativeOutputSnapshot })
  const binding = { executionId: command.executionId, threadId: 'thread1', turnId: 'turn1' }; session.bindTurn(binding)
  const call = (tool, args, callId = 'call1') => session.callTool({ ...binding, callId, tool, arguments: args })
  const stage = (path = '/outputs/a.txt', callId = 'call1') => call('artifact_stage', { path, displayName: 'a.txt', mediaTypeHint: 'text/plain' }, callId)
  const propose = (refs, callId = 'proposal1') => call('result_propose', { summary: 'done', artifactRefs: refs, data: null }, callId)
  const terminal = { threadId: 'thread1', turnId: 'turn1', finishReason: 'completed' }
  return { store, session, binding, call, stage, propose, terminal, write: text => writeFileSync(resolve(store.directory, 'drafts/a.txt'), text) }
}
test('stage freezes bytes, same invocation does not reread drafts, proposal alone is not a result', t => {
  const f = fixture(t); f.write('original'); const first = f.stage(); f.write('changed')
  assert.deepEqual(f.stage(), first); assert.equal(f.store.readBlob(first.outputId).toString(), 'original')
  f.propose([first.artifactRef]); assert.equal(f.store.loadResult(), null)
  const result = f.session.finalize(f.terminal, []); assert.equal(result.result.artifacts[0].sha256, first.sha256)
  assert.throws(() => f.stage('/outputs/a.txt', 'late'), /ALREADY_FROZEN/)
  assert.deepEqual(f.stage(), first)
})
test('empty documents and HTML can be snapshotted; invalid UTF-8 and unapproved types cannot', t => {
  const f = fixture(t); f.write(''); assert.equal(f.stage().byteLength, '0')
  f.write('<html><script>not executed</script></html>')
  assert.equal(f.call('artifact_stage', { path: '/outputs/a.txt', displayName: 'x.html', mediaTypeHint: 'text/html' }, 'html').contentMimeType, 'text/html')
  f.write(Buffer.from([0xff])); assert.throws(() => f.stage('/outputs/a.txt', 'bad'), e => e.code === 'NATIVE_OUTPUT_FORMAT_INVALID' && e.recoverableToolError)
  assert.throws(() => f.call('artifact_stage', { path: '/outputs/a.txt', displayName: 'x', mediaTypeHint: 'application/pdf' }, 'pdf'), /ARGUMENTS_INVALID/)
})
test('execution identity, invocation arguments, selected references and terminal must match', t => {
  const f = fixture(t); f.write('abc'); const a = f.stage()
  assert.throws(() => f.session.callTool({ ...f.binding, executionId: 'other', callId: 'x', tool: 'artifact_stage', arguments: {} }), /BINDING_INVALID/)
  assert.throws(() => f.stage('/outputs/b.txt'), /CALL_CONFLICT/)
  assert.throws(() => f.propose(['unknown']), /ARTIFACT_UNKNOWN/)
  assert.throws(() => f.session.finalize(f.terminal, []), /PROPOSAL_REQUIRED/)
  f.propose([a.artifactRef]); assert.throws(() => f.session.finalize({ ...f.terminal, finishReason: 'failed' }, []), /TERMINAL_UNCONFIRMED/)
  assert.equal(f.store.loadResult(), null)
})
test('replaying an older proposal never replaces a later revision', t => {
  const f = fixture(t); f.write('one'); const a = f.stage(); f.propose([a.artifactRef])
  f.write('two'); const b = f.stage('/outputs/a.txt', 'call2'); f.propose([b.artifactRef], 'proposal2'); f.propose([a.artifactRef])
  assert.equal(f.session.finalize(f.terminal, []).result.artifacts[0].outputId, b.outputId)
})
test('snapshot publication resumes from its captured journal, not from changed draft', t => {
  const f = fixture(t); f.write('before'); const write = f.store.write.bind(f.store); let failOnce = true
  f.store.write = (key, value) => {
    if (key.startsWith('artifact-') && failOnce) { failOnce = false; throw new Error('SIMULATED_STORE_FAILURE') }
    return write(key, value)
  }
  assert.throws(() => f.stage(), /SIMULATED_STORE_FAILURE/); f.write('after')
  const a = f.stage(); assert.equal(f.store.readBlob(a.outputId).toString(), 'before')
})
test('local-file delivery is valid for native execution without masquerading as local-script', t => {
  const f = fixture(t); f.store.command.inputRefs = ['input1']; f.store.write('inputs-snapshot', { inputs: [{ inputRef: 'input1', sha256: 'b'.repeat(64) }] })
  f.write('done'); const a = f.stage(); f.propose([a.artifactRef])
  const result = f.session.finalize(f.terminal, [{ inputRef: 'input1', sha256: 'b'.repeat(64), carrier: 'local-file', delivery: 'DELIVERED' }])
  assert.equal(result.result.inputReceipts[0].carrier, 'local-file')
})
