import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import DOMMatrix from './vendor/dommatrix.mjs'

// PDF.js diagnostics must never contaminate the runner's single JSON response.
console.log = (...args) => console.error(...args)
globalThis.DOMMatrix = DOMMatrix
let raw = ''
for await (const chunk of process.stdin) raw += chunk
const request = JSON.parse(raw)
if (request.schemaVersion !== 1 || request.inputs?.length !== 1 ||
    request.inputs[0].contentMimeType !== 'application/pdf' ||
    !request.parameters || Object.keys(request.parameters).length) throw new Error('PDF_REQUEST_INVALID')
const input = request.inputs[0]
const bytes = await readFile(input.path)
if (String(bytes.length) !== input.byteLength || createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('PDF_INPUT_INTEGRITY')
const pdf = await import('./vendor/pdf.mjs')
pdf.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href
const task = pdf.getDocument({
  data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true,
  cMapUrl: fileURLToPath(new URL('./vendor/cmaps/', import.meta.url)),
  standardFontDataUrl: fileURLToPath(new URL('./vendor/standard_fonts/', import.meta.url)),
  isEvalSupported: false, enableXfa: false, useSystemFonts: false,
  disableFontFace: true, useWasm: false, isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false
})
let result
try {
  const document = await task.promise
  const pages = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items.filter(item => typeof item.str === 'string')
      .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim()
    pages.push({ page: pageNumber, text })
    page.cleanup()
  }
  const emptyPages = pages.filter(page => !page.text).map(page => page.page)
  const text = pages.map(page => `--- Page ${page.page} ---\n${page.text || '[未提取到文字；未执行 OCR]'}`).join('\n\n') + '\n'
  await writeFile(`${request.outputDirectory}/document.txt`, text, { flag: 'wx', mode: 0o600 })
  result = { data: { status: emptyPages.length ? 'OCR_MAY_BE_REQUIRED' : 'EXTRACTED', pageCount: pages.length, pages, emptyPages, ocrPerformed: false },
    artifacts: [{ outputId: 'pdf_text', contentMimeType: 'text/plain', path: 'document.txt' }] }
} catch (error) {
  const status = error?.name === 'PasswordException' ? 'PASSWORD_REQUIRED' :
    ['InvalidPDFException', 'FormatError'].includes(error?.name) ? 'INVALID_PDF' : null
  if (!status) throw error
  result = { data: { status, pageCount: 0, pages: [], emptyPages: [], ocrPerformed: false }, artifacts: [] }
} finally { await task.destroy() }
process.stdout.write(JSON.stringify(result))
