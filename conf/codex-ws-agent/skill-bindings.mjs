import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseSkillJson } from './skill-manifest.mjs'
import { skillDigest } from './skill-executor.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
const fields = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export function parseSkillBindings(raw) {
  const value = typeof raw === 'string' || Buffer.isBuffer(raw) ? parseSkillJson(raw) : structuredClone(raw)
  if (!fields(value, ['schemaVersion', 'providers', 'subjects', 'costInfoOverrides']) || value.schemaVersion !== 1
      || !object(value.providers) || !object(value.subjects) || !object(value.costInfoOverrides)) fail('SKILL_BINDINGS_INVALID')
  for (const [bindingId, binding] of Object.entries(value.providers)) {
    if (!id(bindingId) || !fields(binding, ['adapter', 'endpoint', 'model', 'credentialEnv', 'revision']) || binding.adapter !== 'image-http'
        || !id(binding.model) || typeof binding.credentialEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(binding.credentialEnv)
        || typeof binding.revision !== 'string' || !/^[1-9][0-9]*$/.test(binding.revision)) fail('SKILL_BINDINGS_INVALID')
    let url
    try { url = new URL(binding.endpoint) } catch { fail('SKILL_BINDINGS_INVALID') }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || binding.endpoint !== url.origin) fail('SKILL_BINDINGS_INVALID')
  }
  for (const [agentId, subject] of Object.entries(value.subjects)) {
    if (!id(agentId) || !fields(subject, ['providerAliases']) || !object(subject.providerAliases)) fail('SKILL_BINDINGS_INVALID')
    for (const [alias, target] of Object.entries(subject.providerAliases)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias) || !id(target) || !Object.hasOwn(value.providers, target)) fail('SKILL_BINDINGS_INVALID')
    }
  }
  return value
}

/** Exactly one shared public binding file, secrets continue through the host's
 * existing full-subject providerEnvironments. Never process.env or another HOME. */
export class SkillBindings {
  constructor({ file, credentialEnvironment, load = null }) {
    this.file = file; this.credentials = credentialEnvironment || Object.freeze({})
    this.load = load || (() => {
      if (!isAbsolute(file || '') || realpathSync(file) !== resolve(file) || !lstatSync(file).isFile()) fail('SKILL_BINDINGS_UNAVAILABLE')
      return readFileSync(file)
    })
  }
  async resolve({ scope, alias }) {
    try {
      const config = parseSkillBindings(await this.load())
      const bindingId = config.subjects[scope.agentId]?.providerAliases[alias]
      if (!bindingId) return { ready: false, reasonCode: 'SKILL_PROVIDER_BINDING_MISSING' }
      const binding = config.providers[bindingId], credential = this.credentials[binding.credentialEnv]
      if (typeof credential !== 'string' || !credential || credential !== credential.trim() || /[\r\n\0]/.test(credential)) return { ready: false, reasonCode: 'SKILL_PROVIDER_CREDENTIAL_UNAVAILABLE' }
      return Object.freeze({ ready: true, scope, bindingId, revision: binding.revision,
        digest: skillDigest({ scope, bindingId, ...binding }), adapter: binding.adapter,
        endpoint: binding.endpoint, model: binding.model, credential })
    } catch { return { ready: false, reasonCode: 'SKILL_PROVIDER_BINDING_UNAVAILABLE' } }
  }
}
