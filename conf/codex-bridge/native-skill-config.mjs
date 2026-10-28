// Customer-owned per-installation configuration. No Provider protocol or global
// environment lookup; only packages already authorized for this execution enter.
import { constants, openSync, closeSync, readFileSync, fstatSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseSkillJson } from './skill-manifest.mjs'
import { skillDigest, NATIVE_SKILL_SCRIPT_POLICY } from './skill-executor.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scopeKeys = ['tenantId', 'ownerJiacn', 'clientId', 'agentId']
export { NATIVE_SKILL_SCRIPT_POLICY }
export function nativeSkillOrigins(values) {
  if (!Array.isArray(values)) fail('NATIVE_SKILL_NETWORK_INVALID')
  const origins = values.map(value => {
    let url; try { url = new URL(value) } catch { fail('NATIVE_SKILL_NETWORK_INVALID') }
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value || url.username || url.password) fail('NATIVE_SKILL_NETWORK_INVALID')
    return value
  })
  return Object.freeze([...new Set(origins)].sort())
}
export function loadNativeSkillConfiguration({ file, scope, command, entries }) {
  if (command.toolPolicyRef !== NATIVE_SKILL_SCRIPT_POLICY || !entries.length || !file) return Object.freeze([])
  let config
  try {
    if (!isAbsolute(file) || realpathSync(file) !== resolve(file)) fail('NATIVE_SKILL_CONFIG_UNSAFE')
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd, { bigint: true })
      if (!before.isFile() || before.uid !== BigInt(process.geteuid()) || (before.mode & 0o777n) !== 0o600n) fail('NATIVE_SKILL_CONFIG_UNSAFE')
      config = parseSkillJson(readFileSync(fd))
      const after = fstatSync(fd, { bigint: true })
      if (['size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('NATIVE_SKILL_CONFIG_CHANGED')
    } finally { closeSync(fd) }
  } catch (error) {
    // A configured file can disappear or become unreadable during customer
    // maintenance. Scope that I/O failure to this execution, not the whole poll.
    if (typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code)) fail('NATIVE_SKILL_CONFIG_UNAVAILABLE')
    throw error
  }
  if (!object(config) || config.schemaVersion !== 1 || !object(config.scope) || !object(config.installations)
      || scopeKeys.some(key => typeof scope?.[key] !== 'string' || config.scope[key] !== scope[key])) fail('NATIVE_SKILL_CONFIG_SCOPE_MISMATCH')
  const selected = entries.flatMap(({ descriptor }) => {
    const commandSkill = command.skills.find(item => item.taskSkillBinding.skillInstallationId === descriptor.skillInstallationId)
    if (!commandSkill || commandSkill.skill.key !== descriptor.skillKey || commandSkill.skill.packageSha256 !== descriptor.packageSha256) fail('NATIVE_SKILL_CONFIG_BINDING_INVALID')
    const entry = config.installations[descriptor.skillInstallationId]
    if (entry === undefined) return []
    if (!object(entry) || !object(entry.configuration)) fail('NATIVE_SKILL_CONFIG_INVALID')
    const configuration = structuredClone(entry.configuration), networkOrigins = nativeSkillOrigins(entry.networkOrigins || [])
    return [{ skillKey: descriptor.skillKey, skillInstallationId: descriptor.skillInstallationId, configuration, networkOrigins,
      digest: skillDigest({ configuration, networkOrigins }) }]
  })
  return Object.freeze(selected.map(Object.freeze))
}
