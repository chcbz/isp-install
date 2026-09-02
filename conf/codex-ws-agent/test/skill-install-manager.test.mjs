import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import test, { afterEach } from 'node:test'

import {
  ACK_STATUS,
  AckOutbox,
  AgentMessageProcessor,
  DurableDedupeLedger,
  MESSAGE_TYPES,
  PersistentCommandInbox,
  runManagedCommand
} from '../agent-client.mjs'
import {
  SKILL_INSTALL_FAILURE,
  SkillInstallManager,
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

const validPackage = (skillKey = 'repo-test', version = '1.0.0') => zip([
  { name: 'SKILL.md', data: `---\nname: ${skillKey}\nversion: ${version}\n---\n\n# ${skillKey}\n` },
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

const managerRuntime = ({ enabled = true, packageBytes = validPackage(), sendResultFn = () => false, fetchFn, root = temporaryDirectory() } = {}) => {
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
  const result = await runtime.manager.execute(dispatch(bytes))

  assert.equal(result.status, 'failed')
  assert.equal(result.failureCode, SKILL_INSTALL_FAILURE.DISABLED)
  assert.equal(result.resultEnvelope.failureCode, 'SKILL_INSTALL_DISABLED')
  assert.equal(downloads, 0)
  assert.equal(runtime.manager.pendingResults().length, 1)
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
    ['reserved marker', zip([{ name: '.cyf-installation.json', data: '{}' }]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['duplicate', zip([
      { name: 'SKILL.md', data: '---\nname: repo-test\nversion: 1.0.0\n---\n' },
      { name: 'SKILL.md', data: 'duplicate' }
    ]), SKILL_INSTALL_FAILURE.ARCHIVE_INVALID],
    ['symlink', zip([
      { name: 'SKILL.md', data: '---\nname: repo-test\nversion: 1.0.0\n---\n' },
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
  assert.equal(runtime.manager.pendingResults().length, 0)
  assert.equal(runtime.manager.sentResults().length, 1)
  assert.equal(sent[0].messageType, 'work.result')
  assert.equal(sent[0].status, 'SUCCEEDED')
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
  assert.equal(manager.sentResults().length, 1)
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
  assert.equal(restarted.replayResults(), 1)
  assert.deepEqual(replayed, [expectedEnvelope])
  assert.equal(restarted.pendingResults().length, 0)
  assert.equal(restarted.sentResults().length, 1)
})
