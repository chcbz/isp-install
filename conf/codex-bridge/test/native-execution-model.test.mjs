import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { measureMinimalNativeExecutionToolchain } from '../native-execution-profile.mjs'
import { skillPackageTreeDigest } from '../skill-manifest.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { runNativeExecution } from '../native-execution.mjs'

// Explicit opt-in: invokes the configured real model, but never API admission,
// business commit, deployment or image Provider operations. No host-side output
// fabrication: the only deliverable must come from the isolated model tools.
const enabled = process.env.CYF_NATIVE_MODEL_PROBE === '1'
const withSkill = process.env.CYF_NATIVE_PROBE_SKILL === '1'
test(withSkill ? 'real isolated model discovers and executes a fixed ordinary skill script' : 'real isolated model reads original TXT and produces a staged/proposed file with no skills', { skip: !enabled }, async t => {
  const sourceHome = process.env.CYF_NATIVE_PROBE_CODEX_HOME
  const baseUrl = process.env.CYF_NATIVE_PROBE_BASE_URL
  const model = process.env.CYF_NATIVE_PROBE_MODEL
  assert.ok(sourceHome && baseUrl && model, 'explicit source Home, Provider URL and model required')
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-native-model-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = name => { const path = resolve(root, name); mkdirSync(path, { mode: 0o700 }); return path }
  const command = { executionProtocolVersion: 5, executionId: `probe-${randomUUID()}`, commandId: `command-${randomUUID()}`, messageId: randomUUID(), snapshotDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    skills: [], inputRefs: ['input1'], parameters: {}, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1',
    instruction: 'Use your shell tool to read /inputs/input1. Create /outputs/result.txt containing exactly the original input bytes, with no changes. Do not quote the contents in chat. Stage the real file with artifact_stage using mediaTypeHint text/plain and displayName result.txt. Call result_propose selecting that artifact, summary copied, data null. Then finish. Do not make network calls.',
    outputs: { dataSchema: null, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: true } }
  const bytes = Buffer.from(`real-input-${randomUUID()}\n原始文件字节\n`)
  const entries = []
  if (withSkill) {
    const packageRoot = directory('approved-package')
    mkdirSync(resolve(packageRoot, 'scripts'), { mode: 0o700 })
    writeFileSync(resolve(packageRoot, 'SKILL.md'), '---\nname: native-copy-helper\ndescription: Copy a task input with the required package marker using a fixed local shell script.\n---\nRun the scripts/copy.sh script in this skill directory with bash. It writes /outputs/result.txt from /inputs/input1. Then stage and propose that file.\n', { mode: 0o600 })
    writeFileSync(resolve(packageRoot, 'scripts/copy.sh'), '#!/bin/bash\nset -eu\n{ printf "SKILL_APPLIED\\n"; cat /inputs/input1; } > /outputs/result.txt\n', { mode: 0o600 })
    entries.push({ descriptor: { skillKey: 'native-copy-helper', packageRoot, packageTreeDigest: skillPackageTreeDigest(packageRoot) } })
    command.instruction = 'Use $native-copy-helper and run its packaged scripts/copy.sh to produce /outputs/result.txt. Stage that real file as text/plain, displayName result.txt, then result_propose with summary copied and data null. Do not make network calls.'
  }
  const expected = withSkill ? Buffer.concat([Buffer.from('SKILL_APPLIED\n'), bytes]) : bytes
  const expectedSha256 = createHash('sha256').update(expected).digest('hex')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const store = new SkillExecutionStore({ rootDirectory: directory('store'), scope: { agentId: 'native-probe' }, command })
  const input = { inputRef: 'input1', sha256, contentMimeType: 'text/plain', byteLength: bytes.length }
  writeFileSync(resolve(store.directory, 'inputs/input1'), bytes, { mode: 0o600 })
  store.write('inputs-snapshot', { inputs: [input] })
  const runtime = new TypedInspectionProfileRuntime({ profile: { profileId: 'native-model-probe', agentId: 'native-probe', codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: sourceHome,
    typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionProviderId: 'native-probe', typedInspectionProviderBaseUrl: baseUrl, typedInspectionNetworkConnectTimeoutMs: 10000 },
    materializerRoot: directory('materializer'), stateRoot: directory('state'), nativeToolchain: measureMinimalNativeExecutionToolchain() })
  // Preserve only visible fixture diagnostics, never reasoning or auth/config.
  const visibleCommands = []
  const suspend = runtime.suspendAdapter.bind(runtime)
  runtime.suspendAdapter = async key => {
    const adapter = runtime.activeAdapters.get(key)?.adapter
    const thread = store.read('native-thread')
    try {
      if (adapter && thread) {
        const result = await adapter.request('thread/read', { threadId: thread.threadId, includeTurns: true })
        for (const turn of result.thread?.turns || []) for (const item of turn.items || []) {
          if (item.type === 'commandExecution') visibleCommands.push(item.command)
          if (item.type === 'commandExecution') console.log(JSON.stringify({ type: item.type, status: item.status, command: item.command, exitCode: item.exitCode, aggregatedOutput: item.aggregatedOutput }))
          if (item.type === 'agentMessage') console.log(JSON.stringify({ type: item.type, text: item.text }))
        }
      }
    } finally { await suspend(key) }
  }
  try {
    const result = await runNativeExecution({ command, inputs: [input], entries, store, checkActive() {}, profileRuntime: runtime, model, effort: 'medium' })
    assert.equal(result.result.artifacts.length, 1)
    const artifact = result.result.artifacts[0]
    assert.deepEqual(store.readBlob(artifact.outputId), expected)
    if (withSkill) assert.ok(visibleCommands.some(command => command.includes('/scripts/copy.sh')), 'model must actually execute the approved packaged script')
    assert.equal(artifact.sha256, expectedSha256)
    assert.equal(store.read('native-terminal').status, 'completed')
    assert.equal(result.result.inputReceipts[0].carrier, 'local-file')
    assert.deepEqual(result.result.effectDependencies, [])
    console.log(JSON.stringify({ model, executionId: command.executionId, thread: store.read('native-thread'), turn: store.read('native-turn'), artifact: { outputId: artifact.outputId, sha256: artifact.sha256, byteLength: artifact.byteLength }, engineTerminal: 'completed', apiCommit: 'NOT_RUN', skills: entries.map(entry => entry.descriptor.skillKey) }))
  } finally {
    await runtime.dispose()
  }
})
