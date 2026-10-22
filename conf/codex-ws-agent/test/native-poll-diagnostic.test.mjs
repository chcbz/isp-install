import test from 'node:test'
import assert from 'node:assert/strict'
import { nativePollDiagnostic } from '../native-poll-diagnostic.mjs'
test('distinguishes absent causes from redacted causes and retains safe skill/network codes', () => {
  assert.equal(nativePollDiagnostic({}).cause, 'ABSENT')
  assert.equal(nativePollDiagnostic({ stage: 'skill-effect-invoke' }).stage, 'skill-effect-invoke')
  assert.equal(nativePollDiagnostic({ stage: 'secret' }).stage, 'native-conversation-poll')
  for (const cause of [new Error('secret'), { code: 'secret\nTOKEN=abc' }, 'secret']) assert.equal(nativePollDiagnostic({ cause }).cause, 'REDACTED')
  for (const code of ['ECONNRESET', 'SKILL_LOCAL_PROCESS_FAILED', 'MATERIALS_INPUT_INVALID']) assert.equal(nativePollDiagnostic({ cause: { code } }).cause, code)
})
test('only safe process and execution fields are logged, never raw diagnostics', () => {
  const error = { message: 'secret', cause: { code: 'SKILL_LOCAL_PROCESS_FAILED', exitCode: 7, signal: 'SIGTERM', stderr: 'secret', message: 'secret' }, executionErrors: [{ executionId: 'pwe_1', code: 'SKILL_RESULT_UNKNOWN', command: 'secret' }] }
  assert.deepEqual(nativePollDiagnostic(error), { stage: 'native-conversation-poll', cause: 'SKILL_LOCAL_PROCESS_FAILED', exitCode: 7, signal: 'SIGTERM', executions: [{ executionId: 'pwe_1', code: 'SKILL_RESULT_UNKNOWN' }] })
  const hostile = nativePollDiagnostic({ cause: { code: 'SKILL_LOCAL_PROCESS_FAILED', exitCode: 'secret', signal: 'secret' }, executionErrors: [{ executionId: 'secret\n', code: 'secret' }] })
  assert.equal(JSON.stringify(hostile).includes('secret'), false)
  assert.equal(hostile.exitCode, undefined); assert.equal(hostile.signal, undefined)
})
