import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const COMMAND_KEYS = ['inputManifest', 'outputManifest', 'runId', 'taskId']
const INPUT_KEYS = ['downloadPath', 'inputId', 'length', 'relativePath', 'sha256']
const OUTPUT_KEYS = ['contentType', 'maxLength', 'outputId', 'relativePath', 'uploadPath']
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/
const INPUT_LIMIT = 128
const OUTPUT_LIMIT = 128
const PATH_LIMIT = 512
const INPUT_PREFIX = '/internal/agent/tasks'
const AUTH_MAX_LENGTH = 4096
const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0

export class WorkspaceFileBridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkspaceFileBridgeError'
    this.code = code
  }
}

const fail = (code, message) => { throw new WorkspaceFileBridgeError(code, message) }

const isPlainObject = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const assertExactKeys = (value, expected, label) => {
  if (!isPlainObject(value)) fail('COMMAND_INVALID', `${label} must be an object`)
  const ownKeys = Reflect.ownKeys(value)
  const actual = ownKeys.filter(key => typeof key === 'string').sort()
  if (actual.length !== ownKeys.length || actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    fail('COMMAND_INVALID', `${label} must contain only: ${expected.join(', ')}`)
  }
}

const parseId = (value, label) => {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail('COMMAND_INVALID', `${label} must be a canonical 1-64 character ASCII identifier`)
  }
  return value
}

const parseLength = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('COMMAND_INVALID', `${label} must be a non-negative safe integer`)
  }
  return value
}

const parseRelativePath = (value, label) => {
  if (typeof value !== 'string' || !value || value.length > PATH_LIMIT || value.includes('\\')
      || value.startsWith('/') || value.endsWith('/') || value.includes('//')
      || /[\u0000-\u001f\u007f-\uffff]/u.test(value)) {
    fail('PATH_UNSAFE', `${label} must be a canonical relative ASCII path`)
  }
  const segments = value.split('/')
  if (segments.some(segment => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment))) {
    fail('PATH_UNSAFE', `${label} contains an unsafe path segment`)
  }
  return value
}

const expectedInputPath = (taskId, runId, inputId) => (
  `${INPUT_PREFIX}/${taskId}/runs/${runId}/inputs/${inputId}/content`
)

const expectedOutputPath = (taskId, runId, outputId) => (
  `${INPUT_PREFIX}/${taskId}/runs/${runId}/outputs/${outputId}/content`
)

const expectedCommitPath = (taskId, runId, manifestId) => (
  `${INPUT_PREFIX}/${taskId}/runs/${runId}/output-commits/${manifestId}`
)

const freezeList = list => Object.freeze(list.map(item => Object.freeze(item)))

export const parseWorkspaceFileCommand = command => {
  assertExactKeys(command, COMMAND_KEYS, 'workspace file command')
  const taskId = parseId(command.taskId, 'taskId')
  const runId = parseId(command.runId, 'runId')
  if (!Array.isArray(command.inputManifest) || command.inputManifest.length > INPUT_LIMIT) {
    fail('COMMAND_INVALID', `inputManifest must be an array with at most ${INPUT_LIMIT} entries`)
  }
  if (!Array.isArray(command.outputManifest) || command.outputManifest.length > OUTPUT_LIMIT) {
    fail('COMMAND_INVALID', `outputManifest must be an array with at most ${OUTPUT_LIMIT} entries`)
  }

  const identities = new Set()
  const paths = new Set()
  const addPath = relativePath => {
    if ([...paths].some(existing => existing === relativePath
        || existing.startsWith(`${relativePath}/`) || relativePath.startsWith(`${existing}/`))) {
      fail('COMMAND_INVALID', `duplicate or overlapping manifest relativePath: ${relativePath}`)
    }
    paths.add(relativePath)
  }
  const inputs = command.inputManifest.map((input, index) => {
    const label = `inputManifest[${index}]`
    assertExactKeys(input, INPUT_KEYS, label)
    const inputId = parseId(input.inputId, `${label}.inputId`)
    const relativePath = parseRelativePath(input.relativePath, `${label}.relativePath`)
    if (identities.has(`input:${inputId}`)) fail('COMMAND_INVALID', `duplicate inputId: ${inputId}`)
    addPath(relativePath)
    identities.add(`input:${inputId}`)
    if (typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) {
      fail('COMMAND_INVALID', `${label}.sha256 must be canonical lowercase SHA-256`)
    }
    const downloadPath = expectedInputPath(taskId, runId, inputId)
    if (input.downloadPath !== downloadPath) {
      fail('ENDPOINT_FORBIDDEN', `${label}.downloadPath must be the exact run-scoped API path`)
    }
    return {
      inputId,
      relativePath,
      downloadPath,
      sha256: input.sha256,
      length: parseLength(input.length, `${label}.length`)
    }
  })

  const outputs = command.outputManifest.map((output, index) => {
    const label = `outputManifest[${index}]`
    assertExactKeys(output, OUTPUT_KEYS, label)
    const outputId = parseId(output.outputId, `${label}.outputId`)
    const relativePath = parseRelativePath(output.relativePath, `${label}.relativePath`)
    if (identities.has(`output:${outputId}`)) fail('COMMAND_INVALID', `duplicate outputId: ${outputId}`)
    addPath(relativePath)
    identities.add(`output:${outputId}`)
    const uploadPath = expectedOutputPath(taskId, runId, outputId)
    if (output.uploadPath !== uploadPath) {
      fail('ENDPOINT_FORBIDDEN', `${label}.uploadPath must be the exact run-scoped API path`)
    }
    if (typeof output.contentType !== 'string' || !CONTENT_TYPE.test(output.contentType)) {
      fail('COMMAND_INVALID', `${label}.contentType must be a canonical media type without parameters`)
    }
    return {
      outputId,
      relativePath,
      uploadPath,
      contentType: output.contentType,
      maxLength: parseLength(output.maxLength, `${label}.maxLength`)
    }
  })

  return Object.freeze({ taskId, runId, inputs: freezeList(inputs), outputs: freezeList(outputs) })
}

const isLoopback = hostname => {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127)
}

const parseApiOrigin = value => {
  let url
  try { url = new URL(value) } catch { fail('CONFIG_INVALID', 'apiOrigin must be an absolute URL origin') }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || (url.protocol === 'http:' && !isLoopback(url.hostname))) {
    fail('CONFIG_INVALID', 'apiOrigin must be an HTTPS origin, or an explicit loopback HTTP origin')
  }
  return url.origin
}

const endpointUrl = (origin, exactPath) => {
  let url
  try { url = new URL(exactPath, `${origin}/`) } catch { fail('ENDPOINT_FORBIDDEN', 'manifest endpoint is invalid') }
  if (url.origin !== origin || url.pathname !== exactPath || url.search || url.hash || url.username || url.password) {
    fail('ENDPOINT_FORBIDDEN', 'manifest endpoint escaped the configured API origin or exact path')
  }
  return url
}

const assertNoSymlinkComponents = (path, { allowMissing = false } = {}) => {
  const absolute = resolve(path)
  const parts = absolute.split(sep).filter(Boolean)
  let current = sep
  for (const part of parts) {
    current = resolve(current, part)
    if (!existsSync(current)) {
      if (allowMissing) return
      fail('PATH_UNSAFE', `required path does not exist: ${current}`)
    }
    if (lstatSync(current).isSymbolicLink()) fail('PATH_UNSAFE', `symlink path component is forbidden: ${current}`)
  }
}

const fsyncDirectory = directory => {
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const ensureDirectory = path => {
  assertNoSymlinkComponents(path, { allowMissing: true })
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertNoSymlinkComponents(path)
  if (!lstatSync(path).isDirectory()) fail('PATH_UNSAFE', `path is not a directory: ${path}`)
  chmodSync(path, 0o700)
}

const ensureRelativeParent = (runDirectory, relativePath) => {
  let current = runDirectory
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = resolve(current, segment)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PATH_UNSAFE', `unsafe parent directory: ${current}`)
    chmodSync(current, 0o700)
  }
  assertNoSymlinkComponents(current)
}

const assertInside = (parent, candidate) => {
  const child = relative(parent, candidate)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail('PATH_UNSAFE', 'manifest path escaped its private run directory')
  }
}

const commandFingerprint = command => createHash('sha256').update(JSON.stringify(command)).digest('hex')

export const buildOutputCommit = ({ taskId, runId, uploads }) => {
  const outputs = [...uploads].map(upload => ({
    outputId: upload.outputId,
    sha256: upload.sha256,
    length: upload.length
  })).sort((left, right) => left.outputId < right.outputId ? -1 : left.outputId > right.outputId ? 1 : 0)
  const sequence = outputs.map(output => `${output.outputId}\n${output.sha256}\n${output.length}\n`).join('')
  const manifestId = `pwe_m_${createHash('sha256').update(sequence, 'utf8').digest('hex')}`
  return Object.freeze({
    manifestId,
    idempotencyKey: `pwe-commit-${manifestId.slice(6)}`,
    path: expectedCommitPath(taskId, runId, manifestId),
    body: Object.freeze({ outputs: freezeList(outputs) })
  })
}

const validateRuntimeAuth = value => {
  if (typeof value !== 'string' || !value || value.length > AUTH_MAX_LENGTH || /[\r\n\u0000]/.test(value)) {
    fail('AUTH_INVALID', 'runtimeAuthHeader must be a non-empty single HTTP header value')
  }
  return value
}

const writeResponseToFile = async ({ response, descriptor, expectedLength }) => {
  const hash = createHash('sha256')
  let total = 0
  const consume = chunkValue => {
    const chunk = Buffer.from(chunkValue)
    total += chunk.length
    if (total > expectedLength) fail('INPUT_LENGTH_MISMATCH', 'download exceeded its declared length')
    hash.update(chunk)
    writeSync(descriptor, chunk)
  }
  if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) consume(chunk)
  } else if (typeof response?.arrayBuffer === 'function') {
    consume(await response.arrayBuffer())
  } else {
    fail('DOWNLOAD_FAILED', 'input response has no readable body')
  }
  if (total !== expectedLength) fail('INPUT_LENGTH_MISMATCH', 'download length does not match its manifest')
  return { length: total, sha256: hash.digest('hex') }
}

const sameFileIdentity = (left, right) => (
  left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
)

const readBoundedRegularFile = (path, maxLength) => {
  assertNoSymlinkComponents(path)
  const descriptor = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n) fail('OUTPUT_INVALID', 'declared file must be a private regular file')
    if (before.size > BigInt(maxLength)) fail('OUTPUT_TOO_LARGE', 'declared output exceeds maxLength')
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameFileIdentity(before, after) || BigInt(bytes.length) !== after.size) {
      fail('OUTPUT_INVALID', 'declared output changed while it was being collected')
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

const walkRunFiles = (runDirectory, current = runDirectory, found = []) => {
  assertNoSymlinkComponents(current)
  for (const name of readdirSync(current)) {
    const path = resolve(current, name)
    assertInside(runDirectory, path)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail('PATH_UNSAFE', `symlink is forbidden in run directory: ${path}`)
    if (stat.isDirectory()) walkRunFiles(runDirectory, path, found)
    else if (stat.isFile()) found.push(relative(runDirectory, path).split(sep).join('/'))
    else fail('PATH_UNSAFE', `special file is forbidden in run directory: ${path}`)
  }
  return found
}

export class WorkspaceFileBridge {
  #apiOrigin
  #rootDir
  #fetchFn
  #runs = new Map()

  constructor({ apiOrigin, rootDir, fetchFn = globalThis.fetch } = {}) {
    this.#apiOrigin = parseApiOrigin(apiOrigin)
    if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) fail('CONFIG_INVALID', 'rootDir must be an absolute path')
    this.#rootDir = resolve(rootDir)
    ensureDirectory(this.#rootDir)
    this.#fetchFn = fetchFn
  }

  get apiOrigin() { return this.#apiOrigin }
  get rootDir() { return this.#rootDir }

  _runKey(command) { return `${command.taskId}\u0000${command.runId}` }

  _runDirectory(command) {
    const directory = resolve(this.#rootDir, command.taskId, command.runId)
    assertInside(this.#rootDir, directory)
    return directory
  }

  async materializeInputs(rawCommand, { runtimeAuthHeader } = {}) {
    const command = parseWorkspaceFileCommand(rawCommand)
    const auth = validateRuntimeAuth(runtimeAuthHeader)
    if (typeof this.#fetchFn !== 'function') fail('CONFIG_INVALID', 'fetchFn must be a function')
    const key = this._runKey(command)
    if (this.#runs.has(key)) fail('RUN_EXISTS', 'taskId/runId is already bound in this bridge')
    const taskDirectory = resolve(this.#rootDir, command.taskId)
    ensureDirectory(taskDirectory)
    const runDirectory = this._runDirectory(command)
    if (existsSync(runDirectory)) fail('RUN_EXISTS', 'private run directory already exists')
    mkdirSync(runDirectory, { mode: 0o700 })
    assertNoSymlinkComponents(runDirectory)

    try {
      const materialized = []
      for (const input of command.inputs) {
        const endpoint = endpointUrl(this.#apiOrigin, input.downloadPath)
        let response
        try {
          response = await this.#fetchFn(endpoint, {
            method: 'GET',
            redirect: 'error',
            headers: { Authorization: auth, Accept: 'application/octet-stream' }
          })
        } catch {
          fail('DOWNLOAD_FAILED', 'input download failed')
        }
        if (!response || response.status !== 200 || response.redirected === true) {
          fail('DOWNLOAD_FORBIDDEN', 'input endpoint did not return a direct 200 response')
        }
        if (typeof response.url !== 'string' || !response.url) {
          fail('DOWNLOAD_FORBIDDEN', 'input response URL is missing')
        }
        {
          let observed
          try { observed = new URL(response.url) } catch { fail('DOWNLOAD_FORBIDDEN', 'input response URL is invalid') }
          if (observed.origin !== endpoint.origin || observed.pathname !== endpoint.pathname
              || observed.search || observed.hash || observed.username || observed.password) {
            fail('DOWNLOAD_FORBIDDEN', 'input response escaped the configured same-origin exact path')
          }
        }
        const contentLength = response.headers?.get?.('content-length')
        if (contentLength !== null && contentLength !== undefined && contentLength !== '') {
          if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || BigInt(contentLength) !== BigInt(input.length)) {
            fail('INPUT_LENGTH_MISMATCH', 'Content-Length does not match the input manifest')
          }
        }

        const targetPath = resolve(runDirectory, ...input.relativePath.split('/'))
        assertInside(runDirectory, targetPath)
        ensureRelativeParent(runDirectory, input.relativePath)
        if (existsSync(targetPath)) fail('PATH_UNSAFE', 'input target already exists')
        const temporaryPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`)
        const descriptor = openSync(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW, 0o600)
        let downloaded
        try {
          downloaded = await writeResponseToFile({ response, descriptor, expectedLength: input.length })
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        if (downloaded.sha256 !== input.sha256) {
          unlinkSync(temporaryPath)
          fail('INPUT_DIGEST_MISMATCH', 'downloaded input SHA-256 does not match its manifest')
        }
        chmodSync(temporaryPath, 0o400)
        try { linkSync(temporaryPath, targetPath) } catch {
          unlinkSync(temporaryPath)
          fail('PATH_UNSAFE', 'input target could not be created without replacement')
        }
        unlinkSync(temporaryPath)
        fsyncDirectory(dirname(targetPath))
        materialized.push(Object.freeze({
          inputId: input.inputId,
          relativePath: input.relativePath,
          path: targetPath,
          length: downloaded.length,
          sha256: downloaded.sha256
        }))
      }
      const fingerprint = commandFingerprint(command)
      this.#runs.set(key, Object.freeze({ fingerprint, command, runDirectory }))
      return Object.freeze({
        taskId: command.taskId,
        runId: command.runId,
        runDirectory,
        inputs: Object.freeze(materialized)
      })
    } catch (error) {
      try { rmSync(runDirectory, { recursive: true, force: true }) } catch {}
      if (error instanceof WorkspaceFileBridgeError) throw error
      fail('IO_FAILED', 'workspace file materialization failed')
    }
  }

  collectOutputs(rawCommand) {
    const command = parseWorkspaceFileCommand(rawCommand)
    const key = this._runKey(command)
    const binding = this.#runs.get(key)
    if (!binding || binding.fingerprint !== commandFingerprint(command)) {
      fail('RUN_NOT_BOUND', 'taskId/runId manifest is not bound to a materialized private run')
    }
    const runDirectory = binding.runDirectory
    assertNoSymlinkComponents(runDirectory)
    const allowedFiles = new Set([
      ...command.inputs.map(input => input.relativePath),
      ...command.outputs.map(output => output.relativePath)
    ])
    for (const relativePath of walkRunFiles(runDirectory)) {
      if (!allowedFiles.has(relativePath)) fail('OUTPUT_NOT_DECLARED', `undeclared run file is forbidden: ${relativePath}`)
    }

    for (const input of command.inputs) {
      const path = resolve(runDirectory, ...input.relativePath.split('/'))
      const bytes = readBoundedRegularFile(path, input.length)
      if (bytes.length !== input.length || createHash('sha256').update(bytes).digest('hex') !== input.sha256) {
        fail('INPUT_CHANGED', `materialized input changed before output collection: ${input.relativePath}`)
      }
    }

    const uploads = command.outputs.map(output => {
      const path = resolve(runDirectory, ...output.relativePath.split('/'))
      if (!existsSync(path)) fail('OUTPUT_MISSING', `declared output is missing: ${output.relativePath}`)
      assertInside(runDirectory, path)
      const bytes = readBoundedRegularFile(path, output.maxLength)
      const length = bytes.length
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const url = endpointUrl(this.#apiOrigin, output.uploadPath).toString()
      return Object.freeze({
        outputId: output.outputId,
        relativePath: output.relativePath,
        path,
        length,
        sha256,
        request: Object.freeze({
          method: 'POST',
          url,
          redirect: 'error',
          multipart: Object.freeze({
            fields: freezeList([
              { name: 'taskId', value: command.taskId },
              { name: 'runId', value: command.runId },
              { name: 'outputId', value: output.outputId },
              { name: 'sha256', value: sha256 },
              { name: 'length', value: String(length) }
            ]),
            file: Object.freeze({
              fieldName: 'file',
              fileName: basename(output.relativePath),
              contentType: output.contentType,
              path,
              length,
              sha256
            })
          })
        })
      })
    })
    return Object.freeze({
      taskId: command.taskId,
      runId: command.runId,
      runDirectory,
      uploads: Object.freeze(uploads)
    })
  }

  async uploadOutputsAndCommit(rawCommand, { runtimeAuthHeader } = {}) {
    const command = parseWorkspaceFileCommand(rawCommand)
    const auth = validateRuntimeAuth(runtimeAuthHeader)
    if (typeof this.#fetchFn !== 'function') fail('CONFIG_INVALID', 'fetchFn must be a function')
    const collected = this.collectOutputs(rawCommand)
    const responseHasData = async response => {
      if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of response.body) return Buffer.from(chunk).length > 0
        return false
      }
      if (typeof response?.arrayBuffer === 'function') return Buffer.from(await response.arrayBuffer()).length > 0
      return false
    }
    const assertDirectSuccess = (response, endpoint, statuses, code) => {
      if (!response || !statuses.has(response.status) || response.redirected === true) {
        fail(code, 'runtime API did not return an allowed direct success response')
      }
      let observed
      try { observed = new URL(response.url) } catch { fail(code, 'runtime API response URL is invalid') }
      if (observed.origin !== endpoint.origin || observed.pathname !== endpoint.pathname
          || observed.search || observed.hash || observed.username || observed.password) {
        fail(code, 'runtime API response escaped the configured same-origin exact path')
      }
    }

    for (const upload of collected.uploads) {
      const endpoint = new URL(upload.request.url)
      const form = new FormData()
      for (const field of upload.request.multipart.fields) form.append(field.name, field.value)
      const bytes = readBoundedRegularFile(upload.path, upload.length)
      if (bytes.length !== upload.length || createHash('sha256').update(bytes).digest('hex') !== upload.sha256) {
        fail('OUTPUT_CHANGED', 'declared output changed after collection and before upload')
      }
      form.append(
        upload.request.multipart.file.fieldName,
        new Blob([bytes], { type: upload.request.multipart.file.contentType }),
        upload.request.multipart.file.fileName
      )
      let response
      try {
        response = await this.#fetchFn(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: auth,
            'Idempotency-Key': `pwe-output-${command.taskId}-${command.runId}-${upload.outputId}-${upload.sha256.slice(0, 16)}`
          },
          body: form
        })
      } catch {
        fail('UPLOAD_FAILED', 'declared output upload failed')
      }
      assertDirectSuccess(response, endpoint, new Set([200, 201]), 'UPLOAD_FAILED')
    }

    const commit = buildOutputCommit({ taskId: command.taskId, runId: command.runId, uploads: collected.uploads })
    const endpoint = endpointUrl(this.#apiOrigin, commit.path)
    let response
    try {
      response = await this.#fetchFn(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: auth,
          'Idempotency-Key': commit.idempotencyKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(commit.body)
      })
    } catch {
      fail('COMMIT_FAILED', 'output manifest commit failed')
    }
    assertDirectSuccess(response, endpoint, new Set([200]), 'COMMIT_FAILED')
    if (!(await responseHasData(response))) fail('COMMIT_FAILED', 'output manifest commit response has no body data')
    return Object.freeze({
      taskId: command.taskId,
      runId: command.runId,
      manifestId: commit.manifestId,
      outputs: commit.body.outputs
    })
  }

  cleanup(rawCommand) {
    const command = parseWorkspaceFileCommand(rawCommand)
    const key = this._runKey(command)
    const binding = this.#runs.get(key)
    if (!binding || binding.fingerprint !== commandFingerprint(command)) {
      fail('RUN_NOT_BOUND', 'taskId/runId manifest is not bound to a materialized private run')
    }
    try {
      assertNoSymlinkComponents(binding.runDirectory)
      rmSync(binding.runDirectory, { recursive: true, force: false })
      this.#runs.delete(key)
    } catch (error) {
      if (error instanceof WorkspaceFileBridgeError) throw error
      fail('CLEANUP_FAILED', 'private workspace file run cleanup failed')
    }
  }
}
