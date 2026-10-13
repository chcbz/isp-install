import { createHash } from 'node:crypto'
import { parseSkillJson, validateSkillParameters } from './skill-manifest.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
export const skillHash = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const skillCanonicalJson = value => JSON.stringify(canonical(value))
export const skillDigest = value => skillHash(skillCanonicalJson(value))
export const skillId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
export const skillSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const mime = value => typeof value === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)
const exact = (value, keys) => object(value) && keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key))

export function parseSkillCommand(raw) {
  const value = typeof raw === 'string' || Buffer.isBuffer(raw) ? parseSkillJson(raw) : structuredClone(raw)
  const fields = ['executionProtocolVersion', 'executionId', 'taskId', 'runId', 'conversationId', 'conversationGeneration',
    'skill', 'snapshotDigest', 'parameters', 'instruction', 'inputRefs', 'outputs']
  if (!exact(value, fields) || value.executionProtocolVersion !== 4 || !['executionId', 'taskId', 'runId', 'conversationId'].every(key => skillId(value[key]))
      || typeof value.conversationGeneration !== 'string' || !/^[1-9][0-9]*$/.test(value.conversationGeneration)
      || !exact(value.skill, ['key', 'version', 'packageSha256', 'manifestSha256']) || !skillId(value.skill.key) || !skillId(value.skill.version)
      || !skillSha(value.skill.packageSha256) || !skillSha(value.skill.manifestSha256) || !skillSha(value.snapshotDigest)
      || !object(value.parameters) || typeof value.instruction !== 'string' || !value.instruction.trim()
      || !Array.isArray(value.inputRefs) || value.inputRefs.length > 32 || !value.inputRefs.every(skillId) || new Set(value.inputRefs).size !== value.inputRefs.length
      || !Array.isArray(value.outputs) || new Set(value.outputs.map(item => item?.outputId)).size !== value.outputs.length
      || !value.outputs.every(item => exact(item, ['outputId', 'contentMimeType']) && skillId(item.outputId) && mime(item.contentMimeType))) fail('SKILL_COMMAND_INVALID')
  return value
}

/** One executor for installed descriptors. Context owns authenticated HTTP, durable
 * persistence and lease checks, not packages. No pricing, consent or per-skill lane. */
export async function executeSkill(raw, ctx) {
  const command = parseSkillCommand(raw)
  const entry = await ctx.registry.requireExact({ skillKey: command.skill.key, skillVersion: command.skill.version,
    packageSha256: command.skill.packageSha256, manifestSha256: command.skill.manifestSha256 })
  const descriptor = entry.descriptor
  const parameters = validateSkillParameters(descriptor.manifest.parametersSchema, command.parameters)
  const outputs = descriptor.manifest.outputs
  if ((outputs.artifactsRequired && command.outputs.length === 0) || (!outputs.multiple && command.outputs.length > 1)
      || command.outputs.some(item => !outputs.mimeTypes.includes(item.contentMimeType))) fail('SKILL_OUTPUT_CONTRACT_INVALID')
  const runner = ctx.runners.get(descriptor.manifest.runner)
  if (typeof runner?.run !== 'function') fail('SKILL_RUNNER_MISSING')
  const claim = await ctx.claimOrResume(command)
  // Recovery consumes the actual persisted result, never invokes the runner again.
  let manifest = claim.resultManifest || await ctx.loadResult(command)
  if (!manifest) {
    const inputs = await ctx.materializeAuthorizedInputs(command, descriptor)
    if (inputs.length < descriptor.manifest.inputs.minItems || inputs.length > descriptor.manifest.inputs.maxItems
        || inputs.some(input => !descriptor.manifest.inputs.acceptedMimeTypes.includes(input.contentMimeType))) fail('SKILL_INPUT_CONTRACT_INVALID')
    const result = await runner.run({ command, instruction: command.instruction, parameters, inputs, descriptor,
      binding: entry.binding, effects: ctx.effects, outputDirectory: ctx.outputDirectory })
    manifest = await ctx.validateAndPersistResult(command, descriptor, result)
  }
  if (manifest.executionId !== command.executionId || manifest.snapshotDigest !== command.snapshotDigest) fail('SKILL_RESULT_BINDING_INVALID')
  if (manifest.result.artifacts.length) await ctx.stageOutputs(command, manifest.result.artifacts)
  const receipt = await ctx.commitResult(command, manifest)
  await ctx.persistReceipt(command, manifest, receipt)
  return receipt
}
