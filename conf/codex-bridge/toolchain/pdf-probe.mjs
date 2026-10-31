/** Disposable PDF readiness probe, not a business document template. */
import { withBrowser } from './browser-session.mjs'
import { execFileSync } from 'node:child_process'
await withBrowser(async ({ page }) => {
  await page.setContent('<meta charset="utf-8"><style>body{font-family:"Noto Sans CJK SC"}</style><p>中文文档核验 PDF-1031</p>')
  await page.pdf({ path: '/workspace/probe.pdf', format: 'A4' })
})
execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `from pypdf import PdfReader
from unicodedata import normalize
reader = PdfReader('/workspace/probe.pdf', strict=True)
assert len(reader.pages) == 1
# Chromium/Noto may map shared glyphs to compatibility radicals (e.g. U+2F42).
text = ''.join(normalize('NFKC', reader.pages[0].extract_text()).split())
assert '中文文档核验PDF-1031' in text, repr(text)
fonts = reader.pages[0]['/Resources']['/Font'].get_object()
for ref in fonts.values():
 font = ref.get_object()
 if font.get('/Subtype') == '/Type3':
  # Type3 embeds glyph painting streams instead of FontFile descriptors.
  # PDF Reference 5.5.4; Skia src/pdf/SkPDFFont.cpp emit_subset_type3.
  glyphs = font['/CharProcs'].get_object()
  assert glyphs and all(g.get_object().get_data() for g in glyphs.values()), 'Missing embedded glyphs'
 else:
  for candidate in font.get('/DescendantFonts', [font]):
   descriptor = candidate.get_object().get('/FontDescriptor')
   assert descriptor and any(key in descriptor.get_object() for key in ('/FontFile', '/FontFile2', '/FontFile3')), 'Missing embedded font'
assert fonts, 'PDF must contain fonts'
`], { stdio: ['ignore', 'pipe', 'pipe'] })
console.log('native-pdf-ready')
