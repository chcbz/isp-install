import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { zip } from './fixtures/skill-management-fixture.mjs'
import { validateNativeOutputSnapshot } from '../native-output-format.mjs'
import { DOCUMENT_MIMES } from '../native-document-toolchain.mjs'
const [docx, xlsx] = DOCUMENT_MIMES
const parts = part => [{ name: '[Content_Types].xml', data: '<Types/>' }, { name: '_rels/.rels', data: '<Relationships/>' }, { name: part, data: '<fixture/>' }]
const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'native-office-format-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = resolve(root, 'snapshot'); return { root, path, put: bytes => writeFileSync(path, bytes) }
}
test('Office identification uses OOXML parts, not a filename or any ZIP signature', async t => {
  const f = fixture(t)
  f.put(zip(parts('word/document.xml'))); assert.equal(await validateNativeOutputSnapshot(f.path, docx), docx)
  await assert.rejects(() => validateNativeOutputSnapshot(f.path, xlsx), /FORMAT_INVALID/)
  f.put(zip(parts('xl/workbook.xml'))); assert.equal(await validateNativeOutputSnapshot(f.path, xlsx), xlsx)
  // Identification alone does not declare these deliberately minimal XML stubs
  // semantically reopenable. Actual reopens belong to document-tool regressions.
  for (const bytes of [Buffer.from('PK fake'), zip([{ name: 'ordinary.txt', data: 'not Office' }]), zip(parts('xl/workbook.xml')).subarray(0, 40)]) {
    f.put(bytes); await assert.rejects(() => validateNativeOutputSnapshot(f.path, xlsx), /FORMAT_INVALID/)
  }
})
test('invalid archive paths, duplicate entries and symlink snapshots are rejected without extraction', async t => {
  const f = fixture(t)
  for (const extra of [{ name: '../escape.xml', data: 'x' }, { name: 'word/document.xml', data: 'duplicate' }]) {
    f.put(zip([...parts('word/document.xml'), extra])); await assert.rejects(() => validateNativeOutputSnapshot(f.path, docx), /FORMAT_INVALID/)
  }
  f.put(zip(parts('word/document.xml')))
  const link = resolve(f.root, 'linked'); symlinkSync(f.path, link)
  await assert.rejects(() => validateNativeOutputSnapshot(link, docx), { code: 'ELOOP' })
})

test('PDF collector checks the byte envelope only, matching the existing API contract', async t => {
  const { pdfFixture } = await import('./fixtures/pdf-document.mjs')
  const f = fixture(t)
  for (const bytes of [pdfFixture(), Buffer.concat([pdfFixture(), Buffer.alloc(9000, 32)]), pdfFixture({ encrypted: true })]) {
    f.put(bytes); assert.equal(validateNativeOutputSnapshot(f.path, 'application/pdf'), 'application/pdf')
  }
  // Encrypted PDFs can be carried; this check does not claim they can be read.
  for (const bytes of [Buffer.from('not PDF'), pdfFixture().subarray(0, -8), Buffer.concat([pdfFixture(), Buffer.from('garbage')]), Buffer.from('%%EOF')]) {
    f.put(bytes); assert.throws(() => validateNativeOutputSnapshot(f.path, 'application/pdf'), /FORMAT_INVALID/)
  }
})
