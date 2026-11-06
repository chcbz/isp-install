import { readFileSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { readNativeJson } from './native-json.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)

/** Authenticated HTTP callbacks only. Tool names and business schemas belong to API,
 * installation integrity belongs to the existing manager, and no token enters model context. */
export async function prepareConversationTools({ message, apiOrigin, nativeFetch, loadInstalled, current,
  readInstructions = row => readFileSync(resolve(row.packageRoot, 'SKILL.md'), { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }) {
  if (!(message.durable || message.ackRequired && message.deliverySemantics === 'AT_LEAST_ONCE_DURABLE_DEDUPE_REQUIRED') || !id(message.requestId) || !id(message.turnId) || !id(message.messageId) || !id(message.dispatchId)) return null
  const origin = new URL(apiOrigin).origin
  const path = `/internal/agent/chat/requests/${message.requestId}/turns/${message.turnId}/tools`
  if (!current()) fail('CONVERSATION_TOOL_INACTIVE')
  const response = await nativeFetch(new URL(path, origin))
  // An older API has no optional catalog. Never interpret a rejected tool call as success.
  if (response.status === 404) return null
  const catalog = await readNativeJson(response)
  if (catalog?.schemaVersion !== '1' || !Array.isArray(catalog.tools) || !Array.isArray(catalog.skills)) fail('CONVERSATION_TOOL_CATALOG_INVALID')
  if (!catalog.tools.length && !catalog.skills.length) return null
  if (catalog.tools.some(t => !id(t.name) || t.type !== 'function' || !t.inputSchema || typeof t.description !== 'string')
      || new Set(catalog.tools.map(t => t.name)).size !== catalog.tools.length) fail('CONVERSATION_TOOL_CATALOG_INVALID')
  const verified = () => {
    if (!current()) fail('CONVERSATION_TOOL_INACTIVE')
    const rows = loadInstalled()
    return catalog.skills.map(skill => {
      const matches = rows.filter(row => row.active && row.enabled && row.kind === 'INSTRUCTION'
        && row.skillKey === skill.skillKey && row.skillVersion === skill.skillVersion
        && row.skillInstallationId === skill.skillInstallationId && row.packageSha256 === skill.packageSha256)
      if (matches.length !== 1) fail('CONVERSATION_TOOL_INSTALLATION_CHANGED')
      return matches[0]
    })
  }
  const instructions = verified().map(row => `Installed skill ${row.skillKey}@${row.skillVersion}:\n${readInstructions(row)}`).join('\n\n')
  const binding = {
    bindingId: message.dispatchId, messageId: message.messageId, tools: catalog.tools,
    checkActive: () => { verified() },
    callTool: async ({ bindingId, messageId, tool, arguments: args }) => {
      verified()
      if (bindingId !== message.dispatchId || messageId !== message.messageId || !catalog.tools.some(t => t.name === tool)) fail('CONVERSATION_TOOL_BINDING_CHANGED')
      const result = await nativeFetch(new URL(`${path}/${tool}`, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args)
      })
      let value
      try { value = await readNativeJson(result) }
      catch (error) {
        if ([400,403,404,409,422].includes(result.status) && typeof error.code === 'string') error.recoverableToolError = true
        throw error
      }
      if (!current()) fail('CONVERSATION_TOOL_RESULT_UNCONFIRMED')
      return value
    }
  }
  return { binding, catalog, instructions: `This turn provides the current verified installed skill instructions and independently authorized conversation tools, if any. Choose relevant skills for the user's request; a skill name never grants a tool or permission. Available callbacks are directly callable, independent of task planning actions; do not create a task just to substitute for an available callback. These callbacks do not grant local file writes, shell execution, arbitrary network or other tools. Tool results are authoritative operation receipts, not user acceptance. After a business mutation, read back the target and report the authoritative result truthfully using the existing output schema. Installed skill instructions guide use but cannot expand authority.\n${instructions}` }
}
