import test from 'node:test'
import assert from 'node:assert/strict'
import * as host from '../agent-client.mjs'

test('conversation host does not export retired image or fixed-output execution adapters', () => {
  for (const name of ['createNativeBountyExecutionRuntime', 'createControlledImageV3SourceRuntime', 'runNativeConversationImage', 'runSkillNativeModel', 'startControlledImageV3ConversationPoller', 'stopControlledImageV3ConversationPoller']) {
    assert.equal(Object.hasOwn(host, name), false, name)
  }
})

import { EXECUTION_PAYLOAD_FILES } from '../../cyf-agent-runtime-v1/lib/execution-adapter.mjs'
test('runtime payload includes native configuration and excludes retired fixed runners', () => {
  for (const name of ['native-execution.mjs', 'native-skill-config.mjs', 'skill-conversation.mjs', 'skill-runners/local-script.mjs']) assert.ok(EXECUTION_PAYLOAD_FILES.includes(name), name)
  for (const name of ['skill-runners/native-model.mjs', 'skill-runners/image-provider.mjs', 'conversation-text-file.mjs', 'native-image-tool.mjs']) assert.equal(EXECUTION_PAYLOAD_FILES.includes(name), false, name)
})

import * as nativeHelpers from '../conversation-native.mjs'
test('retired conversation protocols have no executable payload or native lane export', () => {
  assert.equal(Object.hasOwn(nativeHelpers, 'NativeConversationLane'), false)
  assert.equal(Object.hasOwn(nativeHelpers, 'parseNativeConversationCommand'), false)
  for (const name of ['conversation-controlled-image.mjs', 'conversation-controlled-image-v3.mjs', 'controlled-image-http-executor.mjs', 'controlled-image-http-executor-v3.mjs', 'controlled-image-gpt-cli-executor-v3.mjs', 'controlled-image-http-ledger.mjs', 'controlled-image-delivery-retention-v3.mjs']) assert.equal(EXECUTION_PAYLOAD_FILES.includes(name), false, name)
})
