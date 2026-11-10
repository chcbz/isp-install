// Platform maintenance only. The caller supplies trusted provider configuration and
// a durable platform cost sink; neither conversation text nor model output is a log.
// No SDK retries, tools, original user metadata or continuation of the user's thread.
const failure = code => Object.assign(new Error(code), { code });
const exact = value => typeof value === 'string' && value.trim() === value && value.length > 0;

export function createKnowledgeResponsesClient({ endpoint, model, credential, channel, recordAttempt,
  fetchImpl = globalThis.fetch }) {
  let url;
  try { url = new URL(endpoint); } catch { throw failure('KNOWLEDGE_PROVIDER_CONFIG_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || ![model, credential, channel].every(exact) || typeof recordAttempt !== 'function')
    throw failure('KNOWLEDGE_PROVIDER_CONFIG_INVALID');
  // endpoint is the exact trusted /responses endpoint, not model-selected input.
  return async ({ attemptId, instructions, input, schema, schemaName }) => {
    if (![attemptId, schemaName].every(exact)
        || [instructions, input].some(value => typeof value !== 'string' || !value.trim())
        || !schema || typeof schema !== 'object')
      throw failure('KNOWLEDGE_REQUEST_INVALID');
    const binding = Object.freeze({ attemptId, channel, requestedModel: model, costBearer: 'PLATFORM' });
    // A crash/timeout remains a real unpriced attempt. Fail closed BEFORE spending
    // if the platform cost sink cannot durably acknowledge the starting receipt.
    await recordAttempt({ ...binding, receiptId: 'started', phase: 'STARTED', evidence: null });
    let response, body;
    try {
      response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', headers: {
        Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json'
      }, body: JSON.stringify({ model, store: false, stream: false, tools: [],
        instructions, input, text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } } }) });
      body = await response.json();
    } catch { throw failure('KNOWLEDGE_PROVIDER_RESULT_UNKNOWN'); }
    // Preserve provider usage even for refusal, incomplete, invalid JSON text, or
    // non-2xx responses. Do not invent zero tokens, a model alias or a price here.
    const evidence = {
      providerReceiptId: typeof body?.id === 'string' ? body.id : null,
      actualModel: typeof body?.model === 'string' ? body.model : null,
      serviceTier: typeof body?.service_tier === 'string' ? body.service_tier : null,
      usage: body?.usage ?? null,
      httpStatus: response.status
    };
    await recordAttempt({ ...binding, receiptId: 'responded', phase: 'RESPONDED', evidence });
    if (!response.ok || body?.status !== 'completed' || !Array.isArray(body.output))
      throw failure('KNOWLEDGE_PROVIDER_INCOMPLETE');
    const text = [];
    for (const item of body.output) {
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content))
        throw failure('KNOWLEDGE_PROVIDER_OUTPUT_INVALID');
      for (const content of item.content) {
        if (content.type !== 'output_text' || typeof content.text !== 'string')
          throw failure('KNOWLEDGE_PROVIDER_OUTPUT_INVALID');
        text.push(content.text);
      }
    }
    try { return JSON.parse(text.join('')); }
    catch { throw failure('KNOWLEDGE_PROVIDER_OUTPUT_INVALID'); }
  };
}
