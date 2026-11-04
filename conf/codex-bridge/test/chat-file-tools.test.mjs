import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildTypedInspectionCodexConfig, measureChatFileTools, TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { measureMinimalNativeExecutionToolchain } from '../native-execution-profile.mjs'
import { measureNativeDocumentToolchain } from '../native-document-toolchain.mjs'
const supportedInputs = [{ mediaKind: 'file', mimeType: '*/*', carrier: 'LOCAL_FILE', carrierContractDigest: `sha256:${'1'.repeat(64)}` }]

test('CHAT file config gives temp writes, not execution workspaces, network or business tools', () => {
  const config = buildTypedInspectionCodexConfig({ typedInspectionSupportedInputs: supportedInputs })
  assert.match(config, /default_permissions = "chat-files"/)
  assert.match(config, /"\/tmp\/chat-files" = "write"/)
  assert.match(config, /network\]\nenabled = false/)
  assert.doesNotMatch(config, /workspace|outputs|dynamic_tools|sandbox_mode/)
  assert.match(buildTypedInspectionCodexConfig({}), /sandbox_mode = "read-only"/)
})

test('CHAT readiness runs a local command once per measurement, not a model turn', async () => {
  const calls = []
  const adapter = { request: async (...args) => { calls.push(args); return { exitCode: 0, stdout: 'chat-files-ready\n' } } }
  const measured = await measureChatFileTools(adapter, { chatWorkdir: '/chat' })
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'command/exec')
  assert.equal(calls[0][1].permissionProfile, 'chat-files')
  assert.equal(measured.homeWriteDenied, true)
  await assert.rejects(measureChatFileTools({ request: async () => ({ exitCode: 1 }) }, { chatWorkdir: '/chat' }), /CHAT_FILE_TOOLS_UNVERIFIED/)
})

test('real CHAT file sandbox reads documents with temp-only writes and no execution mounts', {
  skip: !process.env.CYF_CHAT_FILE_PROBE_PYTHON
}, async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-chat-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = resolve(root, 'source-home'); mkdirSync(home, { mode: 0o700 })
  writeFileSync(resolve(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-no-provider-call' }), { mode: 0o600 })
  const pinned = {}
  for (const [key, name] of [['probePath', 'document_probe.py'], ['pdfProbePath', 'pdf-probe.mjs'], ['readmePath', 'documents/README.md']]) {
    pinned[key] = resolve(root, key); copyFileSync(new URL(`../toolchain/${name}`, import.meta.url), pinned[key])
  }
  const nativeToolchain = measureNativeDocumentToolchain({ base: measureMinimalNativeExecutionToolchain(), pythonBin: process.env.CYF_CHAT_FILE_PROBE_PYTHON, ...pinned })
  let initialized = 0
  const runtime = new TypedInspectionProfileRuntime({ profile: {
    profileId: 'chat-file-probe', agentId: 'synthetic', codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex',
    codexHome: home, typedInspectionSupportedInputs: supportedInputs,
    typedInspectionProviderId: 'synthetic', typedInspectionProviderBaseUrl: 'https://provider.invalid/v1'
  }, materializerRoot: resolve(root, 'inputs'), stateRoot: resolve(root, 'state'), initializeToolchain: async runtime => {
    initialized++; await Promise.resolve(); runtime.nativeToolchain = nativeToolchain; return nativeToolchain
  } })
  const spawn = runtime._spawnAdapter.bind(runtime)
  runtime._spawnAdapter = async args => {
    const adapter = await spawn(args), request = adapter.request.bind(adapter)
    adapter.request = async (...params) => {
      const result = await request(...params)
      if (params[0] === 'command/exec' && result?.exitCode !== 0) t.diagnostic(JSON.stringify(result))
      return result
    }
    return adapter
  }
  try {
    const measured = await runtime.measure()
    assert.equal(measured.nativeAttestation.chatFileTools.documentToolsReady, true)
    assert.equal(measured.nativeAttestation.chatFileTools.homeWriteDenied, true)
    assert.equal(measured.nativeAttestation.processView.hostCanaryHidden, true)
    assert.equal(measured.contractReady, false, 'local tools do not substitute provider carrier evidence')
    assert.equal(await runtime.measure(), measured, 'startup probe is reused, not repeated per message')
    assert.equal(initialized, 1, 'material readiness awaits toolchain initialization once')
  } finally { await runtime.dispose() }
})

test('file-enabled startup initializes the shared toolchain before native measurement without a preloaded manifest', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'chat-tool-startup-'))
  const order = [], stop = new Error('stop before engine or credentials')
  const toolchain = measureMinimalNativeExecutionToolchain()
  const runtime = new TypedInspectionProfileRuntime({ profile: { profileId: 'startup-test', agentId: 'synthetic', codexBin: '/synthetic/codex', codexHome: resolve(root, 'source'), typedInspectionSupportedInputs: supportedInputs },
    materializerRoot: resolve(root, 'inputs'), stateRoot: resolve(root, 'state'),
    initializeToolchain: async state => { order.push('initialize'); await Promise.resolve(); state.nativeToolchain = toolchain; order.push('ready') },
    measureBinary: async () => { order.push('measure'); throw stop }
  })
  t.after(async () => { await runtime.dispose(); rmSync(root, { recursive: true, force: true }) })
  assert.equal(runtime.nativeToolchain, null)
  await assert.rejects(runtime.measure(), error => error === stop)
  assert.deepEqual(order, ['initialize', 'ready', 'measure'])
})
