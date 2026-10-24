import { createHash } from 'node:crypto'
import { validateManagement } from './skill-management-wire.mjs'
import { parseSkillJson, validateSkillParameters } from './skill-manifest.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
export const skillHash = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Emit members directly: rebuilding an object would re-order integer-shaped keys.
export const skillCanonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(skillCanonicalJson).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${skillCanonicalJson(value[key])}`).join(',')}}`
  if (value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail('SKILL_CANONICAL_JSON_INVALID')
  return JSON.stringify(value)
}
export const skillDigest = value => skillHash(skillCanonicalJson(value))
export const skillId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
export const skillSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const mime = value => typeof value === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)
const required = (value, keys) => object(value) && keys.every(key => Object.hasOwn(value, key))
const commandFields = ['executionProtocolVersion', 'executionId', 'taskId', 'runId', 'conversationId', 'conversationGeneration',
  'commandId', 'messageId', 'skill', 'taskSkillBinding', 'snapshotDigest', 'parameters', 'instruction', 'inputRefs', 'outputs']
const skillFields = ['key', 'version', 'packageSha256', 'manifestSha256']
const outputFields = ['dataSchema', 'mimeTypes', 'multiple', 'artifactsRequired']
const project = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]))
// Additive metadata remains in the immutable command/hash, but is never runner
// configuration or execution authority. Only the declared semantics reach code.
const executionView = command => ({ ...project(command, commandFields), skill: project(command.skill, skillFields),
  outputs: project(command.outputs, outputFields) })

export function parseSkillCommand(raw) {
  const value = typeof raw === 'string' || Buffer.isBuffer(raw) ? parseSkillJson(raw) : structuredClone(raw)
  if (!required(value, commandFields) || value.executionProtocolVersion !== 4 || !['executionId', 'taskId', 'runId', 'conversationId', 'commandId', 'messageId'].every(key => skillId(value[key]))
      || typeof value.conversationGeneration !== 'string' || !/^[1-9][0-9]*$/.test(value.conversationGeneration)
      || !required(value.skill, skillFields) || !skillId(value.skill.key) || !skillId(value.skill.version)
      || !skillSha(value.skill.packageSha256) || !skillSha(value.skill.manifestSha256) || !skillSha(value.snapshotDigest)
      || !object(value.parameters) || typeof value.instruction !== 'string' || !value.instruction.trim()
      || !Array.isArray(value.inputRefs) || !value.inputRefs.every(skillId) || new Set(value.inputRefs).size !== value.inputRefs.length
      || !required(value.outputs, outputFields) || !Array.isArray(value.outputs.mimeTypes)
      || !value.outputs.mimeTypes.every(mime) || typeof value.outputs.multiple !== 'boolean' || typeof value.outputs.artifactsRequired !== 'boolean') fail('SKILL_COMMAND_INVALID')
  const binding = validateManagement('TaskSkillBinding', value.taskSkillBinding)
  if (binding.executionId !== value.executionId || binding.skillKey !== value.skill.key || binding.skillVersion !== value.skill.version
      || binding.packageSha256 !== value.skill.packageSha256 || binding.manifestSha256 !== value.skill.manifestSha256) fail('SKILL_COMMAND_INVALID')
  return value
}

/** One executor for installed descriptors. Context owns authenticated HTTP, durable
 * persistence and lease checks, not packages. No pricing, consent or per-skill lane. */
export async function executeSkill(raw, ctx) {
  const command = parseSkillCommand(raw)
  const entry = await ctx.registry.requireExact({ skillKey: command.skill.key, skillVersion: command.skill.version,
    packageSha256: command.skill.packageSha256, manifestSha256: command.skill.manifestSha256 }, { allowUnavailable: true, taskBinding: command.taskSkillBinding })
  const descriptor = entry.descriptor
  const parameters = validateSkillParameters(descriptor.manifest.parametersSchema, command.parameters)
  const outputs = descriptor.manifest.outputs
  if (skillDigest(project(command.outputs, outputFields)) !== skillDigest(project(outputs, outputFields))) fail('SKILL_OUTPUT_CONTRACT_INVALID')
  const claim = await ctx.claimOrResume(command)
  // Recovery consumes the actual persisted result, never invokes the runner again.
  if (claim.resultManifest) {
    const receipt = await ctx.recoverCommittedResult(command, descriptor, claim.resultManifest)
    await ctx.persistReceipt(command, claim.resultManifest, receipt)
    return receipt
  }
  let manifest = await ctx.loadResult(command)
  if (!manifest) {
    if (entry.item && entry.item.readiness !== 'READY') fail('SKILL_EXECUTION_BINDING_CHANGED')
    const runner = ctx.runners.get(descriptor.manifest.runner)
    if (typeof runner?.run !== 'function') fail('SKILL_RUNNER_MISSING')
    const inputs = await ctx.materializeAuthorizedInputs(command, descriptor)
    if (inputs.length < descriptor.manifest.inputs.minItems || inputs.length > descriptor.manifest.inputs.maxItems
        || inputs.some(input => !descriptor.manifest.inputs.acceptedMimeTypes.includes(input.contentMimeType))) fail('SKILL_INPUT_CONTRACT_INVALID')
    const result = await runner.run({ command: executionView(command), instruction: command.instruction, parameters, inputs, descriptor,
      binding: entry.binding, effects: ctx.effects, outputDirectory: ctx.outputDirectory })
    manifest = await ctx.validateAndPersistResult(command, descriptor, result)
  }
  if (manifest.executionId !== command.executionId || manifest.snapshotDigest !== command.snapshotDigest) fail('SKILL_RESULT_BINDING_INVALID')
  if (manifest.result.artifacts.length) await ctx.stageOutputs(command, manifest.result.artifacts)
  const receipt = await ctx.commitResult(command, manifest)
  await ctx.persistReceipt(command, manifest, receipt)
  return receipt
}
