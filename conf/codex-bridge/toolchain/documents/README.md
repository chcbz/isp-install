# Native document tools

This is tool documentation, not a skill or authorization. Use ordinary scripts
for the current task; do not install packages or call the readiness probes as
business document generators. Inputs are read-only. Write deliverables to
`/outputs`, reopen and check their actual content before artifact_stage and
result_propose.

`/usr/bin/python3 -I -B` provides `docx`, `openpyxl` and `pypdf`:
- Read/edit DOCX with `docx.Document`; XLSX with `openpyxl.load_workbook`.
  Formulas can be preserved but are not recalculated by openpyxl.
- Read text PDFs with `pypdf.PdfReader`, inspect `pages` and `extract_text()`;
  use `PdfWriter` for page operations. Preserve original inputs. Encrypted or
  malformed documents may fail; report the actual limitation. Scanned pages
  with no text need an OCR tool not supplied here; never invent extracted text.
- Generate Chinese PDFs with the existing browser tool documented in
  `/usr/lib/cyf-browser/README.md`: load your HTML, use UTF-8 and
  `font-family: "Noto Sans CJK SC"`, then
  `await page.pdf({path:'/outputs/document.pdf',format:'A4',printBackground:true})`.
  Use the existing withBrowser helper and retain sandbox, TLS and network policy.
  HTML and layout are authored by the model, not a bridge business template.
- Chromium/Noto text extraction can use Unicode compatibility radicals for shared
  glyphs (for example `⽂` versus `文`). For semantic text comparison, use
  `unicodedata.normalize("NFKC", extracted_text)` on both expected and actual text;
  retain the original extracted text and never replace missing characters.
- Reopen generated PDFs with pypdf and verify text/page count. A valid header or
  a successful write does not establish correct content or layout. A page
  screenshot can help inspect layout, but is not a substitute for PDF text checks.

Large extracted content stays in workspace files rather than whole stdout.
Do not encode Chinese as ASCII placeholders, silently omit pages, or treat PDF
text extraction as visual understanding of figures.
