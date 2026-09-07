import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import test, { afterEach } from 'node:test'

import {
  ACK_STATUS,
  AckOutbox,
  AgentMessageProcessor,
  DurableDedupeLedger,
  CommandFingerprint,
  MESSAGE_TYPES,
  PersistentCommandInbox,
  ensureProfiles,
  runManagedCommand,
  startBoundedSkillResultReplay
} from '../agent-client.mjs'
import {
  LINUX_ATOMIC_FS,
  SKILL_INSTALL_FAILURE,
  WORK_RESULT_RECEIPT_TYPE,
  SkillInstallError,
  SkillInstallManager,
  buildSkillDownloadUrl,
  defaultSkillInstallStateRoot
} from '../skill-install-manager.mjs'


const temporaryDirectories = []
afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

const temporaryDirectory = () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'codex-ws-agent-skill-'))
  temporaryDirectories.push(directory)
  return directory
}

const profile = codexHome => ({
  profileId: 'profile-a',
  agentId: 'agent-a',
  agentName: 'Agent A',
  personaName: 'Agent A',
  apiKey: '',
  codexHome,
  codexWorkdir: codexHome,
  codexBin: '/bin/true',
  codexSandbox: 'workspace-write',
  codexApproval: 'never',
  codexSessionMode: 'new',
  codexTimeoutMs: 1000
})

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const zip = entries => {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8')
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data || '', 'utf8')
    const crc = crc32(data)
    const flags = 0x0800
    const mode = item.mode ?? (item.name.endsWith('/') ? 0o040755 : 0o100644)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

const skillDocument = (skillKey = 'repo-test', version = '1.0.0') => (
  `---\nname: ${skillKey}\ndescription: Run focused authorized repository tests.\nmetadata:\n  version: "${version}"\n---\n\n# ${skillKey}\n`
)

const validPackage = (skillKey = 'repo-test', version = '1.0.0') => zip([
  { name: 'SKILL.md', data: skillDocument(skillKey, version) },
  { name: 'scripts/run.sh', data: '#!/bin/sh\necho safe\n', mode: 0o100755 }
])

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const dispatch = (packageBytes, overrides = {}) => ({
  schemaVersion: 1,
  messageType: MESSAGE_TYPES.COMMAND_DISPATCH,
  messageId: 'msg-install-1',
  requestId: 'msg-install-1',
  commandType: 'SKILL_INSTALL',
  commandId: 'cmd-install-1',
  attempt: 1,
  fencingToken: '1',
  deliveryEpoch: '1',
  targetAgentId: 'agent-a',
  orderId: 'so_1',
  installationId: 'si_1',
  productVersionId: 'spv_1',
  skillKey: 'repo-test',
  skillVersion: '1.0.0',
  packageSize: String(packageBytes.length),
  packageDigest: digest(packageBytes),
  downloadPath: '/internal/agent/skill-installations/si_1/package',
  ...overrides
})

const responseFor = (bytes, url = 'https://api.example.test/internal/agent/skill-installations/si_1/package') => ({
  status: 200,
  redirected: false,
  url,
  headers: { get: name => name.toLowerCase() === 'content-length' ? String(bytes.length) : null },
  body: Readable.from([bytes])
})

const receiptFor = (envelope, overrides = {}) => ({
  schemaVersion: 1,
  messageType: WORK_RESULT_RECEIPT_TYPE,
  messageId: `receipt-${envelope.messageId}`,
  correlationId: envelope.messageId,
  resultType: envelope.resultType,
  receiptStatus: 'ACCEPTED',
  commandId: envelope.commandId,
  attempt: envelope.attempt,
  fencingToken: envelope.fencingToken,
  deliveryEpoch: envelope.deliveryEpoch,
  installationId: envelope.installationId,
  targetAgentId: envelope.targetAgentId,
  ...overrides
})

const identity = path => {
  const status = lstatSync(path, { bigint: true })
  return {
    path: resolve(path),
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    kind: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : status.isSymbolicLink() ? 'symlink' : 'other'
  }
}

const identityMatches = (left, right) => left && right
  && left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.kind === right.kind

const ownerEvidenceDigest = directory => {
  let bytes
  try { bytes = readFileSync(resolve(directory, 'owner.json')) } catch (error) {
    if (error?.code === 'ENOENT') bytes = Buffer.alloc(0)
    else throw error
  }
  return createHash('sha256').update(bytes).digest('hex')
}

const testAtomicFs = {
  renameNoReplace(sourcePath, targetPath, expected = {}) {
    try {
      if (expected.sourceParent && !identityMatches(identity(resolve(sourcePath, '..')), expected.sourceParent)) {
        return { ok: false, code: 'PARENT_CHANGED_ROLLED_BACK', message: 'source parent changed' }
      }
      if (expected.targetParent && !identityMatches(identity(resolve(targetPath, '..')), expected.targetParent)) {
        return { ok: false, code: 'PARENT_CHANGED_ROLLED_BACK', message: 'target parent changed' }
      }
      if (expected.sourceIdentity && !identityMatches(identity(sourcePath), expected.sourceIdentity)) {
        return { ok: false, code: 'SOURCE_CHANGED', message: 'source changed' }
      }
      if (expected.sourceOwnerSha256 && ownerEvidenceDigest(sourcePath) !== expected.sourceOwnerSha256) {
        return { ok: false, code: 'SOURCE_CHANGED', message: 'source owner generation changed' }
      }
      if (existsSync(targetPath)) return { ok: false, code: 'TARGET_EXISTS', message: 'target exists' }
      renameSync(sourcePath, targetPath)
      if (expected.sourceOwnerSha256 && ownerEvidenceDigest(targetPath) !== expected.sourceOwnerSha256) {
        return { ok: false, code: 'POSTCONDITION_FAILED', message: 'target owner generation changed' }
      }
      return { ok: true, code: 'OK', message: '' }
    } catch (error) {
      return { ok: false, code: 'IO_ERROR', message: error.message }
    }
  },
  exchangeIfMatch() {
    return { ok: false, code: 'UNSUPPORTED', message: 'test helper does not emulate exchange' }
  }
}

const managerForExistingState = ({ profile: selectedProfile, stateRoot, sendResultFn = () => false, atomicFs = testAtomicFs, ...options }) => new SkillInstallManager({
  profile: selectedProfile,
  stateRoot,
  wsUrl: 'wss://api.example.test/ws/agent/channel',
  apiKey: 'existing-secret',
  enabled: true,
  fetchFn: async () => { throw new Error('network must not be used during recovery') },
  sendResultFn,
  runtimeInstanceId: 'runtime-restart',
  atomicFs,
  ...options
})

const managerRuntime = ({ enabled = true, packageBytes = validPackage(), sendResultFn = () => false, fetchFn, root = temporaryDirectory(), atomicFs = testAtomicFs } = {}) => {
  const codexHome = resolve(root, 'codex-home')
  mkdirSync(codexHome, { recursive: true })
  const selectedProfile = profile(codexHome)
  const stateRoot = resolve(root, 'state')
  const manager = new SkillInstallManager({
    profile: selectedProfile,
    stateRoot,
    wsUrl: 'wss://api.example.test/ws/agent/channel?keep=1',
    apiKey: 'existing-secret',
    enabled,
    fetchFn: fetchFn || (async () => responseFor(packageBytes)),
    sendResultFn,
    runtimeInstanceId: 'runtime-test',
    atomicFs,
    now: (() => { let value = 1788320000000; return () => value++ })()
  })
  manager.initialize()
  return { root, codexHome, stateRoot, profile: selectedProfile, manager, packageBytes }
}

test('SKILL_INSTALL is default-off and performs no download or activation', async () => {
  const bytes = validPackage()
  let downloads = 0
  const runtime = managerRuntime({
    enabled: false,
    packageBytes: bytes,
    fetchFn: async () => { downloads += 1; return responseFor(bytes) }
  })
  const persistFailure = runtime.manager._persistFailureResult.bind(runtime.manager)
  let persistedUnderMutex = false
  runtime.manager._persistFailureResult = (...args) => {
    assert.ok(runtime.manager.lockOwner)
    persistedUnderMutex = true
    return persistFailure(...args)
  }
  const result = await runtime.manager.execute(dispatch(bytes))

  assert.equal(result.status, 'failed')
  assert.equal(result.failureCode, SKILL_INSTALL_FAILURE.DISABLED)
  assert.equal(result.resultEnvelope.failureCode, 'SKILL_INSTALL_DISABLED')
  assert.equal(downloads, 0)
  assert.equal(persistedUnderMutex, true)
  assert.equal(runtime.manager.pendingResults().length, 1)
})

test('failure-result persistence loss stays non-terminal for startup reconciliation', async () => {
  const bytes = validPackage()
  const runtime = managerRuntime({ enabled: false, packageBytes: bytes })
  runtime.manager._persistFailureResult = () => {
    assert.ok(runtime.manager.lockOwner)
    throw new Error('injected failure-result persistence loss')
  }
  const result = await runtime.manager.execute(dispatch(bytes))
  assert.equal(result.status, 'recovery_required')
  assert.equal(result.activationCommitted, false)
  assert.equal(runtime.manager.pendingResults().length, 0)
})

test('strict command, target, path, and declared-size validation perform no download', async t => {
  const bytes = validPackage()
  const cases = [
    ['command type', { commandType: 'skill_install' }, SKILL_INSTALL_FAILURE.COMMAND_INVALID],
    ['target Agent', { targetAgentId: 'agent-b' }, SKILL_INSTALL_FAILURE.COMMAND_INVALID],
    ['download path', { downloadPath: 'https://evil.example/package' }, SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN],
    ['declared size', { packageSize: String(16 * 1024 * 1024 + 1) }, SKILL_INSTALL_FAILURE.PACKAGE_TOO_LARGE]
  ]
  for (const [name, overrides, expectedCode] of cases) {
    await t.test(name, async () => {
      let downloads = 0
      const runtime = managerRuntime({
        packageBytes: bytes,
        fetchFn: async () => { downloads += 1; return responseFor(bytes) }
      })
      const result = await runtime.manager.execute(dispatch(bytes, overrides))
      assert.equal(result.failureCode, expectedCode)
      assert.equal(downloads, 0)
      assert.equal(runtime.manager.getInstallation('si_1'), null)
    })
  }
})

test('same-origin download uses only X-API-Key and digest mismatch fails before extraction', async () => {
  const bytes = validPackage()
  const observed = []
  const runtime = managerRuntime({
    packageBytes: bytes,
    fetchFn: async (url, options) => {
      observed.push({ url: url.toString(), options })
      return responseFor(bytes)
    }
  })
  const result = await runtime.manager.execute(dispatch(bytes, { packageDigest: `sha256:${'0'.repeat(64)}` }))

  assert.equal(result.failureCode, SKILL_INSTALL_FAILURE.PACKAGE_DIGEST_MISMATCH)
  assert.equal(observed.length, 1)
  const endpoint = new URL(observed[0].url)
  assert.equal(endpoint.origin, 'https://api.example.test')
  assert.equal(endpoint.pathname, '/internal/agent/skill-installations/si_1/package')
  assert.equal(endpoint.search, '')
  assert.deepEqual(observed[0].options.headers, { 'X-API-Key': 'existing-secret', Accept: 'application/zip' })
  assert.equal(JSON.stringify(runtime.manager.pendingResults()).includes('existing-secret'), false)
})

test('malicious ZIP entries and skill identity mismatches fail closed', async t => {
  const cases = [
    ['traversal', zip([{ name: '../SKILL.md', data: 'bad' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['absolute', zip([{ name: '/SKILL.md', data: 'bad' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['backslash', zip([{ name: 'dir\\SKILL.md', data: 'bad' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['control character', zip([{ name: 'docs/control\u0001.txt', data: 'bad' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['trailing dot alias', zip([{ name: 'docs./file.txt', data: 'bad' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['trailing space alias', zip([{ name: 'docs /file.txt', data: 'bad' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['reserved marker', zip([{ name: '.cyf-installation.json', data: '{}' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['duplicate', zip([
      { name: 'SKILL.md', data: skillDocument() },
      { name: 'SKILL.md', data: 'duplicate' }
    ]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['symlink', zip([
      { name: 'SKILL.md', data: skillDocument() },
      { name: 'escape', data: '../outside', mode: 0o120777 }
    ]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['missing manifest', zip([{ name: 'README.md', data: 'missing skill identity' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['identity mismatch', validPackage('different-skill', '2.0.0'), SKILL_INSTALL_FAILURE.IDENTITY_MISMATCH]
  ]
  for (const [name, bytes, expectedCode] of cases) {
    await t.test(name, async () => {
      const runtime = managerRuntime({ packageBytes: bytes })
      const result = await runtime.manager.execute(dispatch(bytes))
      assert.equal(result.failureCode, expectedCode)
      assert.equal(runtime.manager.getInstallation('si_1'), null)
    })
  }
})

test('metadata.version frontmatter accepts the bounded string mapping format', async t => {
  const cases = [
    ['plain version', 'name: repo-test\ndescription: Run authorized tests.\nmetadata:\n  version: 1.0.0'],
    ['quoted strings and comments', "name: 'repo-test' # exact key\ndescription: \"Run: authorized tests.\"\nmetadata: # string metadata\n  version: '1.0.0' # exact version"],
    ['additional supported fields', "name: repo-test\ndescription: 'Run buyer''s authorized tests.'\nlicense: MIT\nallowed-tools: Bash\nmetadata:\n  short-description: Run focused tests.\n  version: \"1.0.0\""],
    ['metadata first with CRLF', 'metadata:\r\n  version: "1.0.0"\r\nname: repo-test\r\ndescription: Run authorized tests.']
  ]
  for (const [name, header] of cases) {
    await t.test(name, async () => {
      const bytes = zip([{ name: 'SKILL.md', data: `---\n${header}\n---\n# Fixture\n` }])
      const runtime = managerRuntime({ packageBytes: bytes })
      const result = await runtime.manager.execute(dispatch(bytes))
      assert.equal(result.status, 'completed', result.errorMessage)
      assert.equal(runtime.manager.getInstallation('si_1').state, 'ACTIVE')
      assert.equal(result.resultEnvelope.skillVersion, '1.0.0')
    })
  }
})

test('metadata.version frontmatter rejects missing, duplicate, conflicting, or unsupported identities', async t => {
  const header = 'name: repo-test\ndescription: Run authorized tests.\nmetadata:\n  version: "1.0.0"'
  const cases = [
    ['missing description', header.replace('description: Run authorized tests.\n', '')],
    ['empty description', header.replace('Run authorized tests.', '""')],
    ['whitespace description', header.replace('Run authorized tests.', "'   '")],
    ['non-string description', header.replace('Run authorized tests.', 'true')],
    ['missing name', header.replace('name: repo-test\n', '')],
    ['missing metadata version', 'name: repo-test\ndescription: Run tests.\nmetadata:\n  label: fixture'],
    ['legacy top-level version', 'name: repo-test\ndescription: Run tests.\nversion: "1.0.0"'],
    ['top-level version even when matching', `${header}\nversion: "1.0.0"`],
    ['conflicting top-level version', `${header}\nversion: "2.0.0"`],
    ['same duplicate name', `name: repo-test\n${header}`],
    ['conflicting duplicate name', `name: other-skill\n${header}`],
    ['duplicate description', `description: Different description.\n${header}`],
    ['same duplicate metadata version', `${header}\n  version: "1.0.0"`],
    ['conflicting duplicate metadata version', `${header}\n  version: "2.0.0"`],
    ['duplicate metadata mapping', `${header}\nmetadata:\n  version: "1.0.0"`],
    ['version identity mismatch', header.replace('1.0.0', '2.0.0')],
    ['name identity mismatch', header.replace('repo-test', 'other-skill')],
    ['numeric metadata version', header.replace('"1.0.0"', '1')],
    ['nested version is not metadata.version', header.replace('  version:', '  nested:\n    version:')],
    ['wrong version indentation', header.replace('  version:', ' version:')],
    ['version after unrelated top-level field', header.replace('metadata:', 'metadata:\nlicense: MIT')],
    ['tagged name', header.replace('name: repo-test', 'name: !!str repo-test')],
    ['alias version', header.replace('"1.0.0"', '*version')],
    ['anchor metadata', header.replace('metadata:', 'metadata: &identity')],
    ['merge key', `${header}\n  <<: *identity`],
    ['flow mapping is outside preview subset', header.replace('metadata:\n  version: "1.0.0"', 'metadata: {version: "1.0.0"}')],
    ['quoted duplicate key cannot bypass detection', `${header}\n"name": repo-test`],
    ['folded scalar is outside preview subset', header.replace('description: Run authorized tests.', 'description: >\n  Run authorized tests.')],
    ['control character', header.replace('Run authorized tests.', 'Run\tauthorized tests.')],
    ['unknown top-level property', `${header}\nunsupported: value`],
    ['unterminated quote', header.replace('"1.0.0"', '"1.0.0')],
    ['trailing scalar content', header.replace('"1.0.0"', '"1.0.0" extra')]
  ]
  for (const [name, invalidHeader] of cases) {
    await t.test(name, async () => {
      const bytes = zip([{ name: 'SKILL.md', data: `---\n${invalidHeader}\n---\n# Fixture\n` }])
      const runtime = managerRuntime({ packageBytes: bytes })
      const result = await runtime.manager.execute(dispatch(bytes))
      assert.equal(result.status, 'failed')
      assert.equal(result.failureCode, SKILL_INSTALL_FAILURE.IDENTITY_MISMATCH)
      assert.equal(runtime.manager.getInstallation('si_1'), null)
      assert.equal(existsSync(resolve(runtime.codexHome, 'skills', 'repo-test')), false)
      assert.deepEqual(readdirSync(runtime.manager.stagingDir), [])
      assert.deepEqual(runtime.manager.pendingResults().map(item => item.envelope.status), ['FAILED'])
    })
  }
})

test('six exact W08 metadata.version ZIP packages install with digest and marker identity preserved', async t => {
  // Immutable source fixture, not regenerated ZIPs or a dependency on another worktree.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/w08-metadata-version-packages.json', import.meta.url), 'utf8'))
  assert.equal(fixture.sourceCommit, '6619aae27fd8a31c9ea1dec429a738236ea8a252')
  assert.equal(fixture.sourceTree, '0b869eb0acf78068a97790785f50228da06431ff')
  assert.deepEqual(fixture.packages.map(item => item.skillKey).sort(), [
    'code-editor', 'code-reviewer', 'deploy-runner', 'repo-inspector', 'repo-test', 'web-builder'
  ])
  for (const item of fixture.packages) {
    await t.test(item.skillKey, async () => {
      const bytes = Buffer.from(item.packageBase64, 'base64')
      assert.equal(bytes.toString('base64'), item.packageBase64)
      assert.equal(String(bytes.length), item.packageSize)
      assert.equal(digest(bytes), item.packageDigest)
      const runtime = managerRuntime({ packageBytes: bytes })
      const message = dispatch(bytes, { skillKey: item.skillKey, skillVersion: item.skillVersion })
      const result = await runManagedCommand({
        profile: runtime.profile,
        message,
        skillInstallManager: runtime.manager,
        workspaceManager: { forbidden: true },
        runCodexFn: async () => { throw new Error('package installation must not execute a skill or Codex') }
      })
      assert.equal(result.status, 'completed', result.errorMessage)
      const target = resolve(runtime.codexHome, 'skills', item.skillKey)
      assert.equal(digest(readFileSync(resolve(target, 'SKILL.md'))), `sha256:${item.skillMdSha256}`)
      const marker = JSON.parse(readFileSync(resolve(target, '.cyf-installation.json'), 'utf8'))
      assert.equal(marker.skillKey, item.skillKey)
      assert.equal(marker.skillVersion, item.skillVersion)
      assert.equal(marker.packageDigest, item.packageDigest)
      assert.equal(runtime.manager.getInstallation('si_1').state, 'ACTIVE')
      assert.equal(runtime.manager.pendingResults()[0].envelope.status, 'SUCCEEDED')
      const restarted = managerForExistingState({ profile: runtime.profile, stateRoot: runtime.stateRoot })
      assert.equal(restarted.initialize().healthy, true)
      assert.equal((await restarted.execute(message)).idempotent, true)
    })
  }
})

test('verified package activates atomically, records identity, and routes outside Codex/worktrees', async () => {
  const bytes = validPackage()
  const sent = []
  const requests = []
  const runtime = managerRuntime({
    packageBytes: bytes,
    sendResultFn: envelope => { sent.push(envelope); return true },
    fetchFn: async (url, options) => {
      requests.push({ url: url.toString(), options })
      return responseFor(bytes)
    }
  })
  let codexRuns = 0
  const result = await runManagedCommand({
    profile: runtime.profile,
    message: dispatch(bytes),
    skillInstallManager: runtime.manager,
    workspaceManager: { forbidden: true },
    runCodexFn: async () => { codexRuns += 1; throw new Error('must not execute') }
  })

  assert.equal(result.status, 'completed')
  assert.equal(codexRuns, 0)
  assert.equal(requests.length, 1)
  const target = resolve(runtime.codexHome, 'skills', 'repo-test')
  assert.equal(readFileSync(resolve(target, 'SKILL.md'), 'utf8').includes('name: repo-test'), true)
  assert.equal(statSync(resolve(target, 'scripts', 'run.sh')).mode & 0o777, 0o755)
  const marker = JSON.parse(readFileSync(resolve(target, '.cyf-installation.json'), 'utf8'))
  assert.equal(marker.installationId, 'si_1')
  assert.equal(marker.packageDigest, digest(bytes))
  assert.equal(runtime.manager.getInstallation('si_1').state, 'ACTIVE')
  assert.equal(runtime.manager.pendingResults().length, 1)
  assert.equal(runtime.manager.acknowledgedResults().length, 0)
  assert.equal(sent[0].messageType, 'work.result')
  assert.equal(sent[0].status, 'SUCCEEDED')
  assert.equal(runtime.manager.acknowledgeResultReceipt(receiptFor(sent[0])).status, 'acknowledged')
  assert.equal(runtime.manager.pendingResults().length, 0)
  assert.equal(runtime.manager.acknowledgedResults().length, 1)
})

test('processor preserves ACK order and persists work.result before terminal success', async () => {
  const bytes = validPackage()
  const root = temporaryDirectory()
  const codexHome = resolve(root, 'codex-home')
  mkdirSync(codexHome, { recursive: true })
  const selectedProfile = profile(codexHome)
  const wire = []
  const manager = new SkillInstallManager({
    profile: selectedProfile,
    stateRoot: resolve(root, 'skill-state'),
    wsUrl: 'wss://api.example.test/ws/agent/channel',
    apiKey: 'secret',
    enabled: true,
    fetchFn: async () => responseFor(bytes),
    sendResultFn: envelope => { wire.push(`RESULT:${envelope.status}`); return true },
    runtimeInstanceId: 'runtime-test'
  })
  manager.initialize()
  const storageRoot = resolve(root, Buffer.from(selectedProfile.agentId).toString('hex'))
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile: selectedProfile })
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile: selectedProfile })
  ledger.initialize()
  ackOutbox.initialize()
  let codexRuns = 0
  const processor = new AgentMessageProcessor({
    profile: selectedProfile,
    inbox: new PersistentCommandInbox({ rootDir: root, profile: selectedProfile }),
    runCommand: message => runManagedCommand({
      profile: selectedProfile,
      message,
      skillInstallManager: manager,
      workspaceManager: null,
      runCodexFn: async () => { codexRuns += 1; return { status: 'completed' } }
    }),
    runChat: async () => {},
    onWorkResultReceipt: message => manager.acknowledgeResultReceipt(message),
    recoverCommandOutcome: message => manager.reconcileCommandOutcome(message),
    ledger,
    ackOutbox,
    sendFn: envelope => { wire.push(`ACK:${envelope.ackStatus}`); return true }
  })
  processor.start()
  await processor.handle(dispatch(bytes))
  await processor.waitForIdle()

  assert.equal(codexRuns, 0)
  assert.deepEqual(wire, [
    `ACK:${ACK_STATUS.RECEIVED}`,
    `ACK:${ACK_STATUS.STARTED}`,
    'RESULT:SUCCEEDED',
    `ACK:${ACK_STATUS.SUCCEEDED}`
  ])
  assert.equal(manager.pendingResults().length, 1)
  assert.equal(manager.acknowledgedResults().length, 0)
  const resultEnvelope = manager.pendingResults()[0].envelope
  assert.equal((await processor.handle(receiptFor(resultEnvelope))).kind, 'work-result-receipt')
  assert.equal(manager.pendingResults().length, 0)
  assert.equal(manager.acknowledgedResults().length, 1)
  assert.equal(ledger.getEntry('cmd-install-1').status, ACK_STATUS.SUCCEEDED)
})

test('restart reuses an exact installation and conflicting installationId/fence fails without download', async () => {
  const bytes = validPackage()
  const root = temporaryDirectory()
  let downloads = 0
  const first = managerRuntime({
    root,
    packageBytes: bytes,
    sendResultFn: () => true,
    fetchFn: async () => { downloads += 1; return responseFor(bytes) }
  })
  assert.equal((await first.manager.execute(dispatch(bytes))).status, 'completed')
  assert.equal(downloads, 1)

  const restarted = new SkillInstallManager({
    profile: first.profile,
    stateRoot: first.stateRoot,
    wsUrl: 'wss://api.example.test/ws/agent/channel',
    apiKey: 'existing-secret',
    enabled: true,
    fetchFn: async () => { downloads += 1; return responseFor(bytes) },
    sendResultFn: () => true,
    runtimeInstanceId: 'runtime-restart'
  })
  restarted.initialize()
  const replay = await restarted.execute(dispatch(bytes))
  assert.equal(replay.status, 'completed')
  assert.equal(replay.idempotent, true)
  assert.equal(downloads, 1)

  const conflict = await restarted.execute(dispatch(bytes, { fencingToken: '2' }))
  assert.equal(conflict.status, 'failed')
  assert.equal(conflict.failureCode, SKILL_INSTALL_FAILURE.CONFLICT)
  assert.equal(downloads, 1)
  assert.equal(restarted.getInstallation('si_1').command.fencingToken, '1')
})

test('durable work.result survives restart and replays the identical envelope', async () => {
  const bytes = validPackage()
  const root = temporaryDirectory()
  const first = managerRuntime({ root, packageBytes: bytes, sendResultFn: () => false })
  const installed = await first.manager.execute(dispatch(bytes))
  assert.equal(installed.status, 'completed')
  const pending = first.manager.pendingResults()
  assert.equal(pending.length, 1)
  const expectedEnvelope = pending[0].envelope

  const replayed = []
  const restarted = new SkillInstallManager({
    profile: first.profile,
    stateRoot: first.stateRoot,
    wsUrl: 'wss://api.example.test/ws/agent/channel',
    apiKey: 'existing-secret',
    enabled: true,
    fetchFn: async () => { throw new Error('network must not be used during result replay') },
    sendResultFn: envelope => { replayed.push(envelope); return true },
    runtimeInstanceId: 'runtime-restart'
  })
  restarted.initialize()
  assert.equal(restarted.replayResults(undefined, { replayToken: 'connection-1' }), 1)
  assert.deepEqual(replayed, [expectedEnvelope])
  assert.equal(restarted.pendingResults().length, 1)
  assert.equal(restarted.acknowledgedResults().length, 0)
  assert.equal(restarted.replayResults(undefined, { replayToken: 'connection-1' }), 0)
  assert.equal(restarted.replayResults(undefined, { replayToken: 'connection-2' }), 1)
  assert.equal(replayed.length, 2)
  assert.throws(
    () => restarted.acknowledgeResultReceipt(receiptFor(expectedEnvelope, { fencingToken: '999' })),
    error => error.code === SKILL_INSTALL_FAILURE.CONFLICT
  )
  assert.equal(restarted.pendingResults().length, 1)
  assert.equal(restarted.acknowledgeResultReceipt(receiptFor(expectedEnvelope)).idempotent, false)
  assert.equal(restarted.acknowledgeResultReceipt(receiptFor(expectedEnvelope)).idempotent, true)
  assert.equal(restarted.pendingResults().length, 0)
  assert.equal(restarted.acknowledgedResults().length, 1)
})


test('receipt retirement crash duplicates reconcile, while tampered acknowledged evidence fails closed', async () => {
  const bytes = validPackage()
  const root = temporaryDirectory()
  const first = managerRuntime({ root, packageBytes: bytes, sendResultFn: () => false })
  assert.equal((await first.manager.execute(dispatch(bytes))).status, 'completed')
  const envelope = first.manager.pendingResults()[0].envelope
  const receipt = receiptFor(envelope)
  const acknowledged = first.manager.acknowledgeResultReceipt(receipt)
  const acknowledgedPath = first.manager._resultPath(first.manager.resultsAcknowledgedDir, acknowledged.recordId)
  const pendingPath = first.manager._resultPath(first.manager.resultsPendingDir, acknowledged.recordId)

  writeFileSync(pendingPath, readFileSync(acknowledgedPath))
  const duplicateRestart = managerForExistingState({ profile: first.profile, stateRoot: first.stateRoot })
  assert.equal(duplicateRestart.initialize().healthy, true)
  assert.equal(duplicateRestart.pendingResults().length, 0)
  assert.equal(duplicateRestart.acknowledgedResults().length, 1)

  const tampered = JSON.parse(readFileSync(acknowledgedPath, 'utf8'))
  tampered.receipt.fencingToken = '999'
  writeFileSync(acknowledgedPath, `${JSON.stringify(tampered, null, 2)}\n`)
  const tamperedRestart = managerForExistingState({ profile: first.profile, stateRoot: first.stateRoot })
  const health = tamperedRestart.initialize()
  assert.equal(health.healthy, false)
  assert.equal(tamperedRestart.pendingResults().length, 1)
  assert.equal(readdirSync(tamperedRestart.resultsQuarantineDir).some(name => name.endsWith('.json')), true)
})

test('credentialed package URLs require TLS except exact loopback development origins', () => {
  const path = '/internal/agent/skill-installations/si_1/package'
  assert.equal(buildSkillDownloadUrl('wss://api.example.test/ws', path).protocol, 'https:')
  for (const url of ['ws://localhost:8080/ws', 'ws://127.0.0.1:8080/ws', 'ws://127.255.0.1/ws', 'ws://[::1]:8080/ws']) {
    assert.equal(buildSkillDownloadUrl(url, path).protocol, 'http:')
  }
  for (const url of ['ws://api.example.test/ws', 'ws://0.0.0.0/ws', 'ws://192.168.1.3/ws', 'ws://localhost.example/ws']) {
    assert.throws(() => buildSkillDownloadUrl(url, path), error => error.code === SKILL_INSTALL_FAILURE.DOWNLOAD_FORBIDDEN)
  }
})

test('archive rejects Unicode normalization and case-folded path collisions', async t => {
  const cases = [
    ['ASCII case', zip([
      { name: 'SKILL.md', data: skillDocument() },
      { name: 'skill.md', data: 'collision' }
    ])],
    ['Unicode normalization', zip([
      { name: 'SKILL.md', data: skillDocument() },
      { name: 'docs/é.txt', data: 'nfc' },
      { name: 'docs/e\u0301.txt', data: 'nfd' }
    ])],
    ['Unicode case folding', zip([
      { name: 'SKILL.md', data: skillDocument() },
      { name: 'docs/Σ.txt', data: 'sigma' },
      { name: 'docs/ς.txt', data: 'final sigma' }
    ])],
    ['case-folded ancestor', zip([
      { name: 'SKILL.md', data: skillDocument() },
      { name: 'Docs/a.txt', data: 'upper' },
      { name: 'docs/b.txt', data: 'lower' }
    ])],
    ['case-folded prefix', zip([
      { name: 'SKILL.md', data: skillDocument() },
      { name: 'Bin', data: 'file' },
      { name: 'bin/run.sh', data: 'nested' }
    ])]
  ]
  for (const [name, bytes] of cases) {
    await t.test(name, async () => {
      const runtime = managerRuntime({ packageBytes: bytes })
      const result = await runtime.manager.execute(dispatch(bytes))
      assert.equal(result.failureCode, SKILL_INSTALL_FAILURE.ARCHIVE_INVALID)
      assert.equal(runtime.manager.getInstallation('si_1'), null)
    })
  }
})

test('installer lock rejects live owners and durably reclaims dead or stale incomplete owners', () => {
  const liveRoot = temporaryDirectory()
  const liveHome = resolve(liveRoot, 'codex-home')
  const liveState = resolve(liveRoot, 'state')
  mkdirSync(liveHome, { recursive: true })
  mkdirSync(resolve(liveState, 'installer.lock'), { recursive: true })
  writeFileSync(resolve(liveState, 'installer.lock', 'owner.json'), `${JSON.stringify({
    formatVersion: 2, ownerToken: 'live-owner', pid: 44, processStartToken: 'start', bootId: 'boot'
  })}\n`)
  const live = managerForExistingState({
    profile: profile(liveHome), stateRoot: liveState,
    processIdentityFn: () => ({ pid: 55, processStartToken: 'other', bootId: 'boot' }),
    lockOwnerAliveFn: () => true
  })
  assert.throws(() => live.initialize(), error => error.code === SKILL_INSTALL_FAILURE.CONFLICT)
  assert.equal(existsSync(resolve(liveState, 'installer.lock')), true)

  const legacyRoot = temporaryDirectory()
  const legacyHome = resolve(legacyRoot, 'codex-home')
  const legacyState = resolve(legacyRoot, 'state')
  mkdirSync(legacyHome, { recursive: true })
  mkdirSync(resolve(legacyState, 'installer.lock'), { recursive: true })
  writeFileSync(resolve(legacyState, 'installer.lock', 'owner.json'), `${JSON.stringify({
    formatVersion: 1, pid: process.pid, operation: 'legacy-live', acquiredAt: 1
  })}\n`)
  utimesSync(resolve(legacyState, 'installer.lock'), new Date(0), new Date(0))
  const legacy = managerForExistingState({
    profile: profile(legacyHome), stateRoot: legacyState, unownedLockStaleMs: 0,
    processIdentityFn: () => ({ pid: 99, processStartToken: 'new', bootId: 'boot' })
  })
  assert.throws(() => legacy.initialize(), error => error.code === SKILL_INSTALL_FAILURE.CONFLICT)
  assert.equal(existsSync(resolve(legacyState, 'installer.lock')), true)

  const deadRoot = temporaryDirectory()
  const deadHome = resolve(deadRoot, 'codex-home')
  const deadState = resolve(deadRoot, 'state')
  mkdirSync(deadHome, { recursive: true })
  mkdirSync(resolve(deadState, 'installer.lock'), { recursive: true })
  writeFileSync(resolve(deadState, 'installer.lock', 'owner.json'), `${JSON.stringify({
    formatVersion: 2, ownerToken: 'dead-owner', pid: 66, processStartToken: 'old', bootId: 'boot'
  })}\n`)
  const dead = managerForExistingState({
    profile: profile(deadHome), stateRoot: deadState,
    processIdentityFn: () => ({ pid: 77, processStartToken: 'new', bootId: 'boot' }),
    lockOwnerAliveFn: () => false,
    atomicFs: LINUX_ATOMIC_FS,
    createId: (() => { let value = 0; return () => `id-${++value}` })()
  })
  assert.equal(dead.initialize().healthy, true)
  assert.equal(existsSync(resolve(deadState, 'installer.lock')), false)
  assert.equal(readdirSync(resolve(deadState, 'stale-locks')).length, 1)

  const incompleteRoot = temporaryDirectory()
  const incompleteHome = resolve(incompleteRoot, 'codex-home')
  const incompleteState = resolve(incompleteRoot, 'state')
  mkdirSync(incompleteHome, { recursive: true })
  mkdirSync(resolve(incompleteState, 'installer.lock'), { recursive: true })
  utimesSync(resolve(incompleteState, 'installer.lock'), new Date(0), new Date(0))
  const incomplete = managerForExistingState({
    profile: profile(incompleteHome), stateRoot: incompleteState,
    now: () => 100_000,
    unownedLockStaleMs: 10,
    processIdentityFn: () => ({ pid: 88, processStartToken: 'new', bootId: 'boot' }),
    lockOwnerAliveFn: () => false,
    atomicFs: LINUX_ATOMIC_FS,
    createId: (() => { let value = 0; return () => `id-${++value}` })()
  })
  assert.equal(incomplete.initialize().healthy, true)
  assert.equal(readdirSync(resolve(incompleteState, 'stale-locks')).length, 1)
})

test('lock release binds the exact owner bytes and never removes a mutated generation', () => {
  const runtime = managerRuntime()
  let mutateOnRelease = false
  runtime.manager.atomicFs = {
    ...testAtomicFs,
    renameNoReplace(sourcePath, targetPath, expected) {
      if (mutateOnRelease && sourcePath === resolve(runtime.stateRoot, 'installer.lock')) {
        writeFileSync(resolve(sourcePath, 'owner.json'), `${JSON.stringify({
          formatVersion: 2,
          ownerToken: 'foreign-owner',
          pid: process.pid,
          processStartToken: 'foreign-start',
          bootId: 'foreign-boot'
        })}\n`)
      }
      return testAtomicFs.renameNoReplace(sourcePath, targetPath, expected)
    }
  }

  assert.throws(
    () => runtime.manager._withLockSync('owner-generation-race', () => { mutateOnRelease = true }),
    error => error.code === SKILL_INSTALL_FAILURE.CONFLICT
  )
  assert.equal(existsSync(resolve(runtime.stateRoot, 'installer.lock')), true)
  assert.equal(JSON.parse(readFileSync(resolve(runtime.stateRoot, 'installer.lock', 'owner.json'), 'utf8')).ownerToken, 'foreign-owner')
})

test('concurrent stale reclaimers bind exchange to inspected owner generation and never move the winner', () => {
  const seed = managerRuntime()
  const stalePath = resolve(seed.stateRoot, 'installer.lock')
  mkdirSync(stalePath)
  writeFileSync(resolve(stalePath, 'owner.json'), `${JSON.stringify({
    formatVersion: 2, ownerToken: 'stale-owner', pid: 1, processStartToken: 'stale', bootId: 'stale'
  })}\n`)

  const winner = managerForExistingState({
    profile: seed.profile,
    stateRoot: seed.stateRoot,
    atomicFs: LINUX_ATOMIC_FS,
    processIdentityFn: () => ({ pid: process.pid, processStartToken: 'winner-start', bootId: 'winner-boot' }),
    lockOwnerAliveFn: owner => owner.operation === 'winner'
  })
  let winnerAcquired = false
  const racingAtomicFs = {
    renameNoReplace: (...args) => LINUX_ATOMIC_FS.renameNoReplace(...args),
    exchangeIfMatch: (...args) => {
      if (!winnerAcquired) {
        winner._acquireLock('winner')
        winnerAcquired = true
      }
      return LINUX_ATOMIC_FS.exchangeIfMatch(...args)
    }
  }
  const loser = managerForExistingState({
    profile: seed.profile,
    stateRoot: seed.stateRoot,
    atomicFs: racingAtomicFs,
    processIdentityFn: () => ({ pid: process.pid, processStartToken: 'loser-start', bootId: 'loser-boot' }),
    lockOwnerAliveFn: owner => owner.operation === 'winner'
  })

  assert.throws(() => loser._acquireLock('loser'), error => error.code === SKILL_INSTALL_FAILURE.CONFLICT)
  const observed = JSON.parse(readFileSync(resolve(stalePath, 'owner.json'), 'utf8'))
  assert.equal(observed.ownerToken, winner.lockOwner.ownerToken)
  assert.equal(observed.operation, 'winner')
  winner._releaseLock()
})

test('target and parent races fail closed without replacing foreign or replacement-parent content', async t => {
  const bytes = validPackage()
  await t.test('target appears at commit', async () => {
    let injected = false
    const racingAtomicFs = {
      ...testAtomicFs,
      renameNoReplace(sourcePath, targetPath, expected) {
        if (!injected && targetPath.endsWith('/repo-test')) {
          injected = true
          mkdirSync(targetPath)
          writeFileSync(resolve(targetPath, 'foreign.txt'), 'foreign-target')
        }
        return testAtomicFs.renameNoReplace(sourcePath, targetPath, expected)
      }
    }
    const runtime = managerRuntime({ packageBytes: bytes, atomicFs: racingAtomicFs })
    const result = await runtime.manager.execute(dispatch(bytes))
    assert.equal(result.status, 'recovery_required')
    assert.equal(readFileSync(resolve(runtime.codexHome, 'skills', 'repo-test', 'foreign.txt'), 'utf8'), 'foreign-target')
    assert.equal(runtime.manager.pendingResults().length, 0)
  })

  await t.test('skills parent inode changes immediately before commit', async () => {
    let injected = false
    let displaced = ''
    const racingAtomicFs = {
      ...testAtomicFs,
      renameNoReplace(sourcePath, targetPath, expected) {
        if (!injected && targetPath.endsWith('/repo-test')) {
          injected = true
          const skills = resolve(targetPath, '..')
          displaced = `${skills}-displaced`
          renameSync(skills, displaced)
          mkdirSync(skills)
          writeFileSync(resolve(skills, 'replacement-parent.txt'), 'replacement-parent')
        }
        return testAtomicFs.renameNoReplace(sourcePath, targetPath, expected)
      }
    }
    const runtime = managerRuntime({ packageBytes: bytes, atomicFs: racingAtomicFs })
    const result = await runtime.manager.execute(dispatch(bytes))
    assert.equal(result.status, 'recovery_required')
    assert.equal(existsSync(resolve(runtime.codexHome, 'skills', 'repo-test')), false)
    assert.equal(readFileSync(resolve(runtime.codexHome, 'skills', 'replacement-parent.txt'), 'utf8'), 'replacement-parent')
    assert.equal(existsSync(resolve(displaced, 'repo-test')), false)
  })
})

test('durable installer state is bound to canonical API origin and profile scope', async () => {
  const first = managerRuntime({ sendResultFn: () => false })
  assert.equal((await first.manager.execute(dispatch(first.packageBytes))).status, 'completed')
  const foreignOrigin = managerForExistingState({
    profile: first.profile,
    stateRoot: first.stateRoot,
    wsUrl: 'wss://other-origin.example.test/ws'
  })
  assert.throws(
    () => foreignOrigin.initialize(),
    error => error.code === SKILL_INSTALL_FAILURE.CONFLICT && /different origin\/profile scope/.test(error.message)
  )
  const foreignProfile = managerForExistingState({
    profile: { ...first.profile, profileId: 'profile-b' },
    stateRoot: first.stateRoot
  })
  assert.throws(
    () => foreignProfile.initialize(),
    error => error.code === SKILL_INSTALL_FAILURE.CONFLICT && /different origin\/profile scope/.test(error.message)
  )
})

test('ACTIVE plus durable FAILED reconciles to quarantined failure and inbox terminal FAILED only', async () => {
  const first = managerRuntime({ sendResultFn: () => false })
  const message = dispatch(first.packageBytes)
  assert.equal((await first.manager.execute(message)).status, 'completed')
  const active = first.manager.getInstallation('si_1')
  first.manager._withLockSync('inject-upgrade-failure', () => {
    first.manager._persistFailureResult(active.command, new SkillInstallError(SKILL_INSTALL_FAILURE.IO_FAILED, 'legacy contradictory failure'))
  })

  const restarted = managerForExistingState({ profile: first.profile, stateRoot: first.stateRoot })
  assert.equal(restarted.initialize().healthy, true)
  const quarantined = restarted.getInstallation('si_1')
  assert.equal(quarantined.state, 'QUARANTINED')
  assert.equal(existsSync(quarantined.targetPath), false)
  assert.equal(existsSync(quarantined.quarantinedPath), true)
  assert.deepEqual(restarted.pendingResults().map(item => item.envelope.status), ['FAILED'])
  assert.equal(readdirSync(restarted.resultsSupersededDir).some(name => name.endsWith('.json')), true)
  assert.equal(restarted.reconcileCommandOutcome(message).status, 'failed')

  const inboxRoot = resolve(first.root, 'inbox-state')
  const inbox = new PersistentCommandInbox({ rootDir: inboxRoot, profile: first.profile })
  const profileRoot = resolve(inboxRoot, Buffer.from(first.profile.agentId).toString('hex'))
  const ledger = new DurableDedupeLedger({ rootDir: profileRoot, profile: first.profile })
  const ackOutbox = new AckOutbox({ rootDir: profileRoot, profile: first.profile })
  inbox.initialize(); ledger.initialize(); ackOutbox.initialize()
  const item = inbox.enqueue(message)
  const fingerprint = CommandFingerprint.compute(item.normalized)
  ledger.checkOrRecord(message.commandId, fingerprint, { messageId: message.messageId, commandType: message.commandType, targetAgentId: message.targetAgentId })
  ledger.recordQueueSequence(message.commandId, item.record.queueSequence)
  ledger.markStarted(message.commandId)
  inbox.markRecoveryRequired(inbox.claimNext(), 'upgrade contradiction')

  const wire = []
  const processor = new AgentMessageProcessor({
    profile: first.profile,
    inbox,
    runCommand: async () => { throw new Error('must not execute') },
    runChat: async () => {},
    recoverCommandOutcome: command => restarted.reconcileCommandOutcome(command),
    ledger,
    ackOutbox,
    sendFn: envelope => { wire.push(envelope); return true }
  })
  const recovery = processor.start({ drain: false })
  assert.equal(recovery.failClosedCode, '')
  assert.equal(ledger.getEntry(message.commandId).status, ACK_STATUS.FAILED)
  assert.equal(inbox.list('archive')[0].outcome.status, 'failed')
  assert.deepEqual(wire.filter(item => [ACK_STATUS.SUCCEEDED, ACK_STATUS.FAILED].includes(item.ackStatus)).map(item => item.ackStatus), [ACK_STATUS.FAILED])
})

test('stable connection drains 33+ results in bounded batches and receipts retire only exact records', () => {
  const runtime = managerRuntime({ sendResultFn: () => false })
  runtime.manager._withLockSync('seed-33-results', () => {
    for (let index = 0; index < 35; index += 1) {
      runtime.manager._persistFailureResult({
        ...dispatch(runtime.packageBytes),
        messageId: `msg-${index}`,
        commandId: `cmd-${index}`,
        installationId: `si-${index}`,
        downloadPath: `/internal/agent/skill-installations/si-${index}/package`,
        scopeDigest: runtime.manager.scope.digest
      }, new SkillInstallError(SKILL_INSTALL_FAILURE.DISABLED, 'disabled'))
    }
  })
  const sent = []
  runtime.manager.sendResultFn = envelope => { sent.push(envelope); return true }
  const scheduled = []
  const batches = []
  const cancel = startBoundedSkillResultReplay({
    manager: runtime.manager,
    replayToken: 'stable-connection',
    isStable: () => true,
    schedule: callback => scheduled.push(callback),
    onBatch: count => batches.push(count)
  })
  while (scheduled.length) scheduled.shift()()
  cancel()

  assert.deepEqual(batches, [32, 3])
  assert.equal(sent.length, 35)
  assert.equal(new Set(sent.map(item => item.messageId)).size, 35)
  assert.equal(runtime.manager.pendingResults().length, 35)
  const later = sent[34]
  assert.equal(runtime.manager.acknowledgeResultReceipt(receiptFor(later)).status, 'acknowledged')
  assert.equal(runtime.manager.pendingResults().length, 34)
  assert.equal(runtime.manager.acknowledgedResults().length, 1)
})

test('durable PREPARED and activation-boundary persistence faults reconcile forward without false failure', async t => {
  const bytes = validPackage()
  for (const faultState of ['PREPARED', 'ACTIVE']) {
    await t.test(faultState, async () => {
      const runtime = managerRuntime({ packageBytes: bytes, sendResultFn: () => false })
      const original = runtime.manager._writeRegistry.bind(runtime.manager)
      let injected = false
      runtime.manager._writeRegistry = record => {
        original(record)
        if (!injected && record.state === faultState) {
          injected = true
          throw new Error(`injected ${faultState} persistence response loss`)
        }
      }
      const reconcilePrepared = runtime.manager._reconcilePreparedRecord.bind(runtime.manager)
      let reconciledUnderMutex = false
      runtime.manager._reconcilePreparedRecord = (...args) => {
        assert.ok(runtime.manager.lockOwner)
        reconciledUnderMutex = true
        return reconcilePrepared(...args)
      }
      const result = await runtime.manager.execute(dispatch(bytes))
      assert.equal(result.status, 'completed')
      assert.equal(result.activationCommitted, true)
      assert.equal(reconciledUnderMutex, true)
      assert.equal(runtime.manager.getInstallation('si_1').state, 'ACTIVE')
      assert.equal(runtime.manager.pendingResults().length, 1)
      assert.equal(runtime.manager.pendingResults()[0].envelope.status, 'SUCCEEDED')
    })
  }
})

test('PREPARED recovery completes both pre-publication and post-publication crash states', async () => {
  const bytes = validPackage()
  const root = temporaryDirectory()
  const first = managerRuntime({ root, packageBytes: bytes, sendResultFn: () => false })
  assert.equal((await first.manager.execute(dispatch(bytes))).status, 'completed')
  const active = first.manager.getInstallation('si_1')
  const registryPath = first.manager._registryPath('si_1')

  renameSync(active.targetPath, active.stagingPath)
  writeFileSync(registryPath, `${JSON.stringify({ ...active, state: 'PREPARED', activatedAt: null }, null, 2)}\n`)
  const beforePublish = managerForExistingState({ profile: first.profile, stateRoot: first.stateRoot })
  assert.equal(beforePublish.initialize().healthy, true)
  assert.equal(beforePublish.getInstallation('si_1').state, 'ACTIVE')
  assert.equal(existsSync(active.targetPath), true)
  assert.equal(existsSync(active.stagingPath), false)

  const recovered = beforePublish.getInstallation('si_1')
  writeFileSync(registryPath, `${JSON.stringify({ ...recovered, state: 'PREPARED', activatedAt: null }, null, 2)}\n`)
  const afterPublish = managerForExistingState({ profile: first.profile, stateRoot: first.stateRoot })
  assert.equal(afterPublish.initialize().healthy, true)
  assert.equal(afterPublish.getInstallation('si_1').state, 'ACTIVE')
  assert.equal(afterPublish.pendingResults().length, 1)
})

test('startup reconciles committed installer evidence with a recovery-required inbox without re-execution', async () => {
  const bytes = validPackage()
  const root = temporaryDirectory()
  const codexHome = resolve(root, 'codex-home')
  mkdirSync(codexHome, { recursive: true })
  const selectedProfile = profile(codexHome)
  const stateRoot = resolve(root, 'skill-state')
  const manager = new SkillInstallManager({
    profile: selectedProfile, stateRoot,
    wsUrl: 'wss://api.example.test/ws', apiKey: 'secret', enabled: true,
    fetchFn: async () => responseFor(bytes), sendResultFn: () => false,
    runtimeInstanceId: 'runtime-before-crash'
  })
  manager.initialize()
  const inbox = new PersistentCommandInbox({ rootDir: root, profile: selectedProfile })
  const storageRoot = resolve(root, Buffer.from(selectedProfile.agentId).toString('hex'))
  const ledger = new DurableDedupeLedger({ rootDir: storageRoot, profile: selectedProfile })
  const ackOutbox = new AckOutbox({ rootDir: storageRoot, profile: selectedProfile })
  inbox.initialize(); ledger.initialize(); ackOutbox.initialize()
  const message = dispatch(bytes)
  const item = inbox.enqueue(message)
  const fingerprint = CommandFingerprint.compute(item.normalized)
  ledger.checkOrRecord(message.commandId, fingerprint, { messageId: message.messageId, commandType: message.commandType, targetAgentId: message.targetAgentId, expiresAt: null })
  ledger.recordQueueSequence(message.commandId, item.record.queueSequence)
  ledger.markStarted(message.commandId)
  const claimed = inbox.claimNext()
  assert.equal((await manager.execute(message)).status, 'completed')
  inbox.markRecoveryRequired(claimed, 'simulated crash after activation')
  ledger.markRecoveryRequired(message.commandId, fingerprint, { messageId: message.messageId, commandType: message.commandType, targetAgentId: message.targetAgentId }, 'simulated crash')

  const restartedManager = managerForExistingState({ profile: selectedProfile, stateRoot })
  restartedManager.initialize()
  let executions = 0
  const processor = new AgentMessageProcessor({
    profile: selectedProfile, inbox,
    runCommand: async () => { executions += 1; return { status: 'failed' } },
    runChat: async () => {}, ledger, ackOutbox, sendFn: () => false,
    recoverCommandOutcome: command => restartedManager.reconcileCommandOutcome(command),
    onWorkResultReceipt: receipt => restartedManager.acknowledgeResultReceipt(receipt)
  })
  const recovery = processor.start({ drain: false })
  assert.equal(recovery.failClosedCode, '')
  assert.equal(executions, 0)
  assert.equal(ledger.getEntry(message.commandId).status, ACK_STATUS.SUCCEEDED)
  assert.equal(inbox.count('recovery'), 0)
})

test('profile validation rejects equal, nested, and symlink-aliased CODEX_HOME paths', () => {
  const root = temporaryDirectory()
  const homeA = resolve(root, 'home-a')
  const nested = resolve(homeA, 'nested')
  const workA = resolve(root, 'work-a')
  const workB = resolve(root, 'work-b')
  mkdirSync(nested, { recursive: true })
  mkdirSync(workA); mkdirSync(workB)
  const base = (profileId, agentId, codexHome, codexWorkdir) => ({
    ...profile(codexHome), profileId, agentId, codexHome, codexWorkdir,
    workspaceNoTaskPolicy: 'reject', workspacePolicyId: '', workspaceNonCodingCommandTypes: [],
    workspaceFallbackWorkdir: '', workspaceRole: ''
  })
  assert.throws(() => ensureProfiles([
    base('a', 'agent-a', homeA, workA), base('b', 'agent-b', nested, workB)
  ], 'a', new Map(), false), /must not be equal or overlap/)
  assert.throws(() => ensureProfiles([
    base('a', 'agent-a', homeA, workA), base('b', 'agent-b', homeA, workB)
  ], 'a', new Map(), false), /must not be equal or overlap/)
  const alias = resolve(root, 'home-alias')
  symlinkSync(homeA, alias, 'dir')
  assert.throws(() => ensureProfiles([
    base('a', 'agent-a', homeA, workA), base('b', 'agent-b', alias, workB)
  ], 'a', new Map(), false), /must not be equal or overlap/)

  const realParent = resolve(root, 'real-parent')
  const parentAlias = resolve(root, 'parent-alias')
  mkdirSync(realParent)
  symlinkSync(realParent, parentAlias, 'dir')
  assert.throws(() => ensureProfiles([
    base('a', 'agent-a', resolve(realParent, 'future-home'), workA),
    base('b', 'agent-b', resolve(parentAlias, 'future-home', 'nested'), workB)
  ], 'a', new Map(), false), /must not be equal or overlap/)
})
