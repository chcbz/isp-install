import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')
const bytes = value => Buffer.byteLength(value, 'utf8')
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value
const canonical = value => JSON.stringify(sorted(value), null, 2) + '\n'
const fail = code => { throw new Error(code) }

export function buildArchive(source) {
  for (const key of ['workId','editionId','title','sourceName','sourceRights','sourceText','sourceSha256'])
    if (typeof source?.[key] !== 'string' || !source[key].trim()) fail('ARCHIVE_SOURCE_REQUIRED')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source.workId)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(source.editionId)
      || hash(source.sourceText) !== source.sourceSha256) fail('ARCHIVE_SOURCE_MISMATCH')
  const lines = source.sourceText.replace(/^\uFEFF/, '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const isHeading = line => /^(?:第[零〇一二三四五六七八九十百千万两0-9]+[回章节卷](?:$|(?:\s|[：:、]).*)|#{1,6}\s+.+)$/u.test(line)
  const first = lines.findIndex(isHeading)
  let preface = null; const chapters = []
  const block = (title, texts, number) => {
    if (!texts.length) fail('ARCHIVE_EMPTY_CHAPTER')
    const key = number == null ? 'preface' : `chapter-${number}`
    const paragraphs = texts.map((text, i) => ({ paragraphId: `${key}-p-${i+1}`, text, sha256: hash(text), utf8ByteLength: bytes(text) }))
    return { chapterId: number == null ? null : key, number, prefaceId: number == null ? key : null, title,
      paragraphCount: paragraphs.length, paragraphs, utf8ByteLength: paragraphs.reduce((n,p) => n+p.utf8ByteLength,0) }
  }
  if (first < 0) chapters.push(block('正文', lines, 1))
  else {
    if (first > 0) preface = block('引首', lines.slice(0,first), null)
    let heading = null; let body = []
    for (const line of lines.slice(first)) {
      if (isHeading(line)) {
        if (heading !== null) chapters.push(block(heading, body, chapters.length+1))
        heading = line.replace(/^#{1,6}\s+/u,''); body=[]
      } else body.push(line)
    }
    chapters.push(block(heading,body,chapters.length+1))
  }
  const chapterParagraphCount = chapters.reduce((n,c)=>n+c.paragraphCount,0)
  const chapterUtf8ByteLength = chapters.reduce((n,c)=>n+c.utf8ByteLength,0)
  const prefaceParagraphCount = preface?.paragraphCount || 0, prefaceUtf8ByteLength = preface?.utf8ByteLength || 0
  const manifest = { schemaVersion: 1, workId: source.workId, editionId: source.editionId, title: source.title,
    source: { file: source.sourceName, page: null, upstreamCommit: null, upstreamRepo: null,
      sha256: source.sourceSha256, utf8ByteLength: bytes(source.sourceText), excludedNoticeLines: [] },
    chapterCount: chapters.length, chapterParagraphCount, chapterUtf8ByteLength, chapters, preface,
    prefaceParagraphCount, prefaceUtf8ByteLength, readerParagraphCount: prefaceParagraphCount+chapterParagraphCount,
    readerUtf8ByteLength: prefaceUtf8ByteLength+chapterUtf8ByteLength }
  manifest.manifestSha256 = hash(canonical(manifest))
  const manifestJson = canonical(manifest)
  return { manifestJson, manifestFileSha256: hash(manifestJson) }
}

if (process.argv[1] && import.meta.url.endsWith('/'+process.argv[1].replaceAll('\\','/').split('/').pop())) {
  try {
    let input=''; for await (const chunk of process.stdin) input+=chunk
    process.stdout.write(JSON.stringify(buildArchive(JSON.parse(input))))
  } catch (error) { process.stderr.write(String(error.message)); process.exitCode=1 }
}
