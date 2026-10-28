/** Shared native format identification and authenticated session proof. No legacy executor. */
const AUTH = /^AgentRuntime rts1_[0-9a-f]{64}$/
const ascii = (bytes, offset, text) => bytes.length >= offset + text.length && Buffer.from(text).equals(bytes.subarray(offset, offset + text.length))
const validUtf8 = bytes => { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !text.includes('\0') } catch { return false } }
export const validateNativeConversationOutput = (mime, bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16 * 1024 * 1024) return false
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255,216,255]))
  if (mime === 'image/webp') return ascii(bytes,0,'RIFF') && ascii(bytes,8,'WEBP')
  if (mime === 'image/gif') return ascii(bytes,0,'GIF87a') || ascii(bytes,0,'GIF89a')
  if (mime === 'audio/mpeg') return ascii(bytes,0,'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  if (mime === 'audio/wav') return ascii(bytes,0,'RIFF') && ascii(bytes,8,'WAVE')
  if (mime === 'audio/ogg') return ascii(bytes,0,'OggS')
  if (mime === 'audio/webm') return bytes.length >= 4 && bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
  if (mime === 'text/plain' || mime === 'text/markdown') return validUtf8(bytes)
  if (mime === 'application/json') { if (!validUtf8(bytes)) return false; try { JSON.parse(bytes.toString('utf8')); return true } catch { return false } }
  return mime === 'application/octet-stream'
}

export class NativeConversationError extends Error {
  constructor(code) { super(code); this.code = code }
}
const deny = code => { throw new NativeConversationError(code) }
// Only the current installation-derived session proof may enter native HTTP.
// No registration token, API key or partial identity fallback. Copy only the six
// transport headers; none become lease/fingerprint/checkpoint business fields.
export const nativePositiveLong = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
export const nativeSessionHeaders = (value, agentId, runtimeInstanceId) => {
  let headers
  try { headers = new Headers(value) } catch { deny('CONVERSATION_AUTH_UNAVAILABLE') }
  const keys = ['Authorization', 'X-Agent-Id', 'X-Agent-Installation-Id', 'X-Agent-Host-Id',
    'X-Agent-Runtime-Id', 'X-Agent-Session-Generation']
  const proof = Object.fromEntries(keys.map(key => [key, headers.get(key)]))
  const generation = proof['X-Agent-Session-Generation']
  if (!AUTH.test(proof.Authorization || '') || headers.has('x-api-key') || headers.has('cookie')
      || proof['X-Agent-Id'] !== agentId || proof['X-Agent-Runtime-Id'] !== runtimeInstanceId
      || !keys.every(key => typeof proof[key] === 'string' && proof[key].trim() === proof[key] && proof[key])
      || !nativePositiveLong(generation)) deny('CONVERSATION_AUTH_UNAVAILABLE')
  return Object.freeze(proof)
}
