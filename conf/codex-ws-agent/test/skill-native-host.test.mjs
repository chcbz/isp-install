import test from 'node:test'
import assert from 'node:assert/strict'
import { runSkillNativeModel } from '../agent-client.mjs'
import { CODEX_APP_SERVER_SCHEMA_CONTRACTS, DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID } from './fixtures/recorded-app-server-schemas.mjs'
import { skillHash } from '../skill-executor.mjs'
const setup = (finishReason = 'completed') => {
  const contract = CODEX_APP_SERVER_SCHEMA_CONTRACTS[DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID]
  let sent
  const adapter = { readback: { initialize: true, schema: { ...contract, schemaContractId: contract.contractId, measured: true } },
    startOrResumeThread: async () => ({ threadId: 'thread' }),
    runTurn: async request => { sent = request; return { threadId: 'thread', turnId: 'turn', finishReason, content: '{"text":"实际原生模型正文"}' } } }
  const bytes = Buffer.from('任务资料正文')
  return { state: { profile: {}, chatWorkdir: '/tmp/isolated-chat', ensureAppServer: async () => adapter },
    request: { command: { executionId: 'pwe_1', snapshotDigest: 'a'.repeat(64), commandId: 'cmd', messageId: 'msg' }, instruction: '整理', parameters: {}, outputSchema: { type: 'object' }, outputDirectory: '/tmp/skill/outputs',
      inputs: [{ inputRef: 'input_1', bytes, byteLength: String(bytes.length), contentMimeType: 'text/plain', sha256: skillHash(bytes) }] }, sent: () => sent }
}
test('host uses real AppServerAdapter finishReason and delivers actual authorized material in that model turn', async () => {
  const f = setup(); const result = await runSkillNativeModel(f.state, f.request)
  assert.deepEqual(result.data, { text: '实际原生模型正文' })
  assert.equal(result.inputReceipts[0].delivery, 'DELIVERED')
  assert.match(f.sent().input[1].text, /任务资料正文/)
  assert.equal(f.sent().policy.outputSchema, f.request.outputSchema)
})
test('non-completed native turn or missing actual image carrier cannot produce a success result', async () => {
  const f = setup('failed'); await assert.rejects(runSkillNativeModel(f.state, f.request), { code: 'SKILL_NATIVE_RESULT_UNKNOWN' })
  f.request.inputs[0].contentMimeType = 'image/png'
  await assert.rejects(runSkillNativeModel(f.state, f.request), { code: 'MATERIALS_CARRIER_UNAVAILABLE' })
})
