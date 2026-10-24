// Transport codec extracted from controlled-image-http-executor-v3. No consent,
// binding selection, scheduling or side-effect retry is performed here.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
export const decodeCanonicalPng = value => {
  if (typeof value !== 'string' || !value || /\s/.test(value)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image response is not canonical base64')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length < PNG_SIGNATURE.length
      || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image response is not one bounded PNG')
  }
  return bytes
}

export const responsePng = async (response, endpoint) => {
  if (!response || response.status !== 200 || response.redirected === true || response.url !== endpoint.href) {
    fail('CONTROLLED_IMAGE_PROVIDER_REJECTED', 'controlled image Provider did not return a direct 200 response')
  }
  const contentType = response.headers?.get?.('content-type')
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image Provider response is not JSON')
  }
  let payload
  try { payload = await response.json() } catch {
    fail('CONTROLLED_IMAGE_OUTCOME_UNKNOWN', 'controlled image Provider response could not be read')
  }
  if (!object(payload) || !Array.isArray(payload.data) || payload.data.length !== 1
      || !object(payload.data[0])
      || !['b64_json', 'b64_json,generation_id'].includes(Object.keys(payload.data[0]).sort().join(','))
      || (Object.hasOwn(payload.data[0], 'generation_id')
        && (typeof payload.data[0].generation_id !== 'string' || !payload.data[0].generation_id))) {
    fail('CONTROLLED_IMAGE_RESPONSE_INVALID', 'controlled image Provider response must contain exactly one base64 image')
  }
  // Provider generation_id is opaque metadata, never an output/command identity.
  return decodeCanonicalPng(payload.data[0].b64_json)
}

