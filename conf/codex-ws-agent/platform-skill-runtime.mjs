import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ARCHIVE_MAINTENANCE_PROTOCOL, ARCHIVE_MAINTENANCE_TYPE } from './archive-maintenance-native.mjs'
import { defaultArchiveMaintenanceCheckpointRoot } from './archive-maintenance-checkpoints.mjs'
import { ArchiveMaintenanceRunner } from './archive-maintenance-runner.mjs'
import { LINUX_ATOMIC_FS } from './skill-install-manager.mjs'
import { PlatformSkillManager, defaultPlatformSkillStateRoot } from './platform-skill-manager.mjs'

export const PLATFORM_SKILL_PROTOCOL = 'PLATFORM_SKILL_INSTALL/v1'

let productionAvailability = null

export const platformSkillRuntimeAvailable = () => {
  if (productionAvailability !== null) return productionAvailability
  if (process.platform !== 'linux') return (productionAvailability = false)
  let root = ''
  try {
    // Exercise the same Python/libc renameat2 bridge used by activation instead of
    // inferring support from a callable factory or architecture name.
    root = mkdtempSync(resolve(tmpdir(), 'cyf-platform-skill-probe-'))
    const source = resolve(root, 'source')
    const target = resolve(root, 'target')
    mkdirSync(source, { mode: 0o700 })
    const moved = LINUX_ATOMIC_FS.renameNoReplace(source, target)
    if (!moved?.ok || existsSync(source) || !lstatSync(target).isDirectory()) return (productionAvailability = false)
    const second = resolve(root, 'second')
    mkdirSync(second, { mode: 0o700 })
    const blocked = LINUX_ATOMIC_FS.renameNoReplace(second, target)
    productionAvailability = blocked?.ok === false && blocked.code === 'TARGET_EXISTS' && existsSync(second)
    return productionAvailability
  } catch {
    return (productionAvailability = false)
  } finally {
    if (root) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
  }
}

const unavailable = (message, status = 'failed') => ({
  status,
  exitCode: null,
  commandId: message?.commandId || '',
  taskId: message?.taskId || message?.workItemId || message?.commandId || '',
  workItemId: message?.workItemId || '',
  errorMessage: status === 'recovery_required'
    ? 'CONTROLLED_COMMAND_RECOVERY_REQUIRED: verified native runtime is unavailable'
    : 'CONTROLLED_COMMAND_UNAVAILABLE: verified native runtime is not registered'
})

/**
 * One live-socket adapter. It owns no credential: every native call asks the
 * registration observer for the current process-memory authorization header.
 */
export class PlatformSkillRuntime {
  constructor({
    profile,
    commandInboxDir,
    wsUrl,
    enabled = false,
    archiveEnabled = false,
    authorizationProvider = () => '',
    managerFactory = options => new PlatformSkillManager(options),
    archiveRunnerFactory = options => new ArchiveMaintenanceRunner(options),
    availability = platformSkillRuntimeAvailable,
    archiveAvailability = platformSkillRuntimeAvailable,
    managerOptions = {},
    archiveOptions = {}
  }) {
    this.profile = profile
    this.commandInboxDir = commandInboxDir
    this.wsUrl = wsUrl
    this.enabled = enabled === true
    this.archiveEnabled = archiveEnabled === true
    this.authorizationProvider = authorizationProvider
    this.managerFactory = managerFactory
    this.archiveRunnerFactory = archiveRunnerFactory
    this.available = (this.enabled || this.archiveEnabled) && typeof availability === 'function' && availability() === true
    this.archiveAvailable = this.archiveEnabled && typeof archiveAvailability === 'function' && archiveAvailability() === true
    this.managerOptions = managerOptions
    this.archiveOptions = archiveOptions
    this.generation = 0
    this.controller = null
    this.manager = null
    this.archiveRunner = null
    this.ready = false
  }

  get supported() { return this.available && typeof this.managerFactory === 'function' }
  get archiveSupported() { return this.supported && this.archiveAvailable && typeof this.archiveRunnerFactory === 'function' }
  get commandProtocols() {
    const protocols = []
    if (this.enabled && this.supported) protocols.push(PLATFORM_SKILL_PROTOCOL)
    if (this.archiveEnabled && this.archiveSupported) protocols.push(ARCHIVE_MAINTENANCE_PROTOCOL)
    return Object.freeze(protocols)
  }

  disconnect(reason = 'socket disconnected') {
    this.generation += 1
    this.ready = false
    this.archiveRunner = null
    this.manager = null
    if (this.controller && !this.controller.signal.aborted) this.controller.abort(new Error(reason))
    this.controller = null
  }

  async activateAndRecover(runtimeScope) {
    this.disconnect('socket registration rotated')
    if (!this.commandProtocols.length || !this.supported) return { active: false, recovered: [] }
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const stateRoot = defaultPlatformSkillStateRoot(this.commandInboxDir, this.profile,
      runtimeScope, this.wsUrl)
    const manager = this.managerFactory({
      ...this.managerOptions,
      profile: this.profile,
      runtimeScope,
      stateRoot,
      wsUrl: this.wsUrl,
      enabled: this.enabled,
      authorizationProvider: arguments_ => {
        if (controller.signal.aborted || generation !== this.generation) throw controller.signal.reason || new Error('socket registration rotated')
        const authorization = this.authorizationProvider(arguments_)
        if (!/^AgentRuntime [0-9a-f]{32}$/u.test(authorization || '')) throw new Error('registered runtime authorization is unavailable')
        return authorization
      },
      sessionSignal: controller.signal
    })
    manager.initialize()
    this.manager = manager
    const recovered = []
    if (this.enabled) {
      // Each page is bounded by the manager. Yield between pages and re-check the
      // live socket generation; do not report recovery complete while records remain.
      while (true) {
        if (controller.signal.aborted || generation !== this.generation || this.manager !== manager) {
          return { active: false, stale: true, recovered }
        }
        const batch = await manager.replayPending()
        recovered.push(...batch)
        const complete = manager.replayPendingComplete
        if (complete === true || (complete === undefined && batch.length < manager.maxReplayBatch)) break
        await new Promise(resolvePromise => setImmediate(resolvePromise))
      }
    }
    if (controller.signal.aborted || generation !== this.generation || this.manager !== manager) {
      return { active: false, stale: true, recovered }
    }
    if (this.archiveEnabled && this.archiveSupported) {
      this.archiveRunner = this.archiveRunnerFactory({
        ...this.archiveOptions,
        runtimeScope,
        wsUrl: this.wsUrl,
        authorizationProvider: () => {
          if (controller.signal.aborted || generation !== this.generation) throw controller.signal.reason || new Error('socket registration rotated')
          return this.authorizationProvider()
        },
        platformSkillManager: manager,
        checkpointRoot: defaultArchiveMaintenanceCheckpointRoot(this.commandInboxDir, this.profile),
        checkpointProfileId: this.profile.profileId,
        sessionSignal: controller.signal
      })
    }
    this.ready = true
    return { active: true, recovered }
  }

  async recoverArchiveCommands(messages) {
    const runner = this.archiveRunner
    if (!this.ready || !runner || this.controller?.signal.aborted) return []
    const outcomes = await runner.recover(messages)
    if (this.controller?.signal.aborted || runner !== this.archiveRunner) return []
    return outcomes
  }

  async execute(message) {
    if (!this.ready || !this.manager || this.controller?.signal.aborted) return unavailable(message)
    const generation = this.generation
    const controller = this.controller
    const manager = this.manager
    const archiveRunner = this.archiveRunner
    let result
    if (message?.commandType === 'PLATFORM_SKILL_INSTALL') {
      if (!this.enabled) return unavailable(message)
      result = await manager.execute(message)
    } else if (message?.commandType === ARCHIVE_MAINTENANCE_TYPE) {
      if (!this.archiveEnabled || !archiveRunner) return unavailable(message)
      try { result = await archiveRunner.execute(message) } catch { result = unavailable(message, 'recovery_required') }
    } else return unavailable(message)
    if (controller?.signal.aborted || generation !== this.generation || controller !== this.controller
        || manager !== this.manager || (message?.commandType === ARCHIVE_MAINTENANCE_TYPE && archiveRunner !== this.archiveRunner)) {
      return { ...unavailable(message, 'recovery_required'), errorMessage: 'CONTROLLED_COMMAND_RECOVERY_REQUIRED: socket registration rotated' }
    }
    return { ...result, exitCode: result.status === 'completed' ? 0 : result.exitCode ?? null }
  }

  reconcileCommandOutcome(message) {
    if (!this.ready || !this.manager || this.controller?.signal.aborted) return null
    if (message?.commandType === ARCHIVE_MAINTENANCE_TYPE) return this.archiveRunner?.reconcileCommandOutcome(message) || null
    return this.manager.reconcileCommandOutcome(message)
  }
}
