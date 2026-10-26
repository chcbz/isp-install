import test, { after } from 'node:test'
import yauzl from 'yauzl'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pdfFixture } from './fixtures/pdf-document.mjs'
import { parseSkillManifest, skillPackageTreeDigest } from '../skill-manifest.mjs'
import { createLocalScriptRunner } from '../skill-runners/local-script.mjs'
// Test the exact distributable ZIP, not a developer's staged vendor tree.
const root = mkdtempSync(resolve(tmpdir(), 'pdf-skill-archive-'))
after(() => rmSync(root, { recursive: true, force: true }))
const packageRoot = resolve(root, 'package'); mkdirSync(packageRoot)
const receipt = JSON.parse(readFileSync(new URL('../toolchain/skill-packages-se2/pdf-extract/release-input.json', import.meta.url)))
const archive = readFileSync(new URL('../toolchain/skill-packages-se2/pdf-extract-1.0.0.zip', import.meta.url))
assert.equal(createHash('sha256').update(archive).digest('hex'), receipt.packageSha256)
await new Promise((accept, reject) => yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
  if (error) return reject(error)
  zip.on('error', reject); zip.on('end', accept)
  zip.on('entry', entry => {
    if (entry.fileName.startsWith('/') || entry.fileName.split('/').includes('..')) return reject(new Error('Unsafe fixture ZIP'))
    zip.openReadStream(entry, async (error, stream) => {
      if (error) return reject(error)
      try {
        const chunks = []; for await (const chunk of stream) chunks.push(chunk)
        const path = resolve(packageRoot, entry.fileName); mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, Buffer.concat(chunks), { mode: 0o644 }); zip.readEntry()
      } catch (error) { reject(error) }
    })
  }); zip.readEntry()
}))
const manifest = parseSkillManifest(readFileSync(resolve(packageRoot, 'manifest.json')), { skillKey: 'pdf-extract', skillVersion: '1.0.0' })
const fixture = (t, bytes) => {
  const root = mkdtempSync(resolve(tmpdir(), 'pdf-skill-test-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = resolve(root, 'input.pdf'), outputDirectory = resolve(root, 'outputs'); mkdirSync(outputDirectory, { mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o400 })
  const input = { inputRef: 'pdf_1', contentMimeType: 'application/pdf', bytes, byteLength: String(bytes.length), sha256: createHash('sha256').update(bytes).digest('hex'), path }
  return { input, outputDirectory, request: { schemaVersion: 1, inputs: [input], parameters: {}, outputDirectory } }
}
for (const [label, bytes, status] of [['pages and Chinese and empty-page warning', pdfFixture(), 'OCR_MAY_BE_REQUIRED'], ['invalid', Buffer.from('%PDF-broken'), 'INVALID_PDF'], ['password', pdfFixture({ encrypted: true }), 'PASSWORD_REQUIRED']]) {
  test(`packaged PDF script: ${label}`, t => {
    const f = fixture(t, bytes)
    const child = spawnSync(process.execPath, ['--no-addons', resolve(packageRoot, 'main.mjs')], { input: JSON.stringify(f.request), encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout)
    assert.equal(result.data.status, status)
    assert.equal(result.data.ocrPerformed, false)
    if (status === 'OCR_MAY_BE_REQUIRED') {
      assert.equal(result.data.pageCount, 3); assert.match(result.data.pages[0].text, /First PDF page/); assert.equal(result.data.pages[1].text, '中文'); assert.deepEqual(result.data.emptyPages, [3])
      assert.equal(result.artifacts[0].path, 'document.txt'); assert.match(readFileSync(resolve(f.outputDirectory, 'document.txt'), 'utf8'), /未执行 OCR/)
    } else { assert.deepEqual(result.data.pages, []); assert.deepEqual(result.artifacts, []) }
  })
}
test('actual PDF package executes in the existing no-network local-script sandbox with real input receipt', async t => {
  const f = fixture(t, pdfFixture()), runner = createLocalScriptRunner()
  const context = { packageRoot, entrypoint: manifest.entrypoint }
  const probe = await runner.probe(context)
  if (!probe.ready) { t.skip('Real bubblewrap unavailable; package is not READY'); return }
  const result = await runner.run({ descriptor: { packageRoot, manifest, packageTreeDigest: skillPackageTreeDigest(packageRoot) }, command: { executionId: 'pdf_skill_test', inputRefs: ['pdf_1'] }, inputs: [f.input], parameters: {}, instruction: 'read PDF', outputDirectory: f.outputDirectory, effects: { invoke: async (_id, _req, invoke) => invoke() } })
  assert.equal(result.data.pages[1].text, '中文'); assert.equal(result.data.pageCount, 3)
  assert.deepEqual(result.inputReceipts, [{ inputRef: 'pdf_1', sha256: f.input.sha256, carrier: 'local-file', delivery: 'DELIVERED' }])
  assert.match(result.artifacts[0].bytes.toString('utf8'), /First PDF page/)
})
