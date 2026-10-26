import test from 'node:test'
import assert from 'node:assert/strict'
import { createSkillConfigurationCandidate } from '../skill-config-candidate.mjs'
import { normalizeProfile } from '../agent-client.mjs'
import { skillDigest } from '../skill-executor.mjs'
const profile = () => ({ agentId: 'agent', profileId: 'existing', codexHome: '/private/existing/home', codexWorkdir: '/private/existing/work',
  controlledImageHttpEnabled: true, controlledImageHttpEndpoint: 'https://images.example.invalid', controlledImageHttpModelId: 'gpt-image-1',
  controlledImageHttpApiKeyEnv: 'IMAGE_TOKEN', controlledImageHttpBindingId: 'image-default', controlledImageHttpBindingEpoch: '2', controlledImageHttpLedgerRoot: '/private/existing/ledger',
  typedInspectionEnabled: true, typedInspectionRootDir: '/private/existing/inputs', typedInspectionStateRoot: '/private/existing/state',
  typedInspectionProfileId: 'existing', typedInspectionCarrierEvidencePath: '/private/existing/evidence.json', typedInspectionCarrierEvidenceDigest: `sha256:${'a'.repeat(64)}`,
  typedInspectionSupportedInputs: [{ mimeType: 'image/png', carrier: 'LOCAL_IMAGE' }], nativeConversationImageGenerationEnabled: true })
test('pure candidate maps one shared binding and real carrier config, preserves identity/HOME and evidence bytes reference', () => {
  const source = [profile(), { agentId: 'other', codexHome: '/private/other/home' }], before = structuredClone(source)
  const result = createSkillConfigurationCandidate(source, '/private/shared/skill-bindings.json')
  assert.deepEqual(source, before)
  assert.equal(result.profiles[0].codexHome, source[0].codexHome)
  assert.equal(result.profiles[0].profileId, 'existing')
  assert.equal(result.profiles[0].inputCarriers.carrierEvidenceDigest, source[0].typedInspectionCarrierEvidenceDigest)
  assert.equal(result.profiles[0].skillBindingsFile, result.profiles[1].skillBindingsFile)
  assert.equal(Object.keys(result.skillBindings.providers).length, 1)
  assert.deepEqual(result.skillBindings.subjects.agent.providerAliases, { image: 'image-default' })
  assert.equal(result.skillBindings.subjects.other, undefined)
  assert.ok(!Object.keys(result.profiles[0]).some(key => /^(controlledImage|typedInspection|nativeConversationImage)/.test(key)))
  assert.equal(result.candidateDigest, skillDigest({ profiles: result.profiles, skillBindings: result.skillBindings }))
  const normalized = normalizeProfile(result.profiles[0], {}, 0, { isolated: true })
  assert.equal(normalized.typedInspectionRootDir, source[0].typedInspectionRootDir)
  assert.deepEqual(normalized.typedInspectionSupportedInputs, source[0].typedInspectionSupportedInputs)
  assert.equal(normalized.typedInspectionEnabled, false)
})
test('binding collisions fail instead of quietly changing another subject; no operator writes/restarts', () => {
  const source = profile()
  assert.throws(() => createSkillConfigurationCandidate([source, { ...source, agentId: 'other', controlledImageHttpEndpoint: 'https://other.example.invalid' }], '/shared/bindings.json'), /CONFLICT/)
  assert.throws(() => createSkillConfigurationCandidate([source], 'relative.json'), /INVALID/)
})
