import { constants, openSync, closeSync, writeFileSync, fsyncSync, readFileSync, lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeImageInput } from './image-input.mjs'
/** Write only alongside an already verified, private, materialized original. */
function writeImageDerivative({ path, bytes, mimeType }, mapPath) {
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink() || realpathSync(path) !== path || !readFileSync(path).equals(bytes))
    throw Object.assign(new Error('IMAGE_SOURCE_PATH_INVALID'), { code: 'IMAGE_SOURCE_PATH_INVALID' })
  const normalized = normalizeImageInput(bytes, mimeType)
  const output = `${path}.${normalized.provenance.sha256}.png`
  let fd
  try {
    fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
    writeFileSync(fd, normalized.bytes); fsyncSync(fd)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = lstatSync(output)
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== st.uid ||
        (existing.mode & 0o077) || realpathSync(output) !== output || !readFileSync(output).equals(normalized.bytes)) throw error
  } finally { if (fd !== undefined) closeSync(fd) }
  const directory = openSync(dirname(output), constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  return { ...normalized.provenance, bytes: normalized.bytes, path: mapPath(output) }
}

export function prepareImageDerivative(source, mapPath = value => value) {
  try { return writeImageDerivative(source, mapPath) }
  catch (cause) {
    if (cause.code?.startsWith('IMAGE_')) throw cause
    throw Object.assign(new Error('已收到图片，但暂时无法准备可读取的图片文件，请重试'), { code: 'IMAGE_NORMALIZATION_STORAGE_FAILED', cause })
  }
}
