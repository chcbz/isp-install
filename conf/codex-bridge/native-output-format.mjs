import { isNativeOfficeMime, validateNativeOfficeSnapshot } from './native-office-format.mjs'
/** File-format boundary for the native collector; no task orchestration. */
import { constants, openSync, closeSync, readSync, readFileSync } from 'node:fs'
import { validateNativeConversationOutput } from './conversation-native.mjs'
const textTypes = new Set(['text/plain', 'text/markdown', 'text/html', 'text/csv'])
const signatures = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'])
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function validateNativeOutputSnapshot(path, mediaTypeHint) {
  if (isNativeOfficeMime(mediaTypeHint)) return validateNativeOfficeSnapshot(path, mediaTypeHint)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (textTypes.has(mediaTypeHint)) {
      const decoder = new TextDecoder('utf-8', { fatal: true }); const bytes = Buffer.allocUnsafe(64 * 1024)
      try {
        let count
        while ((count = readSync(fd, bytes, 0, bytes.length, null))) if (decoder.decode(bytes.subarray(0, count), { stream: true }).includes('\0')) fail('NATIVE_OUTPUT_FORMAT_INVALID')
        if (decoder.decode().includes('\0')) fail('NATIVE_OUTPUT_FORMAT_INVALID')
      } catch { fail('NATIVE_OUTPUT_FORMAT_INVALID') }
      return mediaTypeHint // empty UTF-8 documents are valid
    }
    if (mediaTypeHint === 'application/json') {
      try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd))) } catch { fail('NATIVE_OUTPUT_FORMAT_INVALID') }
      return mediaTypeHint
    }
    if (signatures.has(mediaTypeHint)) {
      const head = Buffer.alloc(16); const count = readSync(fd, head, 0, head.length, 0)
      // Reuse existing carrier signature checks, without its legacy whole-file
      // size gate. This is format identification, not semantic media validation.
      if (!validateNativeConversationOutput(mediaTypeHint, head.subarray(0, count))) fail('NATIVE_OUTPUT_FORMAT_INVALID')
      return mediaTypeHint
    }
    if (mediaTypeHint === 'application/octet-stream') return mediaTypeHint
    fail('NATIVE_OUTPUT_FORMAT_UNSUPPORTED')
  } finally { closeSync(fd) }
}
