/** OOXML container identification only. No XML evaluation or extraction.
 * Tools reopen documents; the API retains its existing format/ACL validation. */
import yauzl from 'yauzl'
import { openSync, closeSync, constants } from 'node:fs'
const parts = new Map([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word/document.xml'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xl/workbook.xml']
])
export const isNativeOfficeMime = mime => parts.has(mime)
export function validateNativeOfficeSnapshot(path, mime) {
  return new Promise((accept, reject) => {
    let fd
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { reject(error); return }
    yauzl.fromFd(fd, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      let closed = false
      const finish = valid => {
        if (closed) return
        closed = true
        closeSync(fd)
        if (valid) accept(mime)
        else reject(Object.assign(new Error('NATIVE_OUTPUT_FORMAT_INVALID'), { code: 'NATIVE_OUTPUT_FORMAT_INVALID' }))
      }
      if (error) { finish(false); return }
      const names = new Set()
      zip.on('error', () => finish(false))
      zip.on('entry', entry => {
        if (names.has(entry.fileName) || entry.isEncrypted()) { finish(false); return }
        names.add(entry.fileName)
        zip.readEntry()
      })
      zip.on('end', () => finish(['[Content_Types].xml', '_rels/.rels', parts.get(mime)].every(name => names.has(name))))
      zip.readEntry()
    })
  })
}
