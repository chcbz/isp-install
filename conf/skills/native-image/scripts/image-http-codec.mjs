// Adapted from the existing image HTTP codec; no bridge or platform dependency.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }) }
export function decodeCanonicalPng(value) {
  if (typeof value !== 'string' || !value || /\s/.test(value) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('IMAGE_RESPONSE_INVALID', 'Provider response is not canonical base64', { outcome: 'UNKNOWN' })
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_OUTPUT_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail('IMAGE_RESPONSE_INVALID', 'Provider response is not one bounded PNG', { outcome: 'UNKNOWN' })
  return bytes
}
export async function responsePng(response, endpoint) {
  if (!response || response.status !== 200 || response.redirected === true || response.url !== endpoint.href) fail('IMAGE_PROVIDER_REJECTED', 'Provider did not return a direct 200 response', { outcome: 'UNKNOWN', ...(Number.isInteger(response?.status) ? { httpStatus: response.status } : {}) })
  const contentType = response.headers?.get?.('content-type')
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) fail('IMAGE_RESPONSE_INVALID', 'Provider response is not JSON', { outcome: 'UNKNOWN' })
  let payload
  try { payload = await response.json() } catch { fail('IMAGE_OUTCOME_UNKNOWN', 'Provider response could not be read', { outcome: 'UNKNOWN' }) }
  if (!object(payload) || !Array.isArray(payload.data) || payload.data.length !== 1 || !object(payload.data[0]) || !['b64_json', 'b64_json,generation_id'].includes(Object.keys(payload.data[0]).sort().join(',')) || (Object.hasOwn(payload.data[0], 'generation_id') && (typeof payload.data[0].generation_id !== 'string' || !payload.data[0].generation_id))) fail('IMAGE_RESPONSE_INVALID', 'Provider response must contain exactly one base64 image', { outcome: 'UNKNOWN' })
  return decodeCanonicalPng(payload.data[0].b64_json)
}
