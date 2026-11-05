import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareConversationTools } from '../conversation-tools.mjs'
const tool = { type: 'function', name: 'domain_maintenance', description: 'Maintain the authorized resource', inputSchema: { type: 'object' } }
const skill = { skillKey: 'some-position-skill', skillVersion: '1.0.0', skillInstallationId: 'install1', packageSha256: 'a'.repeat(64) }
const message = { durable: true, requestId: 'request1', turnId: 'turn1', messageId: 'message1', dispatchId: 'dispatch1' }
const json = (data, status = 200, code = 'E0') => new Response(JSON.stringify({ protocolVersion: 1, requestId: 'r1', code, msg: status === 200 ? 'ok' : 'private failure details', data }), { status, headers: { 'X-Request-Id': 'r1' } })
function fixture() {
  const calls = []; let active = true; let installed = true; let reply = () => json({ disposition: 'UPDATED' })
  const options = { message, apiOrigin: 'https://api.test', current: () => active,
    loadInstalled: () => installed ? [{ ...skill, active: true, enabled: true, kind: 'INSTRUCTION' }] : [],
    readInstructions: () => '# Maintenance\nUse the provided tool.',
    nativeFetch: async (url, options) => {
      calls.push({ url: url.href, options })
      return options?.method === 'POST' ? reply() : json({ schemaVersion: '1', skills: [skill], tools: [tool] })
    } }
  return { options, calls, deactivate: () => { active = false }, uninstall: () => { installed = false }, reply: fn => { reply = fn } }
}
const invoke = session => session.binding.callTool({ bindingId: 'dispatch1', messageId: 'message1', tool: tool.name, arguments: { title: '名称' } })

test('generic installed skill and API catalog provide bounded conversation callbacks, not a skill-name branch', async () => {
  const f = fixture(); const session = await prepareConversationTools(f.options)
  assert.match(session.instructions, /some-position-skill@1.0.0/)
  assert.deepEqual(session.binding.tools, [tool]); assert.equal(session.binding.messageId, message.messageId)
  assert.deepEqual(await invoke(session), { disposition: 'UPDATED' })
  assert.equal(f.calls[1].url, 'https://api.test/internal/agent/chat/requests/request1/turns/turn1/tools/domain_maintenance')
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { title: '名称' })
  assert.ok(!JSON.stringify(session).includes('Authorization'))
})

test('empty installations or an older API do not grant tools or fail ordinary chat', async () => {
  const f = fixture(); f.uninstall()
  f.options.nativeFetch = async () => json({ schemaVersion: '1', skills: [], tools: [] })
  assert.equal(await prepareConversationTools(f.options), null)
  const g = fixture(); g.options.nativeFetch = async () => new Response('', { status: 404 })
  assert.equal(await prepareConversationTools(g.options), null)
})

test('disabled or replaced installation invalidates a pending tool call before HTTP', async () => {
  const f = fixture(); const session = await prepareConversationTools(f.options); f.uninstall()
  await assert.rejects(invoke(session), /CONVERSATION_TOOL_INSTALLATION_CHANGED/); assert.equal(f.calls.length, 1)
})

test('session changes and model-selected names or message bindings cannot redirect authority', async () => {
  const f = fixture(); const session = await prepareConversationTools(f.options)
  await assert.rejects(session.binding.callTool({ bindingId: 'other', messageId: 'message1', tool: tool.name }), /BINDING_CHANGED/)
  await assert.rejects(session.binding.callTool({ bindingId: 'dispatch1', messageId: 'message1', tool: '../arbitrary' }), /BINDING_CHANGED/)
  f.deactivate(); await assert.rejects(invoke(session), /CONVERSATION_TOOL_INACTIVE/); assert.equal(f.calls.length, 1)
})

test('CAS conflict is returned as a recoverable code, never a successful maintenance result', async () => {
  const f = fixture(); f.reply(() => json(null, 409, 'SKILL_PRODUCT_CHANGED'))
  const session = await prepareConversationTools(f.options)
  await assert.rejects(invoke(session), error => error.code === 'SKILL_PRODUCT_CHANGED' && error.recoverableToolError === true)
  assert.equal(f.calls.length, 2)
})

test('lost or invalid operation response is not automatically replayed', async () => {
  const f = fixture(); f.reply(() => { throw new Error('transport lost') })
  const session = await prepareConversationTools(f.options)
  await assert.rejects(invoke(session), /transport lost/); assert.equal(f.calls.length, 2)
})

test('same catalog on a later turn binds callbacks to the new request, never the prior dispatch', async () => {
  const f = fixture(); const first = await prepareConversationTools(f.options)
  const second = await prepareConversationTools({ ...f.options,
    message: { ...message, requestId: 'request2', turnId: 'turn2', dispatchId: 'dispatch2', messageId: 'message2' } })
  assert.deepEqual(second.catalog, first.catalog)
  await assert.rejects(second.binding.callTool({ bindingId: 'dispatch1', messageId: 'message1', tool: tool.name }), /BINDING_CHANGED/)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(await second.binding.callTool({ bindingId: 'dispatch2', messageId: 'message2', tool: tool.name, arguments: {} }), { disposition: 'UPDATED' })
  assert.equal(f.calls[2].url, 'https://api.test/internal/agent/chat/requests/request2/turns/turn2/tools/domain_maintenance')
})

test('archive and skill-management catalogs compose without granting shell or rewriting source bytes', async () => {
  const f = fixture()
  const skills = [
    { ...skill, skillKey: 'archive-maintenance', skillVersion: '2.0.0' },
    { ...skill, skillKey: 'skill-management', skillInstallationId: 'install2', packageSha256: 'b'.repeat(64) }
  ]
  const tools = ['archive_prepare', 'archive_publish', 'archive_read', 'skill_read'].map(name => ({ ...tool, name }))
  let called
  f.options.loadInstalled = () => skills.map(s => ({ ...s, active: true, enabled: true, kind: 'INSTRUCTION' }))
  f.options.nativeFetch = async (url, options) => {
    if (options?.method !== 'POST') return json({ schemaVersion: '1', skills, tools })
    called = { path: url.pathname, body: JSON.parse(options.body) }
    return json({ jobId: 'job1', state: 'DRAFT', active: false, chapterCount: '2' })
  }
  const session = await prepareConversationTools(f.options)
  assert.deepEqual(session.binding.tools, tools)
  assert.match(session.instructions, /archive-maintenance@2.0.0/)
  assert.match(session.instructions, /skill-management@1.0.0/)
  const arguments_ = { fileId: 'fixed-file', fileVersion: '1', sourceSha256: 'c'.repeat(64) }
  const result = await session.binding.callTool({ bindingId: 'dispatch1', messageId: 'message1', tool: 'archive_prepare', arguments: arguments_ })
  assert.equal(result.state, 'DRAFT'); assert.equal(result.active, false)
  assert.deepEqual(called.body, arguments_); assert.ok(!Object.hasOwn(called.body, 'sourceText'))
  await assert.rejects(session.binding.callTool({ bindingId: 'dispatch1', messageId: 'message1', tool: 'shell', arguments: {} }), /BINDING_CHANGED/)
})


test('instruction-only skills are loaded without adding a domain tool or skill-name branch', async () => {
  const f = fixture()
  const arbitrary = { ...skill, skillKey: 'new-writing-guide' }
  let enabled = true
  f.options.loadInstalled = () => enabled ? [{ ...arbitrary, active: true, enabled: true, kind: 'INSTRUCTION' }] : []
  f.options.nativeFetch = async () => json({ schemaVersion: '1', skills: [arbitrary], tools: [] })
  const session = await prepareConversationTools(f.options)
  assert.match(session.instructions, /new-writing-guide@1.0.0/)
  assert.deepEqual(session.binding.tools, [])
  await assert.rejects(invoke(session), /BINDING_CHANGED/)
  enabled = false
  assert.throws(() => session.binding.checkActive(), /INSTALLATION_CHANGED/)
})

test('business tools and installed instructions are independent, never inferred from each other', async () => {
  const f = fixture(); f.uninstall()
  f.options.nativeFetch = async (url, options) => options?.method === 'POST'
    ? json({ disposition: 'UPDATED' }) : json({ schemaVersion: '1', skills: [], tools: [tool] })
  const session = await prepareConversationTools(f.options)
  assert.deepEqual(session.binding.tools, [tool])
  assert.deepEqual(await invoke(session), { disposition: 'UPDATED' })
  assert.doesNotMatch(session.instructions, /Installed skill [^ \n]+@/)
})
