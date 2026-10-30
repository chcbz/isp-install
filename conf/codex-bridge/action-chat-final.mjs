/** Durable publication of an already computed action CHAT final. Never reruns the model. */
import { canonicalSha256 } from './chat-runtime.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function buildActionChatFinal({ message, outcome, engineThreadId, engineTurnId, threadKey, finalSeq = message.__deltaSeq || '0' }) {
  if (!/^(0|[1-9][0-9]*)$/.test(finalSeq) || typeof finalSeq !== 'string') fail('CHAT_FINAL_SEQUENCE_INVALID')
  const binding = Object.fromEntries(['tenantId', 'ownerJiacn', 'clientId', 'conversationId', 'conversationGeneration', 'taskId', 'requestId', 'turnId', 'dispatchId', 'targetAgentId'].map(key => [key, message[key]]))
  const bindingDigest = canonicalSha256({ binding, contextHash: message.contextSnapshot.contextHash })
  const outboundMessageId = `action_final_${canonicalSha256({ bindingDigest, outcome }).slice(7)}`
  const prepared = { schemaVersion: 1, contract: 'juyiting-action-chat-final-v1', bindingDigest,
    requestId: message.requestId, turnId: message.turnId, dispatchId: message.dispatchId, outboundMessageId, content: outcome.text,
    extra: { status: 'completed', routeUsed: 'CHAT_FAST', productPolicy: 'read-only-constrained', threadGeneration: threadKey,
      finalSeq, outcomeContractVersion: outcome.schemaVersion, interactionOutcome: outcome, outboundMessageId },
    result: { status: 'final_computed', computationStatus: 'completed', serverPersistence: 'unconfirmed',
      threadId: engineThreadId, turnId: engineTurnId, threadKey, outboundMessageId } }
  return { ...prepared, finalDigest: canonicalSha256(prepared) }
}
export async function publishActionChatFinal({ profile, message, finalPrepared, validateOutcome, controls, sendFinal }) {
  if (finalPrepared?.contract !== 'juyiting-action-chat-final-v1') fail('CHAT_FINAL_PREPARED_INVALID')
  const outcome = validateOutcome(finalPrepared.extra?.interactionOutcome)
  const expected = buildActionChatFinal({ message, outcome, engineThreadId: finalPrepared.result?.threadId,
    engineTurnId: finalPrepared.result?.turnId, threadKey: finalPrepared.result?.threadKey, finalSeq: finalPrepared.extra?.finalSeq })
  if (canonicalSha256(expected) !== canonicalSha256(finalPrepared)) fail('CHAT_FINAL_PREPARED_INVALID')
  let sent = false, errorCode = null
  try { sent = await sendFinal(profile, message, expected.content, expected.extra) === true }
  catch (error) { errorCode = error.code || 'CHAT_FINAL_SEND_FAILED' }
  const publication = { schemaVersion: 1, outboundMessageId: expected.outboundMessageId,
    state: sent ? 'WS_WRITE_ACCEPTED_PERSISTENCE_UNCONFIRMED' : 'NOT_SENT', errorCode }
  await controls.markFinalPublication(publication)
  return { ...expected.result, status: 'recovery_required', finalDigest: expected.finalDigest,
    recoveryReason: sent ? 'FINAL_SERVER_PERSISTENCE_UNCONFIRMED' : 'FINAL_PUBLISH_NOT_SENT', publicationState: publication.state }
}
