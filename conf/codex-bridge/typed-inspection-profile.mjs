import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { AppServerAdapter } from './app-server-adapter.mjs'
import { canonicalSha256 } from './chat-runtime.mjs'
import { restrictedProviderNetworkPolicy } from './typed-inspection-network.mjs'

import { CHAT_FILE_PERMISSION_PROFILE, validateNativeExecutionToolchain } from './native-execution-profile.mjs'

import { IsolatedEngineProfileRuntime, DIGEST, object, nonblank, fail, sha256, ensurePrivateDirectory, within, SANDBOX_MOUNTS, CHAT_FILE_MOUNTS, bwrapPolicy, exactSupportedInputs, usesChatFiles, stageCodexHome, engineStateBinding, stateMarker, sealCredential, emptyMcpCatalog, verifyProcessView, measureChatFileTools, buildTypedInspectionCodexConfig, buildTypedInspectionNativeAttestation, loadTypedInspectionCarrierEvidence } from './isolated-engine-profile.mjs'
export { measureChatFileTools, buildTypedInspectionCodexConfig, buildTypedInspectionNativeAttestation, loadTypedInspectionCarrierEvidence } from './isolated-engine-profile.mjs'

// Read-only materials and warm discussion sessions only.
export class TypedInspectionProfileRuntime extends IsolatedEngineProfileRuntime {
  canShareChatProvider(readback) {
    const config = readback?.config?.config, provider = config?.model_providers?.[config?.model_provider]
    return this.profile.typedInspectionProviderNetwork === 'restricted-proxy'
      && config?.model_provider === this.profile.typedInspectionProviderId
      && typeof provider?.base_url === 'string'
      && provider.base_url.replace(/\/$/, '') === this.profile.typedInspectionProviderBaseUrl?.replace(/\/$/, '')
      && provider.wire_api === (this.profile.typedInspectionProviderWireApi || 'responses')
      && provider.requires_openai_auth === true
      && !provider.env_key && [provider.http_headers, provider.env_http_headers, provider.query_params]
        .every(value => value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0))
  }
  _conversationDirectory(conversationKey) {
    if (!DIGEST.test(conversationKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    return resolve(this.stateRoot, 'conversations', conversationKey.slice('sha256:'.length))
  }
  _prepareConversationState(conversationKey, { requireExistingState = false } = {}) {
    const directory = this._conversationDirectory(conversationKey)
    if (requireExistingState && (!existsSync(resolve(directory, 'binding.json')) || !existsSync(resolve(directory, 'codex-home'))))
      fail('TYPED_INSPECTION_RECOVERY_STATE_MISSING')
    ensurePrivateDirectory(dirname(directory)); ensurePrivateDirectory(directory)
    const markerPath = stateMarker(directory, { schemaVersion: 1, conversationKey })
    return { directory, conversationDirectory: directory, conversationKey, markerPath,
      sandboxStatePath: directory, chatWorkdir: ensurePrivateDirectory(resolve(directory, 'chat')),
      ...stageCodexHome(this.profile, directory) }
  }
  async _closeWarmChat(conversationKey) {
    const active = this.warmChatAdapters?.get(conversationKey)
    if (!active) return
    if (!active.idle && !active.adapter.closed) fail('TYPED_INSPECTION_CONVERSATION_IN_USE')
    if (active.closing) return active.closing
    this.chatAdapterLifecycle?.closing(active.adapter)
    active.closing = (async () => {
      try { await active.adapter.shutdown({ timeoutMs: 1000 }) }
      finally { await active.egress?.dispose() }
      if (active.emptyInputs) rmSync(active.emptyInputs, { recursive: true, force: true })
    })().catch(error => { active.closing = null; throw error })
    await active.closing
    if (this.warmChatAdapters.get(conversationKey) === active) this.warmChatAdapters.delete(conversationKey)
    if (this.conversationOwners?.get(conversationKey) === active.owner) this.conversationOwners.delete(conversationKey)
    if (this.idleWarmChatKey === conversationKey) this.idleWarmChatKey = null
  }
  async _closeIdleWarmChat(exceptKey = null) {
    if (this.idleWarmChatKey && this.idleWarmChatKey !== exceptKey) await this._closeWarmChat(this.idleWarmChatKey)
  }
  // One reusable idle engine per profile. An unresolved turn retains its own
  // owner until exact recovery; switching conversations never interrupts it.
  async openWarmChatAdapter(conversationKey, requestKey, { requireExistingState = false, schemaMeasurement = null, environment = {}, spawnFn = spawn } = {}) {
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    this._conversationDirectory(conversationKey)
    if (!nonblank(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    this.warmChatAdapters ||= new Map(); this.pendingWarmChats ||= new Map(); this.conversationOwners ||= new Map()
    if (this.pendingWarmChats.has(conversationKey)) fail('TYPED_INSPECTION_CONVERSATION_IN_USE')
    let active = this.warmChatAdapters.get(conversationKey)
    if (active && !active.idle && !(requireExistingState && active.requestKey === requestKey)) fail('TYPED_INSPECTION_CONVERSATION_IN_USE')
    await this._closeIdleWarmChat(conversationKey)
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    if (active?.closing) await active.closing
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    active = this.warmChatAdapters.get(conversationKey)
    if (active && !active.idle && !(requireExistingState && active.requestKey === requestKey)) fail('TYPED_INSPECTION_CONVERSATION_IN_USE')
    if (active && !active.adapter.closed) {
      active.idle = false; active.requestKey = requestKey
      if (this.idleWarmChatKey === conversationKey) this.idleWarmChatKey = null
      await this.chatAdapterLifecycle?.ready(active.adapter)
      return active.adapter
    }
    if (active) await this._closeWarmChat(conversationKey)
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    if (this.conversationOwners.has(conversationKey)) fail('TYPED_INSPECTION_CONVERSATION_IN_USE')
    const owner = Symbol(`warm:${conversationKey}`)
    this.conversationOwners.set(conversationKey, owner)
    const pending = (async () => {
      let adapter, engineState, egress, emptyInputs
      try {
        engineState = this._prepareConversationState(conversationKey, { requireExistingState })
        if (usesChatFiles(this.profile)) {
          const measured = await this.measure()
          if (!measured.contractReady) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_REQUIRED')
          emptyInputs = ensurePrivateDirectory(mkdtempSync(resolve(this.materializerRoot, '.warm-chat-')))
          egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl,
            networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs })
          await egress.start()
          if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
          adapter = await this._spawnAdapter({ inputDirectory: emptyInputs, engineState,
            schemaMeasurement: this.nativeReadback.schema, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
          await egress.bindOwner(adapter.child, this.bwrap)
          await egress.attach(); await this._initializeAndSeal(adapter)
        } else {
          adapter = await AppServerAdapter.spawnAsync({ ...this.profile, codexHome: engineState.codexHome }, {
            cwd: engineState.chatWorkdir, schemaMeasurement, shouldSpawn: () => !this.disposed,
            spawnFn: (binary, args, options) => spawnFn(binary, args, { ...options, env: { ...environment, ...options.env,
              HOME: resolve(engineState.directory, 'home'), CODEX_HOME: engineState.codexHome } }) })
          adapter.typedInspectionEngineState = engineState
          await adapter.verifySpawnedExecutable(); await adapter.initialize()
          const pid = adapter.readback.processExecutable?.pid
          if (!Number.isInteger(pid) || pid <= 0) fail('TYPED_INSPECTION_SANDBOX_PROCESS_REQUIRED')
          adapter.readback.credentialIsolation = sealCredential(engineState, pid)
        }
        if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
        if (!emptyMcpCatalog(adapter.readback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
        this.warmChatAdapters.set(conversationKey, { adapter, engineState, owner, requestKey, idle: false, egress, emptyInputs })
        await this.chatAdapterLifecycle?.ready(adapter)
        return adapter
      } catch (error) {
        await adapter?.shutdown({ timeoutMs: 1000 }).catch(() => {})
        await egress?.dispose().catch(() => {})
        if (emptyInputs) rmSync(emptyInputs, { recursive: true, force: true })
        if (engineState?.authPath) rmSync(engineState.authPath, { force: true })
        if (this.conversationOwners.get(conversationKey) === owner) this.conversationOwners.delete(conversationKey)
        throw error
      }
    })()
    this.pendingWarmChats.set(conversationKey, pending)
    try { return await pending } finally { this.pendingWarmChats.delete(conversationKey) }
  }
  async finishWarmChatAdapter(conversationKey, requestKey) {
    const active = this.warmChatAdapters?.get(conversationKey)
    if (this.disposed || !active || active.closing || active.requestKey !== requestKey) return false
    // Publish the idle slot before yielding. Concurrent recovery completions must
    // not each observe an empty slot and leave two reusable engines resident.
    const previousIdleKey = this.idleWarmChatKey
    active.idle = true
    this.idleWarmChatKey = conversationKey
    if (previousIdleKey && previousIdleKey !== conversationKey) await this._closeWarmChat(previousIdleKey)
    return true
  }
  async measure() {
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    if (this.measurement) return this.measurement
    if (usesChatFiles(this.profile)) {
      // CHAT now needs the same process-wide toolchain before material readiness,
      // not only in the later native-execution startup phase.
      await this.initializeToolchain(this)
      if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
      this.nativeToolchain = validateNativeExecutionToolchain(this.nativeToolchain)
    }
    const schemaMeasurement = await this.measureBinary(this.profile)
    const probeDirectory = mkdtempSync(resolve(this.materializerRoot, '.profile-probe-')); chmodSync(probeDirectory, 0o700)
    const probePath = resolve(probeDirectory, '.cyf-inspection-profile-probe.txt'); writeFileSync(probePath, 'typed-inspection-profile-probe\n', { mode: 0o400 }); chmodSync(probePath, 0o400)
    const outsideCanary = resolve(tmpdir(), `.cyf-inspection-outside-${randomUUID()}`); writeFileSync(outsideCanary, 'must-not-be-visible\n', { mode: 0o600 })
    const isolatedState = this._prepareEphemeralState('isolated'); let adapter
    try {
      adapter = await this._spawnAdapter({ inputDirectory: probeDirectory, engineState: isolatedState, schemaMeasurement, networkMode: 'isolated' })
      const isolatedReadback = await this._initializeAndSeal(adapter)
      if (!emptyMcpCatalog(isolatedReadback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      const view = verifyProcessView({ pid: isolatedReadback.processExecutable.pid, inputDirectory: probeDirectory, stateRoot: isolatedState.directory, sandboxStatePath: isolatedState.sandboxStatePath, sourceCodexHome: realpathSync(this.profile.codexHome), outsideCanary })
      const chatFileTools = usesChatFiles(this.profile) ? await measureChatFileTools(adapter, isolatedState) : null
      const toolchainDigest = chatFileTools ? canonicalSha256(this.nativeToolchain) : null
      const mounts = chatFileTools ? CHAT_FILE_MOUNTS : SANDBOX_MOUNTS
      let executionReadback = null; let executionNetworkAttestation = null
      if (this.profile.typedInspectionProviderNetwork === 'restricted-proxy') {
        const egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs })
        const executionState = this._prepareEphemeralState('execution')
        let executionAdapter
        try {
          await egress.start()
          executionAdapter = await this._spawnAdapter({ inputDirectory: probeDirectory, engineState: executionState, schemaMeasurement, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
          await egress.bindOwner(executionAdapter.child, this.bwrap); executionNetworkAttestation = await egress.attach()
          executionReadback = await this._initializeAndSeal(executionAdapter)
          const providerTls = await egress.measureAllowedTls(executionReadback.providerCaTrust)
          executionNetworkAttestation = Object.freeze({ ...executionNetworkAttestation, providerTls })
          if (!emptyMcpCatalog(executionReadback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
        } finally { await executionAdapter?.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress.dispose().catch(() => {}); rmSync(executionState.directory, { recursive: true, force: true }) }
      }
      const supportedInputs = exactSupportedInputs(this.profile.typedInspectionSupportedInputs)
      const profileId = String(this.profile.typedInspectionProfileId || `${this.profile.profileId}-typed-inspection-v1`)
      const engineContractId = String(this.profile.typedInspectionEngineContractId || 'codex-app-server-typed-inspection-v1')
      const networkPolicy = this.profile.typedInspectionProviderNetwork === 'restricted-proxy' ? restrictedProviderNetworkPolicy(this.profile.typedInspectionProviderBaseUrl, { connectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs }) : null
      const enginePolicyDigest = canonicalSha256({ schemaContractId: schemaMeasurement.schemaContractId, bundleSha256: schemaMeasurement.bundleSha256, binaryIdentityDigest: schemaMeasurement.binaryIdentityDigest, bwrap: bwrapPolicy(this.bwrap), mounts, ...(chatFileTools ? { toolchainDigest } : {}), networkPolicy, providerHttpRoute: 'respect_system_proxy=true/readback-required', providerCaTrustDigest: executionReadback?.providerCaTrust?.sha256 || null })
      const toolPolicyDigest = canonicalSha256({ policy: 'MANIFEST_READ_ONLY', mcpCatalogEmptyMeasured: true, mcpCatalogNotStrictNoToolsProof: true, webSearch: 'disabled', adapterDeniedRequests: 'command|file|permission|network|mcp|dynamic-tool|tool', bootstrapCredential: 'removed-before-model-turn', sandboxPolicy: chatFileTools ? { permissionProfile: CHAT_FILE_PERMISSION_PROFILE, tempWritable: true, networkAccess: false } : { type: 'readOnly', networkAccess: false }, filesystem: mounts, ...(chatFileTools ? { toolchainDigest, chatFileTools } : {}) })
      const inputPolicyDigest = canonicalSha256({ sourcesStrictlyOrdered: true, requestDirectoryReadOnly: true, supportedInputs })
      const binding = Object.freeze({ profileId, engineContractId, enginePolicyDigest, toolPolicyDigest, inputPolicyDigest })
      const nativeProbe = { schemaVersion: 1, schemaContractId: schemaMeasurement.schemaContractId, processExecutable: isolatedReadback.processExecutable, bwrap: this.bwrap, view, authSourceDigest: isolatedState.authDigest, isolatedConfigDigest: isolatedState.configDigest, credentialIsolation: isolatedReadback.credentialIsolation, executionNetworkReadback: executionNetworkAttestation, providerSystemProxyEnabled: executionReadback?.providerSystemProxy?.enabled === true, providerCaTrust: executionReadback?.providerCaTrust || null, modelCount: Array.isArray(isolatedReadback.models?.data) ? isolatedReadback.models.data.length : null, mcpCatalogCount: isolatedReadback.tools.data.length }
      const nativeAttestation = buildTypedInspectionNativeAttestation({ schemaMeasurement, bwrap: this.bwrap, view, isolatedConfigDigest: isolatedState.configDigest, mcpCatalogCount: isolatedReadback.tools.data.length, executionNetworkAttestation, chatFileTools, toolchainDigest })
      const nativeAttestationDigest = canonicalSha256(nativeAttestation)
      const providerModel = String(this.profile.chatModel || this.profile.codexModel || '')
      const carrierEvidence = loadTypedInspectionCarrierEvidence({ path: this.profile.typedInspectionCarrierEvidencePath,
        expectedDigest: this.profile.typedInspectionCarrierEvidenceDigest, binding, supportedInputs, nativeProbeDigest: nativeAttestationDigest,
        providerId: this.profile.typedInspectionProviderId, providerModel })
      this.nativeReadback = executionReadback
      this.contractReadback = carrierEvidence && executionReadback && executionNetworkAttestation ? Object.freeze({ schemaVersion: 1, measured: true, ...binding, toolPolicy: 'MANIFEST_READ_ONLY', recovery: 'durable-inbox-turn-readback-v1', supportedInputs }) : null
      this.measurement = Object.freeze({ schemaVersion: 1, measured: true, binding, supportedInputs, nativeProbe: Object.freeze(nativeProbe), nativeAttestation, nativeAttestationDigest, nativeProbeDigest: nativeAttestationDigest, carrierEvidence, providerExecutionNetwork: executionNetworkAttestation ? 'restricted-proxy-measured-no-paid-turn' : 'isolated-measurement-only', providerExecutionNetworkAttestation: executionNetworkAttestation, providerSystemProxyEnabled: nativeProbe.providerSystemProxyEnabled, providerCaTrustDigest: nativeProbe.providerCaTrust?.sha256 || null, contractReady: Boolean(this.contractReadback) })
      return this.measurement
    } finally {
      await adapter?.shutdown({ timeoutMs: 1000 }).catch(() => {})
      rmSync(isolatedState.directory, { recursive: true, force: true }); rmSync(probeDirectory, { recursive: true, force: true }); try { rmSync(outsideCanary, { force: true }) } catch {}
    }
  }
  async openAdapter(inputDirectory, requestKey = '', requestBinding = null, options = {}) {
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    this.pendingInspectionKeys ||= new Set(); this.pendingInspectionAdapters ||= new Map(); this.conversationOwners ||= new Map()
    if (this.closingAdapters?.has(requestKey)) fail('NATIVE_EXECUTION_ADAPTER_CLOSING')
    if (this.pendingInspectionKeys.has(requestKey) || this.pendingNativeAdapters?.has(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    if (this.activeAdapters.get(requestKey)?.adapter.closed) await this.releaseAdapter(requestKey, { preserveState: true })
    if (this.disposed || this.pendingInspectionKeys.has(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    const conversationKey = options.conversationKey ?? null
    // Recovery must locate its durable state before disturbing a healthy idle
    // chat. This read-only preflight does not stage credentials or create state.
    // _prepareRequestState remains the owner of safe staging/binding validation.
    if (options.requireExistingState) {
      const binding = engineStateBinding(requestBinding)
      if (binding.requestKey !== requestKey) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
      const directory = resolve(this.stateRoot, 'requests', canonicalSha256(binding).slice('sha256:'.length))
      const required = [resolve(directory, 'binding.json')]
      if (conversationKey !== null) required.push(resolve(directory, 'conversation-binding.json'),
        resolve(this._conversationDirectory(conversationKey), 'binding.json'), resolve(this._conversationDirectory(conversationKey), 'codex-home'))
      else required.push(resolve(directory, 'codex-home'))
      if (required.some(path => !existsSync(path))) fail('TYPED_INSPECTION_RECOVERY_STATE_MISSING')
    }
    if (conversationKey && this.warmChatAdapters?.has(conversationKey)) await this._closeWarmChat(conversationKey)
    if (this.idleWarmChatKey) await this._closeIdleWarmChat()
    if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED')
    if (conversationKey !== null && !/^sha256:[a-f0-9]{64}$/.test(conversationKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    if (conversationKey && this.conversationOwners.has(conversationKey) && this.conversationOwners.get(conversationKey) !== requestKey)
      fail('TYPED_INSPECTION_CONVERSATION_IN_USE')
    this.pendingInspectionKeys.add(requestKey)
    if (conversationKey) this.conversationOwners.set(conversationKey, requestKey)
    const pending = this._openInspectionAdapter(inputDirectory, requestKey, requestBinding, { ...options, conversationKey })
    this.pendingInspectionAdapters.set(requestKey, pending)
    try { return await pending }
    finally {
      this.pendingInspectionKeys.delete(requestKey); this.pendingInspectionAdapters.delete(requestKey)
      if (conversationKey && this.activeAdapters.get(requestKey)?.engineState.conversationKey !== conversationKey && this.conversationOwners.get(conversationKey) === requestKey) this.conversationOwners.delete(conversationKey)
    }
  }
  async _openInspectionAdapter(inputDirectory, requestKey = '', requestBinding = null, { requireExistingState = false, conversationKey = null } = {}) {
    const checkActive = () => { if (this.disposed) fail('TYPED_INSPECTION_PROFILE_DISPOSED') }
    const measurement = await this.measure(); checkActive(); if (!measurement.contractReady) fail('TYPED_INSPECTION_CARRIER_EVIDENCE_REQUIRED')
    if (this.profile.typedInspectionProviderNetwork !== 'restricted-proxy') fail('TYPED_INSPECTION_PROVIDER_NETWORK_NOT_CONFIGURED')
    if (!nonblank(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_INVALID')
    if (this.pendingNativeAdapters?.has(requestKey)) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    const binding = engineStateBinding(requestBinding); const bindingDigest = canonicalSha256(binding)
    if (binding.requestKey !== requestKey) fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    if (requestKey && this.activeAdapters.has(requestKey)) {
      const active = this.activeAdapters.get(requestKey)
      if (!active.nativeLayout && !active.adapter.closed && active.inputDirectory === realpathSync(inputDirectory)
          && active.engineState.bindingDigest === bindingDigest && (active.engineState.conversationKey ?? null) === conversationKey) return active.adapter
      fail('TYPED_INSPECTION_ENGINE_STATE_BINDING_CONFLICT')
    }
    const engineState = this._prepareRequestState(binding, { requireExistingState, conversationKey })
    const egress = this.egressFactory({ providerBaseUrl: this.profile.typedInspectionProviderBaseUrl, networkConnectTimeoutMs: this.profile.typedInspectionNetworkConnectTimeoutMs })
    let adapter
    try {
      await egress.start(); checkActive()
      adapter = await this._spawnAdapter({ inputDirectory, engineState, schemaMeasurement: this.nativeReadback.schema, networkMode: 'provider-restricted', proxyUrl: egress.proxyUrl })
      checkActive(); await egress.bindOwner(adapter.child, this.bwrap); await egress.attach(); checkActive(); await this._initializeAndSeal(adapter); checkActive()
      if (!emptyMcpCatalog(adapter.readback.tools)) fail('TYPED_INSPECTION_NATIVE_MCP_CATALOG_NOT_EMPTY')
      this.suspendedNativeStates?.delete(requestKey)
      this.activeAdapters.set(requestKey, { adapter, egress, engineState, inputDirectory: realpathSync(inputDirectory) })
      if (conversationKey) await this.chatAdapterLifecycle?.ready(adapter)
      adapter.once('exit', () => {
        // Retain ownership until shutdown/egress cleanup is joined; a new request
        // must not open the same durable Home while this process is still dying.
        void egress.dispose().catch(() => {})
      })
      return adapter
    } catch (error) {
      await adapter?.shutdown({ timeoutMs: 1000 }).catch(() => {}); await egress.dispose().catch(() => {})
      if (engineState.authPath) rmSync(engineState.authPath, { force: true })
      if (engineState.created) rmSync(engineState.directory, { recursive: true, force: true })
      throw error
    }
  }
  // Native execution is NOT authorized by the read-only carrier evidence.
  // The caller supplies an API-authorized execution/tool binding and pinned
  // package/toolchain bytes; this path measures its own actual engine view.
  mapInputPath(hostPath, inputDirectory) {
    const root = realpathSync(inputDirectory); const path = realpathSync(hostPath); if (!within(root, path)) fail('TYPED_INSPECTION_INPUT_PATH_OUTSIDE_REQUEST')
    return resolve('/inputs', path.slice(root.length + 1))
  }
  // Capability measurement, not an execution authorization. Each call uses an
  // isolated disposable request and never starts a model turn.
  declaration() {
    if (!this.contractReadback) return null
    return Object.freeze({ schemaVersion: 1, contract: 'juyiting-typed-inspection-v1', enabled: true, profileId: this.contractReadback.profileId,
      engineContractId: this.contractReadback.engineContractId, enginePolicyDigest: this.contractReadback.enginePolicyDigest,
      toolPolicyDigest: this.contractReadback.toolPolicyDigest, inputPolicyDigest: this.contractReadback.inputPolicyDigest,
      toolPolicy: this.contractReadback.toolPolicy, recovery: this.contractReadback.recovery, supportedInputs: this.contractReadback.supportedInputs })
  }
}
