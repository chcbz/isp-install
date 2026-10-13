import Ajv2020 from 'ajv/dist/2020.js'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { parseStrictTypedOutcomeJson } from './juyiting-typed-outcome.mjs'

export const SKILL_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const fail = code => { const error = new Error(code); error.code = code; throw error }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
// Both engines treat format as annotation, never mutate the caller's parameters.
const ajv = new Ajv2020({ strictSchema: true, strictTypes: false, strictTuples: false,
  strictRequired: false, allErrors: false, validateFormats: false, coerceTypes: false,
  useDefaults: false, removeAdditional: false, addUsedSchema: false })
const manifestSchema = JSON.parse(readFileSync(new URL('./schemas/skill-manifest-v1.schema.json', import.meta.url), 'utf8'))
const validateManifestStructure = ajv.compile(manifestSchema)
const keywords = new Set(('$schema $ref $dynamicRef $anchor $dynamicAnchor $defs $comment title description default examples deprecated readOnly writeOnly '
  + 'type enum const multipleOf minimum maximum exclusiveMinimum exclusiveMaximum minLength maxLength pattern format '
  + 'contentEncoding contentMediaType contentSchema items prefixItems contains minContains maxContains minItems maxItems uniqueItems '
  + 'properties patternProperties additionalProperties propertyNames required dependentRequired dependentSchemas minProperties maxProperties '
  + 'allOf anyOf oneOf not if then else unevaluatedItems unevaluatedProperties').split(' '))
const singleSchemas = new Set('items contains additionalProperties propertyNames not if then else unevaluatedItems unevaluatedProperties contentSchema'.split(' '))
const listSchemas = new Set('allOf anyOf oneOf prefixItems'.split(' '))
const mapSchemas = new Set('$defs properties patternProperties dependentSchemas'.split(' '))

export function parseSkillJson(raw) {
  try { return parseStrictTypedOutcomeJson(Buffer.isBuffer(raw) ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw) }
  catch { fail('SKILL_INVALID_JSON') }
}
function requirePortableJson(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) fail('SKILL_UNSAFE_NUMBER')
  if (object(value) || Array.isArray(value)) Object.values(value).forEach(requirePortableJson)
}
// Deployment policy traversal, not a second JSON Schema validation engine.
function checkSchemaPolicy(schema) {
  if (typeof schema === 'boolean') return
  if (!object(schema)) fail('SKILL_SCHEMA_INVALID')
  for (const [key, value] of Object.entries(schema)) {
    if (!keywords.has(key)) fail('SKILL_SCHEMA_UNSUPPORTED')
    if (key === '$schema' && value !== SKILL_SCHEMA_DIALECT) fail('SKILL_SCHEMA_DIALECT')
    if ((key === '$ref' || key === '$dynamicRef') && (typeof value !== 'string' || !value.startsWith('#'))) fail('SKILL_SCHEMA_REF_FORBIDDEN')
    if (singleSchemas.has(key)) checkSchemaPolicy(value)
    if (listSchemas.has(key)) { if (!Array.isArray(value)) fail('SKILL_SCHEMA_INVALID'); value.forEach(checkSchemaPolicy) }
    if (mapSchemas.has(key)) { if (!object(value)) fail('SKILL_SCHEMA_INVALID'); Object.values(value).forEach(checkSchemaPolicy) }
  }
}
export function compileSkillSchema(schema) {
  if (!object(schema) || schema.$schema !== SKILL_SCHEMA_DIALECT) fail('SKILL_SCHEMA_DIALECT')
  requirePortableJson(schema); checkSchemaPolicy(schema)
  try { return ajv.compile(schema) } catch { fail('SKILL_SCHEMA_INVALID') }
}
export function validateSkillParameters(schema, raw) {
  const value = typeof raw === 'string' || Buffer.isBuffer(raw) ? parseSkillJson(raw) : structuredClone(raw)
  requirePortableJson(value)
  if (!compileSkillSchema(schema)(value)) fail('SKILL_PARAMETERS_INVALID')
  return freeze(value)
}
function validEntrypoint(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*(?![\s\S])/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..')
}
export function resolveSkillEntrypoint(packageRoot, entrypoint) {
  if (!validEntrypoint(entrypoint)) fail('SKILL_ENTRYPOINT_INVALID')
  const root = realpathSync(packageRoot), candidate = resolve(root, entrypoint)
  const path = relative(root, realpathSync(candidate))
  if (!path || path === '..' || path.startsWith(`..${sep}`) || lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isFile()) fail('SKILL_ENTRYPOINT_ESCAPE')
  return realpathSync(candidate)
}
function normalizeCost(value) {
  const unknown = { mode: 'UNKNOWN', amount: null, currency: null, unit: null, description: null, source: null, updatedAt: null }
  if (value === undefined) return { costInfo: unknown, metadataWarnings: [] }
  const fields = new Set(Object.keys(unknown))
  const valid = object(value) && Object.keys(value).every(key => fields.has(key))
    && ['FREE', 'FIXED', 'METERED', 'UNKNOWN'].includes(value.mode)
    && ['amount', 'currency', 'unit', 'description', 'source', 'updatedAt'].every(key => value[key] == null || typeof value[key] === 'string')
    && (value.amount == null || /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.amount))
  return valid ? { costInfo: { ...unknown, ...value }, metadataWarnings: [] }
    : { costInfo: unknown, metadataWarnings: ['SKILL_COST_INFO_INVALID'] }
}
/** Missing manifest is an instructional package, not a failed executable skill. */
export function parseSkillManifest(raw, expectedIdentity) {
  if (raw == null) return null
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')
  const document = parseSkillJson(bytes)
  if (!object(document)) fail('SKILL_MANIFEST_INVALID')
  const executable = { ...document }; delete executable.costInfo
  if (!validateManifestStructure(executable)) fail('SKILL_MANIFEST_INVALID')
  if (!expectedIdentity || document.skillKey !== expectedIdentity.skillKey || document.skillVersion !== expectedIdentity.skillVersion) fail('SKILL_IDENTITY_MISMATCH')
  if (!validEntrypoint(document.entrypoint)) fail('SKILL_ENTRYPOINT_INVALID')
  if (document.inputs.minItems > document.inputs.maxItems) fail('SKILL_INPUT_BOUNDS_INVALID')
  if ((!document.outputs.dataSchema && document.outputs.mimeTypes.length === 0)
    || (document.outputs.artifactsRequired && document.outputs.mimeTypes.length === 0)) fail('SKILL_OUTPUTS_INVALID')
  compileSkillSchema(document.parametersSchema)
  if (document.outputs.dataSchema !== null) compileSkillSchema(document.outputs.dataSchema)
  return freeze({ ...document, ...normalizeCost(document.costInfo), manifestSha256: createHash('sha256').update(bytes).digest('hex') })
}
