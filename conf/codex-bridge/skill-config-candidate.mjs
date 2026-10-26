/** Pure migration candidate + diff/readback. Never edits live profiles, provider
 * credentials, workspace policy, enabled-skill lists or shared service state. */
import { parseSkillBindings } from './skill-bindings.mjs'
import { skillDigest } from './skill-executor.mjs'
import { isAbsolute } from 'node:path'
const carrierNames = { rootDir: 'RootDir', stateRoot: 'StateRoot', profileId: 'ProfileId', engineContractId: 'EngineContractId', providerId: 'ProviderId', providerBaseUrl: 'ProviderBaseUrl',
  providerWireApi: 'ProviderWireApi', providerNetwork: 'ProviderNetwork', networkConnectTimeoutMs: 'NetworkConnectTimeoutMs', caBundlePath: 'CaBundlePath',
  carrierEvidencePath: 'CarrierEvidencePath', carrierEvidenceDigest: 'CarrierEvidenceDigest', bwrapBin: 'BwrapBin', supportedInputs: 'SupportedInputs' }
export function materialProfileFromInputCarriers(profile) {
  if (!profile.inputCarriers) return profile
  const mapped = { ...profile }
  for (const [key, suffix] of Object.entries(carrierNames)) if (Object.hasOwn(profile.inputCarriers, key)) mapped[`typedInspection${suffix}`] = profile.inputCarriers[key]
  return mapped
}
export function createSkillConfigurationCandidate(profiles, bindingsFile) {
  if (!Array.isArray(profiles) || !isAbsolute(bindingsFile || '')) throw Object.assign(new Error('SKILL_CONFIG_CANDIDATE_INVALID'), { code: 'SKILL_CONFIG_CANDIDATE_INVALID' })
  const skillBindings = { schemaVersion: 1, providers: {}, subjects: {}, costInfoOverrides: {} }
  const candidates = profiles.map(source => {
    const profile = structuredClone(source)
    profile.skillBindingsFile = bindingsFile
    if (source.controlledImageHttpEnabled === true || source.controlledImageHttpEnabled === 'true') {
      const bindingId = source.controlledImageHttpBindingId
      const provider = { adapter: 'image-http', endpoint: source.controlledImageHttpEndpoint, model: source.controlledImageHttpModelId,
        credentialEnv: source.controlledImageHttpApiKeyEnv, revision: String(source.controlledImageHttpBindingEpoch) }
      if (skillBindings.providers[bindingId] && skillDigest(skillBindings.providers[bindingId]) !== skillDigest(provider)) throw new Error('SKILL_BINDING_CANDIDATE_CONFLICT')
      skillBindings.providers[bindingId] = provider
      skillBindings.subjects[source.agentId] = { providerAliases: { image: bindingId } }
    }
    const carriers = {}
    for (const [key, suffix] of Object.entries(carrierNames)) {
      const value = source[`typedInspection${suffix}`]
      if (value !== undefined && value !== null && value !== '') carriers[key] = value
    }
    if (Object.keys(carriers).length) profile.inputCarriers = carriers
    for (const key of Object.keys(profile)) if (key.startsWith('controlledImage') || key.startsWith('typedInspection') || /^nativeConversation(?:TextFileEnabled|ImageGenerationEnabled)$/.test(key)) delete profile[key]
    return profile
  })
  parseSkillBindings(skillBindings)
  return { schemaVersion: 1, beforeDigest: skillDigest(profiles), profiles: candidates, skillBindings,
    candidateDigest: skillDigest({ profiles: candidates, skillBindings }),
    changes: profiles.map((source, index) => ({ agentId: source.agentId, removedKeys: Object.keys(source).filter(key => !Object.hasOwn(candidates[index], key)),
      changedKeys: Object.keys(candidates[index]).filter(key => skillDigest(source[key] ?? null) !== skillDigest(candidates[index][key])) })) }
}
