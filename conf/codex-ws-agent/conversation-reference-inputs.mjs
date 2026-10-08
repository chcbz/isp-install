/** Materialize only exact, grant-fenced native CONVERSATION inputs into a private run.
 * Snapshot fields are server-authenticated but validated again at the client boundary;
 * filenames and fileIds never become paths or model instructions.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export class ConversationInputError extends Error {
  constructor(code) { super(code); this.code = code }
}
const deny = () => { throw new ConversationInputError('CONVERSATION_INPUTS_UNAVAILABLE') }
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const HASH = /^[a-f0-9]{64}$/
const MIME = new Map([['image/png','png'],['image/jpeg','jpg'],['image/webp','webp'],['image/gif','gif'],['audio/mpeg','mp3'],['audio/wav','wav'],['audio/ogg','ogg'],['audio/webm','webm'],['text/plain','txt'],['text/markdown','md'],['application/json','json'],['application/octet-stream','bin'],['application/pdf','pdf'],['application/vnd.openxmlformats-officedocument.wordprocessingml.document','docx'],['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','xlsx'],['application/vnd.openxmlformats-officedocument.presentationml.presentation','pptx']])
const FIELDS = ['inputRef', 'fileId', 'version', 'originalFilename', 'contentMimeType', 'byteLength', 'sha256'].sort().join(',')

export const parseNativeConversationInputs = (snapshot, executionId, leaseVersion) => {
  if (!obj(snapshot) || Object.keys(snapshot).sort().join(',') !==
      ['executionId', 'leaseVersion', 'noReferencedMaterials', 'inputs'].sort().join(',') ||
      snapshot.executionId !== executionId || snapshot.leaseVersion !== leaseVersion ||
      !Array.isArray(snapshot.inputs) || snapshot.inputs.length > 32 ||
      snapshot.noReferencedMaterials !== (snapshot.inputs.length === 0)) deny()
  return Object.freeze(snapshot.inputs.map((input, index) => {
    if (!obj(input) || Object.keys(input).sort().join(',') !== FIELDS ||
        input.inputRef !== `input_${index + 1}` || !ID.test(input.fileId || '') ||
        !Number.isSafeInteger(input.version) || input.version < 1 ||
        typeof input.originalFilename !== 'string' || !input.originalFilename.trim() ||
        input.originalFilename.length > 255 || !MIME.has(input.contentMimeType) ||
        !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || !HASH.test(input.sha256 || '')) deny()
    return Object.freeze({ ...input, relativePath: `inputs/${input.inputRef}.${MIME.get(input.contentMimeType)}` })
  }))
}

/** A content read is reauthorized by the API on every call; no legacy /inputs fallback. */
export const materializeNativeConversationInputs = async ({ inputs, runDirectory, readInput }) => {
  if (!Array.isArray(inputs) || typeof runDirectory !== 'string' || typeof readInput !== 'function') deny()
  const output = []
  for (const input of inputs) {
    const path = resolve(runDirectory, input.relativePath)
    if (!path.startsWith(`${resolve(runDirectory, 'inputs')}${sep}`)) deny()
    const bytes = await readInput(input)
    if (!Buffer.isBuffer(bytes) || bytes.length !== input.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== input.sha256) deny()
    // 'wx' forbids overwriting a pre-existing path, including a symlink. Run directory
    // is unique and 0700, and never shared with CHAT or an unrelated execution.
    let fd; let created = false
    try {
      fd = openSync(path, 'wx', 0o600); created = true
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
      closeSync(fd); fd = undefined
      if (realpathSync(path) !== path) deny()
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      if (created) try { unlinkSync(path) } catch { /* the run tree is removed on exit */ }
      throw error instanceof ConversationInputError ? error : new ConversationInputError('CONVERSATION_INPUTS_UNAVAILABLE')
    }
    output.push(Object.freeze({ relativePath: input.relativePath, contentType: input.contentMimeType,
      byteLength: input.byteLength, sha256: input.sha256 }))
  }
  return Object.freeze(output)
}
