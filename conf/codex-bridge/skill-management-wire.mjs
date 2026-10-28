// SM-C1 / interface-standard 1.2 (2026-10-14). One schema, no legacy install decoder.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseStrictJson } from './api-envelope.mjs'
import { validateMessage } from './message-envelope.mjs'

const schema = JSON.parse(readFileSync(new URL('./schemas/management-contract-v1.schema.json', import.meta.url)))
const nativeTaskSkillBindingSchema = JSON.parse(readFileSync(new URL('./schemas/native-task-skill-binding-v5.schema.json', import.meta.url)))
// The Runtime installer/validator imports the transport for offline collation
// before node_modules exists. Load the already-declared validator only when an
// actual management DTO is consumed, not during stdlib-only payload preparation.
const require = createRequire(import.meta.url)
let ajv = null
const validators = new Map()
const fail = (code = 'SKILL_INSTALL_COMMAND_INVALID') => { throw Object.assign(new Error(code), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unicode = value => {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i)
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail()
    } else if (n >= 0xdc00 && n <= 0xdfff) fail()
  }
}
export function managementCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(managementCanonicalJson).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => {
    unicode(key); return `${JSON.stringify(key)}:${managementCanonicalJson(value[key])}`
  }).join(',')}}`
  if (typeof value === 'string') unicode(value)
  else if (typeof value === 'number' ? !Number.isSafeInteger(value) || Object.is(value, -0) : value !== null && typeof value !== 'boolean') fail()
  return JSON.stringify(value)
}
export const managementDigest = (domain, value) => createHash('sha256').update(domain).update('\0').update(managementCanonicalJson(value)).digest('hex')
const managementAjv = () => {
  if (!ajv) {
    const module = require('ajv'), Ajv = module.default || module
    ajv = new Ajv({ strict: false, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false })
    ajv.addSchema(schema)
  }
  return ajv
}
export function validateManagement(definition, value) {
  managementCanonicalJson(value)
  managementAjv()
  if (!validators.has(definition)) validators.set(definition, ajv.compile({ $ref: `${schema.$id}#/definitions/${definition}` }))
  if (!validators.get(definition)(value)) fail()
  return value
}
// V5 only: syntax permits null; the authorized installed descriptor determines
// whether null is appropriate. This is not a tool authorization check.
export function validateNativeTaskSkillBinding(value) {
  managementCanonicalJson(value)
  const engine = managementAjv(), key = nativeTaskSkillBindingSchema.$id
  if (!validators.has(key)) validators.set(key, engine.compile(nativeTaskSkillBindingSchema))
  if (!validators.get(key)(value)) fail()
  return value
}
export const isManagementMessage = message => message?.protocolVersion === 1 && (
  message.messageType === 'command.dispatch' && ['SKILL_INSTALL', 'SKILL_SET_ENABLED', 'SKILL_RECONCILE'].includes(message.data?.commandType)
  || message.data?.schemaVersion === 2 && ['command.ack', 'work.result', 'work.result.receipt'].includes(message.messageType))
export function parseManagementMessage(input) {
  const value = typeof input === 'string' || Buffer.isBuffer(input)
    ? parseStrictJson(Buffer.isBuffer(input) ? new TextDecoder('utf-8', { fatal: true }).decode(input) : input, { integerTokensOnly: true }) : structuredClone(input)
  validateMessage(value)
  const definition = { 'command.dispatch': 'Command', 'command.ack': 'CommandAck', 'work.result': 'Result', 'work.result.receipt': 'ResultReceipt' }[value.messageType]
  if (!definition) fail()
  validateManagement(definition, value)
  if (definition === 'Command') {
    const { commandSha256, deliveryEpoch, ...preimage } = value.data
    if (commandSha256 !== managementDigest('cyf.skill.command.v2', preimage) || value.data.fencingToken !== value.data.skillRevision) fail('SKILL_RESULT_CONFLICT')
    const c = value.data
    if ((c.action === 'INSTALL' ? c.source !== null : c.source === null)
      || (c.action === 'ENABLE' && !c.desiredEnabled) || (['DISABLE', 'UNINSTALL'].includes(c.action) && c.desiredEnabled)) fail()
    for (const ref of [c.source, c.target].filter(Boolean)) {
      // Installation IDs become one path segment exactly once; never URL-normalize aliases.
      if (/[\\/%?#]/u.test(ref.skillInstallationId) || ref.skillInstallationId === '.' || ref.skillInstallationId === '..') fail('SKILL_DOWNLOAD_FORBIDDEN')
    }
    if (c.phase === 'PREPARE' && c.downloadPath !== `/internal/agent/skill-installations/${c.target.skillInstallationId}/package`) fail('SKILL_DOWNLOAD_FORBIDDEN')
  }
  if (definition === 'Result') {
    const { resultSha256, ...preimage } = value.data
    if (resultSha256 !== managementDigest('cyf.skill.result.v2', preimage)) fail('SKILL_RESULT_CONFLICT')
  }
  return value
}
export const preparedDigest = command => managementDigest('cyf.skill.prepared.v1', Object.fromEntries(
  ['skillChangeId', 'attempt', 'source', 'target', 'approvedPermissionsSha256'].map(key => [key, command[key]])))
