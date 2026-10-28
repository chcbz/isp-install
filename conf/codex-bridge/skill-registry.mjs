import { skillDigest } from './skill-executor.mjs'
import { validateManagement, validateNativeTaskSkillBinding } from './skill-management-wire.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value)
const exact = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const identity = manifest => JSON.stringify([manifest.skillKey, manifest.skillVersion])
const fenceFields = ['installationId', 'hostId', 'runtimeInstanceId', 'sessionGeneration']
const code = value => value === 'PROVIDER_UNBOUND' ? value : 'DEPENDENCY_MISSING'

/** Current authenticated discovery view + exact retained execution lookup, not a
 * second installer/ACL. Only a server-authorized TaskSkillBinding selects history. */
export class SkillRegistry {
  constructor({ scope, loadInstalled, loadRetained = loadInstalled, runnerRegistry = new Map(), toolProbes = new Map(), now = Date.now }) {
    const fields = ['tenantId', 'clientId', 'ownerJiacn', 'agentId']
    if (!object(scope) || fields.some(field => !exact(scope[field]))) fail('SKILL_SCOPE_INVALID')
    if (typeof loadInstalled !== 'function' || typeof loadRetained !== 'function') fail('SKILL_INSTALL_SOURCE_REQUIRED')
    this.scope = Object.freeze(Object.fromEntries(fields.map(field => [field, scope[field]])))
    Object.assign(this, { loadInstalled, loadRetained, now })
    this.runners = new Map(runnerRegistry); this.tools = new Map(toolProbes)
    this.fence = null; this.epoch = 0; this.ticket = 0; this.revision = 0n
    this.cached = null; this.entries = new Map(); this.fingerprint = null; this.lastErrorCode = null
  }
  setSession(fence) {
    if (fence !== null && (!object(fence) || fenceFields.slice(0, 3).some(field => !exact(fence[field]))
        || typeof fence.sessionGeneration !== 'string' || !/^[1-9][0-9]*(?![\s\S])/.test(fence.sessionGeneration)
        || BigInt(fence.sessionGeneration) > 9223372036854775807n)) fail('SKILL_SESSION_INVALID')
    const next = fence === null ? null : Object.freeze(Object.fromEntries(fenceFields.map(field => [field, fence[field]])))
    if (JSON.stringify(next) === JSON.stringify(this.fence)) return false
    this.fence = next; this.invalidate(); return true
  }
  invalidate() { this.epoch++; this.cached = null; this.entries = new Map(); this.lastErrorCode = null }
  declaration() { return this.cached }

  async measureInstallation(input, fence = this.fence, { tools = new Map() } = {}) {
    if (!fence) fail('SKILL_SESSION_INVALID')
    const row = freeze(structuredClone(input)), manifest = row.manifest
    if (!exact(row.skillInstallationId) || !exact(row.productVersionId) || !exact(row.skillKey) || !exact(row.skillVersion)
        || !hash(row.packageSha256) || !['EXECUTABLE', 'INSTRUCTION'].includes(row.kind)) fail('SKILL_INSTALL_SOURCE_INVALID')
    if (row.kind === 'INSTRUCTION' ? manifest !== null || row.manifestSha256 !== null : !object(manifest)
        || !hash(row.manifestSha256) || manifest.manifestSha256 !== row.manifestSha256
        || manifest.skillKey !== row.skillKey || manifest.skillVersion !== row.skillVersion) fail('SKILL_INSTALL_SOURCE_INVALID')
    let reasonCode = null, toolchainDigest = null, bindingRevision = null, binding = null
    const measured = []
    if (manifest) {
      const context = Object.freeze({ scope: this.scope, fence, skillKey: row.skillKey, skillVersion: row.skillVersion,
        entrypoint: manifest.entrypoint, inputMimeTypes: manifest.inputs.acceptedMimeTypes,
        packageRoot: row.packageRoot, packageTreeDigest: row.packageTreeDigest })
      // Only the archive reconciler's local-script path remains supported.
      // Unknown/retired EXECUTABLE semantics are not ordinary native skills.
      const runner = manifest.runner === 'local-script' ? this.runners.get('local-script') : null
      if (typeof runner?.run !== 'function' || typeof runner?.probe !== 'function') reasonCode = 'DEPENDENCY_MISSING'
      if (!reasonCode) {
        const probe = await Promise.resolve().then(() => runner.probe(context)).catch(() => null)
        if (probe?.ready !== true || !hash(probe.digest)) reasonCode = code(probe?.reasonCode)
        else measured.push({ runner: manifest.runner, digest: probe.digest })
      }
      for (const name of manifest.requirements.tools || []) {
        if (reasonCode) break
        if (!tools.has(name)) tools.set(name, Promise.resolve().then(() => this.tools.get(name)?.({ scope: this.scope, fence })))
        const probe = await tools.get(name).catch(() => null)
        if (probe?.ready !== true || !hash(probe.digest)) reasonCode = 'DEPENDENCY_MISSING'
        else measured.push({ tool: name, digest: probe.digest })
      }
      // Provider bindings belong to the retired runner protocol, not native discovery.
      if (!reasonCode && manifest.requirements.providerAlias) reasonCode = 'DEPENDENCY_MISSING'
      if (!reasonCode) toolchainDigest = skillDigest(measured)
    }
    const item = freeze({ skillKey: row.skillKey, skillInstallationId: row.skillInstallationId, productVersionId: row.productVersionId,
      skillVersion: row.skillVersion, packageSha256: row.packageSha256, manifestSha256: row.manifestSha256, kind: row.kind,
      policyRevision: row.policyRevision, enabled: row.enabled, runner: manifest?.runner || null,
      readiness: !manifest ? 'NOT_EXECUTABLE' : reasonCode ? reasonCode === 'PROVIDER_UNBOUND' ? 'PROVIDER_UNBOUND' : 'DEPENDENCY_MISSING' : 'READY',
      reasonCode, toolchainDigest, bindingRevision, observedAt: this.now() })
    validateManagement('SkillCapability', item)
    const cacheKey = skillDigest({ scope: this.scope, fence, skillInstallationId: row.skillInstallationId,
      packageSha256: row.packageSha256, manifestSha256: row.manifestSha256, toolchainDigest, binding })
    return freeze({ cacheKey, item, descriptor: row, binding })
  }
  async refresh() {
    const fence = this.fence, epoch = this.epoch, ticket = ++this.ticket
    if (!fence) { this.cached = null; this.entries = new Map(); return null }
    const current = () => this.fence === fence && this.epoch === epoch && this.ticket === ticket
    try {
      const installed = await this.loadInstalled()
      if (!Array.isArray(installed)) fail('SKILL_INSTALL_SOURCE_INVALID')
      const entries = new Map(), publicItems = [], shared = { tools: new Map() }
      for (const row of installed.sort((a, b) => Buffer.compare(Buffer.from(a.skillKey), Buffer.from(b.skillKey)))) {
        const entry = await this.measureInstallation(row, fence, shared), key = identity(entry.item)
        if (entries.has(key)) fail('SKILL_INSTALLATION_AMBIGUOUS')
        entries.set(key, entry); publicItems.push(entry.item)
      }
      if (!current()) return null
      // observedAt is measurement time, not a configuration change or a new policy revision.
      const fingerprint = skillDigest({ scope: this.scope, fence, items: publicItems.map(({ observedAt, ...item }) => item),
        cacheKeys: [...entries.values()].map(entry => entry.cacheKey) })
      if (fingerprint !== this.fingerprint) this.revision++
      this.fingerprint = fingerprint; this.entries = entries; this.lastErrorCode = null
      this.cached = freeze({ schemaVersion: 2, catalogRevision: String(this.revision), skills: publicItems })
      validateManagement('SkillExecutionDeclaration', this.cached)
      return this.cached
    } catch {
      if (current()) { this.cached = null; this.entries = new Map(); this.lastErrorCode = 'SKILL_CATALOG_UNAVAILABLE' }
      return null
    }
  }
  // Resolve only the API-authorized immutable package. Installation storage
  // verifies its tree/marker; readiness and tool authorization are separate.
  // Do not use this method to grant tool, network or Provider permissions.
  async requireNativePackage(skill, { taskBinding } = {}) {
    const fence = this.fence, epoch = this.epoch
    if (!fence || !taskBinding || !object(skill)) fail('SKILL_EXECUTION_BINDING_CHANGED')
    validateNativeTaskSkillBinding(taskBinding)
    const fields = ['skillKey', 'skillVersion', 'packageSha256', 'manifestSha256']
    if (taskBinding.agentId !== this.scope.agentId || fields.some(key => taskBinding[key] !== skill[key])) fail('SKILL_EXECUTION_BINDING_CHANGED')
    const rows = await this.loadRetained(taskBinding.skillInstallationId)
    if (!Array.isArray(rows)) fail('SKILL_EXECUTION_BINDING_CHANGED')
    const matches = rows.filter(row => row.skillInstallationId === taskBinding.skillInstallationId)
    if (matches.length !== 1) fail('SKILL_EXECUTION_BINDING_CHANGED')
    const row = matches[0]
    if ([...fields, 'productVersionId', 'approvedPermissionsSha256'].some(key => row[key] !== taskBinding[key])
        || !exact(row.packageRoot) || !hash(row.packageTreeDigest)
        || row.kind !== 'INSTRUCTION' || row.manifest !== null || row.manifestSha256 !== null
        || this.fence !== fence || this.epoch !== epoch) fail('SKILL_EXECUTION_BINDING_CHANGED')
    return freeze({ descriptor: structuredClone(row) })
  }
  async requireExact(skill, { toolchainDigest, bindingRevision, allowUnavailable = false, taskBinding = null } = {}) {
    const fence = this.fence, epoch = this.epoch
    if (!fence) fail('SKILL_EXECUTION_BINDING_CHANGED')
    let entry
    if (taskBinding) {
      validateManagement('TaskSkillBinding', taskBinding)
      if (taskBinding.agentId !== this.scope.agentId || ['skillKey', 'skillVersion', 'packageSha256', 'manifestSha256'].some(key => taskBinding[key] !== skill[key])) fail('SKILL_EXECUTION_BINDING_CHANGED')
      const rows = (await this.loadRetained(taskBinding.skillInstallationId)).filter(row => row.skillInstallationId === taskBinding.skillInstallationId)
      if (rows.length !== 1 || ['productVersionId', 'packageSha256', 'manifestSha256', 'approvedPermissionsSha256'].some(key => rows[0][key] !== taskBinding[key])) fail('SKILL_EXECUTION_BINDING_CHANGED')
      // New management revisions/enabled state cannot revoke an already authorized exact task.
      entry = await this.measureInstallation(rows[0], fence)
    } else {
      if (!await this.refresh()) fail('SKILL_EXECUTION_BINDING_CHANGED')
      entry = skill && this.entries.get(identity(skill))
      if (!entry?.item.enabled) fail('SKILL_EXECUTION_BINDING_CHANGED')
    }
    if (this.fence !== fence || this.epoch !== epoch || !entry || (!allowUnavailable && entry.item.readiness !== 'READY')
        || entry.item.packageSha256 !== skill.packageSha256 || entry.item.manifestSha256 !== skill.manifestSha256
        || (toolchainDigest !== undefined && entry.item.toolchainDigest !== toolchainDigest)
        || (bindingRevision !== undefined && entry.item.bindingRevision !== bindingRevision)) fail('SKILL_EXECUTION_BINDING_CHANGED')
    return entry
  }
}
