import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test, { afterEach } from 'node:test'

import {
  WorkspaceFileBridge,
  WorkspaceFileBridgeError,
  buildOutputCommit,
  parseWorkspaceFileCommand
} from '../workspace-file-bridge.mjs'

const temporaryDirectories = []
afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

const temporaryDirectory = () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'codex-ws-agent-file-bridge-'))
  temporaryDirectories.push(directory)
  return directory
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

// A tiny stored ZIP is sufficient for the bridge's OpenXML container boundary checks; it
// deliberately avoids a ZIP library so this security test exercises only Node built-ins.
const storedZip = entryName => {
  const name = Buffer.from(entryName, 'utf8')
  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(name.length, 26)
  name.copy(local, 30)
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(name.length, 28)
  name.copy(central, 46)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, central, eocd])
}

const commandFor = (bytes = Buffer.from('trusted input\n'), overrides = {}) => {
  const taskId = overrides.taskId || 'task-1'
  const runId = overrides.runId || 'run-1'
  return {
    taskId,
    runId,
    inputManifest: overrides.inputManifest || [{
      inputId: 'source',
      relativePath: 'inputs/source.txt',
      downloadPath: `/internal/agent/tasks/${taskId}/runs/${runId}/inputs/source/content`,
      sha256: digest(bytes),
      length: bytes.length
    }],
    outputManifest: overrides.outputManifest || [{
      outputId: 'result',
      relativePath: 'outputs/result.json',
      uploadPath: `/internal/agent/tasks/${taskId}/runs/${runId}/outputs/result/content`,
      contentType: 'application/json',
      maxLength: 4096
    }]
  }
}

const responseFor = (bytes, url = 'https://api.example.test/internal/agent/tasks/task-1/runs/run-1/inputs/source/content', overrides = {}) => ({
  status: overrides.status ?? 200,
  redirected: overrides.redirected ?? false,
  url,
  headers: {
    get: name => name.toLowerCase() === 'content-length'
      ? (overrides.contentLength ?? String(bytes.length))
      : null
  },
  body: Readable.from(overrides.chunks || [bytes])
})

const bridgeFor = (rootDir, fetchFn = async (url) => responseFor(Buffer.from('trusted input\n'), url.toString())) => (
  new WorkspaceFileBridge({ apiOrigin: 'https://api.example.test', rootDir, fetchFn })
)

const assertBridgeCode = (operation, code) => assert.throws(
  operation,
  error => error instanceof WorkspaceFileBridgeError && error.code === code
)

const assertRejectsCode = (operation, code) => assert.rejects(
  operation,
  error => error instanceof WorkspaceFileBridgeError && error.code === code
)

test('command parser freezes a canonical explicit identity and rejects ambiguous manifests', async t => {
  const bytes = Buffer.from('trusted input\n')
  const parsed = parseWorkspaceFileCommand(commandFor(bytes))
  assert.equal(parsed.taskId, 'task-1')
  assert.equal(parsed.runId, 'run-1')
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.inputs[0]), true)

  const cases = [
    ['unknown command field', { ...commandFor(bytes), commandId: 'command-1' }, 'COMMAND_INVALID'],
    ['missing run identity', { ...commandFor(bytes), runId: undefined }, 'COMMAND_INVALID'],
    ['noncanonical task identity', commandFor(bytes, { taskId: '../task' }), 'COMMAND_INVALID'],
    ['absolute input path', commandFor(bytes, { inputManifest: [{ ...commandFor(bytes).inputManifest[0], relativePath: '/tmp/source' }] }), 'PATH_UNSAFE'],
    ['backslash path', commandFor(bytes, { inputManifest: [{ ...commandFor(bytes).inputManifest[0], relativePath: 'inputs\\source' }] }), 'PATH_UNSAFE'],
    ['encoded endpoint traversal', commandFor(bytes, { inputManifest: [{ ...commandFor(bytes).inputManifest[0], downloadPath: '/internal/agent/tasks/task-1/runs/run-1/inputs/%2e%2e/content' }] }), 'ENDPOINT_FORBIDDEN'],
    ['query-bearing endpoint', commandFor(bytes, { inputManifest: [{ ...commandFor(bytes).inputManifest[0], downloadPath: '/internal/agent/tasks/task-1/runs/run-1/inputs/source/content?x=1' }] }), 'ENDPOINT_FORBIDDEN'],
    ['duplicate input identity', commandFor(bytes, { inputManifest: [commandFor(bytes).inputManifest[0], { ...commandFor(bytes).inputManifest[0], relativePath: 'inputs/other.txt' }] }), 'COMMAND_INVALID'],
    ['input-output path collision', commandFor(bytes, { outputManifest: [{ ...commandFor(bytes).outputManifest[0], relativePath: 'inputs/source.txt' }] }), 'COMMAND_INVALID'],
    ['uppercase digest', commandFor(bytes, { inputManifest: [{ ...commandFor(bytes).inputManifest[0], sha256: digest(bytes).toUpperCase() }] }), 'COMMAND_INVALID'],
    ['unbounded output', commandFor(bytes, { outputManifest: [{ ...commandFor(bytes).outputManifest[0], maxLength: -1 }] }), 'COMMAND_INVALID'],
    ['content type parameters', commandFor(bytes, { outputManifest: [{ ...commandFor(bytes).outputManifest[0], contentType: 'application/json; charset=utf-8' }] }), 'COMMAND_INVALID']
  ]
  for (const [name, command, code] of cases) {
    await t.test(name, () => assertBridgeCode(() => parseWorkspaceFileCommand(command), code))
  }
})

test('configured origin is HTTPS or explicit loopback and cannot carry path or credentials', async t => {
  const root = temporaryDirectory()
  for (const origin of [
    'http://api.example.test',
    'https://user:secret@api.example.test',
    'https://api.example.test/base',
    'https://api.example.test/?query=1'
  ]) {
    await t.test(origin, () => assertBridgeCode(
      () => new WorkspaceFileBridge({ apiOrigin: origin, rootDir: resolve(root, digest(origin)), fetchFn: async () => {} }),
      'CONFIG_INVALID'
    ))
  }
  const loopback = new WorkspaceFileBridge({
    apiOrigin: 'http://127.0.0.1:8080',
    rootDir: resolve(root, 'loopback'),
    fetchFn: async () => {}
  })
  assert.equal(loopback.apiOrigin, 'http://127.0.0.1:8080')
})

test('input materialization uses caller runtime auth transiently and verifies bytes before private publication', async () => {
  const bytes = Buffer.from('trusted input\n')
  const root = temporaryDirectory()
  const observed = []
  const bridge = bridgeFor(root, async (url, options) => {
    observed.push({ url: url.toString(), options })
    return responseFor(bytes, url.toString(), { chunks: [bytes.subarray(0, 3), bytes.subarray(3)] })
  })
  const result = await bridge.materializeInputs(commandFor(bytes), { runtimeAuthHeader: 'Bearer runtime-secret' })

  assert.equal(observed.length, 1)
  assert.equal(observed[0].url, 'https://api.example.test/internal/agent/tasks/task-1/runs/run-1/inputs/source/content')
  assert.deepEqual(observed[0].options, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: 'Bearer runtime-secret', Accept: 'application/octet-stream' }
  })
  assert.equal(readFileSync(result.inputs[0].path, 'utf8'), bytes.toString())
  assert.equal(statSync(result.runDirectory).mode & 0o777, 0o700)
  assert.equal(statSync(result.inputs[0].path).mode & 0o777, 0o400)
  assert.equal(JSON.stringify(result).includes('runtime-secret'), false)
  assert.equal(JSON.stringify(bridge).includes('runtime-secret'), false)
})

test('download boundary rejects redirects, response URL escape, length mismatch, digest mismatch, and secret-bearing errors', async t => {
  const bytes = Buffer.from('trusted input\n')
  const cases = [
    ['redirect', async (url) => responseFor(bytes, url.toString(), { redirected: true }), 'DOWNLOAD_FORBIDDEN'],
    ['wrong response origin', async () => responseFor(bytes, 'https://evil.example/internal/agent/tasks/task-1/runs/run-1/inputs/source/content'), 'DOWNLOAD_FORBIDDEN'],
    ['wrong response path', async () => responseFor(bytes, 'https://api.example.test/internal/agent/tasks/task-1/runs/run-1/inputs/other/content'), 'DOWNLOAD_FORBIDDEN'],
    ['header length mismatch', async (url) => responseFor(bytes, url.toString(), { contentLength: String(bytes.length + 1) }), 'INPUT_LENGTH_MISMATCH'],
    ['stream length mismatch', async (url) => responseFor(Buffer.concat([bytes, Buffer.from('x')]), url.toString(), { contentLength: '', chunks: [bytes, Buffer.from('x')] }), 'INPUT_LENGTH_MISMATCH'],
    ['digest mismatch', async (url) => responseFor(Buffer.from('untrusted bytes'), url.toString(), { contentLength: String(Buffer.byteLength('untrusted bytes')) }), 'INPUT_DIGEST_MISMATCH'],
    ['transport error', async () => { throw new Error('Bearer runtime-secret') }, 'DOWNLOAD_FAILED']
  ]
  for (const [name, fetchFn, code] of cases) {
    await t.test(name, async () => {
      const root = temporaryDirectory()
      const command = name === 'digest mismatch'
        ? commandFor(Buffer.from('xxxxxxxxxxxxxxx'))
        : commandFor(bytes)
      let error
      try {
        await bridgeFor(root, fetchFn).materializeInputs(command, { runtimeAuthHeader: 'Bearer runtime-secret' })
      } catch (caught) { error = caught }
      assert.equal(error?.code, code)
      assert.equal(String(error?.message).includes('runtime-secret'), false)
      assert.equal(existsSync(resolve(root, 'task-1', 'run-1')), false)
    })
  }
})

test('existing or symlinked run storage fails closed before any download', async t => {
  const bytes = Buffer.from('trusted input\n')
  await t.test('existing run directory', async () => {
    const root = temporaryDirectory()
    mkdirSync(resolve(root, 'task-1', 'run-1'), { recursive: true })
    let downloads = 0
    const bridge = bridgeFor(root, async () => { downloads += 1; return responseFor(bytes) })
    await assertRejectsCode(
      () => bridge.materializeInputs(commandFor(bytes), { runtimeAuthHeader: 'Bearer token' }),
      'RUN_EXISTS'
    )
    assert.equal(downloads, 0)
  })

  await t.test('symlinked task directory', async () => {
    const root = temporaryDirectory()
    const outside = temporaryDirectory()
    symlinkSync(outside, resolve(root, 'task-1'))
    let downloads = 0
    const bridge = bridgeFor(root, async () => { downloads += 1; return responseFor(bytes) })
    await assertRejectsCode(
      () => bridge.materializeInputs(commandFor(bytes), { runtimeAuthHeader: 'Bearer token' }),
      'PATH_UNSAFE'
    )
    assert.equal(downloads, 0)
    assert.deepEqual(readdirSync(outside), [])
  })
})

test('output collection is bound to the original manifest and emits upload multipart metadata only', async () => {
  const bytes = Buffer.from('trusted input\n')
  const output = Buffer.from('{"ok":true}\n')
  const root = temporaryDirectory()
  const command = commandFor(bytes)
  const bridge = bridgeFor(root, async url => responseFor(bytes, url.toString()))
  const materialized = await bridge.materializeInputs(command, { runtimeAuthHeader: 'Bearer runtime-secret' })
  mkdirSync(resolve(materialized.runDirectory, 'outputs'), { recursive: true })
  writeFileSync(resolve(materialized.runDirectory, 'outputs/result.json'), output, { mode: 0o600 })

  const result = bridge.collectOutputs(command)
  assert.equal(result.uploads.length, 1)
  assert.deepEqual(result.uploads[0].request, {
    method: 'POST',
    url: 'https://api.example.test/internal/agent/tasks/task-1/runs/run-1/outputs/result/content',
    redirect: 'error',
    multipart: {
      fields: [
        { name: 'taskId', value: 'task-1' },
        { name: 'runId', value: 'run-1' },
        { name: 'outputId', value: 'result' },
        { name: 'sha256', value: digest(output) },
        { name: 'length', value: String(output.length) }
      ],
      file: {
        fieldName: 'file',
        fileName: 'result.json',
        contentType: 'application/json',
        path: resolve(materialized.runDirectory, 'outputs/result.json'),
        length: output.length,
        sha256: digest(output)
      }
    }
  })
  assert.equal(JSON.stringify(result).includes('runtime-secret'), false)

  const widened = commandFor(bytes, {
    outputManifest: [{
      outputId: 'stolen',
      relativePath: 'outputs/stolen.txt',
      uploadPath: '/internal/agent/tasks/task-1/runs/run-1/outputs/stolen/content',
      contentType: 'text/plain',
      maxLength: 4096
    }]
  })
  assertBridgeCode(() => bridge.collectOutputs(widened), 'RUN_NOT_BOUND')
})

test('output collection rejects undeclared files, symlinks, oversized output, and changed input', async t => {
  const bytes = Buffer.from('trusted input\n')
  const setup = async (suffix = '', commandOverrides = {}) => {
    const root = temporaryDirectory()
    const runId = `run-${suffix || 'case'}`
    const command = commandFor(bytes, { runId, ...commandOverrides })
    const bridge = bridgeFor(root, async url => responseFor(bytes, url.toString()))
    const materialized = await bridge.materializeInputs(command, { runtimeAuthHeader: 'Bearer token' })
    mkdirSync(resolve(materialized.runDirectory, 'outputs'), { recursive: true })
    return { bridge, command, materialized }
  }

  await t.test('undeclared file', async () => {
    const { bridge, command, materialized } = await setup('undeclared')
    writeFileSync(resolve(materialized.runDirectory, 'outputs/result.json'), '{}')
    writeFileSync(resolve(materialized.runDirectory, 'secret.txt'), 'secret')
    assertBridgeCode(() => bridge.collectOutputs(command), 'OUTPUT_NOT_DECLARED')
  })

  await t.test('private scratch is allowed but never declared as an upload', async () => {
    const { bridge, command, materialized } = await setup('scratch')
    writeFileSync(resolve(materialized.runDirectory, 'outputs/result.json'), '{}')
    writeFileSync(resolve(materialized.runDirectory, 'scratch', 'temporary.txt'), 'private work')
    const collected = bridge.collectOutputs(command)
    assert.equal(collected.uploads.length, 1)
    assert.equal(collected.uploads[0].relativePath, 'outputs/result.json')
  })

  await t.test('symlinked output', async () => {
    const { bridge, command, materialized } = await setup('symlink')
    const outside = resolve(temporaryDirectory(), 'outside.json')
    writeFileSync(outside, '{}')
    symlinkSync(outside, resolve(materialized.runDirectory, 'outputs/result.json'))
    assertBridgeCode(() => bridge.collectOutputs(command), 'PATH_UNSAFE')
  })

  await t.test('oversized output', async () => {
    const runId = 'run-large'
    const outputManifest = [{
      ...commandFor(bytes).outputManifest[0],
      uploadPath: `/internal/agent/tasks/task-1/runs/${runId}/outputs/result/content`,
      maxLength: 2
    }]
    const { bridge, command, materialized } = await setup('large', { outputManifest })
    writeFileSync(resolve(materialized.runDirectory, 'outputs/result.json'), '123')
    assertBridgeCode(() => bridge.collectOutputs(command), 'OUTPUT_TOO_LARGE')
  })

  await t.test('changed input', async () => {
    const { bridge, command, materialized } = await setup('changed')
    writeFileSync(resolve(materialized.runDirectory, 'outputs/result.json'), '{}')
    chmodSync(materialized.inputs[0].path, 0o600)
    writeFileSync(materialized.inputs[0].path, Buffer.alloc(bytes.length, 0x78))
    assertBridgeCode(() => bridge.collectOutputs(command), 'INPUT_CHANGED')
  })
})


test('output collection verifies declared delivery bytes before any upload', async t => {
  const bytes = Buffer.from('trusted input\n')
  const cases = [
    ['fake PDF', 'application/pdf', 'outputs/result.pdf', Buffer.from('not a pdf'), 'OUTPUT_FORMAT_INVALID'],
    ['fake PNG', 'image/png', 'outputs/result.png', Buffer.from('not a png'), 'OUTPUT_FORMAT_INVALID'],
    ['fake DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'outputs/result.docx', Buffer.from('not a zip'), 'OUTPUT_FORMAT_INVALID'],
    ['wrong OpenXML part', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'outputs/result.docx', storedZip('xl/workbook.xml'), 'OUTPUT_FORMAT_INVALID']
  ]
  for (const [name, contentType, relativePath, output, code] of cases) {
    await t.test(name, async () => {
      const root = temporaryDirectory()
      const command = commandFor(bytes, { outputManifest: [{
        outputId: 'result', relativePath,
        uploadPath: '/internal/agent/tasks/task-1/runs/run-1/outputs/result/content',
        contentType, maxLength: 4096
      }] })
      const bridge = bridgeFor(root, async url => responseFor(bytes, url.toString()))
      const materialized = await bridge.materializeInputs(command, { runtimeAuthHeader: 'Bearer runtime-secret' })
      mkdirSync(resolve(materialized.runDirectory, 'outputs'), { recursive: true })
      writeFileSync(resolve(materialized.runDirectory, relativePath), output)
      assertBridgeCode(() => bridge.collectOutputs(command), code)
    })
  }

  const root = temporaryDirectory()
  const command = commandFor(bytes, { outputManifest: [{
    outputId: 'result', relativePath: 'outputs/result.docx',
    uploadPath: '/internal/agent/tasks/task-1/runs/run-1/outputs/result/content',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', maxLength: 4096
  }] })
  const bridge = bridgeFor(root, async url => responseFor(bytes, url.toString()))
  const materialized = await bridge.materializeInputs(command, { runtimeAuthHeader: 'Bearer runtime-secret' })
  mkdirSync(resolve(materialized.runDirectory, 'outputs'), { recursive: true })
  writeFileSync(resolve(materialized.runDirectory, 'outputs/result.docx'), storedZip('word/document.xml'))
  assert.equal(bridge.collectOutputs(command).uploads.length, 1)
})

test('output commit manifest binds its exact task and run namespace', () => {
  const uploads = [{ outputId: 'result', sha256: 'a'.repeat(64), length: 7 }]
  const first = buildOutputCommit({ taskId: 'task-a', runId: 'run-a', uploads })
  const same = buildOutputCommit({ taskId: 'task-a', runId: 'run-a', uploads })
  const otherTask = buildOutputCommit({ taskId: 'task-b', runId: 'run-a', uploads })
  const otherRun = buildOutputCommit({ taskId: 'task-a', runId: 'run-b', uploads })
  assert.equal(first.manifestId, same.manifestId)
  assert.notEqual(first.manifestId, otherTask.manifestId)
  assert.notEqual(first.manifestId, otherRun.manifestId)
})

test('uploads each declared output then commits its canonical output manifest with transient runtime auth', async () => {
  const bytes = Buffer.from('trusted input\n')
  const alpha = Buffer.from('alpha\n')
  const result = Buffer.from('{"ok":true}\n')
  const root = temporaryDirectory()
  const command = commandFor(bytes, {
    outputManifest: [
      {
        outputId: 'result', relativePath: 'outputs/result.json',
        uploadPath: '/internal/agent/tasks/task-1/runs/run-1/outputs/result/content',
        contentType: 'application/json', maxLength: 4096
      },
      {
        outputId: 'alpha', relativePath: 'outputs/alpha.txt',
        uploadPath: '/internal/agent/tasks/task-1/runs/run-1/outputs/alpha/content',
        contentType: 'text/plain', maxLength: 4096
      }
    ]
  })
  const requests = []
  const bridge = bridgeFor(root, async (url, options = {}) => {
    requests.push({ url: url.toString(), options })
    if (options.method === 'GET') return responseFor(bytes, url.toString())
    return responseFor(Buffer.from('{"data":{}}'), url.toString())
  })
  const materialized = await bridge.materializeInputs(command, { runtimeAuthHeader: 'Bearer runtime-secret' })
  mkdirSync(resolve(materialized.runDirectory, 'outputs'), { recursive: true })
  writeFileSync(resolve(materialized.runDirectory, 'outputs/result.json'), result)
  writeFileSync(resolve(materialized.runDirectory, 'outputs/alpha.txt'), alpha)

  const expected = buildOutputCommit({
    taskId: 'task-1', runId: 'run-1', uploads: [
      { outputId: 'result', sha256: digest(result), length: result.length },
      { outputId: 'alpha', sha256: digest(alpha), length: alpha.length }
    ]
  })
  const committed = await bridge.uploadOutputsAndCommit(command, { runtimeAuthHeader: 'Bearer runtime-secret' })
  assert.equal(committed.manifestId, expected.manifestId)
  assert.equal(requests.length, 4)
  const uploads = requests.slice(1, 3)
  assert.deepEqual(uploads.map(request => request.options.headers.Authorization), ['Bearer runtime-secret', 'Bearer runtime-secret'])
  assert.deepEqual(uploads.map(request => request.options.headers['Idempotency-Key']), [
    `pwe-output-task-1-run-1-result-${digest(result).slice(0, 16)}`,
    `pwe-output-task-1-run-1-alpha-${digest(alpha).slice(0, 16)}`
  ])
  assert.ok(uploads.every(request => request.options.body instanceof FormData))
  assert.equal(uploads[0].options.body.get('outputId'), 'result')
  assert.equal(uploads[1].options.body.get('outputId'), 'alpha')
  const commit = requests[3]
  assert.equal(commit.url, `https://api.example.test${expected.path}`)
  assert.deepEqual(commit.options.headers, {
    Authorization: 'Bearer runtime-secret',
    'Idempotency-Key': expected.idempotencyKey,
    'Content-Type': 'application/json'
  })
  assert.equal(commit.options.body, JSON.stringify(expected.body))
  bridge.cleanup(command)
  assert.equal(existsSync(materialized.runDirectory), false)
})

test('upload or commit failures fail closed without treating the manifest as committed', async t => {
  const bytes = Buffer.from('trusted input\n')
  for (const [name, failedStatus, expectedCode, expectedPostCount] of [
    ['upload', 500, 'UPLOAD_FAILED', 1],
    ['commit', 500, 'COMMIT_FAILED', 2]
  ]) {
    await t.test(name, async () => {
      const root = temporaryDirectory()
      let postCount = 0
      const bridge = bridgeFor(root, async (url, options = {}) => {
        if (options.method === 'GET') return responseFor(bytes, url.toString())
        postCount += 1
        const status = postCount === expectedPostCount ? failedStatus : 200
        return responseFor(Buffer.from('{"data":{}}'), url.toString(), { status })
      })
      const command = commandFor(bytes)
      const materialized = await bridge.materializeInputs(command, { runtimeAuthHeader: 'Bearer runtime-secret' })
      mkdirSync(resolve(materialized.runDirectory, 'outputs'), { recursive: true })
      writeFileSync(resolve(materialized.runDirectory, 'outputs/result.json'), '{}')
      await assertRejectsCode(() => bridge.uploadOutputsAndCommit(command, { runtimeAuthHeader: 'Bearer runtime-secret' }), expectedCode)
      assert.equal(postCount, expectedPostCount)
      bridge.cleanup(command)
      assert.equal(existsSync(materialized.runDirectory), false)
    })
  }
})
