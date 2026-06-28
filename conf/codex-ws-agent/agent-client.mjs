import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, accessSync, constants as fsConstants, readdirSync, statSync, watchFile, unwatchFile } from 'node:fs'
import { resolve } from 'node:path'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

const parseNonNegativeMs = (value, fallback) => {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const DISABLED_PROFILE_STATUSES = new Set(['disabled', 'inactive', 'unavailable'])

const hasFlag = (flag) => process.argv.slice(2).includes(flag)

const canExecute = (targetPath) => {
  try {
    accessSync(targetPath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

const resolveExecutable = (command) => {
  const value = String(command || '').trim()
  if (!value) return ''
  if (value.includes('/')) {
    return canExecute(value) ? value : ''
  }

  const searchPaths = String(process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of searchPaths) {
    const candidate = resolve(dir, value)
    if (canExecute(candidate)) return candidate
  }
  return ''
}

const parseScalarValue = (rawValue) => {
  const value = String(rawValue || '').trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

const configError = (message, exitOnError = true) => {
  if (exitOnError) {
    console.error(message)
    process.exit(1)
  }
  throw new Error(message)
}

const parseSectionProfiles = (raw, fallbackProfile, options = {}) => {
  const exitOnError = options.exitOnError !== false
  const profiles = []
  let current = null
  let defaults = {}

  for (const originalLine of String(raw).split(/\r?\n/)) {
    const line = originalLine.trim()
    if (!line || line.startsWith('#')) continue

    if (/^\[(default|profile\.default|agent\.default)\]$/.test(line)) {
      if (current) profiles.push(current)
      current = { __section: 'default' }
      continue
    }

    const sectionMatch = line.match(/^\[(agent|profile)\.([^\]]+)\]$/)
    if (sectionMatch) {
      if (current) profiles.push(current)
      current = {
        profileId: sectionMatch[2]
      }
      continue
    }

    if (!current) continue

    const index = line.indexOf('=')
    if (index < 0) continue

    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    current[key] = parseScalarValue(value)
  }

  if (current) profiles.push(current)

  const defaultIndex = profiles.findIndex(profile => profile.__section === 'default')
  if (defaultIndex >= 0) {
    defaults = { ...profiles[defaultIndex] }
    delete defaults.__section
    profiles.splice(defaultIndex, 1)
  }

  if (!profiles.length) {
    configError('CODEX_PROFILES_FILE section format is empty or invalid', exitOnError)
  }

  return profiles.map((profile, index) => normalizeProfile({ ...defaults, ...profile }, fallbackProfile, index))
}

const normalizeProfile = (profile, fallback = {}, index = 0) => {
  const agentId = profile.agentId || fallback.agentId || `local-codex-${index + 1}`
  const status = String(profile.status || fallback.status || '').trim().toLowerCase()
  const enabled = profile.enabled !== false
    && profile.active !== false
    && !DISABLED_PROFILE_STATUSES.has(status)
  return {
    profileId: profile.profileId || agentId,
    agentId,
    agentName: profile.agentName || fallback.agentName || `本地 Codex ${index + 1}`,
    personaName: profile.personaName || fallback.personaName || profile.agentName || fallback.agentName || `Codex ${index + 1}`,
    apiKey: profile.apiKey || fallback.apiKey || '',
    codexBin: profile.codexBin || fallback.codexBin || 'codex',
    codexHome: profile.codexHome || fallback.codexHome || '',
    codexWorkdir: profile.codexWorkdir || fallback.codexWorkdir || process.cwd(),
    codexSandbox: profile.codexSandbox || fallback.codexSandbox || 'workspace-write',
    codexApproval: profile.codexApproval || fallback.codexApproval || 'never',
    codexSessionMode: profile.codexSessionMode || fallback.codexSessionMode || 'new',
    codexTimeoutMs: parseNonNegativeMs(profile.codexTimeoutMs, fallback.codexTimeoutMs || 900000),
    enabled,
    status,
    isDefault: profile.isDefault === true
  }
}

const loadProfilesRaw = (options = {}) => {
  const exitOnError = options.exitOnError !== false
  const profilesFile = process.env.CODEX_PROFILES_FILE?.trim()
  if (profilesFile) {
    try {
      return readFileSync(resolve(profilesFile), 'utf8')
    } catch (error) {
      configError(`failed to read CODEX_PROFILES_FILE ${profilesFile}: ${error.message}`, exitOnError)
    }
  }

  return process.env.CODEX_PROFILES || ''
}

const parseProfiles = (raw, fallbackProfile, options = {}) => {
  const exitOnError = options.exitOnError !== false
  if (!raw || !String(raw).trim()) return [fallbackProfile]

  const text = String(raw).trim()
  if (/^\[(agent|profile)\./m.test(text)) {
    return parseSectionProfiles(text, fallbackProfile, { exitOnError })
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    configError(`CODEX_PROFILES must be valid JSON: ${error.message}`, exitOnError)
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    configError('CODEX_PROFILES must be a non-empty JSON array', exitOnError)
  }

  return parsed.map((profile, index) => normalizeProfile(profile || {}, fallbackProfile, index))
}

const legacyProfile = normalizeProfile({
  profileId: process.env.CODEX_PROFILE_ID || process.env.AGENT_ID || 'default',
  agentId: process.env.AGENT_ID || 'local-codex',
  agentName: process.env.AGENT_NAME || '本地 Codex',
  personaName: process.env.AGENT_PERSONA || '吴用',
  codexBin: process.env.CODEX_BIN || 'codex',
  codexHome: process.env.CODEX_HOME || '',
  codexWorkdir: process.env.CODEX_WORKDIR || process.cwd(),
  codexSandbox: process.env.CODEX_SANDBOX || 'workspace-write',
  codexApproval: process.env.CODEX_APPROVAL || 'never',
  codexSessionMode: process.env.CODEX_SESSION_MODE || 'new',
  codexTimeoutMs: parseNonNegativeMs(process.env.CODEX_TIMEOUT_MS, 900000),
  isDefault: true
})

const loadRuntimeConfig = (options = {}) => {
  const loadedProfiles = parseProfiles(loadProfilesRaw(options), legacyProfile, options)
    .filter(profile => profile.enabled !== false)
  if (!loadedProfiles.length) {
    configError('CODEX_PROFILES has no enabled profiles', options.exitOnError !== false)
  }
  const configuredDefaultProfile = process.env.DEFAULT_CODEX_PROFILE
  const defaultProfile = configuredDefaultProfile
    && loadedProfiles.find(profile => profile.profileId === configuredDefaultProfile || profile.agentId === configuredDefaultProfile)
  return {
    profiles: loadedProfiles,
    defaultProfileId: defaultProfile?.profileId
      || loadedProfiles.find(profile => profile.isDefault)?.profileId
      || loadedProfiles[0].profileId
  }
}

const runtimeConfig = loadRuntimeConfig()

const config = {
  wsUrl: process.env.WS_URL || 'wss://api.chaoyoufan.cn/ws/agent/channel',
  apiKey: process.env.OPENCLAW_API_KEY || '',
  profiles: runtimeConfig.profiles,
  defaultProfileId: runtimeConfig.defaultProfileId,
  heartbeatMs: Number(process.env.HEARTBEAT_MS || 30000),
  reconnectMaxMs: parseNonNegativeMs(process.env.RECONNECT_MAX_MS, 30 * 60 * 1000),
  profileReloadMs: parseNonNegativeMs(process.env.CODEX_PROFILE_RELOAD_MS, 5000)
}

if (!config.apiKey && !config.profiles.every(profile => profile.apiKey)) {
  console.error('OPENCLAW_API_KEY is required unless every profile defines apiKey')
  process.exit(1)
}

const currentRuns = new Map()
let shuttingDown = false
const codexSessionMapPath = resolve(process.env.CODEX_SESSION_MAP_FILE || resolve(process.cwd(), 'codex-session-map.json'))

const loadCodexSessionMap = () => {
  try {
    if (!existsSync(codexSessionMapPath)) return {}
    const parsed = JSON.parse(readFileSync(codexSessionMapPath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    console.warn(`failed to load codex session map | path=${codexSessionMapPath} | ${error.message}`)
    return {}
  }
}

const codexSessionMap = loadCodexSessionMap()

const saveCodexSessionMap = () => {
  try {
    writeFileSync(codexSessionMapPath, `${JSON.stringify(codexSessionMap, null, 2)}\n`)
  } catch (error) {
    console.warn(`failed to save codex session map | path=${codexSessionMapPath} | ${error.message}`)
  }
}

const withApiKey = (url, profile = defaultProfile) => {
  const parsed = new URL(url)
  parsed.searchParams.set('api_key', profile?.apiKey || config.apiKey)
  if (profile?.agentId) {
    parsed.searchParams.set('agent_id', profile.agentId)
    parsed.searchParams.set('agentId', profile.agentId)
  }
  return parsed.toString()
}

const getProfileById = (profileId) => config.profiles.find(profile => profile.profileId === profileId || profile.agentId === profileId)

let defaultProfile = getProfileById(config.defaultProfileId) || config.profiles[0]

const ensureProfiles = (profilesToValidate = config.profiles, defaultProfileIdToValidate = config.defaultProfileId, exitOnError = true) => {
  const seenProfileIds = new Set()
  const seenAgentIds = new Set()
  for (const profile of profilesToValidate) {
    if (seenProfileIds.has(profile.profileId)) {
      configError(`duplicate CODEX_PROFILES profileId: ${profile.profileId}`, exitOnError)
    }
    if (seenAgentIds.has(profile.agentId)) {
      configError(`duplicate CODEX_PROFILES agentId: ${profile.agentId}`, exitOnError)
    }
    seenProfileIds.add(profile.profileId)
    seenAgentIds.add(profile.agentId)

    const resolvedCodexBin = resolveExecutable(profile.codexBin)
    if (!resolvedCodexBin) {
      configError(`codex binary not found or not executable for profile ${profile.profileId}: ${profile.codexBin}`, exitOnError)
    }
    profile.codexBin = resolvedCodexBin

    if (!existsSync(profile.codexWorkdir)) {
      configError(`codex workdir not found for profile ${profile.profileId}: ${profile.codexWorkdir}`, exitOnError)
    }
  }
  if (!profilesToValidate.find(profile => profile.profileId === defaultProfileIdToValidate || profile.agentId === defaultProfileIdToValidate)) {
    configError(`DEFAULT_CODEX_PROFILE not found: ${defaultProfileIdToValidate}`, exitOnError)
  }
}

ensureProfiles()

if (hasFlag('--validate')) {
  console.log(`configuration valid | profiles=${config.profiles.length} | defaultProfile=${defaultProfile.profileId}`)
  for (const profile of config.profiles) {
    console.log(`profile ok | profile=${profile.profileId} | agentId=${profile.agentId} | codexBin=${profile.codexBin} | workdir=${profile.codexWorkdir}`)
  }
  process.exit(0)
}

const createProfileState = (profile) => ({
  profile,
  ws: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  reconnectStartedAt: 0,
  reconnectScheduled: false
})

const profileStates = new Map(config.profiles.map(profile => [profile.agentId, createProfileState(profile)]))

const getProfileState = (profile) => profileStates.get(profile.agentId)

let shutdownStarted = false
let profileReloadTimer = null
let profileReloadInFlight = false
let lastProfileSignature = ''

const clearReconnectState = (state) => {
  if (!state) return
  clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
  state.reconnectScheduled = false
}

const profileSignature = (profiles, defaultProfileId) => JSON.stringify({
  defaultProfileId,
  profiles: profiles.map(profile => ({
    profileId: profile.profileId,
    agentId: profile.agentId,
    agentName: profile.agentName,
    personaName: profile.personaName,
    apiKey: profile.apiKey,
    codexBin: profile.codexBin,
    codexHome: profile.codexHome,
    codexWorkdir: profile.codexWorkdir,
    codexSandbox: profile.codexSandbox,
    codexApproval: profile.codexApproval,
    codexSessionMode: profile.codexSessionMode,
    codexTimeoutMs: profile.codexTimeoutMs,
    enabled: profile.enabled,
    status: profile.status,
    isDefault: profile.isDefault
  }))
})

const sameProfileConfig = (left, right) => profileSignature([left], left.profileId) === profileSignature([right], right.profileId)

const terminateChild = (profile, child, signal = 'SIGTERM') => {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    child.kill(signal)
    console.warn(`sent ${signal} to codex child | profile=${profile.profileId} | agentId=${profile.agentId}`)
  } catch (error) {
    console.error(`failed to send ${signal} to codex child | profile=${profile.profileId} | ${error.message}`)
  }
}

const terminateAllRuns = () => {
  for (const profile of config.profiles) {
    const child = currentRuns.get(profile.agentId)
    if (child) {
      terminateChild(profile, child, 'SIGTERM')
      setTimeout(() => terminateChild(profile, child, 'SIGKILL'), 5000)
    }
  }
}

const scheduleRestart = (reason) => {
  if (shutdownStarted) return
  console.error(`agent restart required | reason=${reason}`)
  shutdown(1, reason)
}

const send = (type, payload = {}, profile = defaultProfile) => {
  const state = getProfileState(profile)
  if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) return
  state.ws.send(JSON.stringify({
    type,
    requestId: `${type}-${Date.now()}`,
    agentId: profile?.agentId || defaultProfile.agentId,
    senderType: 'agent',
    senderName: profile?.agentName || defaultProfile.agentName,
    ...payload
  }))
}

const sendStatus = (profile, status, extra = {}) => {
  send('agent.status', {
    status,
    currentTaskId: extra.taskId || '',
    currentTaskTitle: extra.title || '',
    errorMessage: extra.errorMessage || ''
  }, profile)
}

const registerAgent = (profile) => {
  send('agent.register', {
    agentId: profile.agentId,
    name: profile.agentName,
    personaName: profile.personaName,
    endpoint: config.wsUrl,
    abilities: ['codex', 'shell', 'code-edit', 'debug', 'deploy-assist']
  }, profile)
}

const resolvePrompt = (message) => {
  if (message.prompt) return String(message.prompt)
  if (message.content) return String(message.content)
  if (message.description) return String(message.description)
  if (message.currentTaskTitle) return String(message.currentTaskTitle)
  if (message.title) return `处理任务：${message.title}`
  return ''
}

const trimReply = (value, limit = 12000) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}\n\n[输出已截断]` : text
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const buildReplyChunks = (content, chunkSize = 72) => {
  const text = String(content || '')
  if (!text) return []
  const chunks = []
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize))
  }
  return chunks
}

const sendAgentReplyDelta = (profile, message, content, extra = {}) => {
  if (!content) return
  send('agent.message.delta', {
    conversationId: message.conversationId,
    conversationType: message.conversationType || 'juyiting',
    content,
    agentId: profile.agentId,
    senderName: profile.personaName || profile.agentName,
    ...extra
  }, profile)
}

const extractCodexAgentText = (event) => {
  if (!event || typeof event !== 'object') return ''
  const item = event.item && typeof event.item === 'object' ? event.item : null
  if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text
  if (event.type === 'agent_message_delta' && typeof event.delta === 'string') return event.delta
  if (event.type === 'agent_message_delta' && typeof event.text === 'string') return event.text
  if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') return event.delta
  return ''
}

const extractCodexSessionId = (event) => {
  if (!event || typeof event !== 'object') return ''
  if (typeof event.session_id === 'string') return event.session_id
  if (typeof event.sessionId === 'string') return event.sessionId
  if (event.type === 'session_meta' && typeof event.payload?.id === 'string') return event.payload.id
  if (typeof event.payload?.session_id === 'string') return event.payload.session_id
  if (typeof event.payload?.sessionId === 'string') return event.payload.sessionId
  if (typeof event.item?.session_id === 'string') return event.item.session_id
  return ''
}

const resolveProfileFromMessage = (message) => {
  const candidates = [
    message.cliProfile,
    message.codexProfile,
    message.profileId,
    message.profile,
    message.assignedAgentId,
    message.targetAgentId,
    message.receiverAgentId,
    message.agentId
  ].filter(Boolean)

  for (const candidate of candidates) {
    const profile = getProfileById(String(candidate))
    if (profile) return profile
  }

  return defaultProfile
}

const shouldRun = (message, profile) => {
  if (!profile) return false
  if (currentRuns.has(profile.agentId)) return false
  if (message.type === 'agent_direct_message') return true
  if (['codex.exec', 'task.assign', 'task_assigned'].includes(message.type)) return true
  if (message.type === 'task_event') {
    const assignedToMe = !message.assignedAgentId || message.assignedAgentId === profile.agentId
    return assignedToMe && ['running', 'pending', 'assigned'].includes(String(message.status || '').toLowerCase())
  }
  return false
}

const findCodexSessionFiles = (dir) => {
  const files = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findCodexSessionFiles(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath)
    }
  }
  return files
}

const readCodexSessionMeta = (filePath) => {
  try {
    const firstLine = readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]
    if (!firstLine) return null
    const event = JSON.parse(firstLine)
    if (event?.type !== 'session_meta' || !event.payload?.id) return null
    const stats = statSync(filePath)
    return {
      id: String(event.payload.id),
      path: filePath,
      mtimeMs: stats.mtimeMs,
      timestamp: event.payload.timestamp || event.timestamp || ''
    }
  } catch {
    return null
  }
}

const findLatestCodexSession = (profile, sinceMs = 0) => {
  if (!profile.codexHome) return null
  const sessionsDir = resolve(profile.codexHome, 'sessions')
  return findCodexSessionFiles(sessionsDir)
    .map(readCodexSessionMeta)
    .filter(meta => meta && meta.mtimeMs >= sinceMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null
}

const hasCodexSession = (profile) => {
  if (!profile.codexHome) return false
  const indexPath = resolve(profile.codexHome, 'session_index.jsonl')
  try {
    if (existsSync(indexPath) && readFileSync(indexPath, 'utf8').trim().length > 0) return true
    return Boolean(findLatestCodexSession(profile))
  } catch {
    return false
  }
}

const codexSessionMapKey = (profile, message) => {
  const conversationId = message?.conversationId ? String(message.conversationId) : ''
  if (!conversationId) return ''
  return `${profile.agentId}:${conversationId}`
}

const getMappedCodexSessionId = (profile, message) => {
  const key = codexSessionMapKey(profile, message)
  const sessionId = key ? codexSessionMap[key] : ''
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : ''
}

const rememberCodexSession = (profile, message, sessionId) => {
  const key = codexSessionMapKey(profile, message)
  const value = String(sessionId || '').trim()
  if (!key || !value || codexSessionMap[key] === value) return
  codexSessionMap[key] = value
  saveCodexSessionMap()
  console.log(`remembered codex session | profile=${profile.profileId} | conversationId=${message.conversationId || ''} | sessionId=${value}`)
}

const buildCodexArgs = (profile, message, prompt) => {
  const mappedSessionId = getMappedCodexSessionId(profile, message)
  const resume = profile.codexSessionMode === 'resume' && (mappedSessionId || hasCodexSession(profile))
  if (resume) {
    const sessionSelector = mappedSessionId ? [mappedSessionId] : ['--last', '--all']
    return [
      '--ask-for-approval', profile.codexApproval,
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      ...sessionSelector,
      prompt
    ]
  }

  return [
    '--ask-for-approval', profile.codexApproval,
    'exec',
    '--json',
    '--cd', profile.codexWorkdir,
    '--sandbox', profile.codexSandbox,
    '--skip-git-repo-check',
    prompt
  ]
}

const runCodex = (profile, message) => {
  const prompt = resolvePrompt(message)
  if (!prompt) {
    send('codex.result', {
      status: 'failed',
      message: 'No prompt/content/title found in inbound event'
    }, profile)
    return
  }

  const taskId = message.taskId || message.id || message.requestId || `codex-${Date.now()}`
  const title = message.title || message.currentTaskTitle || 'Codex 执行任务'
  sendStatus(profile, 'busy', { taskId, title })
  if (message.type === 'agent_direct_message') {
    sendAgentReplyDelta(profile, message, '收到，正在整理回报。\n\n', { phase: 'intro' })
  }

  const args = buildCodexArgs(profile, message, prompt)
  const mappedSessionId = getMappedCodexSessionId(profile, message)
  console.log(`starting codex run | profile=${profile.profileId} | agentId=${profile.agentId} | type=${message.type} | taskId=${taskId} | conversationId=${message.conversationId || ''} | resumeSessionId=${mappedSessionId || ''}`)

  const startedAt = Date.now()
  const child = spawn(profile.codexBin, args, {
    cwd: profile.codexWorkdir,
    env: {
      ...process.env,
      ...(profile.codexHome ? { CODEX_HOME: profile.codexHome } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  currentRuns.set(profile.agentId, child)
  let stdout = ''
  let agentReplyText = ''
  let streamedAgentReply = ''
  let streamQueue = Promise.resolve()
  let jsonLineBuffer = ''
  let runSessionId = ''
  let stderr = ''
  const timeout = setTimeout(() => {
    child.kill('SIGTERM')
  }, profile.codexTimeoutMs)

  const streamAgentReplyText = async (content, extra = {}) => {
    if (message.type !== 'agent_direct_message' || !content) return
    const chunks = buildReplyChunks(content)
    for (const [index, chunk] of chunks.entries()) {
      sendAgentReplyDelta(profile, message, chunk, {
        phase: extra.phase || 'reply',
        chunkIndex: extra.chunkIndex ?? index,
        chunkCount: extra.chunkCount ?? chunks.length
      })
      streamedAgentReply += chunk
      await sleep(index === 0 ? 20 : 45)
    }
  }

  const queueAgentReplyText = (content, extra = {}) => {
    if (!content) return streamQueue
    streamQueue = streamQueue.then(() => streamAgentReplyText(content, extra))
    return streamQueue
  }

  const handleJsonLine = line => {
    const trimmed = line.trim()
    if (!trimmed) return
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      agentReplyText += trimmed + '\n'
      return
    }
    const sessionId = extractCodexSessionId(event)
    if (sessionId) {
      runSessionId = sessionId
      rememberCodexSession(profile, message, sessionId)
    }
    const agentText = extractCodexAgentText(event)
    if (!agentText) return

    if (event.type === 'item.completed') {
      agentReplyText = agentText
      const remaining = agentText.startsWith(streamedAgentReply)
        ? agentText.slice(streamedAgentReply.length)
        : agentText
      queueAgentReplyText(remaining, { phase: 'reply' })
      return
    }

    agentReplyText += agentText
    queueAgentReplyText(agentText, { phase: 'reply' })
  }

  child.stdout.on('data', chunk => {
    const raw = chunk.toString()
    stdout += raw
    if (stdout.length > 120000) stdout = stdout.slice(-120000)
    jsonLineBuffer += raw
    let lineEndIndex
    while ((lineEndIndex = jsonLineBuffer.indexOf('\n')) !== -1) {
      const line = jsonLineBuffer.slice(0, lineEndIndex)
      jsonLineBuffer = jsonLineBuffer.slice(lineEndIndex + 1)
      handleJsonLine(line)
    }
  })

  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
    if (stderr.length > 60000) stderr = stderr.slice(-60000)
  })

  child.on('close', async code => {
    clearTimeout(timeout)
    if (jsonLineBuffer.trim()) {
      handleJsonLine(jsonLineBuffer)
      jsonLineBuffer = ''
    }
    currentRuns.delete(profile.agentId)
    const status = code === 0 ? 'completed' : 'failed'
    if (!runSessionId) {
      const latestSession = findLatestCodexSession(profile, startedAt - 5000)
      if (latestSession?.id) {
        runSessionId = latestSession.id
        rememberCodexSession(profile, message, latestSession.id)
      }
    }
    const replyContent = trimReply(agentReplyText) || trimReply(stdout) || trimReply(stderr) || (code === 0 ? '已处理，但无可返回内容。' : '执行失败，暂无详细输出。')
    console.log(`codex run finished | profile=${profile.profileId} | status=${status} | code=${code} | conversationId=${message.conversationId || ''} | sessionId=${runSessionId || ''}`)
    const payload = {
      taskId,
      agentId: profile.agentId,
      status,
      currentTaskTitle: title,
      durationMs: Date.now() - startedAt,
      output: replyContent,
      errorMessage: stderr.trim()
    }
    if (message.type === 'agent_direct_message') {
      if (replyContent && streamedAgentReply !== replyContent) {
        const remaining = replyContent.startsWith(streamedAgentReply)
          ? replyContent.slice(streamedAgentReply.length)
          : replyContent
        await queueAgentReplyText(remaining, { phase: 'reply' })
      }
      await streamQueue
      console.log(`sending agent.message | conversationId=${message.conversationId || ''}`)
      send('agent.message', {
        conversationId: message.conversationId,
        conversationType: message.conversationType || 'juyiting',
        content: replyContent,
        agentId: profile.agentId,
        senderName: profile.personaName || profile.agentName
      }, profile)
    }
    send('task.report', payload, profile)
    send('codex.result', payload, profile)
    sendStatus(profile, 'online')
  })

  child.on('error', error => {
    clearTimeout(timeout)
    currentRuns.delete(profile.agentId)
    console.error(`codex run error | profile=${profile.profileId} | conversationId=${message.conversationId || ''} | ${error.message}`)
    const payload = {
      taskId,
      agentId: profile.agentId,
      status: 'failed',
      currentTaskTitle: title,
      errorMessage: error.message
    }
    if (message.type === 'agent_direct_message') {
      send('agent.message', {
        conversationId: message.conversationId,
        conversationType: message.conversationType || 'juyiting',
        content: `执行失败：${error.message}`,
        agentId: profile.agentId,
        senderName: profile.personaName || profile.agentName
      }, profile)
    }
    send('task.report', payload, profile)
    send('codex.result', payload, profile)
    sendStatus(profile, 'online')
  })
}

const handleMessage = (profile, raw) => {
  let message
  try {
    message = JSON.parse(raw.toString())
  } catch {
    message = { type: 'codex.exec', content: raw.toString() }
  }

  if (message.type === 'connected') {
    console.log(`websocket connected | profile=${profile.profileId} | agentId=${profile.agentId}`)
    registerAgent(profile)
    sendStatus(profile, currentRuns.has(profile.agentId) ? 'busy' : 'online')
    return
  }
  if (message.type === 'ping') {
    send('pong', {}, profile)
    return
  }
  if (message.type === 'agent_direct_message') {
    console.log(`received agent_direct_message | profile=${profile.profileId} | conversationId=${message.conversationId || ''}`)
  }
  const targetProfile = resolveProfileFromMessage(message)
  if (targetProfile.agentId !== profile.agentId) {
    return
  }
  if (shouldRun(message, targetProfile)) {
    runCodex(targetProfile, message)
  }
}

const doReconnect = (profile) => {
  const state = getProfileState(profile)
  if (!state || shuttingDown) return
  if (state.reconnectScheduled) return
  const now = Date.now()
  if (!state.reconnectStartedAt) state.reconnectStartedAt = now
  const elapsed = now - state.reconnectStartedAt
  if (elapsed >= config.reconnectMaxMs) {
    console.error(`reconnect window exceeded ${config.reconnectMaxMs}ms | profile=${profile.profileId}`)
    scheduleRestart(`reconnect timeout for profile ${profile.profileId}`)
    return
  }

  const delay = Math.min(30000, 1000 * 2 ** state.reconnectAttempt, config.reconnectMaxMs - elapsed)
  state.reconnectAttempt += 1
  state.reconnectScheduled = true
  console.warn(`reconnecting in ${delay}ms | profile=${profile.profileId} | attempt ${state.reconnectAttempt} | elapsed ${(elapsed / 1000).toFixed(0)}s`)
  state.reconnectTimer = setTimeout(() => {
    state.reconnectScheduled = false
    state.reconnectTimer = null
    connectProfile(profile)
  }, delay)
}

const connectProfile = (profile) => {
  const state = getProfileState(profile)
  if (!state) return

  clearReconnectState(state)
  clearInterval(state.heartbeatTimer)
  state.heartbeatTimer = null

  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
    try { state.ws.close() } catch {}
  }

  let closeFired = false

  state.ws = new WebSocket(withApiKey(config.wsUrl, profile))

  state.ws.addEventListener('open', () => {
    closeFired = true
    clearReconnectState(state)
    state.reconnectAttempt = 0
    state.reconnectStartedAt = 0
    console.log(`websocket open | profile=${profile.profileId} | agentId=${profile.agentId}`)
    registerAgent(profile)
    sendStatus(profile, currentRuns.has(profile.agentId) ? 'busy' : 'online')
    state.heartbeatTimer = setInterval(() => {
      sendStatus(profile, currentRuns.has(profile.agentId) ? 'busy' : 'online')
    }, config.heartbeatMs)
  })

  state.ws.addEventListener('message', event => handleMessage(profile, event.data))

  state.ws.addEventListener('close', () => {
    closeFired = true
    clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = null
    if (shuttingDown) return
    doReconnect(profile)
  })

  state.ws.addEventListener('error', error => {
    console.error(`websocket error | profile=${profile.profileId}:`, error.message || error)
    setTimeout(() => {
      if (!closeFired && !shuttingDown && !state.reconnectScheduled) {
        console.warn(`websocket error without close, forcing reconnect | profile=${profile.profileId}`)
        if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
          try { state.ws.close() } catch {}
        }
        doReconnect(profile)
      }
    }, 1000)
  })
}

const disconnectProfile = (profile, reason = 'profile removed') => {
  const state = getProfileState(profile)
  if (!state) return
  console.warn(`disconnecting profile | profile=${profile.profileId} | agentId=${profile.agentId} | reason=${reason}`)
  clearReconnectState(state)
  clearInterval(state.heartbeatTimer)
  state.heartbeatTimer = null
  sendStatus(profile, 'offline', { errorMessage: reason })
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
    try { state.ws.close() } catch {}
  }
  const child = currentRuns.get(profile.agentId)
  if (child) {
    terminateChild(profile, child, 'SIGTERM')
    setTimeout(() => terminateChild(profile, child, 'SIGKILL'), 5000)
  }
  profileStates.delete(profile.agentId)
}

const applyProfileConfig = (nextProfiles, nextDefaultProfileId, reason = 'config reload') => {
  const previousProfiles = config.profiles
  const previousByAgentId = new Map(previousProfiles.map(profile => [profile.agentId, profile]))
  const nextByAgentId = new Map(nextProfiles.map(profile => [profile.agentId, profile]))

  for (const previousProfile of previousProfiles) {
    const nextProfile = nextByAgentId.get(previousProfile.agentId)
    if (!nextProfile) {
      disconnectProfile(previousProfile, reason)
      continue
    }
    if (!sameProfileConfig(previousProfile, nextProfile)) {
      disconnectProfile(previousProfile, `${reason}: profile changed`)
    }
  }

  config.profiles = nextProfiles
  config.defaultProfileId = nextDefaultProfileId
  defaultProfile = getProfileById(config.defaultProfileId) || config.profiles[0]

  for (const nextProfile of nextProfiles) {
    const previousProfile = previousByAgentId.get(nextProfile.agentId)
    const state = profileStates.get(nextProfile.agentId)
    if (state && previousProfile && sameProfileConfig(previousProfile, nextProfile)) {
      state.profile = nextProfile
      continue
    }
    profileStates.set(nextProfile.agentId, createProfileState(nextProfile))
    console.log(`connecting profile from config | profile=${nextProfile.profileId} | agentId=${nextProfile.agentId} | reason=${reason}`)
    connectProfile(nextProfile)
  }

  lastProfileSignature = profileSignature(config.profiles, config.defaultProfileId)
  console.log(`profile config active | profiles=${config.profiles.length} | defaultProfile=${defaultProfile.profileId}`)
}

const reloadProfiles = (reason = 'config reload') => {
  if (shuttingDown || shutdownStarted || profileReloadInFlight) return
  profileReloadInFlight = true
  try {
    const nextRuntimeConfig = loadRuntimeConfig({ exitOnError: false })
    ensureProfiles(nextRuntimeConfig.profiles, nextRuntimeConfig.defaultProfileId, false)
    const nextSignature = profileSignature(nextRuntimeConfig.profiles, nextRuntimeConfig.defaultProfileId)
    if (nextSignature === lastProfileSignature) return
    console.log(`profile config changed | reason=${reason}`)
    applyProfileConfig(nextRuntimeConfig.profiles, nextRuntimeConfig.defaultProfileId, reason)
  } catch (error) {
    console.warn(`profile config reload skipped | reason=${reason} | ${error.message}`)
  } finally {
    profileReloadInFlight = false
  }
}

const startProfileWatcher = () => {
  lastProfileSignature = profileSignature(config.profiles, config.defaultProfileId)
  if (config.profileReloadMs <= 0) return
  const profilesFile = process.env.CODEX_PROFILES_FILE?.trim()
  if (profilesFile) {
    const resolvedProfilesFile = resolve(profilesFile)
    watchFile(resolvedProfilesFile, { interval: config.profileReloadMs }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
      reloadProfiles(`file changed: ${resolvedProfilesFile}`)
    })
    console.log(`watching profile config | file=${resolvedProfilesFile} | intervalMs=${config.profileReloadMs}`)
    return
  }

  profileReloadTimer = setInterval(() => reloadProfiles('periodic CODEX_PROFILES check'), config.profileReloadMs)
  console.log(`watching inline profile config | intervalMs=${config.profileReloadMs}`)
}

const shutdown = (exitCode = 0, reason = '') => {
  if (shutdownStarted) return
  shutdownStarted = true
  shuttingDown = true
  if (reason) {
    console.warn(`shutting down codex-ws-agent | reason=${reason}`)
  }
  terminateAllRuns()
  if (profileReloadTimer) {
    clearInterval(profileReloadTimer)
    profileReloadTimer = null
  }
  const profilesFile = process.env.CODEX_PROFILES_FILE?.trim()
  if (profilesFile) {
    unwatchFile(resolve(profilesFile))
  }
  for (const profile of config.profiles) {
    const state = getProfileState(profile)
    clearReconnectState(state)
    clearInterval(state?.heartbeatTimer)
    sendStatus(profile, 'offline')
    state?.ws?.close()
  }
  setTimeout(() => process.exit(exitCode), 100)
}

process.on('SIGINT', () => {
  shutdown(0, 'SIGINT')
})

process.on('SIGTERM', () => {
  shutdown(0, 'SIGTERM')
})

for (const profile of config.profiles) {
  connectProfile(profile)
}

startProfileWatcher()
