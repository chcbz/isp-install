import { skillDigest } from './skill-executor.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value)
const exact = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const digest = skillDigest
const identity = manifest => JSON.stringify([manifest.skillKey, manifest.skillVersion])
const fenceFields = ['installationId', 'hostId', 'runtimeInstanceId', 'sessionGeneration']
const runners = new Set(['provider-operation', 'local-script', 'native-model'])
const code = value => exact(value) && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'SKILL_DEPENDENCY_UNAVAILABLE'

/** Small measured directory, not a second install registry, permission service or scheduler.
 * Runner/tool/binding probes are trusted deployment adapters, never loaded from a skill package.
 * No provider calls, pricing, approval or speculative readiness in this module. */
export class SkillRegistry {
  constructor({ scope, loadInstalled, runnerRegistry = new Map(), toolProbes = new Map(), resolveBinding = null }) {
    const fields = ['tenantId', 'clientId', 'ownerJiacn', 'agentId']
    if (!object(scope) || fields.some(field => !exact(scope[field]))) fail('SKILL_SCOPE_INVALID')
    if (typeof loadInstalled !== 'function') fail('SKILL_INSTALL_SOURCE_REQUIRED')
    this.scope = Object.freeze(Object.fromEntries(fields.map(field => [field, scope[field]])))
    this.loadInstalled = loadInstalled
    this.runners = new Map(runnerRegistry)
    this.tools = new Map(toolProbes)
    this.resolveBinding = resolveBinding
    this.fence = null; this.epoch = 0; this.ticket = 0; this.revision = 0n
    this.cached = null; this.entries = new Map(); this.fingerprint = null; this.lastErrorCode = null
  }

  setSession(fence) {
    if (fence !== null && (!object(fence) || fenceFields.slice(0, 3).some(field => !exact(fence[field]))
        || !Number.isSafeInteger(fence.sessionGeneration) || fence.sessionGeneration <= 0)) fail('SKILL_SESSION_INVALID')
    const next = fence === null ? null : Object.freeze(Object.fromEntries(fenceFields.map(field => [field, fence[field]])))
    if (JSON.stringify(next) === JSON.stringify(this.fence)) return false
    this.fence = next; this.invalidate(); return true
  }

  invalidate() {
    this.epoch++; this.cached = null; this.entries = new Map(); this.lastErrorCode = null
  }

  /** Heartbeat/presence reads do no filesystem/tool/network work. */
  declaration() { return this.cached }

  async refresh() {
    const fence = this.fence, epoch = this.epoch, ticket = ++this.ticket
    if (!fence) { this.cached = null; this.entries = new Map(); return null }
    const current = () => this.fence === fence && this.epoch === epoch && this.ticket === ticket
    try {
      const installed = await this.loadInstalled()
      if (!Array.isArray(installed)) fail('SKILL_INSTALL_SOURCE_INVALID')
      const rows = installed.filter(row => row.manifest !== null).map(row => freeze(structuredClone(row)))
      const counts = new Map()
      for (const row of rows) {
        if (!object(row.manifest) || !exact(row.installationId) || !hash(row.packageSha256)
            || !hash(row.manifestSha256) || row.manifest.manifestSha256 !== row.manifestSha256
            || !runners.has(row.manifest.runner)) fail('SKILL_INSTALL_SOURCE_INVALID')
        const key = identity(row.manifest); counts.set(key, (counts.get(key) || 0) + 1)
      }
      const tools = new Map(), bindings = new Map(), entries = new Map(), publicItems = []
      for (const row of rows.sort((a, b) => identity(a.manifest) < identity(b.manifest) ? -1 : identity(a.manifest) === identity(b.manifest) ? 0 : 1)) {
        if (entries.has(identity(row.manifest))) continue
        const manifest = row.manifest
        let reasonCode = counts.get(identity(manifest)) !== 1 ? 'SKILL_INSTALLATION_AMBIGUOUS' : null
        let toolchainDigest = null, bindingRevision = null, binding = null
        const measured = []
        const context = Object.freeze({ scope: this.scope, fence, skillKey: manifest.skillKey,
          skillVersion: manifest.skillVersion, entrypoint: manifest.entrypoint, inputMimeTypes: manifest.inputs.acceptedMimeTypes, packageRoot: row.packageRoot, packageTreeDigest: row.packageTreeDigest })
        const runner = this.runners.get(manifest.runner)
        if (!reasonCode && (typeof runner?.run !== 'function' || typeof runner?.probe !== 'function')) reasonCode = 'SKILL_RUNNER_MISSING'
        if (!reasonCode) {
          const probe = await runner.probe(context)
          if (probe?.ready !== true || !hash(probe.digest)) reasonCode = code(probe?.reasonCode)
          else measured.push({ runner: manifest.runner, digest: probe.digest })
        }
        for (const name of manifest.requirements.tools || []) {
          if (reasonCode) break
          if (!tools.has(name)) tools.set(name, Promise.resolve().then(() => this.tools.get(name)?.({ scope: this.scope, fence })))
          const probe = await tools.get(name)
          if (probe?.ready !== true || !hash(probe.digest)) reasonCode = 'SKILL_TOOL_MISSING'
          else measured.push({ tool: name, digest: probe.digest })
        }
        const alias = manifest.requirements.providerAlias
        if (!reasonCode && (alias || manifest.runner === 'provider-operation')) {
          if (!alias || typeof this.resolveBinding !== 'function') reasonCode = 'SKILL_PROVIDER_BINDING_MISSING'
          else {
            if (!bindings.has(alias)) bindings.set(alias, Promise.resolve().then(() => this.resolveBinding({ scope: this.scope, fence, alias })))
            const probe = await bindings.get(alias)
            if (probe?.ready !== true || Object.entries(this.scope).some(([key, value]) => probe.scope?.[key] !== value) || !exact(probe.bindingId) || !exact(probe.revision) || !hash(probe.digest)) reasonCode = 'SKILL_PROVIDER_BINDING_UNAVAILABLE'
            else { bindingRevision = probe.revision; binding = Object.freeze({ bindingId: probe.bindingId, revision: probe.revision, digest: probe.digest }) }
          }
        }
        if (!reasonCode) toolchainDigest = digest(measured)
        const item = freeze({ skillKey: manifest.skillKey, skillVersion: manifest.skillVersion,
          packageSha256: row.packageSha256, manifestSha256: row.manifestSha256, runner: manifest.runner,
          readiness: reasonCode ? 'UNAVAILABLE' : 'READY', reasonCode, toolchainDigest, bindingRevision })
        publicItems.push(item)
        // No endpoint/token/fee data in the cache identity or public declaration.
        const cacheKey = digest({ scope: this.scope, fence, installationId: row.installationId,
          packageSha256: row.packageSha256, manifestSha256: row.manifestSha256, toolchainDigest, binding })
        entries.set(identity(manifest), Object.freeze({ cacheKey, item, descriptor: row, binding }))
      }
      if (!current()) return null
      const fingerprint = digest({ scope: this.scope, fence, items: publicItems,
        cacheKeys: [...entries.values()].map(entry => entry.cacheKey) })
      if (fingerprint !== this.fingerprint) this.revision++
      this.fingerprint = fingerprint; this.entries = entries; this.lastErrorCode = null
      this.cached = freeze({ schemaVersion: 1, catalogRevision: String(this.revision), skills: publicItems })
      return this.cached
    } catch {
      if (current()) { this.cached = null; this.entries = new Map(); this.lastErrorCode = 'SKILL_CATALOG_UNAVAILABLE' }
      return null
    }
  }

  /** Execution-side guard remeasures the same immutable descriptor and dependencies.
   * The caller must independently validate the server command's scope/lease/grant. */
  async requireExact(skill, { toolchainDigest, bindingRevision, allowUnavailable = false } = {}) {
    if (!await this.refresh()) fail('SKILL_EXECUTION_BINDING_CHANGED')
    const entry = skill && this.entries.get(identity(skill))
    if (!entry || (!allowUnavailable && entry.item.readiness !== 'READY')
        || entry.item.packageSha256 !== skill.packageSha256 || entry.item.manifestSha256 !== skill.manifestSha256
        || (toolchainDigest !== undefined && entry.item.toolchainDigest !== toolchainDigest) || (bindingRevision !== undefined && entry.item.bindingRevision !== bindingRevision)) fail('SKILL_EXECUTION_BINDING_CHANGED')
    return entry
  }
}
