// Private V0 hosting admission in the existing runner. No public callbacks or shell commands.
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, mkdirSync, lstatSync,
  realpathSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'

export const MAX_HOST_FRAME = 16384
const MAX_FILE = 65536
const fields = ['tenantId', 'clientId', 'ownerJiacn', 'agentId', 'intentId', 'leaseId', 'bindingId',
  'reservedAt', 'operationId', 'requestedAt', 'validUntil']
const exact = (value, max = 100) => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value) <= max && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value)
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
const exists = path => {
  try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const association = request => Object.fromEntries(fields.slice(0, 8).map(key => [key, request[key]]))
const operation = request => Object.fromEntries(fields.map(key => [key, request[key]]))
const unknown = request => ({ protocol: '1', ...operation(request), outcome: 'UNKNOWN' })

export function validateHostingRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).length !== fields.length + 3 ||
      Object.keys(request).some(key => ![...fields, 'protocol', 'method', 'apiKey'].includes(key)) ||
      request.protocol !== '1' || !['ensure', 'observe'].includes(request.method) ||
      !fields.slice(0, 7).every(key => exact(request[key], ['tenantId', 'clientId'].includes(key) ? 50 : 100)) ||
      !/^agt_[0-9a-f]{32}$/.test(request.agentId) || !/^hri_[0-9a-f-]{36}$/.test(request.intentId) ||
      !/^hrl_[0-9a-f-]{36}$/.test(request.leaseId) || !positive(request.bindingId) ||
      !positive(request.reservedAt) || !positive(request.requestedAt) ||
      BigInt(request.requestedAt) < BigInt(request.reservedAt) ||
      !(request.validUntil === null || positive(request.validUntil)) ||
      !(request.operationId === request.intentId || /^hrr-[0-9a-f-]{36}$/.test(request.operationId)) ||
      !exact(request.apiKey, 256) ||
      (request.operationId === request.intentId ? request.validUntil !== null || request.requestedAt !== request.reservedAt
        : request.validUntil === null || BigInt(request.validUntil) <= BigInt(request.requestedAt))) {
    throw new Error('Invalid private hosting request')
  }
  return request
}

// Parent roots are operator-created, private and canonical; never repair permissions or follow symlinks.
export function requirePrivateDirectory(path, allowGroupRead = false) {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('Managed root must be canonical')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & (allowGroupRead ? 0o027 : 0o077))) {
    throw new Error('Managed root permissions/owner are unsafe')
  }
}
function directory(path) {
  try { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)) } catch (e) { if (e.code !== 'EEXIST') throw e }
  requirePrivateDirectory(path)
}
function syncDirectory(path) { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
function readPrivate(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > MAX_FILE) throw new Error('Unsafe managed file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return readFileSync(fd, 'utf8') } finally { closeSync(fd) }
}
function atomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, path); syncDirectory(dirname(path))
}

/** No model turn: initialize a real execution-engine session with the same binary/home/cwd as exec.
 * Kept alive while registered; process exit clears readiness. Bounded stdio child, not another service.
 * Codex app-server: initialize -> initialized -> account/read -> thread/start (never turn/start).
 */
export function initializeHostingEngine(profile, { spawnFn = spawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolveEngine, reject) => {
    const child = spawnFn(profile.codexBin, ['app-server'], {
      cwd: profile.codexWorkdir, env: { ...process.env, CODEX_HOME: profile.codexHome },
      stdio: ['pipe', 'pipe', 'pipe'], shell: false
    })
    const engine = { ready: false, closed: false, threadId: null, close: () => child.kill('SIGTERM') }
    let buffer = ''; let bytes = 0; let settled = false
    const fail = () => {
      engine.ready = false
      clearTimeout(timer)
      if (!settled) {
        settled = true
        const error = new Error('Managed execution engine initialization unknown')
        error.engine = engine
        reject(error)
      }
      child.kill('SIGTERM')
    }
    const timer = setTimeout(fail, timeoutMs)
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.on('error', () => { engine.closed = true; fail() })
    child.on('exit', () => { engine.ready = false; engine.closed = true; if (!settled) fail() })
    child.stdin.on('error', fail)
    child.stderr.on('data', data => { bytes += data.length; if (bytes > 1024 * 1024) fail() })
    child.stdout.on('data', data => {
      bytes += data.length
      if (bytes > 1024 * 1024) { fail(); return }
      buffer += data.toString('utf8')
      if (Buffer.byteLength(buffer) > MAX_FILE) { fail(); return }
      while (buffer.includes('\n')) {
        const split = buffer.indexOf('\n'); const line = buffer.slice(0, split); buffer = buffer.slice(split + 1)
        try {
          const reply = JSON.parse(line)
          if (reply.error || reply.method && reply.id != null) { fail(); return } // No server approval request may be answered.
          if (reply.id === 1 && reply.result && !settled) {
            send({ method: 'initialized', params: {} })
            send({ id: 2, method: 'account/read', params: { refreshToken: false } })
          } else if (reply.id === 2 && reply.result && !settled) {
            if (!reply.result.account && reply.result.requiresOpenaiAuth !== false) { fail(); return }
            send({ id: 3, method: 'thread/start', params: { cwd: profile.codexWorkdir,
              approvalPolicy: 'never', sandbox: 'workspace-write', ...(profile.codexModel ? { model: profile.codexModel } : {}) } })
          } else if (reply.id === 3 && !settled) {
            if (!exact(reply.result?.thread?.id)) { fail(); return }
            engine.threadId = reply.result.thread.id; engine.ready = true; settled = true; clearTimeout(timer)
            resolveEngine(engine)
          }
        } catch { fail(); return }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cyf_managed_host', version: '1.0.0' } } })
  })
}

/** Trust only the successful server registration on the current socket for this managed profile. */
export function managedRegistration(frame, profile, runtimeInstanceId) {
  const payload = frame?.data || frame
  return frame?.type === 'agent_registered' && payload?.agentId === profile.agentId &&
    payload?.runtimeInstanceId === runtimeInstanceId && payload?.status === 'online' && exact(payload?.token, 512)
}

export class ManagedHost {
  constructor({ root, templateHome, codexBin, runtimeInstanceId, tenantId, clientId, ownerJiacn,
    attachProfile, profileState, conflicts, workspacePolicyId, initializeEngine = initializeHostingEngine, maxProfiles = 64, now = Date.now }) {
    this.root = root; this.templateHome = templateHome; this.codexBin = codexBin
    this.runtimeInstanceId = runtimeInstanceId; this.tenantId = tenantId; this.clientId = clientId; this.ownerJiacn = ownerJiacn
    this.workspacePolicyId = workspacePolicyId
    this.attachProfile = attachProfile; this.profileState = profileState; this.conflicts = conflicts
    this.initializeEngine = initializeEngine; this.maxProfiles = maxProfiles; this.now = now
    this.inflight = new Map(); this.engines = new Map(); this.closed = false
  }
  async handle(raw) {
    const request = validateHostingRequest(raw)
    if (this.closed || request.tenantId !== this.tenantId || request.clientId !== this.clientId || request.ownerJiacn !== this.ownerJiacn) return unknown(request)
    if (request.method === 'observe') return this.observe(request)
    const key = request.agentId
    if (this.inflight.has(key)) return unknown(request) // Durable state, not parallel creation.
    if (this.inflight.size >= 16) return unknown(request)
    const action = this.ensure(request).catch(() => unknown(request)).finally(() => this.inflight.delete(key))
    this.inflight.set(key, action)
    return action
  }
  paths(request) {
    const agentRoot = resolve(this.root, request.agentId)
    const generationRoot = resolve(agentRoot, request.intentId)
    return { agentRoot, generationRoot, manifest: resolve(generationRoot, 'association.json'),
      journal: resolve(generationRoot, `${request.operationId}.json`),
      home: resolve(generationRoot, 'home'), workdir: resolve(generationRoot, 'work') }
  }
  read(request) {
    const paths = this.paths(request)
    for (const dir of [this.root, paths.agentRoot, paths.generationRoot]) requirePrivateDirectory(dir)
    const manifest = JSON.parse(readPrivate(paths.manifest))
    if (digest(manifest.association) !== digest(association(request)) || manifest.apiKeyHash !== digest(request.apiKey)) throw new Error('Managed association mismatch')
    const journal = exists(paths.journal) ? JSON.parse(readPrivate(paths.journal)) : null
    if (journal && (digest(journal.operation) !== digest(operation(request)) ||
        (!journal.result && journal.state !== 'STARTED'))) throw new Error('Managed operation mismatch')
    return { paths, manifest, journal }
  }
  observe(request) {
    try {
      const { journal } = this.read(request)
      if (!journal?.result) return unknown(request)
      // Durable historical success proves that this exact operation was once ready, even across restart.
      // A NEW free operation must initialize/register again; it cannot use another operation's receipt.
      return journal.result
    } catch { return unknown(request) }
  }
  async ensure(request) {
    requirePrivateDirectory(this.root)
    const paths = this.paths(request)
    const existingGeneration = exists(paths.manifest)
    // Never adopt an unassociated directory or infer that an interrupted manifest write was harmless.
    if (!existingGeneration && exists(paths.generationRoot)) return unknown(request)
    if (existingGeneration) {
      const prior = this.read(request)
      if (prior.journal?.result) return prior.journal.result
    }
    // Expiry does not imply no-effect: an earlier attempt may have taken effect.
    if (request.validUntil !== null && BigInt(request.validUntil) <= BigInt(this.now())) return unknown(request)
    if (this.conflicts(request.agentId, request.intentId) || (!this.engines.has(request.agentId) && this.engines.size >= this.maxProfiles)) return unknown(request)
    directory(paths.agentRoot); directory(paths.generationRoot)
    if (!existingGeneration) atomic(paths.manifest, JSON.stringify({ association: association(request), apiKeyHash: digest(request.apiKey) }))
    let { journal } = this.read(request)
    if (!journal) {
      // Only a preflight error before STARTED can produce confirmed no-effect. Persist the decision first.
      try {
        requirePrivateDirectory(this.templateHome)
        if (!isAbsolute(this.codexBin) || !lstatSync(this.codexBin).isFile() || !(lstatSync(this.codexBin).mode & 0o111)) throw new Error('Invalid engine executable')
        for (const name of ['config.toml', 'auth.json']) readPrivate(resolve(this.templateHome, name))
      } catch {
        const result = { ...unknown(request), outcome: 'FAILED_NO_EFFECT', evidenceRef: `mh:${digest(operation(request))}:noeffect` }
        atomic(paths.journal, JSON.stringify({ operation: operation(request), result }))
        return result
      }
      journal = { operation: operation(request), state: 'STARTED' }
      atomic(paths.journal, JSON.stringify(journal)) // MUST be durable before profile/engine/socket effects.
    }
    directory(paths.home); directory(paths.workdir)
    for (const name of ['config.toml', 'auth.json']) {
      const target = resolve(paths.home, name)
      // Never replace an existing engine-owned file, even after an interrupted attempt.
      if (!exists(target)) atomic(target, readPrivate(resolve(this.templateHome, name)))
      else readPrivate(target)
    }
    const profile = { profileId: `managed:${request.agentId}:${request.intentId}`, agentId: request.agentId,
      agentName: request.agentId, personaName: request.agentId, apiKey: request.apiKey, codexBin: this.codexBin,
      codexHome: paths.home, codexWorkdir: paths.workdir, codexSandbox: 'workspace-write', codexApproval: 'never',
      codexSessionMode: 'new', codexTimeoutMs: 900000, abilities: [], skills: [], enabled: true,
      managedGeneration: request.intentId, managedProfileRef: `${request.agentId}/${request.intentId}`,
      workspacePolicyId: this.workspacePolicyId, workspaceRole: 'coder', workspaceNoTaskPolicy: 'reject', workspaceNonCodingCommandTypes: [] }
    let engine = this.engines.get(request.agentId)
    if (!engine?.ready) {
      // An engine with unknown termination must not be duplicated on retry.
      if (engine && !engine.closed) return unknown(request)
      try { engine = await this.initializeEngine(profile) } catch (error) {
        if (error.engine) this.engines.set(request.agentId, error.engine)
        throw error
      }
      if (this.closed) { engine.close(); return unknown(request) }
      this.engines.set(request.agentId, engine)
    }
    if (!engine.ready) return unknown(request)
    if (request.validUntil !== null && BigInt(request.validUntil) <= BigInt(this.now())) return unknown(request)
    await this.attachProfile(profile, engine)
    const state = this.profileState(request.agentId)
    if (!engine.ready || !state?.registered || state.generation !== request.intentId || state.runtimeInstanceId !== this.runtimeInstanceId) return unknown(request)
    if (BigInt(this.now()) < BigInt(request.requestedAt)) return unknown(request)
    const serviceReadyAt = String(this.now())
    const result = { ...unknown(request), outcome: 'SERVICE_READY', serviceReadyAt,
      runtimeInstanceId: this.runtimeInstanceId, engineThreadId: engine.threadId,
      profileRef: profile.managedProfileRef, evidenceRef: `mh:${digest(operation(request))}:ready` }
    atomic(paths.journal, JSON.stringify({ operation: operation(request), result }))
    return result
  }
  close() { this.closed = true; for (const engine of this.engines.values()) engine.close() }
}

/** Single restricted channel owned by the existing runner. Start only with explicit release config. */
export async function startManagedHostSocket({ socketPath, host, timeoutMs = 20000 }) {
  requirePrivateDirectory(dirname(socketPath), true)
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100 || exists(socketPath)) throw new Error('Managed socket path unavailable; never steal another runner socket')
  const sockets = new Set()
  const server = createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return }
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    socket.setTimeout(timeoutMs, () => socket.destroy())
    let data = Buffer.alloc(0); let dispatched = false
    socket.on('data', chunk => {
      if (dispatched) { socket.destroy(); return }
      data = Buffer.concat([data, chunk])
      if (data.length > MAX_HOST_FRAME) { socket.destroy(); return }
      const newline = data.indexOf(10)
      if (newline < 0) return
      if (newline !== data.length - 1) { socket.destroy(); return }
      dispatched = true
      let request
      try { request = validateHostingRequest(JSON.parse(data.subarray(0, newline).toString('utf8'))) } catch { socket.destroy(); return }
      void host.handle(request).then(result => {
        const frame = `${JSON.stringify(result)}\n`
        if (Buffer.byteLength(frame) <= MAX_HOST_FRAME && !socket.destroyed) socket.end(frame)
        else socket.destroy()
      }).catch(() => socket.destroy())
    })
  })
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(socketPath, resolveListen) })
    chmodSync(socketPath, 0o660)
  } catch (error) {
    host.close(); for (const socket of sockets) socket.destroy()
    server.close()
    throw error
  }
  const inode = lstatSync(socketPath).ino
  return { close: () => {
    host.close(); for (const socket of sockets) socket.destroy()
    server.close(() => {
      // Node normally removes its own UDS; never remove a replacement owned by another process.
      if (exists(socketPath) && lstatSync(socketPath).ino === inode) unlinkSync(socketPath)
    })
  } }
}

export function preserveManagedProfiles(previous, next) {
  const managed = previous.filter(profile => profile.managedGeneration)
  for (const profile of managed) {
    if (next.some(candidate => candidate.agentId === profile.agentId ||
        resolve(candidate.codexHome || '.') === profile.codexHome ||
        resolve(candidate.codexHome || '.').startsWith(`${profile.codexHome}/`) ||
        profile.codexHome.startsWith(`${resolve(candidate.codexHome || '.')}/`))) {
      throw new Error('Legacy reload conflicts with a managed profile; no profiles changed')
    }
  }
  return [...next, ...managed]
}
