const fail = code => { const error = new Error(code); error.code = code; throw error }
const skipWhitespace = (text, start) => { let index = start; while (' \t\r\n'.includes(text[index] || '\0')) index++; return index }
const stringEnd = (text, start) => {
  let escaped = false
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') return index
    if (text.charCodeAt(index) < 0x20) fail('TYPED_STREAM_INVALID_JSON')
  }
  return -1
}
const skipValue = (text, start) => {
  let index = skipWhitespace(text, start); const first = text[index]
  if (first === '"') { const end = stringEnd(text, index); return end < 0 ? -1 : end + 1 }
  if (first === '{' || first === '[') {
    const stack = [first]; let inString = false; let escaped = false
    for (index++; index < text.length; index++) {
      const char = text[index]
      if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue }
      if (char === '"') inString = true
      else if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') { stack.pop(); if (!stack.length) return index + 1 }
    }
    return -1
  }
  for (; index < text.length; index++) if (text[index] === ',' || text[index] === '}') return index
  return -1
}
const locateTopLevelText = text => {
  let index = skipWhitespace(text, 0); if (text[index] !== '{') return null; index++
  while (true) {
    index = skipWhitespace(text, index)
    if (index >= text.length || text[index] === '}') return null
    if (text[index] !== '"') fail('TYPED_STREAM_INVALID_JSON')
    const keyEnd = stringEnd(text, index); if (keyEnd < 0) return null
    let key; try { key = JSON.parse(text.slice(index, keyEnd + 1)) } catch { fail('TYPED_STREAM_INVALID_JSON') }
    index = skipWhitespace(text, keyEnd + 1); if (index >= text.length) return null; if (text[index] !== ':') fail('TYPED_STREAM_INVALID_JSON')
    index = skipWhitespace(text, index + 1); if (index >= text.length) return null
    if (key === 'text') {
      if (text[index] !== '"') fail('TYPED_STREAM_TEXT_NOT_STRING')
      const end = stringEnd(text, index)
      return { raw: text.slice(index + 1, end < 0 ? text.length : end), complete: end >= 0 }
    }
    const next = skipValue(text, index); if (next < 0) return null
    index = skipWhitespace(text, next); if (index >= text.length) return null
    if (text[index] === ',') { index++; continue }
    if (text[index] === '}') return null
    fail('TYPED_STREAM_INVALID_JSON')
  }
}
const decodePrefix = ({ raw, complete }) => {
  let result = ''
  for (let index = 0; index < raw.length;) {
    const unit = raw.charCodeAt(index)
    if (unit === 0x5c) {
      if (index + 1 >= raw.length) { if (complete) fail('TYPED_STREAM_INVALID_ESCAPE'); break }
      const kind = raw[index + 1]
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (Object.hasOwn(simple, kind)) { result += simple[kind]; index += 2; continue }
      if (kind !== 'u') fail('TYPED_STREAM_INVALID_ESCAPE')
      if (index + 6 > raw.length) { if (complete) fail('TYPED_STREAM_INVALID_ESCAPE'); break }
      const digits = raw.slice(index + 2, index + 6); if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail('TYPED_STREAM_INVALID_ESCAPE')
      const high = parseInt(digits, 16)
      if (high >= 0xd800 && high <= 0xdbff) {
        if (index + 12 > raw.length) { if (complete) fail('TYPED_STREAM_INVALID_UNICODE'); break }
        if (raw.slice(index + 6, index + 8) !== '\\u' || !/^[0-9a-fA-F]{4}$/.test(raw.slice(index + 8, index + 12))) fail('TYPED_STREAM_INVALID_UNICODE')
        const low = parseInt(raw.slice(index + 8, index + 12), 16); if (low < 0xdc00 || low > 0xdfff) fail('TYPED_STREAM_INVALID_UNICODE')
        result += String.fromCharCode(high, low); index += 12; continue
      }
      if (high >= 0xdc00 && high <= 0xdfff) fail('TYPED_STREAM_INVALID_UNICODE')
      result += String.fromCharCode(high); index += 6; continue
    }
    if (unit < 0x20) fail('TYPED_STREAM_INVALID_JSON')
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= raw.length) { if (complete) fail('TYPED_STREAM_INVALID_UNICODE'); break }
      const low = raw.charCodeAt(index + 1); if (low < 0xdc00 || low > 0xdfff) fail('TYPED_STREAM_INVALID_UNICODE')
      result += raw.slice(index, index + 2); index += 2; continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) fail('TYPED_STREAM_INVALID_UNICODE')
    result += raw[index++]
  }
  return result
}

export class TypedOutcomeTextStreamDecoder {
  constructor() { this.raw = ''; this.emitted = '' }
  push(chunk) {
    if (typeof chunk !== 'string') fail('TYPED_STREAM_CHUNK_INVALID')
    this.raw += chunk
    const located = locateTopLevelText(this.raw); if (!located) return ''
    const decoded = decodePrefix(located)
    if (!decoded.startsWith(this.emitted)) fail('TYPED_STREAM_PREFIX_CONFLICT')
    const suffix = decoded.slice(this.emitted.length); this.emitted = decoded; return suffix
  }
  finish(finalText) {
    if (typeof finalText !== 'string' || !finalText.startsWith(this.emitted)) fail('TYPED_STREAM_FINAL_PREFIX_MISMATCH')
    const suffix = finalText.slice(this.emitted.length); this.emitted = finalText; return suffix
  }
}
