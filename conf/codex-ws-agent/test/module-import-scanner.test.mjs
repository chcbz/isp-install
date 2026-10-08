import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { relativeModuleSpecifiers, scanRuntimeModuleClosure } from './module-import-scanner.mjs'

test('import scanner ignores strings, comments, regexp and template text without hiding real imports', () => {
  const source = [
    `const expectedImport = "from './parse-text.mjs'"`,
    `const fake = "import('./not-code.mjs')"`,
    `// import './line-comment.mjs'`,
    `/* import { hidden } from './block-comment.mjs' */`,
    'const template = `import("./template-text.mjs")`',
    String.raw`const regex = /import\("\.\/regexp-text.mjs"\)/`,
    String.raw`if (true) /import\("\.\/control-regexp.mjs"\)/.test('sample')`,
    `object.import('./property-call.mjs')`,
    `const loader = { import(name) { return name } }`,
    `import.meta.resolve('./resolve-not-import.mjs')`,
    `export const selector = value => value.from('./not-an-export.mjs')`,
    `import './real.mjs'`
  ].join('\n')
  assert.deepEqual(relativeModuleSpecifiers(source), ['./real.mjs'])
})

test('import scanner extracts multiline static, side-effect, re-export and literal dynamic imports', () => {
  const source = [
    `import defaultValue, {`,
    `  from as localFrom, named`,
    `} /* between tokens */ from`,
    `  './multiline.mjs'`,
    `import * as namespace from './namespace.mjs'`,
    `import './side-effect.mjs'`,
    `export { named } from './re-export.mjs'`,
    `export * from '../parent.mjs'`,
    `await import(`,
    `  /* actual dynamic dependency */ './dynamic.mjs'`,
    `)`,
    'await import(`./literal-template.mjs`)',
    String.raw`import './escaped\u002emjs'`
  ].join('\n')
  assert.deepEqual(relativeModuleSpecifiers(source), [
    './multiline.mjs', './namespace.mjs', './side-effect.mjs', './re-export.mjs',
    '../parent.mjs', './dynamic.mjs', './literal-template.mjs', './escaped.mjs'
  ])
})

test('import scanner inspects executable template expressions but not a generated data module body', () => {
  const source = [
    'const text = `not import("./fake.mjs") ${await import("./expression.mjs")}`',
    `const checkSource = "import('./data-body.mjs')"`,
    'await import(`data:text/javascript;base64,${Buffer.from(checkSource).toString("base64")}`)'
  ].join('\n')
  assert.deepEqual(relativeModuleSpecifiers(source), ['./expression.mjs'])
  assert.throws(() => relativeModuleSpecifiers('await import(`./${name}.mjs`)'), /cannot prove a computed module specifier/)
  assert.throws(() => relativeModuleSpecifiers("await import('./' + name)"), /cannot prove a computed module specifier/)
})

test('runtime closure rejects a genuine missing static or dynamic module file', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-module-closure-'))
  try {
    for (const source of ["import { missing } from './missing.mjs'", "await import('./missing.mjs')"]) {
      writeFileSync(resolve(root, 'agent-client.mjs'), source)
      assert.throws(() => scanRuntimeModuleClosure(root), error => error.code === 'ENOENT' && error.path === resolve(root, 'missing.mjs'))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a genuine dynamic import followed by an ASI block is scanned and its missing file rejected', () => {
  const source = "if (true) {\n  import('./missing.mjs')\n  {}\n}"
  assert.deepEqual(relativeModuleSpecifiers(source), ['./missing.mjs'])
  // A labelled block and return ASI are not proven object-expression containers either.
  assert.deepEqual(relativeModuleSpecifiers("label: {\n import('./missing.mjs')\n {}\n}"), ['./missing.mjs'])
  assert.deepEqual(relativeModuleSpecifiers("function go() { return\n {\n import('./missing.mjs')\n {}\n} }"), ['./missing.mjs'])
  assert.throws(() => relativeModuleSpecifiers('class Loader { import(name) { return name } }'),
    /cannot prove a computed module specifier/)
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-module-closure-asi-'))
  try {
    writeFileSync(resolve(root, 'agent-client.mjs'), source)
    assert.throws(() => scanRuntimeModuleClosure(root),
      error => error.code === 'ENOENT' && error.path === resolve(root, 'missing.mjs'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('runtime closure follows real multiline dependencies and leaves a fake parse-text reference untouched', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-module-closure-'))
  try {
    writeFileSync(resolve(root, 'agent-client.mjs'), [
      `const expectedImport = "from './parse-text.mjs'"`,
      `import {`, `  value`, `} from './dependency.mjs'`,
      `await import('./dynamic.mjs')`
    ].join('\n'))
    writeFileSync(resolve(root, 'dependency.mjs'), 'export const value = 1')
    writeFileSync(resolve(root, 'dynamic.mjs'), "import { value } from './dependency.mjs'; export { value }")
    assert.deepEqual(scanRuntimeModuleClosure(root), ['agent-client.mjs', 'dependency.mjs', 'dynamic.mjs'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the unchanged archive runner declares real runtime dependencies, not the approved skill internal import string', () => {
  const source = readFileSync(new URL('../archive-maintenance-runner.mjs', import.meta.url), 'utf8')
  assert.match(source, /const expectedImport\s*=\s*"from '\.\/parse-text\.mjs'"/)
  const imports = relativeModuleSpecifiers(source)
  assert.equal(imports.includes('./parse-text.mjs'), false)
  assert.equal(imports.includes('./archive-maintenance-checkpoints.mjs'), true)
  assert.equal(imports.includes('./platform-skill-native.mjs'), true)
})
