import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureMinimalNativeExecutionToolchain, nativeExecutionMountArgs, prepareNativeExecutionLayout, validateNativeExecutionToolchain } from '../native-execution-profile.mjs'
import { DOCUMENT_PROBE, DOCUMENT_MIMES, measureNativeDocumentToolchain } from '../native-document-toolchain.mjs'
import { validateNativeOutputSnapshot } from '../native-output-format.mjs'
const mkdir = path => { mkdirSync(path, { mode: 0o700 }); return path }

test('missing document interpreter is not a supported Office toolchain', () => {
  assert.throws(() => measureNativeDocumentToolchain({ base: measureMinimalNativeExecutionToolchain(), pythonBin: '/nonexistent/document-python' }), { code: 'ENOENT' })
})

// Explicit low-cost process/filesystem probe, no model/service/paid API. CI must
// supply its fixed toolchain; a skipped probe is not a production acceptance.
test('pinned Python actually reads/edits/reopens DOCX/XLSX inside native mounts; no host or input writes', { skip: !process.env.CYF_NATIVE_DOCUMENT_PROBE_PYTHON }, async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-document-probe-')); chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }))
  const probePath = resolve(mkdir(resolve(root, 'probe-tools')), 'document_probe.py'); copyFileSync(fileURLToPath(new URL('../toolchain/document_probe.py', import.meta.url)), probePath); chmodSync(probePath, 0o600)
  const base = measureMinimalNativeExecutionToolchain()
  const measurementStart = performance.now()
  const pdfProbePath = resolve(root, 'probe-tools/pdf-probe.mjs'), readmePath = resolve(root, 'probe-tools/README.md')
  copyFileSync(new URL('../toolchain/pdf-probe.mjs', import.meta.url), pdfProbePath)
  copyFileSync(new URL('../toolchain/documents/README.md', import.meta.url), readmePath)
  const toolchain = measureNativeDocumentToolchain({ base, pythonBin: process.env.CYF_NATIVE_DOCUMENT_PROBE_PYTHON, probePath, pdfProbePath, readmePath })
  t.diagnostic(`document discovery/hash/ldd: ${(performance.now() - measurementStart).toFixed(1)} ms; files: ${toolchain.files.length}`)
  assert.ok(toolchain.files.some(file => file.sandboxPath === '/usr/bin/python3'))
  assert.ok(toolchain.files.some(file => file.sandboxPath.endsWith('/openpyxl/__init__.py')))
  assert.ok(toolchain.files.every(file => !/(?:^|\/)(?:_tkinter[./]|tkinter\/)/.test(file.sandboxPath)))
  assert.ok(toolchain.files.every(file => !file.sandboxPath.startsWith('/home/') && !file.sandboxPath.includes('/pip/')))
  const execution = mkdir(resolve(root, 'execution'))
  const options = { inputDirectory: mkdir(resolve(execution, 'inputs')), scratchDirectory: mkdir(resolve(execution, 'scratch')), draftsDirectory: mkdir(resolve(execution, 'drafts')),
    stateRoot: mkdir(resolve(root, 'state')), sourceHome: mkdir(resolve(root, 'host-home')), skills: [], toolchain,
    nativeExecution: { executionId: 'office-test', tools: [], checkActive() {}, callTool() {} } }
  writeFileSync(resolve(options.sourceHome, 'private-canary'), 'not exposed')
  const engineState = { codexHome: mkdir(resolve(options.stateRoot, 'engine-home')) }
  writeFileSync(resolve(engineState.codexHome, 'config.toml'), '')
  const neutralDirectory = mkdir(resolve(root, 'neutral')), skillsDirectory = mkdir(resolve(root, 'skills'))
  const layoutStart = performance.now()
  const layout = prepareNativeExecutionLayout(options)
  t.diagnostic(`request layout with exact-metadata reuse: ${(performance.now() - layoutStart).toFixed(1)} ms`)
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/inputs', '--ro-bind', options.inputDirectory, '/inputs',
    ...nativeExecutionMountArgs({ layout, engineState, neutralDirectory, skillsDirectory }), '--setenv', 'HOME', '/state/home', '--chdir', '/execution']
  const run = command => spawnSync('/usr/bin/bwrap', [...args, ...command], { encoding: 'utf8', env: { LANG: 'C.UTF-8' } })
  const probe = run(['/usr/bin/python3', '-I', '-B', DOCUMENT_PROBE])
  assert.equal(probe.status, 0, probe.stderr); assert.equal(probe.stdout.trim(), 'native-documents-ready')
  for (const extension of ['docx', 'xlsx']) copyFileSync(resolve(options.scratchDirectory, `probe.${extension}`), resolve(options.inputDirectory, `input.${extension}`))
  const result = run(['/usr/bin/python3', '-I', '-B', '-c', `from pathlib import Path
from docx import Document
from openpyxl import load_workbook
import socket
assert not Path(${JSON.stringify(options.sourceHome)}).exists()
assert not Path('/etc/shadow').exists()
assert not Path('/root/.codex').exists()
for path in ['/inputs/forbidden', '/usr/bin/forbidden', '/state/home/forbidden']:
 try:
  Path(path).write_text('bad')
 except OSError:
  pass
 else:
  raise AssertionError('write isolation failed')
try:
 socket.create_connection(('127.0.0.1', 22), timeout=1)
except OSError:
 pass
else:
 raise AssertionError('host network exposed')
doc = Document('/inputs/input.docx')
assert doc.paragraphs[0].text == '文档能力核验'
doc.add_paragraph('已修改：只读输入保持不变')
doc.save('/outputs/result.docx')
assert Document('/outputs/result.docx').paragraphs[1].text.startswith('已修改')
book = load_workbook('/inputs/input.xlsx', data_only=False)
assert book.active['A2'].value == 12
book.active['A2'] = 15
book.save('/outputs/result.xlsx')
assert load_workbook('/outputs/result.xlsx', data_only=False).active['C2'].value == '=A2*B2'
assert load_workbook('/inputs/input.xlsx').active['A2'].value == 12
print('native-document-edit-pass')`])
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'native-document-edit-pass')
  for (const [extension, mime] of [['docx', DOCUMENT_MIMES[0]], ['xlsx', DOCUMENT_MIMES[1]]]) {
    assert.equal(await validateNativeOutputSnapshot(resolve(options.draftsDirectory, `result.${extension}`), mime), mime)
    assert.deepEqual(readFileSync(resolve(options.inputDirectory, `input.${extension}`)), readFileSync(resolve(options.scratchDirectory, `probe.${extension}`)))
  }
  const drift = { ...toolchain, files: toolchain.files.map(file => file.sandboxPath === '/usr/bin/python3' ? { ...file, sha256: '0'.repeat(64) } : file) }
  assert.throws(() => validateNativeExecutionToolchain(drift), /TOOLCHAIN_DRIFT/)
})

test('document initialization shares in-flight work and retains an already measured toolchain', async () => {
  const { initializeNativeToolchain } = await import('../native-document-toolchain.mjs')
  const measured = { shell: '/bin/bash', files: [] }
  assert.equal(await initializeNativeToolchain({ nativeToolchain: measured }), measured)
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const runtime = { nativeToolchainPending: pending }
  const first = initializeNativeToolchain(runtime), second = initializeNativeToolchain(runtime)
  finish(measured)
  assert.equal(await first, measured); assert.equal(await second, measured)
})

test('replaceable venv base is rejected before importing external Python code', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-document-base-')); chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }))
  const venv = mkdir(resolve(root, 'venv')), bin = mkdir(resolve(venv, 'bin')), home = mkdir(resolve(root, 'replaceable-base'))
  copyFileSync('/usr/bin/bash', resolve(bin, 'python')); chmodSync(resolve(bin, 'python'), 0o700)
  copyFileSync('/usr/bin/bash', resolve(home, 'python3')); chmodSync(resolve(home, 'python3'), 0o700)
  writeFileSync(resolve(venv, 'pyvenv.cfg'), `home = ${home}\n`, { mode: 0o600 })
  chmodSync(home, 0o770)
  assert.throws(() => measureNativeDocumentToolchain({ base: measureMinimalNativeExecutionToolchain(), pythonBin: resolve(bin, 'python') }), { code: 'NATIVE_DOCUMENT_BASE_UNSAFE' })
})

test('frozen local stdlib must be protected before interpreter execution', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-frozen-unsafe-')); chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = mkdir(resolve(root, 'bin')), lib = mkdir(resolve(root, 'lib'))
  const stdlib = mkdir(resolve(lib, 'python3.11')), encodings = mkdir(resolve(stdlib, 'encodings'))
  writeFileSync(resolve(bin, 'python'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  writeFileSync(resolve(stdlib, 'os.py'), '# fixture', { mode: 0o600 })
  writeFileSync(resolve(encodings, '__init__.py'), '# fixture', { mode: 0o600 })
  chmodSync(stdlib, 0o770)
  assert.throws(() => measureNativeDocumentToolchain({ base: measureMinimalNativeExecutionToolchain(), pythonBin: resolve(bin, 'python') }), { code: 'NATIVE_EXECUTION_TOOLCHAIN_UNSAFE' })
})

test('worker discovery retains base tools when the optional browser artifact is absent', async t => {
  const { existsSync } = await import('node:fs')
  if (existsSync(new URL('../.browser-toolchain/chromium/chrome-headless-shell', import.meta.url))) {
    t.skip('this regression targets a source checkout without the optional browser artifact'); return
  }
  const { initializeNativeToolchain } = await import('../native-document-toolchain.mjs')
  const runtime = {}
  const measured = await initializeNativeToolchain(runtime)
  assert.equal(runtime.nativeToolchain, measured)
  assert.ok(measured.files.some(file => file.sandboxPath === '/usr/bin/node'))
  assert.ok(measured.files.some(file => file.sandboxPath === measured.shell))
  assert.equal(runtime.nativeBrowserMeasurementFailure.stage, 'toolchain')
  assert.equal(runtime.nativeToolchainPending, null)
})
