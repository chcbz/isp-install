import { decodeHttpResponse } from './api-envelope.mjs'
/** Only for the authenticated nativeFetch transport, which already verifies the sent request ID. */
export async function readNativeJson(response) {
  return decodeHttpResponse(await response.text(), { status: response.status,
    responseRequestId: response.headers.get('X-Request-Id') }).value
}
