import { BROWSER_PROBE } from './native-browser-toolchain.mjs'
import { DOCUMENT_MIMES, DOCUMENT_PROBE, PDF_PROBE } from './native-document-toolchain.mjs'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createServer } from 'node:net'
import { skillPackageTreeDigest } from './skill-manifest.mjs'

import { canonicalSha256 } from './chat-runtime.mjs'

import { NATIVE_NEUTRAL_MOUNT_TARGETS, NATIVE_PERMISSION_PROFILE, prepareNativeExecutionLayout, validateNativeExecutionToolchain, verifyNativeExecutionConfig, verifyNativeExecutionSkillCatalog } from './native-execution-profile.mjs'

import { IsolatedEngineProfileRuntime, nonblank, fail, sha256, ensurePrivateDirectory, engineStateBinding, stateMarker, emptyMcpCatalog } from './isolated-engine-profile.mjs'

/** Independent native execution owner. Legacy provider field names are accepted
 * as operator-config compatibility, never as a dependency on carrier readiness. */
export const nativeExecutionProfile = profile => {
  const explicit = Boolean(profile.nativeExecutionProviderId || profile.nativeExecutionProviderBaseUrl
    || profile.nativeExecutionProviderWireApi || profile.nativeExecutionNetworkConnectTimeoutMs)
  return { ...profile, typedInspectionSupportedInputs: [],
    typedInspectionProviderId: explicit ? profile.nativeExecutionProviderId : profile.typedInspectionProviderId,
    typedInspectionProviderBaseUrl: explicit ? profile.nativeExecutionProviderBaseUrl : profile.typedInspectionProviderBaseUrl,
    typedInspectionProviderWireApi: explicit ? profile.nativeExecutionProviderWireApi : profile.typedInspectionProviderWireApi,
    typedInspectionProviderNetwork: explicit ? 'restricted-proxy' : profile.typedInspectionProviderNetwork,
    typedInspectionNetworkConnectTimeoutMs: explicit ? profile.nativeExecutionNetworkConnectTimeoutMs : profile.typedInspectionNetworkConnectTimeoutMs
  }
}

export class NativeExecutionProfileRuntime extends IsolatedEngineProfileRuntime {
  constructor(options = {}) {
    super({ ...options, profile: nativeExecutionProfile(options.profile || {}) })
  }
  openNativeExecutionAdapter(inputDirectory, requestKey, requestBinding, { scratchDirectory, draftsDirectory, skills = [], skillConfiguration = [], nativeExecution, requireExistingState = false } = {}) {
    if (nativeExecution) nativeExecution = Object.freeze({ ...nativeExecution, tools: structuredClone(nativeExecution.tools), ...(this.nativeModelCatalog ? { modelCatalogSha256: this.nativeModelCatalog.sha256 } : {}) })
    if (this.disposed) return Promise.reject(Object.assign(new Error('TYPED_INSPECTION_PROFILE_DISPOSED'), { code: 'TYPED_INSPECTION_PROFILE_DISPOSED' }))
    const binding = engineStateBinding(requestBinding)
    if (!nonblank(requestKey) || binding.requestKey !== requestKey) fail('NATIVE_EXECUTION_BINDING_INVALID')
    const layout = prepareNativeExecutionLayout({ inputDirectory, scratchDirectory, draftsDirectory, skills, skillConfiguration, nativeExecution,
      toolchain: this.nativeToolchain, stateRoot: this.stateRoot, sourceHome: this.profile.codexHome })
    const bindingDigest = canonicalSha256(binding)
    const matches = active => active.nativeLayout?.digest === layout.digest && active.engineState.bindingDigest === bindingDigest
      && active.nativeExecution.checkActive === nativeExecution.checkActive && active.nativeExecution.callTool === nativeExecution.callTool
    if (this.closingAdapters?.has(requestKey)) fail('NATIVE_EXECUTION_ADAPTER_CLOSING')
    if (this.pendingInspectionKeys?.has(requestKey)) fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
    const pending = this.pendingNativeAdapters.get(requestKey)
    if (pending) { if (matches(pending)) return pending.promise; fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT') }
    const active = this.activeAdapters.get(requestKey)
    if (active) {
      if (!active.adapter.closed && matches(active)) return Promise.resolve(active.adapter)
      fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
    }
    const slot = { nativeLayout: layout, engineState: { bindingDigest }, nativeExecution, cancelled: false }
    this.pendingNativeAdapters.set(requestKey, slot)
    slot.promise = this._openNativeExecutionAdapter(binding, layout, nativeExecution, requireExistingState, slot)
      .finally(() => { if (this.pendingNativeAdapters.get(requestKey) === slot) this.pendingNativeAdapters.delete(requestKey) })
    return slot.promise
  }
  async _openNativeExecutionAdapter(binding, layout, nativeExecution, requireExistingState, slot) {
    let engineState, adapter, egress
    const timings = []; let stage = 'binary-measure', stageStarted = performance.now(), ready = false
    const phase = next => { timings.push({ phase: stage, durationMs: performance.now() - stageStarted }); stage = next; stageStarted = performance.now() }
    const checkActive = () => { if (this.disposed || slot.cancelled) fail('NATIVE_EXECUTION_START_CANCELLED'); nativeExecution.checkActive() }
    try {
      checkActive()
      if (this.profile.typedInspectionProviderNetwork !== 'restricted-proxy') fail('TYPED_INSPECTION_PROVIDER_NETWORK_NOT_CONFIGURED')
      const schema = await this.measureBinary(this.profile); checkActive()
      phase('request-state-and-skill-view')
      engineState = this._prepareRequestState(binding, { requireExistingState, nativeExecution: true, nativeBinding: layout.binding })
      slot.engineState = engineState
      const skillConfigurationDirectory = ensurePrivateDirectory(resolve(engineState.directory, 'skill-config'))
      for (const item of layout.skillConfiguration) stateMarker(skillConfigurationDirectory, item.configuration, `${item.skillKey}.json`)
      const neutralDirectory = ensurePrivateDirectory(resolve(engineState.directory, 'neutral'))
      const skillsDirectory = ensurePrivateDirectory(resolve(engineState.directory, 'skill-view'))
      if (readdirSync(neutralDirectory).some(name => !NATIVE_NEUTRAL_MOUNT_TARGETS.includes(name)) || readdirSync(skillsDirectory).some(key => key !== '.system' && !layout.skills.some(skill => skill.skillKey === key))) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      for (const name of NATIVE_NEUTRAL_MOUNT_TARGETS) {
        const target = ensurePrivateDirectory(resolve(neutralDirectory, name))
        if (readdirSync(target).length) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      }
      const systemMask = ensurePrivateDirectory(resolve(skillsDirectory, '.system'))
      if (readdirSync(systemMask).length) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      for (const skill of layout.skills) {
        const mountpoint = ensurePrivateDirectory(resolve(skillsDirectory, skill.skillKey))
        if (readdirSync(mountpoint).length) fail('NATIVE_EXECUTION_DISCOVERY_ROOT_UNSAFE')
      }
      phase('egress-start')
      egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs, additionalOrigins: layout.binding.networkOrigins })
      await egress.start(); checkActive()
      // Recheck bytes/identities after asynchronous setup, immediately before bind.
      phase('layout-recheck')
      const current = prepareNativeExecutionLayout({ ...layout, nativeExecution, toolchain: this.nativeToolchain, stateRoot: this.stateRoot, sourceHome: this.profile.codexHome })
      if (current.digest !== layout.digest) fail('NATIVE_EXECUTION_ADAPTER_BINDING_CONFLICT')
      phase('adapter-spawn')
      adapter = await this._spawnAdapter({ inputDirectory: layout.inputDirectory, engineState, schemaMeasurement: schema,
        networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl,
        nativeView: { layout, engineState, neutralDirectory, skillsDirectory, skillConfigurationDirectory }, nativeExecution: { ...nativeExecution, checkActive } })
      checkActive(); phase('egress-bind'); await egress.bindOwner(adapter.child, this.bwrap)
      phase('egress-attach')
      const network = await egress.attach(); checkActive()
      phase('initialize-and-seal')
      const readback = await this._initializeAndSeal(adapter); checkActive(); verifyNativeExecutionConfig(readback, layout.binding.webSearch, this.nativeModelCatalog)
      if (!emptyMcpCatalog(adapter.readback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      adapter.verifyNativeExecutionSkills = async () => {
        checkActive()
        const discovery = verifyNativeExecutionSkillCatalog(await adapter.request('skills/list', { cwds: ['/execution'], forceReload: true }), layout)
        checkActive(); return discovery
      }
      phase('skill-discovery')
      const discovery = await adapter.verifyNativeExecutionSkills()
      // Recheck actual engine discovery at both new/resumed thread and turn
      // boundaries; a cached startup inventory is not refresh/resume evidence.
      for (const method of ['startOrResumeThread', 'runTurn']) {
        const call = adapter[method].bind(adapter)
        adapter[method] = async (...args) => { await adapter.verifyNativeExecutionSkills(); return call(...args) }
      }
      checkActive()
      adapter.nativeExecutionIsolation = Object.freeze({ schemaVersion: 1, layoutDigest: layout.digest, cwd: '/execution',
        writableRoots: Object.freeze(['/workspace', '/outputs']), skills: discovery, network, modelTurnMeasured: false })
      this.suspendedNativeStates?.delete(binding.requestKey)
      this.activeAdapters.set(binding.requestKey, { adapter, egress, engineState, inputDirectory: layout.inputDirectory, nativeLayout: layout, nativeExecution, slot })
      adapter.once('exit', () => {
        // Keep the closed entry until per-execution suspend/release joins
        // egress cleanup; never race a new lease against a dying process.
        this.suspendedNativeStates ||= new Map(); this.suspendedNativeStates.set(binding.requestKey, engineState.directory)
        rmSync(resolve(engineState.directory, 'skill-config'), { recursive: true, force: true })
        void egress.dispose().catch(() => {})
      })
      ready = true
      return adapter
    } catch (error) {
      phase('failure-cleanup')
      await adapter?.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress?.dispose().catch(() => {})
      if (engineState?.authPath) rmSync(engineState.authPath, { force: true })
      if (engineState?.directory) rmSync(resolve(engineState.directory, 'skill-config'), { recursive: true, force: true })
      if (engineState?.created && !slot.preserveState) rmSync(engineState.directory, { recursive: true, force: true })
      if (engineState && slot.preserveState) { this.suspendedNativeStates ||= new Map(); this.suspendedNativeStates.set(binding.requestKey, engineState.directory) }
      throw error
    } finally {
      phase('done')
      try { console.info(JSON.stringify({ event: 'native-execution-prepare-timing', atMs: Date.now(),
        profileKey: createHash('sha256').update(this.profile.profileId || '').digest('hex'),
        requestKey: binding.requestKey, ready, timings })) } catch {}
    }
  }
  nativeExecutionDeclaration() { return this.disposed ? null : this.nativeExecutionReadback || null }
  measureNativeExecution() {
    if (this.disposed) return Promise.resolve(null)
    if (this.nativeExecutionMeasurementPending) return this.nativeExecutionMeasurementPending
    this.nativeExecutionReadback = null
    this.nativeExecutionMeasurementFailure = null
    const measure = async () => {
      const result = await this._measureNativeExecution()
      // A startup RPC timeout before any model turn is safe to retry only after
      // _measureNativeExecution has finished disposing its isolated probe.
      const failure = this.nativeExecutionMeasurementFailure
      if (result || this.disposed || failure?.stage !== 'engine-open' || failure.code !== 'APP_SERVER_RPC_TIMEOUT') return result
      console.warn('native execution startup RPC timed out; retrying cleaned probe once')
      this.nativeExecutionMeasurementFailure = null
      return this._measureNativeExecution()
    }
    const pending = measure().then(result => {
      this.nativeExecutionReadback = this.disposed ? null : result
      return this.nativeExecutionReadback
    }, () => { this.nativeExecutionReadback = null; return null }).finally(() => {
      if (this.nativeExecutionMeasurementPending === pending) this.nativeExecutionMeasurementPending = null
    })
    this.nativeExecutionMeasurementPending = pending
    return pending
  }
  async _measureNativeExecution() {
    if (this.disposed || !this.nativeToolchain || this.profile.typedInspectionProviderNetwork !== 'restricted-proxy') return null
    const id = `native-declaration-${randomUUID()}`
    const binding = { schemaVersion: 1, requestKey: id, authorizationId: id, manifestDigest: id,
      requestId: id, turnId: id, inputPolicyDigest: id }
    this.nativeBrowserReady = false
    let directory, ready = false, scriptReady = false, documentReady = false, browserReady = false, pdfReady = false, stage = 'toolchain'
    const timings = []; let phaseStarted = performance.now()
    const phase = next => { timings.push({ phase: stage, durationMs: performance.now() - phaseStarted }); stage = next; phaseStarted = performance.now() }
    try {
      validateNativeExecutionToolchain(this.nativeToolchain)
      directory = ensurePrivateDirectory(mkdtempSync(resolve(this.materializerRoot, '.native-declaration-')))
      const inputs = ensurePrivateDirectory(resolve(directory, 'inputs'))
      const scratchDirectory = ensurePrivateDirectory(resolve(directory, 'scratch'))
      const draftsDirectory = ensurePrivateDirectory(resolve(directory, 'drafts'))
      writeFileSync(resolve(inputs, 'probe.txt'), 'native-declaration-probe', { mode: 0o600 })
      const nativeExecution = { executionId: id, tools: [], checkActive: () => { if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED') },
        callTool: async () => { fail('NATIVE_EXECUTION_TOOL_UNAVAILABLE') } }
      phase('engine-open')
      const adapter = await this.openNativeExecutionAdapter(inputs, id, binding, { scratchDirectory, draftsDirectory, skills: [], nativeExecution })
      const network = adapter.nativeExecutionIsolation?.network
      if (network?.measured !== true || network.nftDefaultDropReadback !== true || network.directInternetBlocked !== true) fail('NATIVE_EXECUTION_NETWORK_UNVERIFIED')
      const egress = this.activeAdapters.get(id)?.egress
      phase('provider-tls')
      const tls = await egress.measureAllowedTls(adapter.readback.providerCaTrust)
      if (tls?.measured !== true || tls.tlsVerified !== true) fail('NATIVE_EXECUTION_PROVIDER_TLS_UNVERIFIED')
      phase('shell')
      const result = await adapter.request('command/exec', { command: [this.nativeToolchain.shell, '-c',
        'set -e; cat /inputs/probe.txt > /workspace/probe.txt; cat /workspace/probe.txt > /outputs/probe.txt; ! (echo bad > /inputs/probe.txt) 2>/dev/null; ! (echo bad > /state/codex-home/probe.txt) 2>/dev/null; cat /outputs/probe.txt'],
        cwd: '/execution', disableTimeout: true, sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }, null)
      if (result?.exitCode !== 0 || result.stdout !== 'native-declaration-probe'
          || readFileSync(resolve(draftsDirectory, 'probe.txt'), 'utf8') !== 'native-declaration-probe'
          || readFileSync(resolve(inputs, 'probe.txt'), 'utf8') !== 'native-declaration-probe') fail('NATIVE_EXECUTION_SHELL_UNVERIFIED')
      validateNativeExecutionToolchain(this.nativeToolchain)
      phase('document-probe')
      if (this.nativeToolchain.files.some(file => file.sandboxPath === DOCUMENT_PROBE)) {
        this.nativeDocumentMeasurementFailure = null
        try {
          const probe = await adapter.request('command/exec', { command: ['/usr/bin/python3', '-I', '-B', DOCUMENT_PROBE],
            cwd: '/execution', disableTimeout: true, sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }, null)
          documentReady = probe?.exitCode === 0 && probe.stdout.trim() === 'native-documents-ready'
          if (!documentReady) this.nativeDocumentMeasurementFailure = { stage: 'document-probe', code: 'NATIVE_DOCUMENT_PROBE_FAILED' }
        } catch { this.nativeDocumentMeasurementFailure = { stage: 'document-probe', code: 'NATIVE_DOCUMENT_PROBE_FAILED' } }
      }
      phase('browser-probe')
      const browserProbe = this.nativeToolchain.files.find(file => file.sandboxPath === BROWSER_PROBE)
      if (browserProbe) {
        this.nativeBrowserMeasurementFailure = null
        try {
          const probe = await adapter.request('command/exec', { command: ['/usr/bin/node', BROWSER_PROBE], cwd: '/execution', disableTimeout: true, permissionProfile: NATIVE_PERMISSION_PROFILE }, null)
          browserReady = probe.exitCode === 0 && probe.stdout.trim() === 'native-browser-ready'
          if (!browserReady) this.nativeBrowserMeasurementFailure = { stage: 'browser-probe', code: 'NATIVE_BROWSER_PROBE_FAILED' }
        } catch { this.nativeBrowserMeasurementFailure = { stage: 'browser-probe', code: 'NATIVE_BROWSER_PROBE_FAILED' } }
      }
      phase('pdf-probe')
      if (documentReady && browserReady && this.nativeToolchain.files.some(file => file.sandboxPath === PDF_PROBE)) {
        this.nativePdfMeasurementFailure = null
        try {
          const probe = await adapter.request('command/exec', { command: ['/usr/bin/node', PDF_PROBE], cwd: '/execution', disableTimeout: true, permissionProfile: NATIVE_PERMISSION_PROFILE }, null)
          pdfReady = probe?.exitCode === 0 && probe.stdout.trim() === 'native-pdf-ready'
          if (!pdfReady) this.nativePdfMeasurementFailure = { stage: 'pdf-probe', code: 'NATIVE_PDF_PROBE_FAILED' }
        } catch { this.nativePdfMeasurementFailure = { stage: 'pdf-probe', code: 'NATIVE_PDF_PROBE_FAILED' } }
      }
      phase('skill-script-probe')
      ready = !this.disposed
      if (ready) { try { scriptReady = await this._measureNativeSkillScript() } catch { this.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_MEASUREMENT_FAILED' } } }
    } catch (error) { ready = false; this.nativeExecutionMeasurementFailure = { stage, code: error.code || 'NATIVE_EXECUTION_MEASUREMENT_FAILED' } }
    finally {
      phase('cleanup')
      try { await this.releaseAdapter(id, { requestBinding: binding }) } catch { ready = false; this.nativeExecutionMeasurementFailure = { stage: 'cleanup', code: 'NATIVE_EXECUTION_CLEANUP_FAILED' } }
      try { if (directory) rmSync(directory, { recursive: true, force: true }) } catch { ready = false; this.nativeExecutionMeasurementFailure = { stage: 'cleanup', code: 'NATIVE_EXECUTION_CLEANUP_FAILED' } }
    }
    phase('finished')
    console.info(JSON.stringify({ event: 'native-execution-startup-timing', profileKey: createHash('sha256').update(this.profile.profileId || '').digest('hex'), ready, timings }))
    this.nativeBrowserReady = ready && !this.disposed && browserReady
    return ready && !this.disposed ? Object.freeze({ schemaVersion: 1, executionProtocolVersion: 5,
      toolPolicyRef: 'NATIVE_LOCAL_FILES_V1', outputMimeTypes: Object.freeze(['text/plain', 'text/markdown', 'text/html', 'application/json', ...(scriptReady || browserReady ? ['image/png'] : []), ...(documentReady ? DOCUMENT_MIMES : []), ...(pdfReady ? ['application/pdf'] : [])]),
      ...(scriptReady ? { supportedToolPolicyRefs: Object.freeze(['NATIVE_SKILL_SCRIPT_V1']) } : {}) }) : null
  }
  async _measureNativeSkillScript() {
    return measureNativeSkillScript(this)
  }

}

const measureNativeSkillScript = async runtime => {
  runtime.nativeScriptMeasurementFailure = null
  if (!runtime.nativeToolchain?.files?.some(file => file.sandboxPath === '/usr/bin/node')) { runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_NODE_REQUIRED' }; return false }
  const id = `native-script-measurement-${randomUUID()}`
  const binding = { schemaVersion: 1, requestKey: id, authorizationId: id, manifestDigest: id, requestId: id, turnId: id, inputPolicyDigest: id }
  let directory, server, ready = false, stage = 'fixture'
  try {
    directory = ensurePrivateDirectory(mkdtempSync(resolve(runtime.materializerRoot, '.native-script-measurement-')))
    const inputs = ensurePrivateDirectory(resolve(directory, 'inputs'))
    const scratchDirectory = ensurePrivateDirectory(resolve(directory, 'scratch'))
    const draftsDirectory = ensurePrivateDirectory(resolve(directory, 'drafts'))
    const packageRoot = ensurePrivateDirectory(resolve(directory, 'package'))
    writeFileSync(resolve(inputs, 'probe.txt'), 'script-input', { mode: 0o600 })
    writeFileSync(resolve(packageRoot, 'SKILL.md'), '---\nname: probe-skill\ndescription: Synthetic isolated script probe.\n---\nProbe only.\n', { mode: 0o600 })
    const script = `import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
const configPath = process.env.CYF_SKILL_CONFIG_DIR + '/probe-skill.json'
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (config.marker !== 'synthetic-config' || readFileSync('/inputs/probe.txt', 'utf8') !== 'script-input') throw Error('view')
for (const path of [configPath, '/state/codex-home/skills/probe-skill/SKILL.md']) {
  let denied = false; try { writeFileSync(path, 'bad') } catch (e) { denied = ['EROFS', 'EACCES', 'EPERM'].includes(e.code) }
  if (!denied) throw Error('writable')
}
const proxy = new URL(process.env.HTTPS_PROXY)
async function tunnel(authority, expected, marker) {
  await new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname); let data = ''
    socket.setTimeout(config.timeoutMs, () => socket.destroy(Error('timeout')))
    socket.on('connect', () => socket.write('CONNECT ' + authority + ' HTTP/1.1\\r\\nHost: ' + authority + '\\r\\n\\r\\n'))
    socket.on('data', chunk => { data += chunk.toString(); if (data.includes('\\r\\n\\r\\n') && (!marker || data.includes(marker))) { socket.destroy(); if (!data.startsWith('HTTP/1.1 ' + expected + ' ')) reject(Error('status')); else resolve() } })
    socket.on('error', reject); socket.on('end', () => reject(Error('early-close')))
  })
}
await tunnel(config.authority, '200', 'cyf-script-canary')
await tunnel('forbidden.invalid:443', '403', '')
writeFileSync('/outputs/script-probe.txt', 'script-ok')
console.log('script-ok')
`
    writeFileSync(resolve(packageRoot, 'probe.mjs'), script, { mode: 0o600 })
    server = createServer(socket => socket.end('cyf-script-canary'))
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen() }) })
    const authority = `127.0.0.1:${server.address().port}`
    const skills = [{ skillKey: 'probe-skill', packageRoot, packageTreeDigest: skillPackageTreeDigest(packageRoot) }]
    const skillConfiguration = [{ skillKey: 'probe-skill', configuration: { marker: 'synthetic-config', authority, timeoutMs: runtime.profile.typedInspectionNetworkConnectTimeoutMs }, networkOrigins: [`https://${authority}`] }]
    const nativeExecution = { executionId: id, tools: [], networkAccess: true,
      checkActive: () => { if (runtime.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED') }, callTool: async () => { fail('NATIVE_EXECUTION_TOOL_UNAVAILABLE') } }
    stage = 'engine-open'
    const adapter = await runtime.openNativeExecutionAdapter(inputs, id, binding, { scratchDirectory, draftsDirectory, skills, skillConfiguration, nativeExecution })
    const network = adapter.nativeExecutionIsolation?.network
    if (network?.measured !== true || network.nftDefaultDropReadback !== true || network.directInternetBlocked !== true) fail('NATIVE_SCRIPT_NETWORK_UNVERIFIED')
    stage = 'script-exec'
    const result = await adapter.request('command/exec', { command: ['/usr/bin/node', '/state/codex-home/skills/probe-skill/probe.mjs'], cwd: '/execution', disableTimeout: true,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }, null)
    if (result?.exitCode !== 0 || result.stdout?.trim() !== 'script-ok' || readFileSync(resolve(draftsDirectory, 'script-probe.txt'), 'utf8') !== 'script-ok'
        || readFileSync(resolve(inputs, 'probe.txt'), 'utf8') !== 'script-input') fail('NATIVE_SCRIPT_PROBE_FAILED')
    validateNativeExecutionToolchain(runtime.nativeToolchain)
    ready = !runtime.disposed
  } catch (error) { runtime.nativeScriptMeasurementFailure = { stage, code: error.code || 'NATIVE_SCRIPT_MEASUREMENT_FAILED' } }
  finally {
    try { await runtime.releaseAdapter(id, { requestBinding: binding }) } catch { ready = false; runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_CLEANUP_FAILED' } }
    try { if (server?.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())) } catch { ready = false; runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_CLEANUP_FAILED' } }
    try { if (directory) rmSync(directory, { recursive: true, force: true }) } catch { ready = false; runtime.nativeScriptMeasurementFailure = { code: 'NATIVE_SCRIPT_CLEANUP_FAILED' } }
  }
  if (ready) runtime.nativeScriptMeasurementFailure = null
  return ready && !runtime.disposed
}
