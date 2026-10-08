// Test-only lexical import extraction. Never execute the inspected module and never
// scan string/comment/template text as JavaScript. Unknown computed local imports
// are rejected instead of silently making a payload-closure assertion pass.
import { readFileSync } from 'node:fs'
import { extname, relative, resolve, sep, dirname } from 'node:path'

const prefixWords = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'yield', 'await', 'in', 'of', 'instanceof'])
const controlWords = new Set(['if', 'while', 'for', 'with', 'switch', 'catch'])
const knownNonFilePrefix = value => /^(?:data|node):/.test(value)

const tokensOf = source => {
  const tokens = []
  let offset = 0
  const fail = reason => { throw new SyntaxError(`Import scanner: ${reason} at ${offset}`) }
  const escape = () => {
    if (offset >= source.length) fail('unterminated escape')
    const char = source[offset++]
    if (char === '\n') return ''
    if (char === '\r') { if (source[offset] === '\n') offset++; return '' }
    if (char === 'x' || char === 'u') {
      const braced = char === 'u' && source[offset] === '{'
      if (braced) offset++
      const begin = offset
      const end = braced ? source.indexOf('}', offset) : offset + (char === 'x' ? 2 : 4)
      const hex = source.slice(begin, end)
      if (end < begin || !/^[0-9a-f]+$/i.test(hex) || (!braced && hex.length !== (char === 'x' ? 2 : 4))) fail('invalid Unicode escape')
      const code = Number.parseInt(hex, 16)
      if (code > 0x10ffff) fail('invalid Unicode code point')
      offset = end + (braced ? 1 : 0)
      return String.fromCodePoint(code)
    }
    if (/[1-9]/.test(char) || (char === '0' && /[0-9]/.test(source[offset] || ''))) fail('legacy numeric escape in module')
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[char] ?? char
  }
  const quoted = delimiter => {
    offset++
    let value = ''
    while (offset < source.length) {
      const char = source[offset++]
      if (char === delimiter) return value
      if (char === '\\') value += escape()
      else { if (char === '\n' || char === '\r') fail('unterminated string'); value += char }
    }
    fail('unterminated string')
  }
  const regexp = () => {
    offset++
    let characterClass = false
    while (offset < source.length) {
      const char = source[offset++]
      if (char === '\\') { offset++; continue }
      if (char === '[') characterClass = true
      if (char === ']') characterClass = false
      if (char === '/' && !characterClass) {
        while (/[a-z]/i.test(source[offset] || '')) offset++
        return
      }
      if (char === '\n' || char === '\r') fail('unterminated regexp')
    }
    fail('unterminated regexp')
  }
  const template = () => {
    offset++
    const token = { kind: 'template', value: '', interpolated: false }
    tokens.push(token)
    while (offset < source.length) {
      const char = source[offset++]
      if (char === '`') return
      if (char === '\\') { token.value += escape(); continue }
      if (char === '$' && source[offset] === '{') {
        offset++
        token.interpolated = true
        // Preserve executable expressions, including genuine nested import().
        tokens.push({ kind: 'punct', value: '${' })
        code(true)
        tokens.push({ kind: 'punct', value: '}' })
      } else token.value += char
    }
    fail('unterminated template')
  }
  const code = (interpolation = false) => {
    let regexAllowed = true
    const groups = []
    let previous = null
    const emit = (kind, value) => {
      const objectMethodPosition = kind === 'word' && value === 'import'
        && groups.at(-1)?.provenObject === true
        && ['{', ',', 'async', 'get', 'set'].includes(previous?.value)
      previous = { kind, value, objectMethodPosition }; tokens.push(previous)
    }
    while (offset < source.length) {
      const char = source[offset]
      if (/\s/.test(char)) { offset++; continue }
      if (offset === 0 && source.startsWith('#!')) {
        while (offset < source.length && source[offset] !== '\n') offset++
        continue
      }
      if (source.startsWith('//', offset)) {
        while (offset < source.length && source[offset] !== '\n') offset++
        continue
      }
      if (source.startsWith('/*', offset)) {
        const end = source.indexOf('*/', offset + 2)
        if (end < 0) fail('unterminated comment')
        offset = end + 2; continue
      }
      if (char === "'" || char === '"') { emit('string', quoted(char)); regexAllowed = false; continue }
      if (char === '`') { template(); previous = { kind: 'template', value: '' }; regexAllowed = false; continue }
      if (char === '/' && regexAllowed) { regexp(); emit('regexp', ''); regexAllowed = false; continue }
      if (/[a-z_$\u0080-\uffff]/i.test(char)) {
        const begin = offset++
        while (offset < source.length && /[\w$\u0080-\uffff]/.test(source[offset])) offset++
        const word = source.slice(begin, offset)
        emit('word', word); regexAllowed = prefixWords.has(word); continue
      }
      if (/[0-9]/.test(char)) {
        const begin = offset++
        while (offset < source.length && /[\w.]/.test(source[offset])) offset++
        emit('number', source.slice(begin, offset)); regexAllowed = false; continue
      }
      if (char === '}' && interpolation && groups.length === 0) { offset++; return }
      const punct = ['?.', '=>', '++', '--', '...'].find(value => source.startsWith(value, offset)) || char
      offset += punct.length
      if (punct === '(') groups.push({ delimiter: ')', control: controlWords.has(previous?.value) })
      if (punct === '[') groups.push({ delimiter: ']' })
      if (punct === '{') {
        const object = ['=', '(', '[', ',', ':', 'return'].includes(previous?.value)
        // Colon may introduce a labelled statement and return may be followed by ASI.
        // Keep regexp lexical-goal hints separate from proof of an object method.
        const provenObject = ['=', '(', '[', ','].includes(previous?.value)
          || previous?.value === ':' && groups.at(-1)?.provenObject === true
        groups.push({ delimiter: '}', object, provenObject })
      }
      if ([')', ']', '}'].includes(punct)) {
        const group = groups.pop()
        if (group?.delimiter !== punct) fail('unbalanced delimiter')
        regexAllowed = punct === ')' ? Boolean(group.control) : punct === '}' && !group.object
      } else regexAllowed = !['.', '?.', '++', '--'].includes(punct)
      emit('punct', punct)
    }
    if (interpolation || groups.length) fail('unclosed expression')
  }
  code()
  return tokens
}

export const relativeModuleSpecifiers = source => {
  const tokens = tokensOf(source)
  const imports = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.kind !== 'word' || !['import', 'export'].includes(token.value)
        || ['.', '?.'].includes(tokens[index - 1]?.value)) continue
    const next = tokens[index + 1]
    if (token.value === 'import' && next?.value === '(') {
      // Skip only a method position proven by an object-expression container.
      // A call followed by an independent block (ASI) is still a real import().
      // Unproven class/computed forms remain fail-closed below.
      if (token.objectMethodPosition && !['string', 'template', 'number'].includes(tokens[index + 2]?.kind)) {
        let depth = 0; let cursor = index + 1
        for (; cursor < tokens.length; cursor++) {
          if (tokens[cursor].kind !== 'punct') continue
          if (tokens[cursor].value === '(') depth++
          if (tokens[cursor].value === ')' && --depth === 0) break
        }
        if (tokens[cursor + 1]?.value === '{') continue
      }
      const specifier = tokens[index + 2]
      if (specifier?.kind === 'string' || specifier?.kind === 'template') {
        if ((specifier.interpolated || ![')', ','].includes(tokens[index + 3]?.value))
            && !knownNonFilePrefix(specifier.value)) {
          throw new SyntaxError('Import scanner cannot prove a computed module specifier')
        }
        if (!specifier.interpolated && [')', ','].includes(tokens[index + 3]?.value)) imports.push(specifier.value)
      } else {
        throw new SyntaxError('Import scanner cannot prove a computed module specifier')
      }
      continue
    }
    if (token.value === 'import' && next?.kind === 'string') { imports.push(next.value); continue }
    if (token.value === 'export' && !['{', '*'].includes(next?.value)) continue
    if (!next || !['{', '*'].includes(next.value) && next.kind !== 'word') continue
    let depth = 0
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const current = tokens[cursor]
      if (current.value === '{') depth++
      if (current.value === '}') depth--
      if (depth < 0 || current.value === ';') break
      if (depth === 0 && current.kind === 'word' && current.value === 'from') {
        const specifier = tokens[cursor + 1]
        if (specifier?.kind !== 'string') throw new SyntaxError('Import scanner expected a static module specifier')
        imports.push(specifier.value); break
      }
      // An export without a from-clause must not consume a later statement.
      if (depth === 0 && cursor > index + 1 && current.kind === 'word'
          && ['import', 'export', 'const', 'let', 'function', 'class'].includes(current.value)) break
    }
  }
  return imports.filter(value => value.startsWith('./') || value.startsWith('../'))
}

export const scanRuntimeModuleClosure = (sourceRoot, entry = 'agent-client.mjs') => {
  const root = resolve(sourceRoot)
  const pending = [entry]; const closure = new Set()
  while (pending.length) {
    const file = resolve(root, pending.pop())
    const name = relative(root, file).split(sep).join('/')
    if (name === '..' || name.startsWith('../')) throw new Error(`Module dependency escapes payload: ${name}`)
    if (closure.has(name)) continue
    // readFileSync also proves existence, including for a genuinely missing dependency.
    const source = readFileSync(file, 'utf8')
    closure.add(name)
    if (extname(file) === '.mjs' || extname(file) === '.js') {
      for (const specifier of relativeModuleSpecifiers(source)) pending.push(relative(root, resolve(dirname(file), specifier)))
    }
  }
  return [...closure].sort()
}
