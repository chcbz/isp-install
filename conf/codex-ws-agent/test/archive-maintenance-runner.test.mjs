import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test, { afterEach } from 'node:test'

import { ArchiveMaintenanceNativeClient, validateArchiveMaintenanceCommand } from '../archive-maintenance-native.mjs'
import { ArchiveMaintenanceRunner } from '../archive-maintenance-runner.mjs'
import { AgentMessageProcessor, AckOutbox, DurableDedupeLedger, PersistentCommandInbox, runManagedCommand } from '../agent-client.mjs'
import { PlatformSkillManager } from '../platform-skill-manager.mjs'

const roots = []
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }) })
const temporaryDirectory = () => { const path = mkdtempSync(resolve(tmpdir(), 'archive-runner-')); roots.push(path); return path }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const approved = readFileSync(new URL('./fixtures/archive-maintainer-1.0.0-approved.zip', import.meta.url))
const runtimeScope = { scheme: 'native-runtime-v1', tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a', agentId: 'agent-a', runtimeInstanceId: 'runtime-a' }
const profile = { profileId: 'profile-a', agentId: 'agent-a', agentName: 'Agent A', personaName: 'Agent A' }
const identity = path => { const stat = lstatSync(path, { bigint: true }); return { path: resolve(path), dev: stat.dev.toString(), ino: stat.ino.toString(), kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other' } }
const sameIdentity = (left, right) => left && right && left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
const fakeAtomic = { renameNoReplace(source, target, expected = {}) {
  if (expected.sourceParent && !sameIdentity(identity(resolve(source, '..')), expected.sourceParent)) return { ok: false, code: 'SOURCE_CHANGED', message: '' }
  if (expected.targetParent && !sameIdentity(identity(resolve(target, '..')), expected.targetParent)) return { ok: false, code: 'SOURCE_CHANGED', message: '' }
  if (expected.sourceIdentity && !sameIdentity(identity(source), expected.sourceIdentity)) return { ok: false, code: 'SOURCE_CHANGED', message: '' }
  if (existsSync(target)) return { ok: false, code: 'TARGET_EXISTS', message: '' }
  renameSync(source, target); return { ok: true, code: 'OK', message: '' }
} }

const platformCommandId = installationId => `cmd_controlled_${sha(Buffer.from(['0', 'client-a', 'owner-a', installationId, 'agent-a', 'PLATFORM_SKILL_INSTALL'].join('\0')))}`
const installManager = async root => {
  const codexHome = resolve(root, 'codex-home'); mkdirSync(codexHome, { recursive: true })
  const now = Date.now()
  const manager = new PlatformSkillManager({ profile: { ...profile, codexHome }, runtimeScope,
    stateRoot: resolve(root, 'platform-state'), wsUrl: 'wss://api.example.invalid/ws', enabled: true,
    atomicFs: fakeAtomic, now: () => now, createId: (() => { let id = 0; return () => `id-${++id}` })(),
    authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, downloadFn: async () => approved,
    sendResultFn: async ({ command, outcome, errorCode }) => ({ installationId: command.installationId,
      agentId: command.targetAgentId, bindingVersion: command.bindingVersion, skillKey: command.skillKey,
      skillVersion: command.skillVersion, packageSha256: command.packageSha256, origin: 'PLATFORM_PROVISIONED',
      state: outcome, errorCode, revision: '2' }) })
  manager.initialize()
  const installationId = 'installation-a'
  const command = { schemaVersion: 1, messageType: 'command.dispatch', messageId: 'install-message', commandId: platformCommandId(installationId),
    correlationId: installationId, causationId: 'challenge-a', tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a', taskId: installationId,
    workItemId: null, targetAgentId: 'agent-a', commandType: 'PLATFORM_SKILL_INSTALL', issuedAt: now - 1000, expiresAt: now - 1000 + 3600000,
    attempt: 1, fencingToken: '1', deliveryEpoch: '1', executionEpoch: '1', payload: { schemaVersion: 1, installationId,
      bindingVersion: '7', skillKey: 'archive-maintainer', skillVersion: '1.0.0', packageSha256: sha(approved), challengeId: 'challenge-a',
      packageRef: `/internal/agent/platform-skills/installations/${installationId}/package` } }
  assert.equal((await manager.execute(command)).status, 'completed')
  return manager
}

const archiveWire = ({ now = Date.now(), runId = 'run-a' } = {}) => {
  const commandId = `cmd_controlled_${sha(Buffer.from(['0', 'client-a', 'owner-a', runId, 'agent-a', 'ARCHIVE_MAINTENANCE_EXECUTE'].join('\0')))}`
  return { schemaVersion: 1, messageType: 'command.dispatch', messageId: 'archive-message', commandId,
    correlationId: 'job-a', causationId: runId, tenantId: '0', clientId: 'client-a', ownerJiacn: 'owner-a', taskId: 'job-a',
    workItemId: null, targetAgentId: 'agent-a', commandType: 'ARCHIVE_MAINTENANCE_EXECUTE', issuedAt: now - 1000, expiresAt: now + 60000,
    attempt: 1, fencingToken: '1', deliveryEpoch: '1', executionEpoch: '1', payload: { schemaVersion: 1, jobId: 'job-a', runId,
      executionEpoch: '1', appointmentId: 'appointment-a', appointmentRevision: '1', managerAuthorizationRevision: '3', bindingVersion: '7',
      grantRef: 'grant-a', executionRef: 'execution-a', dispatchKey: 'dispatch-a', skillInstallationId: 'installation-a',
      skillPackageSha256: sha(approved), contextRef: `/internal/archive/v1/jobs/job-a/runs/${runId}/context` } }
}

const terminalResult = (wire, state, mode, validationId = null) => ({ jobId: 'job-a', runId: wire.payload.runId, commandId: wire.commandId,
  attempt: '1', executionEpoch: '1', runState: state, runRevision: state === 'AUTHORIZED' ? '1' : state === 'RUNNING' ? '2' : '3',
  jobState: state === 'COMPLETED' ? mode === 'AUTO' ? 'PUBLISHED' : 'AWAITING_PUBLISH' : state === 'FAILED' ? 'FAILED' : state === 'AUTHORIZED' ? 'EXECUTION_REQUESTED' : 'RUNNING',
  jobRevision: state === 'AUTHORIZED' ? '1' : state === 'RUNNING' ? '2' : '3',
  stage: state === 'AUTHORIZED' ? 'READY_TO_START' : state === 'RUNNING' ? 'RUNNING' : state === 'COMPLETED' ? mode === 'AUTO' ? 'COMPLETED' : 'AWAITING_HUMAN_RELEASE' : 'FAILED',
  validationId, validationOutcome: validationId ? 'PASSED' : null, validationDigest: validationId ? 'b'.repeat(64) : null,
  draftRevision: validationId ? '1' : '0', publicationId: state === 'COMPLETED' && mode === 'AUTO' ? 'publication-a' : null,
  workId: state === 'COMPLETED' && mode === 'AUTO' ? 'work-a' : null, editionId: state === 'COMPLETED' && mode === 'AUTO' ? 'edition-a' : null,
  publicationState: state === 'COMPLETED' && mode === 'AUTO' ? 'PUBLISHED' : null,
  failurePhase: state === 'FAILED' ? 'RUNNER' : null, failureCode: state === 'FAILED' ? 'ARCHIVE_LOCAL_PARSE_FAILED' : null,
  failureRetryable: state === 'FAILED' ? false : null })

const startApi = async ({ wire, mode = 'MANUAL', denyResult = false, publishDenied = false, loseResponseAt = '', validateAcceptanceFault = '', sourceBytes = Buffer.from('第一章\n正文内容\n', 'utf8'), initialDraft = { blocks: [], excludedSourceRanges: [] }, initialRevision = '0' }) => {
  const source = sourceBytes; const sourceSha = sha(source)
  const calls = []; let runState = 'AUTHORIZED'; let jobState = 'EXECUTION_REQUESTED'; let draft = structuredClone(initialDraft); let revision = initialRevision; let validationId = null; let responseLost = false
  const validationById = new Map(); const validationByRevision = new Map(); const blockOperations = new Map(); const validationOperations = new Map()
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks).toString('utf8')
    calls.push({ method: request.method, url: request.url, body, headers: request.headers })
    const requestUrl = new URL(request.url, 'http://127.0.0.1')
    const path = requestUrl.pathname
    const expectedHeaders = { authorization: `AgentRuntime ${'a'.repeat(32)}`, 'x-agent-id': 'agent-a', 'x-agent-runtime-id': 'runtime-a',
      'x-archive-grant-ref': 'grant-a', 'x-archive-execution-ref': 'execution-a', 'x-archive-command-id': wire.commandId,
      'x-archive-command-attempt': '1', 'x-archive-execution-epoch': '1' }
    for (const [name, value] of Object.entries(expectedHeaders)) assert.equal(request.headers[name], value, name)
    const send = (data, headers = {}, status = 200, envelopeStatus = status) => {
      const bytes = Buffer.from(JSON.stringify({ msg: 'ok', code: 'E0', status: envelopeStatus, data }))
      response.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': bytes.length, ...headers }); response.end(bytes)
    }
    const lose = action => { if (loseResponseAt !== action || responseLost) return false; responseLost = true; response.destroy(); return true }
    if (denyResult && path.endsWith('/result')) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{}'); return }
    if (path.endsWith('/result')) return send(terminalResult(wire, runState, mode, validationId))
    if (path.endsWith('/start')) { assert.deepEqual(JSON.parse(body), { commandId: wire.commandId, messageId: wire.messageId, attempt: '1', executionEpoch: '1' }); runState = 'RUNNING'; jobState = 'RUNNING'; if (lose('start')) return; return send(terminalResult(wire, runState, mode)) }
    if (path.endsWith('/context')) return send({ jobId: 'job-a', runId: wire.payload.runId, collectionId: 'collection-a', workId: 'work-a', operation: 'REVISE_WORK',
      expectedWorkRevision: '4', expectedActiveEditionId: 'edition-old', appointmentId: 'appointment-a', appointmentRevision: '1', agentId: 'agent-a', bindingVersion: '7',
      permissionProfile: mode === 'AUTO' ? 'PUBLISH_VALIDATED' : 'DRAFT_ONLY', publicationMode: mode, state: jobState, waitReason: null,
      requiredSkill: { key: 'archive-maintainer', version: '1.0.0', packageSha256: sha(approved) }, sourceId: 'source-a', sourceSha256: sourceSha,
      sourceSummary: 'fixed source', rightsBasis: 'authorized', draftId: 'draft-a', draftRevision: revision })
    if (path.endsWith('/sources/source-a/content')) { assert.equal(request.headers.accept, 'text/plain'); response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': source.length, 'X-Archive-Source-Sha256': sourceSha }); response.end(source); return }
    if (path.endsWith('/draft') && request.method === 'GET') return send({ draftId: 'draft-a', jobId: 'job-a', revision, state: validationId ? 'VALIDATED' : 'EDITABLE', content: draft,
      contentSha256: 'c'.repeat(64), validatedRevision: validationId ? revision : null, validationId }, { ETag: `"v${revision}"` })
    const blockMatch = /\/blocks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,99})$/u.exec(path)
    if (blockMatch && request.method === 'PUT') {
      const blockKey = blockMatch[1]; const key = request.headers['idempotency-key']; const parsed = JSON.parse(body)
      assert.deepEqual(Object.keys(parsed).sort(), ['blocks', 'excludedSourceRanges'])
      assert.equal(parsed.blocks.length, 1); assert.equal(parsed.blocks[0].blockKey, blockKey)
      assert.match(key, /^archive-block-/); assert.equal(request.headers['if-match'], `"v${revision}"`)
      const prior = blockOperations.get(key)
      if (prior) {
        assert.equal(prior.blockKey, blockKey); assert.deepEqual(prior.body, parsed)
      } else {
        assert.equal(draft.blocks.some(block => block.blockKey === blockKey), false)
        draft = { blocks: [...draft.blocks, parsed.blocks[0]], excludedSourceRanges: parsed.excludedSourceRanges }
        revision = String(BigInt(revision) + 1n); validationId = null
        blockOperations.set(key, { blockKey, body: parsed })
      }
      if (lose('block')) return
      return send({ draftId: 'draft-a', jobId: 'job-a', revision, state: 'EDITABLE', content: draft, contentSha256: 'c'.repeat(64), validatedRevision: null, validationId: null }, { ETag: `"v${revision}"` })
    }
    if (path.endsWith('/validate') && request.method === 'POST') {
      const key = request.headers['idempotency-key']; const expected = `"v${revision}"`
      assert.equal(request.headers['if-match'], expected); assert.match(key, /^archive-validate-/)
      let receipt = validationOperations.get(key)
      if (!receipt) {
        validationId = 'validation-a'
        const validation = { validationId, draftId: 'draft-a', draftRevision: revision, outcome: 'PASSED', validationDigest: 'b'.repeat(64), findings: [] }
        validationById.set(validationId, validation); validationByRevision.set(revision, validation)
        receipt = { operationId: validationId, jobId: 'job-a', state: 'COMMITTED' }; validationOperations.set(key, receipt)
        jobState = 'AWAITING_PUBLISH'; if (mode === 'MANUAL') runState = 'COMPLETED'
      }
      if (lose('validate')) return
      if (loseResponseAt === 'validate-body' && !responseLost) {
        responseLost = true
        const location = `/internal/archive/v1/jobs/job-a/runs/${wire.payload.runId}/validation?operationId=${receipt.operationId}`
        const bytes = Buffer.from(JSON.stringify({ msg: 'ok', code: 'E0', status: 202, data: receipt }))
        response.writeHead(202, { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': bytes.length, Location: location })
        response.flushHeaders()
        response.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))))
        setImmediate(() => response.destroy())
        return
      }
      const responseReceipt = validateAcceptanceFault === 'receipt' ? { ...receipt, draftId: 'draft-a' } : receipt
      const responseLocation = validateAcceptanceFault === 'location'
        ? `/internal/archive/v1/jobs/job-a/runs/${wire.payload.runId}/validation?operationId=validation-other`
        : `/internal/archive/v1/jobs/job-a/runs/${wire.payload.runId}/validation?operationId=${receipt.operationId}`
      return send(responseReceipt, { Location: responseLocation }, 202, validateAcceptanceFault === 'envelope' ? 200 : 202)
    }
    if (path.endsWith('/validation') && request.method === 'GET') {
      const operationIds = requestUrl.searchParams.getAll('operationId')
      assert.equal([...requestUrl.searchParams.keys()].every(key => key === 'operationId'), true)
      assert.ok(operationIds.length <= 1)
      const validation = operationIds.length === 1 ? validationById.get(operationIds[0]) : validationByRevision.get(revision)
      if (!validation) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{}'); return }
      return send(validation)
    }
    if (path.endsWith('/publish')) {
      assert.equal(mode, 'AUTO'); assert.equal(request.headers['if-match'], `"v${revision}"`)
      assert.deepEqual(JSON.parse(body), { validationId: 'validation-a', expectedActiveEditionId: 'edition-old', expectedWorkRevision: '4' })
      if (publishDenied) { response.writeHead(409, { 'Content-Type': 'application/json' }); response.end('{}'); return }
      runState = 'COMPLETED'; jobState = 'PUBLISHED'
      if (lose('publish')) return
      return send({ publicationId: 'publication-a', jobId: 'job-a', workId: 'work-a', editionId: 'edition-a', draftRevision: revision, manifestSha256: 'd'.repeat(64), sourceSha256: sourceSha, state: 'PUBLISHED', readbackState: 'VERIFIED' })
    }
    if (path.endsWith('/failure')) {
      const failure = JSON.parse(body)
      assert.equal(failure.retryable, false); assert.ok(['RUNNER', 'VALIDATION'].includes(failure.phase))
      runState = 'FAILED'; jobState = 'FAILED'; if (lose('failure')) return; return send(terminalResult(wire, runState, mode))
    }
    response.writeHead(404); response.end()
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  return { calls, currentValidationAvailable: () => validationByRevision.has(revision), close: () => new Promise(resolvePromise => server.close(resolvePromise)), wsUrl: `ws://127.0.0.1:${server.address().port}/ws` }
}

for (const mode of ['MANUAL', 'AUTO']) test(`approved package runner follows authenticated ${mode} lifecycle without Codex or shell fallback`, async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire(); const api = await startApi({ wire, mode })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl, authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    let codex = 0
    const outcome = await runManagedCommand({ profile, message: wire, platformSkillRuntime: { execute: message => runner.execute(message) },
      skillInstallManager: { execute: async () => assert.fail('legacy install path') }, runCodexFn: async () => { codex++; return { status: 'completed' } } })
    assert.equal(outcome.status, 'completed', outcome.errorMessage)
    assert.equal(codex, 0)
    assert.equal(api.calls.filter(call => /\/blocks\/chapter-1$/u.test(call.url) && call.method === 'PUT').length, 1)
    assert.equal(api.calls.filter(call => call.url.endsWith('/draft') && call.method === 'PUT').length, 0)
    assert.equal(api.calls.filter(call => call.url.includes('/draft/blocks/')).length, 0)
    assert.equal(api.calls.filter(call => call.url.endsWith('/validate') && call.method === 'POST').length, 1)
    assert.equal(api.calls.filter(call => call.url.endsWith('/validation?operationId=validation-a') && call.method === 'GET').length, 1)
    assert.equal(api.calls.filter(call => call.url.endsWith('/publish')).length, mode === 'AUTO' ? 1 : 0)
    if (mode === 'AUTO') assert.deepEqual(JSON.parse(api.calls.find(call => call.url.endsWith('/publish')).body), { validationId: 'validation-a', expectedActiveEditionId: 'edition-old', expectedWorkRevision: '4' })
    assert.equal(runner.reconcileCommandOutcome(wire)?.authoritative, true)
  } finally { await api.close() }
})

test('routed processor keeps unknown native result nonterminal in the single inbox and ledger', async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire(); const api = await startApi({ wire, denyResult: true })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl, authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    const inbox = new PersistentCommandInbox({ rootDir: resolve(root, 'inbox'), profile, successPolicy: 'archive' })
    const stateRoot = resolve(root, 'inbox', Buffer.from(profile.agentId).toString('hex'))
    const ledger = new DurableDedupeLedger({ rootDir: stateRoot, profile }); const ackOutbox = new AckOutbox({ rootDir: stateRoot, profile })
    ledger.initialize(); ackOutbox.initialize()
    const processor = new AgentMessageProcessor({ profile, inbox, ledger, ackOutbox, runChat: async () => {}, sendFn: () => true,
      runCommand: message => runManagedCommand({ profile, message, platformSkillRuntime: { execute: value => runner.execute(value) }, skillInstallManager: {}, runCodexFn: async () => assert.fail('Codex fallback') }) })
    processor.start(); await processor.handle(wire); await processor.waitForIdle()
    assert.equal(api.calls.filter(call => call.url.endsWith('/start') && call.method === 'POST').length, 1)
    assert.equal(api.calls.filter(call => call.url.endsWith('/result') && call.method === 'GET').length, 2)
    assert.equal(api.calls.some(call => call.url.endsWith('/context')), true)
    assert.equal(inbox.count('recovery'), 1); assert.equal(inbox.count('archive'), 0)
    assert.equal(ledger.getEntry(wire.commandId).status, 'RECOVERY_REQUIRED')
  } finally { await api.close() }
})

test('routed processor preserves a different human revision and leaves the command nonterminal', async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire()
  const humanDraft = { blocks: [{ blockType: 'CHAPTER', blockKey: 'chapter-human', ordinal: 9, title: '人工编辑', titleSourceRanges: [], paragraphs: [] }], excludedSourceRanges: [] }
  const api = await startApi({ wire, initialDraft: humanDraft, initialRevision: '2' })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl, authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    const inbox = new PersistentCommandInbox({ rootDir: resolve(root, 'inbox'), profile, successPolicy: 'archive' })
    const stateRoot = resolve(root, 'inbox', Buffer.from(profile.agentId).toString('hex'))
    const ledger = new DurableDedupeLedger({ rootDir: stateRoot, profile }); const ackOutbox = new AckOutbox({ rootDir: stateRoot, profile })
    ledger.initialize(); ackOutbox.initialize()
    const processor = new AgentMessageProcessor({ profile, inbox, ledger, ackOutbox, runChat: async () => {}, sendFn: () => true,
      runCommand: message => runManagedCommand({ profile, message, platformSkillRuntime: { execute: value => runner.execute(value) }, skillInstallManager: {}, runCodexFn: async () => assert.fail('Codex fallback') }) })
    processor.start(); await processor.handle(wire); await processor.waitForIdle()
    assert.equal(api.calls.filter(call => call.url.endsWith('/context') && call.method === 'GET').length, 1)
    assert.equal(api.calls.filter(call => call.url.endsWith('/sources/source-a/content') && call.method === 'GET').length, 1)
    assert.equal(api.calls.filter(call => call.url.endsWith('/draft') && call.method === 'GET').length, 1)
    assert.equal(api.calls.filter(call => call.url.endsWith('/draft') && call.method === 'PUT').length, 0)
    assert.equal(inbox.count('recovery'), 1); assert.equal(ledger.getEntry(wire.commandId).status, 'RECOVERY_REQUIRED')
  } finally { await api.close() }
})

test('a disconnected runner cannot replay its cached terminal result through routed execution or reconciliation', async () => {
  const wire = archiveWire(); const controller = new AbortController()
  const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: 'ws://127.0.0.1:1/ws', authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`,
    platformSkillManager: {}, sessionSignal: controller.signal, nativeClientFactory: () => ({ result: async () => terminalResult(wire, 'COMPLETED', 'MANUAL', 'validation-a') }) })
  const route = () => runManagedCommand({ profile, message: wire, platformSkillRuntime: { execute: value => runner.execute(value) },
    skillInstallManager: {}, runCodexFn: async () => assert.fail('Codex fallback') })
  assert.equal((await route()).status, 'completed')
  assert.equal(runner.reconcileCommandOutcome(wire)?.authoritative, true)
  controller.abort(new Error('registration rotated'))
  assert.equal((await route()).status, 'recovery_required')
  assert.equal(runner.reconcileCommandOutcome(wire), null)
})

test('explicit AUTO publish denial remains nonterminal and is not retried', async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire(); const api = await startApi({ wire, mode: 'AUTO', publishDenied: true })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl, authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    const outcome = await runManagedCommand({ profile, message: wire, platformSkillRuntime: { execute: message => runner.execute(message) },
      skillInstallManager: {}, runCodexFn: async () => assert.fail('Codex fallback') })
    assert.equal(outcome.status, 'recovery_required')
    assert.equal(api.calls.filter(call => call.url.endsWith('/publish')).length, 1)
  } finally { await api.close() }
})

for (const scenario of ['completed', 'failed']) test(`routed processor persists authoritative archive ${scenario} terminal status`, async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire()
  const api = await startApi({ wire, mode: 'MANUAL', ...(scenario === 'failed' ? { sourceBytes: Buffer.from('正文内容\n', 'utf8') } : {}) })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl, authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    const inbox = new PersistentCommandInbox({ rootDir: resolve(root, 'inbox'), profile, successPolicy: 'archive' })
    const stateRoot = resolve(root, 'inbox', Buffer.from(profile.agentId).toString('hex'))
    const ledger = new DurableDedupeLedger({ rootDir: stateRoot, profile }); const ackOutbox = new AckOutbox({ rootDir: stateRoot, profile })
    ledger.initialize(); ackOutbox.initialize()
    const processor = new AgentMessageProcessor({ profile, inbox, ledger, ackOutbox, runChat: async () => {}, sendFn: () => true,
      runCommand: message => runManagedCommand({ profile, message, platformSkillRuntime: { execute: value => runner.execute(value) }, skillInstallManager: {}, runCodexFn: async () => assert.fail('Codex fallback') }) })
    processor.start(); await processor.handle(wire); await processor.waitForIdle()
    assert.equal(inbox.count('archive'), 1); assert.equal(inbox.count('recovery'), 0)
    assert.equal(ledger.getEntry(wire.commandId).status, scenario === 'completed' ? 'SUCCEEDED' : 'FAILED')
    assert.equal(api.calls.some(call => call.url.endsWith('/publish')), false)
    assert.equal(api.calls.filter(call => call.url.endsWith('/failure')).length, scenario === 'failed' ? 1 : 0)
  } finally { await api.close() }
})

for (const scenario of [
  { action: 'start', mode: 'MANUAL', expected: 'completed' },
  { action: 'block', mode: 'MANUAL', expected: 'completed' },
  { action: 'validate', mode: 'MANUAL', expected: 'completed' },
  { action: 'publish', mode: 'AUTO', expected: 'completed' },
  { action: 'failure', mode: 'MANUAL', expected: 'failed', sourceBytes: Buffer.from('正文内容\n', 'utf8') }
]) test(`lost ${scenario.action} response recovers from authoritative HTTP state without a second producer write`, async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire()
  const api = await startApi({ wire, mode: scenario.mode, loseResponseAt: scenario.action, ...(scenario.sourceBytes ? { sourceBytes: scenario.sourceBytes } : {}) })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl, authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    const outcome = await runManagedCommand({ profile, message: wire, platformSkillRuntime: { execute: message => runner.execute(message) },
      skillInstallManager: {}, runCodexFn: async () => assert.fail('Codex fallback') })
    assert.equal(outcome.status, scenario.expected, outcome.errorMessage)
    const method = scenario.action === 'block' ? 'PUT' : 'POST'
    const matching = scenario.action === 'block'
      ? api.calls.filter(call => /\/blocks\/chapter-1$/u.test(call.url) && call.method === method)
      : api.calls.filter(call => call.url.endsWith(`/${scenario.action}`) && call.method === method)
    assert.equal(matching.length, 1)
    if (scenario.action === 'validate') {
      assert.equal(api.calls.filter(call => call.url.endsWith('/validation') && call.method === 'GET').length, 1)
      assert.equal(api.calls.some(call => call.url.includes('/validation?operationId=')), false)
    }
  } finally { await api.close() }
})

test('truncated accepted validate response body recovers from current validation without retrying the producer POST', async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire()
  const api = await startApi({ wire, mode: 'MANUAL', loseResponseAt: 'validate-body' })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl,
      authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    const outcome = await runManagedCommand({ profile, message: wire,
      platformSkillRuntime: { execute: message => runner.execute(message) }, skillInstallManager: {},
      runCodexFn: async () => assert.fail('Codex fallback') })
    assert.equal(outcome.status, 'completed', outcome.errorMessage)
    assert.equal(api.currentValidationAvailable(), true)
    const validatePosts = api.calls.filter(call => call.url.endsWith('/validate') && call.method === 'POST')
    assert.equal(validatePosts.length, 1)
    const expectedKey = `archive-validate-${sha(Buffer.from(`${wire.commandId}\0${wire.payload.runId}\0${wire.payload.executionEpoch}\0validate`))}`
    assert.equal(validatePosts[0].headers['idempotency-key'], expectedKey)
    assert.equal(api.calls.filter(call => call.url.endsWith('/validation') && call.method === 'GET').length, 1)
    assert.equal(api.calls.some(call => call.url.includes('/validation?operationId=')), false)
  } finally { await api.close() }
})

for (const validateAcceptanceFault of ['envelope', 'receipt', 'location']) test(`runner fails closed on received invalid validate ${validateAcceptanceFault} without current-validation fallback or later writes`, async () => {
  const root = temporaryDirectory(); const manager = await installManager(root); const wire = archiveWire()
  const api = await startApi({ wire, mode: 'AUTO', validateAcceptanceFault })
  try {
    const runner = new ArchiveMaintenanceRunner({ runtimeScope, wsUrl: api.wsUrl,
      authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, platformSkillManager: manager })
    const outcome = await runManagedCommand({ profile, message: wire,
      platformSkillRuntime: { execute: message => runner.execute(message) }, skillInstallManager: {},
      runCodexFn: async () => assert.fail('Codex fallback') })
    assert.equal(outcome.status, 'recovery_required')
    assert.equal(api.currentValidationAvailable(), true)
    const validateIndex = api.calls.findIndex(call => call.url.endsWith('/validate') && call.method === 'POST')
    assert.notEqual(validateIndex, -1)
    assert.equal(api.calls.filter(call => call.url.includes('/validation') && call.method === 'GET').length, 0)
    assert.equal(api.calls.filter(call => call.url.endsWith('/publish') && call.method === 'POST').length, 0)
    assert.equal(api.calls.filter(call => call.url.endsWith('/failure') && call.method === 'POST').length, 0)
    assert.deepEqual(api.calls.slice(validateIndex + 1), [])
  } finally { await api.close() }
})

test('native validate requires strict 202 receipt, scoped Location and matching 200 result identity', async () => {
  const now = Date.now(); const wire = archiveWire({ now })
  const command = validateArchiveMaintenanceCommand(wire, runtimeScope, now)
  const receipt = { operationId: 'validation-a', jobId: 'job-a', state: 'COMMITTED' }
  const validation = { validationId: 'validation-a', draftId: 'draft-a', draftRevision: '1', outcome: 'PASSED', validationDigest: 'b'.repeat(64), findings: [] }
  const response = (url, httpStatus, envelopeStatus, data, headers = {}) => {
    const bytes = Buffer.from(JSON.stringify({ msg: 'ok', code: 'E0', status: envelopeStatus, data }))
    return { redirected: false, url: url.href, status: httpStatus,
      headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': String(bytes.length), ...headers }), body: new Response(bytes).body }
  }
  const invoke = async responder => {
    let call = 0
    const client = new ArchiveMaintenanceNativeClient({ runtimeScope, wsUrl: 'ws://127.0.0.1:18080/ws',
      authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`,
      fetchFn: async (url, options) => responder(++call, url, options), now: () => now })
    return client.validate(command, 'draft-a', '1', 'validate-key')
  }
  const location = '/internal/archive/v1/jobs/job-a/runs/run-a/validation?operationId=validation-a'

  await assert.rejects(invoke(async (call, url) => {
    assert.equal(call, 1)
    return response(url, 200, 200, validation)
  }), error => error?.code === 'ARCHIVE_NATIVE_DENIED' && error?.status === 200)

  for (const malformed of [
    { name: 'envelope status', receipt, envelopeStatus: 200, location },
    { name: 'receipt keys', receipt: { ...receipt, draftId: 'draft-a' }, envelopeStatus: 202, location },
    { name: 'Location operation', receipt, envelopeStatus: 202,
      location: '/internal/archive/v1/jobs/job-a/runs/run-a/validation?operationId=validation-other' }
  ]) {
    await assert.rejects(invoke(async (call, url) => {
      assert.equal(call, 1, malformed.name)
      return response(url, 202, malformed.envelopeStatus, malformed.receipt, { Location: malformed.location })
    }), error => error?.code === 'ARCHIVE_NATIVE_RESPONSE_INVALID'
      && error?.uncertainty === 'DEFINITE' && error?.uncertain === false)
  }

  for (const mismatched of [
    { ...validation, validationId: 'validation-other' },
    { ...validation, draftId: 'draft-other' },
    { ...validation, draftRevision: '2' }
  ]) {
    await assert.rejects(invoke(async (call, url, options) => {
      if (call === 1) return response(url, 202, 202, receipt, { Location: location })
      assert.equal(call, 2); assert.equal(options.method, 'GET')
      assert.equal(url.searchParams.get('operationId'), 'validation-a')
      return response(url, 200, 200, mismatched)
    }), error => error?.code === 'ARCHIVE_NATIVE_RESPONSE_INVALID'
      && error?.operationId === 'validation-a' && error?.uncertainty === 'DEFINITE'
      && error?.uncertain === false)
  }
})

test('expired producer authority cannot write while the exact terminal result remains readable', async () => {
  const wire = archiveWire({ now: Date.now() - 120000 })
  const command = validateArchiveMaintenanceCommand(wire, runtimeScope, Date.now(), { allowExpired: true })
  let fetches = 0
  const client = new ArchiveMaintenanceNativeClient({ runtimeScope, wsUrl: 'ws://127.0.0.1:18080/ws',
    authorizationProvider: () => `AgentRuntime ${'a'.repeat(32)}`, fetchFn: async (url, options) => {
      fetches += 1; assert.equal(options.method, 'GET')
      const data = url.pathname.endsWith('/result')
        ? terminalResult(wire, 'COMPLETED', 'MANUAL', 'validation-a')
        : { validationId: 'validation-a', draftId: 'draft-a', draftRevision: '1', outcome: 'PASSED', validationDigest: 'b'.repeat(64), findings: [] }
      assert.equal(url.pathname.endsWith('/result') || url.pathname.endsWith('/validation'), true)
      const bytes = Buffer.from(JSON.stringify({ msg: 'ok', code: 'E0', status: 200, data }))
      return { redirected: false, url: url.href, status: 200, headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) }), body: new Response(bytes).body }
    }, now: () => Date.now() })
  assert.equal((await client.result(command)).runState, 'COMPLETED')
  assert.equal((await client.validation(command, 'validation-a')).outcome, 'PASSED')
  await assert.rejects(client.start(command), error => error?.code === 'ARCHIVE_EXECUTION_EXPIRED')
  assert.equal(fetches, 2)
})
