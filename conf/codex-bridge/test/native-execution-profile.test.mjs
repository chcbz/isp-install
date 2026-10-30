import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { canonicalSha256 } from '../chat-runtime.mjs'
import { skillPackageTreeDigest } from '../skill-manifest.mjs'
import { buildTypedInspectionCodexConfig, TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { buildNativeExecutionCodexConfig, measureMinimalNativeExecutionToolchain, nativeExecutionMountArgs, prepareNativeExecutionLayout, validateNativeExecutionToolchain, verifyNativeExecutionSkillCatalog } from '../native-execution-profile.mjs'

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const mkdir = path => { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); return path }
const tool = (sourcePath, sandboxPath) => ({ sourcePath: realpathSync(sourcePath), sandboxPath, sha256: sha256(sourcePath) })
const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-native-profile-')); chmodSync(root, 0o700)
  const execution = mkdir(resolve(root, 'execution')); const stateRoot = mkdir(resolve(root, 'state')); const sourceHome = mkdir(resolve(root, 'main-home'))
  writeFileSync(resolve(sourceHome, 'auth.json'), '{"OPENAI_API_KEY":"nonfunctional-isolation-fixture"}', { mode: 0o600 })
  writeFileSync(resolve(sourceHome, 'private-host-canary'), 'not-visible', { mode: 0o600 })
  const inputDirectory = mkdir(resolve(execution, 'inputs')); const scratchDirectory = mkdir(resolve(execution, 'scratch')); const draftsDirectory = mkdir(resolve(execution, 'drafts'))
  const trustedOutputs = mkdir(resolve(execution, 'outputs')); writeFileSync(resolve(trustedOutputs, 'private-blob'), 'trusted-not-visible', { mode: 0o600 })
  writeFileSync(resolve(inputDirectory, 'source.txt'), 'input-bytes', { mode: 0o600 })
  const packageRoot = mkdir(resolve(root, 'approved-package'))
  writeFileSync(resolve(packageRoot, 'SKILL.md'), '---\nname: authorized-helper\ndescription: Isolation test skill, no operations.\n---\nRead the authorized materials.\n', { mode: 0o600 })
  const skills = [{ skillKey: 'authorized-helper', packageRoot, packageTreeDigest: skillPackageTreeDigest(packageRoot) }]
  const nativeExecution = { executionId: 'exec-1', tools: [{ type: 'function', name: 'artifact_stage', description: 'stage', inputSchema: { type: 'object', properties: {} } }], checkActive() {}, async callTool() {} }
  const toolchain = { shell: '/bin/bash', files: [tool('/usr/bin/bash', '/bin/bash'), tool('/usr/bin/bash', '/bin/sh')] }
  const options = { inputDirectory, scratchDirectory, draftsDirectory, skills, nativeExecution, toolchain, stateRoot, sourceHome }
  const binding = { schemaVersion: 1, requestKey: 'key-1', authorizationId: 'auth-1', manifestDigest: 'manifest-1', requestId: 'req-1', turnId: 'turn-1', inputPolicyDigest: 'policy-1' }
  return { root, execution, options, binding, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const discovery = layout => ({ data: [{ cwd: '/execution', skills: layout.skills.map(skill => ({ name: skill.skillKey, path: `/state/codex-home/skills/${skill.skillKey}/SKILL.md`, enabled: true, scope: 'user' })), errors: [] }] })
const stubRuntime = f => {
  const runtime = Object.create(TypedInspectionProfileRuntime.prototype)
  let spawns = 0, disposals = 0, shutdowns = 0
  Object.assign(runtime, { profile: { codexHome: f.options.sourceHome, typedInspectionProviderNetwork: 'restricted-proxy' },
    stateRoot: f.options.stateRoot, nativeToolchain: f.options.toolchain, activeAdapters: new Map(), pendingNativeAdapters: new Map(), pendingInspectionKeys: new Set(),
    measureBinary: async () => ({ snapshotIdentity: {} }),
    egressFactory: () => ({ proxyUrl: 'http://10.0.2.2:1', start: async () => {}, bindOwner: async () => {}, attach: async () => ({ measured: true }), dispose: async () => { disposals++ } }),
    _spawnAdapter: async args => { spawns++; const adapter = new EventEmitter(); adapter.child = {}; adapter.closed = false; adapter.readback = { tools: { data: [] } }; adapter.request = async () => discovery(args.nativeView.layout); adapter.shutdown = async () => { shutdowns++; adapter.closed = true }; adapter.spawnArgs = args; adapter.startOrResumeThread = async () => 'thread-started'; adapter.runTurn = async () => 'turn-started'; return adapter },
    _initializeAndSeal: async adapter => { rmSync(adapter.spawnArgs.engineState.authPath, { force: true }); return { config: { config: { sandbox_mode: 'workspace-write', approval_policy: 'never', sandbox_workspace_write: { writable_roots: ['/workspace', '/outputs'], network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true } } } } }
  })
  return { runtime, counts: () => ({ spawns, disposals, shutdowns }) }
}
const open = (runtime, f, overrides = {}) => runtime.openNativeExecutionAdapter(f.options.inputDirectory, f.binding.requestKey, f.binding, { ...f.options, ...overrides })

test('native config and mounts keep inspection read-only; only scratch/drafts and engine state are writable', () => {
  const f = fixture()
  try {
    const layout = prepareNativeExecutionLayout(f.options)
    const readOnly = buildTypedInspectionCodexConfig({})
    assert.match(readOnly, /sandbox_mode = "read-only"/)
    assert.doesNotMatch(readOnly, /workspace-write/)
    assert.match(buildNativeExecutionCodexConfig(readOnly), /sandbox_mode = "workspace-write"/)
    assert.match(buildNativeExecutionCodexConfig(readOnly), /network_access = false/)
    const args = nativeExecutionMountArgs({ layout, engineState: { codexHome: resolve(f.options.stateRoot, 'engine-home') }, neutralDirectory: '/private/neutral', skillsDirectory: '/private/skills' })
    assert.deepEqual(args.slice(0, 6), ['--uid', '65534', '--gid', '65534', '--cap-drop', 'ALL'])
    const binds = args.flatMap((value, i) => value === '--bind' ? [[args[i + 1], args[i + 2]]] : [])
    assert.deepEqual(binds, [[resolve(f.options.stateRoot, 'engine-home'), '/state/codex-home'], [f.options.scratchDirectory, '/workspace'], [f.options.draftsDirectory, '/outputs']])
    assert.equal(args.includes(f.options.sourceHome), false)
    assert.equal(args.includes(resolve(f.execution, 'outputs')), false)
    assert.equal(args.includes('/execution'), true)
    assert.equal(args.includes('/state/codex-home/skills/authorized-helper'), true)
  } finally { f.cleanup() }
})

test('native mapping rejects trusted outputs, linked/overlapping roots, unpinned skills and toolchain drift', () => {
  const f = fixture()
  try {
    assert.throws(() => prepareNativeExecutionLayout({ ...f.options, draftsDirectory: resolve(f.execution, 'outputs') }), /DIRECTORY_MAPPING_INVALID/)
    const linked = resolve(f.execution, 'linked'); symlinkSync(f.options.scratchDirectory, linked)
    assert.throws(() => prepareNativeExecutionLayout({ ...f.options, scratchDirectory: linked }), /DIRECTORY_UNSAFE/)
    assert.throws(() => prepareNativeExecutionLayout({ ...f.options, stateRoot: f.execution }), /DIRECTORY_OVERLAP/)
    assert.throws(() => prepareNativeExecutionLayout({ ...f.options, nativeExecution: { ...f.options.nativeExecution, tools: [f.options.nativeExecution.tools[0], f.options.nativeExecution.tools[0]] } }), /BINDING_INVALID/)
    assert.throws(() => prepareNativeExecutionLayout({ ...f.options, skills: [{ ...f.options.skills[0], packageTreeDigest: 'f'.repeat(64) }] }), /SKILL_PACKAGE_CHANGED/)
    assert.throws(() => validateNativeExecutionToolchain(null), /TOOLCHAIN_REQUIRED/)
    assert.throws(() => validateNativeExecutionToolchain({ ...f.options.toolchain, files: [tool('/usr/bin/bash', '/etc/auth.json')] }), /TOOLCHAIN_INVALID/)
    assert.throws(() => validateNativeExecutionToolchain({ ...f.options.toolchain, files: f.options.toolchain.files.map(file => ({ ...file, sha256: 'a'.repeat(64) })) }), /TOOLCHAIN_DRIFT/)
  } finally { f.cleanup() }
})

test('native skill discovery requires the exact authorized paths, not arbitrary or system skills', () => {
  const f = fixture()
  try {
    const layout = prepareNativeExecutionLayout(f.options)
    assert.equal(verifyNativeExecutionSkillCatalog(discovery(layout), layout).measured, true)
    const extra = discovery(layout); extra.data[0].skills.push({ path: '/state/codex-home/skills/.system/unknown/SKILL.md', enabled: true })
    assert.throws(() => verifyNativeExecutionSkillCatalog(extra, layout), /OUTSIDE_AUTHORIZATION/)
    const missing = discovery(layout); missing.data[0].skills = []
    assert.throws(() => verifyNativeExecutionSkillCatalog(missing, layout), /DISCOVERY_UNVERIFIED/)
  } finally { f.cleanup() }
})

test('native open is single flight, binds callbacks/execution/mapping/tools and never uses inspection carrier readiness', async () => {
  const f = fixture(); const { runtime, counts } = stubRuntime(f)
  try {
    runtime.measure = () => { throw new Error('READ_ONLY_MEASUREMENT_MUST_NOT_AUTHORIZE_NATIVE') }
    const first = open(runtime, f); assert.equal(open(runtime, f), first)
    assert.throws(() => open(runtime, f, { nativeExecution: { ...f.options.nativeExecution, executionId: 'exec-2' } }), /BINDING_CONFLICT/)
    const adapter = await first
    assert.equal(await open(runtime, f), adapter)
    assert.equal(adapter.nativeExecutionIsolation.modelTurnMeasured, false)
    assert.equal(adapter.spawnArgs.nativeExecution.executionId, 'exec-1')
    assert.equal(adapter.spawnArgs.nativeView.layout.draftsDirectory, f.options.draftsDirectory)
    assert.throws(() => open(runtime, f, { nativeExecution: { ...f.options.nativeExecution, callTool() {} } }), /BINDING_CONFLICT/)
    assert.throws(() => open(runtime, f, { nativeExecution: { ...f.options.nativeExecution, tools: [] } }), /BINDING_CONFLICT/)
    assert.throws(() => runtime.openNativeExecutionAdapter(f.options.inputDirectory, 'wrong-key', f.binding, f.options), /BINDING_INVALID/)
    assert.deepEqual(counts(), { spawns: 1, disposals: 0, shutdowns: 0 })
    await runtime.releaseAdapter(f.binding.requestKey)
    assert.deepEqual(counts(), { spawns: 1, disposals: 1, shutdowns: 1 })
  } finally { await runtime.dispose(); f.cleanup() }
})

test('recovery checks original mapping before staging credentials; inspection cannot reuse native state', async () => {
  const f = fixture(); const { runtime, counts } = stubRuntime(f)
  try {
    await assert.rejects(open(runtime, f, { requireExistingState: true }), /RECOVERY_STATE_MISSING/)
    assert.equal(counts().spawns, 0)
    await open(runtime, f)
    const active = runtime.activeAdapters.get(f.binding.requestKey); const directory = active.engineState.directory
    await runtime.dispose()
    runtime.disposed = false
    await open(runtime, f, { requireExistingState: true })
    await runtime.dispose(); runtime.disposed = false
    // Same lexical path, different inode: never resume into a replacement directory.
    renameSync(f.options.draftsDirectory, `${f.options.draftsDirectory}-old`); mkdir(f.options.draftsDirectory)
    await assert.rejects(open(runtime, f, { requireExistingState: true }), /BINDING_CONFLICT/)
    assert.equal(existsSync(resolve(directory, 'codex-home/auth.json')), false)
    assert.throws(() => runtime._prepareRequestState(f.binding), /BINDING_CONFLICT/)
  } finally { await runtime.dispose(); f.cleanup() }
})

test('suspend retains the original Home, closes only its process/egress, and permits fresh lease callbacks on resume', async () => {
  const f = fixture(); const { runtime, counts } = stubRuntime(f)
  try {
    const adapter = await open(runtime, f)
    const directory = runtime.activeAdapters.get(f.binding.requestKey).engineState.directory
    const canary = resolve(directory, 'codex-home', 'original-thread-state'); writeFileSync(canary, 'original-state')
    // An unrelated execution must not be touched by suspension.
    const unrelated = { adapter: { shutdown: () => assert.fail('unrelated shutdown') } }
    runtime.activeAdapters.set('unrelated', unrelated)
    assert.equal(await runtime.suspendAdapter(f.binding.requestKey), true)
    assert.equal(adapter.closed, true); assert.equal(existsSync(canary), true)
    assert.throws(() => adapter.spawnArgs.nativeExecution.checkActive(), /START_CANCELLED/)
    assert.equal(runtime.activeAdapters.get('unrelated'), unrelated)
    assert.deepEqual(counts(), { spawns: 1, disposals: 1, shutdowns: 1 })
    const fresh = { ...f.options.nativeExecution, checkActive() {}, async callTool() {} }
    const resumed = await open(runtime, f, { nativeExecution: fresh, requireExistingState: true })
    assert.notEqual(resumed, adapter)
    assert.equal(resumed.spawnArgs.nativeExecution.callTool, fresh.callTool)
    assert.equal(resumed.spawnArgs.engineState.directory, directory)
    assert.equal(readFileSync(canary, 'utf8'), 'original-state')
    await runtime.suspendAdapter(f.binding.requestKey)
    assert.equal(existsSync(directory), true)
    assert.equal(await runtime.releaseAdapter(f.binding.requestKey), true)
    assert.equal(existsSync(directory), false)
    runtime.activeAdapters.delete('unrelated')
  } finally { runtime.activeAdapters.delete('unrelated'); await runtime.dispose(); f.cleanup() }
})

test('post-restart commit cleanup resolves only the verified request Home without maps, engine startup or directory scanning', async () => {
  const f = fixture(); const { runtime } = stubRuntime(f)
  try {
    await open(runtime, f)
    const directory = runtime.activeAdapters.get(f.binding.requestKey).engineState.directory
    await runtime.suspendAdapter(f.binding.requestKey)
    await assert.rejects(runtime.releaseAdapter(f.binding.requestKey, { requestBinding: { ...f.binding, turnId: 'wrong-turn' } }), /BINDING_CONFLICT/)
    assert.equal(existsSync(directory), true)
    const restarted = stubRuntime(f).runtime
    restarted.measureBinary = () => assert.fail('cleanup must not start an engine')
    const unrelated = mkdir(resolve(f.options.stateRoot, 'requests', 'unrelated-home'))
    writeFileSync(resolve(unrelated, 'keep'), 'unrelated')
    assert.equal(await restarted.releaseAdapter(f.binding.requestKey), false)
    assert.equal(existsSync(directory), true)
    await assert.rejects(restarted.releaseAdapter('wrong-key', { requestBinding: f.binding }), /BINDING_INVALID/)
    assert.equal(await restarted.releaseAdapter(f.binding.requestKey, { requestBinding: { ...f.binding, turnId: 'different-turn' } }), false)
    assert.equal(existsSync(directory), true)
    const marker = resolve(directory, 'binding.json'); const original = readFileSync(marker, 'utf8')
    writeFileSync(marker, original.replace('auth-1', 'other-auth'))
    await assert.rejects(restarted.releaseAdapter(f.binding.requestKey, { requestBinding: f.binding }), /BINDING_CONFLICT/)
    assert.equal(existsSync(directory), true)
    writeFileSync(marker, original)
    assert.equal(await restarted.releaseAdapter(f.binding.requestKey, { requestBinding: f.binding }), true)
    assert.equal(existsSync(directory), false)
    assert.equal(readFileSync(resolve(unrelated, 'keep'), 'utf8'), 'unrelated')
    assert.equal(await restarted.releaseAdapter(f.binding.requestKey, { requestBinding: f.binding }), false)
    await restarted.dispose()
  } finally { await runtime.dispose(); f.cleanup() }
})

test('suspend during startup cancels the old lease but preserves a prepared Home; closing fences concurrent reopen', async () => {
  const f = fixture(); const { runtime } = stubRuntime(f)
  try {
    let resume; const originalSpawn = runtime._spawnAdapter
    runtime._spawnAdapter = args => new Promise(resolve => { resume = async () => resolve(await originalSpawn(args)) })
    const opening = open(runtime, f)
    while (!resume) await new Promise(resolve => setImmediate(resolve))
    const stopping = runtime.suspendAdapter(f.binding.requestKey)
    assert.throws(() => open(runtime, f), /ADAPTER_CLOSING/)
    await resume(); await assert.rejects(opening, /START_CANCELLED/); await stopping
    const directory = resolve(f.options.stateRoot, 'requests', canonicalSha256(f.binding).slice(7))
    assert.equal(existsSync(directory), true)
    assert.equal(existsSync(resolve(directory, 'codex-home/auth.json')), false)
    assert.equal(await runtime.releaseAdapter(f.binding.requestKey), true)
    assert.equal(existsSync(directory), false)
  } finally { await runtime.dispose(); f.cleanup() }
})

test('native discovery is read back at thread/resume and turn boundaries, and new unauthorized skills block execution', async () => {
  const f = fixture(); const { runtime } = stubRuntime(f)
  try {
    const adapter = await open(runtime, f)
    assert.equal(await adapter.startOrResumeThread(null, { cwd: '/execution' }), 'thread-started')
    assert.equal(await adapter.runTurn({}), 'turn-started')
    adapter.request = async () => { const result = discovery(adapter.spawnArgs.nativeView.layout); result.data[0].skills.push({ path: '/workspace/.agents/skills/injected/SKILL.md', enabled: true }); return result }
    await assert.rejects(adapter.startOrResumeThread({ threadId: 'existing' }, { cwd: '/execution' }), /OUTSIDE_AUTHORIZATION/)
    await assert.rejects(adapter.runTurn({}), /OUTSIDE_AUTHORIZATION/)
  } finally { await runtime.dispose(); f.cleanup() }
})

for (const phase of ['start', 'spawn', 'catalog', 'cancel']) test(`native ${phase} failure cleans only its resources and removes bootstrap auth`, async () => {
  const f = fixture(); const { runtime, counts } = stubRuntime(f)
  try {
    if (phase === 'start') runtime.egressFactory = () => ({ start: async () => { throw new Error('test-start-failure') }, dispose: async () => {} })
    if (phase === 'spawn') runtime._spawnAdapter = async () => { throw new Error('test-spawn-failure') }
    if (phase === 'catalog') { const spawn = runtime._spawnAdapter; runtime._spawnAdapter = async args => { const adapter = await spawn(args); adapter.request = async () => ({ data: [] }); return adapter } }
    if (phase === 'cancel') { let unblock; runtime.measureBinary = () => new Promise(resolve => { unblock = () => resolve({}) }); const opening = open(runtime, f); const released = runtime.releaseAdapter(f.binding.requestKey); unblock(); await assert.rejects(opening, /START_CANCELLED/); assert.equal(await released, true); assert.equal(counts().spawns, 0); return }
    await assert.rejects(open(runtime, f))
    assert.equal(runtime.activeAdapters.size, 0); assert.equal(runtime.pendingNativeAdapters.size, 0)
    assert.equal(existsSync(resolve(f.options.sourceHome, 'auth.json')), true)
    const directory = resolve(f.options.stateRoot, 'requests', canonicalSha256(f.binding).slice(7))
    assert.equal(existsSync(directory), false)
  } finally { await runtime.dispose(); f.cleanup() }
})

// Opt-in, no model/Provider call. Only a tiny shell and handshake run locally.
const realProbe = process.env.CYF_NATIVE_EXECUTION_ISOLATION_PROBE === '1'
const realToolchain = measureMinimalNativeExecutionToolchain

test('real bwrap native shell writes drafts, cannot mutate inputs/skills/config or see trusted store/host secrets/network', { skip: !realProbe }, () => {
  const f = fixture()
  try {
    const toolchain = realToolchain(); const layout = prepareNativeExecutionLayout({ ...f.options, toolchain })
    const codexHome = mkdir(resolve(f.options.stateRoot, 'engine-home')); writeFileSync(resolve(codexHome, 'config.toml'), buildNativeExecutionCodexConfig(buildTypedInspectionCodexConfig({})), { mode: 0o600 })
    const neutralDirectory = mkdir(resolve(f.options.stateRoot, 'neutral')); const skillsDirectory = mkdir(resolve(f.options.stateRoot, 'skills')); mkdir(resolve(skillsDirectory, 'authorized-helper'))
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/inputs', '--ro-bind', f.options.inputDirectory, '/inputs',
      ...nativeExecutionMountArgs({ layout, engineState: { codexHome }, neutralDirectory, skillsDirectory }), '--setenv', 'HOME', '/state/home', '--setenv', 'CODEX_HOME', '/state/codex-home', '--chdir', '/execution']
    const script = `set -e\n[ "$PWD" = /execution ]\n[ "$(cat /inputs/source.txt)" = input-bytes ]\nprintf draft > /workspace/work.txt\ncat /workspace/work.txt > /outputs/result.txt\n! (echo bad > /inputs/source.txt) 2>/dev/null\n! (echo bad > /state/codex-home/skills/authorized-helper/SKILL.md) 2>/dev/null\n! (echo bad > /state/codex-home/config.toml) 2>/dev/null\n! mkdir /execution/.agents 2>/dev/null\n! mkdir /.agents 2>/dev/null\n! mkdir /state/.agents 2>/dev/null\n! mkdir /state/home/.agents 2>/dev/null\n! mkdir /state/codex-home/skills/unapproved 2>/dev/null\n[ ! -e ${JSON.stringify(f.options.sourceHome)} ]\n[ ! -e ${JSON.stringify(resolve(f.execution, 'outputs/private-blob'))} ]\n[ ! -e /etc/shadow ]\n[ ! -e /root/.codex ]\n[ ! -e /usr/bin/curl ]\n! (echo x > /dev/tcp/1.1.1.1/443) 2>/dev/null\n! (echo x > /dev/tcp/127.0.0.1/22) 2>/dev/null\nprintf native-shell-isolated`
    const result = spawnSync('/usr/bin/bwrap', [...args, '/bin/bash', '--noprofile', '--norc', '-c', script], { encoding: 'utf8', env: { LANG: 'C.UTF-8' } })
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'native-shell-isolated')
    assert.equal(readFileSync(resolve(f.options.draftsDirectory, 'result.txt'), 'utf8'), 'draft')
    assert.equal(readFileSync(resolve(f.options.inputDirectory, 'source.txt'), 'utf8'), 'input-bytes')
    assert.equal(readFileSync(resolve(f.execution, 'outputs/private-blob'), 'utf8'), 'trusted-not-visible')
    console.log('native shell toolchain file identities:', JSON.stringify(toolchain))
  } finally { f.cleanup() }
})

test('real native open masks auto-discovered system skills, supports empty skills and measures restricted egress without a model turn', { skip: !realProbe }, async () => {
  const f = fixture(); const nativeToolchain = realToolchain()
  const runtime = new TypedInspectionProfileRuntime({ profile: { profileId: 'native-isolation-test', agentId: 'native-isolation-agent', codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: f.options.sourceHome,
    typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionProviderId: 'isolation-probe', typedInspectionProviderBaseUrl: 'https://provider.invalid/v1', typedInspectionNetworkConnectTimeoutMs: 1000 },
    materializerRoot: mkdir(resolve(f.root, 'inspection-inputs')), stateRoot: f.options.stateRoot, nativeToolchain })
  let control
  try {
    const schema = await runtime.measureBinary(runtime.profile)
    console.log('native handshake schema/version:', schema.schemaContractId, schema.cliVersion)
    // Positive discovery control: this same delivered engine auto-installs its
    // .system packages into an ordinary writable request CODEX_HOME.
    const controlState = runtime._prepareEphemeralState('system-discovery-control')
    control = await runtime._spawnAdapter({ inputDirectory: runtime.materializerRoot, engineState: controlState, schemaMeasurement: schema })
    await runtime._initializeAndSeal(control)
    const controlSkills = await control.request('skills/list', { cwds: ['/inputs'], forceReload: true })
    console.log('ordinary writable engine system discovery:', JSON.stringify(controlSkills))
    assert.ok(controlSkills.data[0].skills.some(skill => skill.scope === 'system' && skill.path.includes('/skills/.system/')))
    await control.shutdown({ timeoutMs: 1000 }); control = null
    for (const skills of [[], f.options.skills]) {
      const adapter = await open(runtime, f, { skills })
      const view = adapter.nativeExecutionIsolation
      assert.equal(adapter.readback.credentialIsolation.bootstrapCredentialRemoved, true)
      assert.equal(adapter.readback.config.config.sandbox_mode, 'workspace-write')
      assert.equal(adapter.readback.providerSystemProxy.enabled, true)
      assert.equal(view.network.measured, true)
      assert.equal(view.network.nftDefaultDropReadback, true)
      assert.equal(view.network.directInternetBlocked, true)
      const actual = await adapter.request('skills/list', { cwds: ['/execution'], forceReload: true })
      console.log('native actual skill discovery:', JSON.stringify(actual))
      assert.deepEqual(view.skills.paths, skills.map(skill => `/state/codex-home/skills/${skill.skillKey}/SKILL.md`))
      assert.equal(actual.data[0].skills.length, skills.length)
      const shell = await adapter.request('command/exec', { command: ['/bin/bash', '-c',
        'set -e; cat /inputs/source.txt > /outputs/nested.txt; cat /outputs/nested.txt; ! (echo bad > /state/codex-home/forbidden) 2>/dev/null; ! (echo bad > /execution/.agents/SKILL.md) 2>/dev/null; ! (echo bad > /inputs/source.txt) 2>/dev/null'],
        cwd: '/execution', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/outputs'], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } })
      assert.equal(shell.exitCode, 0, shell.stderr)
      assert.equal(shell.stdout, 'input-bytes')
      assert.equal(readFileSync(resolve(f.options.draftsDirectory, 'nested.txt'), 'utf8'), 'input-bytes')
      const pid = adapter.readback.processExecutable.pid
      assert.equal(existsSync(`/proc/${pid}/root/state/codex-home/auth.json`), false)
      assert.equal(existsSync(`/proc/${pid}/root${f.options.sourceHome}`), false)
      await runtime.releaseAdapter(f.binding.requestKey)
    }
  } finally { await control?.shutdown({ timeoutMs: 1000 }).catch(() => {}); await runtime.dispose(); f.cleanup() }
})

test('native declaration requires a successful isolated engine, TLS and shell probe and cleans only its own request', async () => {
  const f = fixture()
  try {
    const materializerRoot = mkdir(resolve(f.root, 'declaration-inputs'))
    const runtime = Object.create(TypedInspectionProfileRuntime.prototype)
    Object.assign(runtime, { materializerRoot, profile: { typedInspectionProviderNetwork: 'restricted-proxy' }, nativeToolchain: f.options.toolchain, activeAdapters: new Map() })
    let mode = 'ok', releases = 0, openings = 0
    runtime.openNativeExecutionAdapter = async (inputs, id, binding, options) => {
      openings++; assert.equal(binding.requestKey, id); assert.deepEqual(options.skills, []); assert.deepEqual(options.nativeExecution.tools, [])
      if (mode === 'open-fail') throw new Error('unavailable')
      runtime.activeAdapters.set(id, { egress: { measureAllowedTls: async () => ({ measured: true, tlsVerified: mode !== 'tls-fail' }) } })
      return { nativeExecutionIsolation: { network: { measured: true, nftDefaultDropReadback: true, directInternetBlocked: true } }, readback: { providerCaTrust: {} },
        request: async (method, args) => {
          assert.equal(method, 'command/exec'); assert.equal(args.cwd, '/execution')
          if (mode === 'shell-fail') return { exitCode: 1, stdout: '' }
          writeFileSync(resolve(options.draftsDirectory, 'probe.txt'), readFileSync(resolve(inputs, 'probe.txt')))
          return { exitCode: 0, stdout: 'native-declaration-probe' }
        } }
    }
    runtime.releaseAdapter = async (id, { requestBinding }) => { assert.equal(id, requestBinding.requestKey); releases++; runtime.activeAdapters.delete(id) }
    runtime.contractReadback = { unrelated: 'inspection evidence' }
    assert.equal(runtime.nativeExecutionDeclaration(), null)
    assert.deepEqual(await runtime.measureNativeExecution(), { schemaVersion: 1, executionProtocolVersion: 5, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1', outputMimeTypes: ['text/plain', 'text/markdown', 'text/html', 'application/json'] })
    assert.equal(runtime.nativeExecutionDeclaration()?.executionProtocolVersion, 5)
    for (mode of ['open-fail', 'tls-fail', 'shell-fail']) { assert.equal(await runtime.measureNativeExecution(), null); assert.equal(runtime.nativeExecutionDeclaration(), null) }
    assert.equal(releases, 4); assert.equal(runtime.activeAdapters.size, 0)
    assert.deepEqual((await import('node:fs')).readdirSync(materializerRoot), [])
    runtime.nativeToolchain = null; assert.equal(await runtime.measureNativeExecution(), null); assert.equal(openings, 4)
    runtime.nativeToolchain = { ...f.options.toolchain, files: f.options.toolchain.files.map(file => ({ ...file, sha256: 'a'.repeat(64) })) }
    assert.equal(await runtime.measureNativeExecution(), null); assert.equal(openings, 4)
    mode = 'ok'
    runtime.nativeToolchain = f.options.toolchain
    const first = runtime.measureNativeExecution(), second = runtime.measureNativeExecution()
    assert.equal(first, second)
    assert.equal(runtime.nativeExecutionDeclaration(), null)
    assert.equal((await first).executionProtocolVersion, 5)
    assert.equal(runtime.nativeExecutionDeclaration().executionProtocolVersion, 5)
    runtime.disposed = true; assert.equal(runtime.nativeExecutionDeclaration(), null); assert.equal(await runtime.measureNativeExecution(), null)
  } finally { f.cleanup() }
})

test('real native capability declaration measures shell and provider TLS without a model turn', { skip: !realProbe || !process.env.CYF_NATIVE_DECLARATION_PROVIDER_URL }, async () => {
  const f = fixture()
  const runtime = new TypedInspectionProfileRuntime({ profile: { profileId: 'native-declaration-test', agentId: 'native-declaration-agent',
    codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: f.options.sourceHome,
    typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionProviderId: 'isolation-probe',
    typedInspectionProviderBaseUrl: process.env.CYF_NATIVE_DECLARATION_PROVIDER_URL, typedInspectionNetworkConnectTimeoutMs: 10000 },
    materializerRoot: mkdir(resolve(f.root, 'declaration-inputs')), stateRoot: f.options.stateRoot, nativeToolchain: realToolchain() })
  try {
    assert.equal(runtime.nativeExecutionDeclaration(), null)
    const declaration = await runtime.measureNativeExecution()
    if (!declaration) console.log('native declaration failure:', JSON.stringify(runtime.nativeExecutionMeasurementFailure))
    assert.deepEqual(declaration, { schemaVersion: 1, executionProtocolVersion: 5, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1',
      outputMimeTypes: ['text/plain', 'text/markdown', 'text/html', 'application/json'] })
    assert.equal(runtime.nativeExecutionDeclaration(), declaration)
    assert.equal(runtime.activeAdapters.size, 0)
    console.log('native declaration real engine/TLS/shell passed; model turn and API commit: NOT_RUN')
  } finally { await runtime.dispose(); f.cleanup() }
})

test('minimal toolchain keeps shell-only default and optionally pins the running Node and dependencies', t => {
  const shell = measureMinimalNativeExecutionToolchain()
  assert.equal(shell.files.some(file => file.sandboxPath === '/usr/bin/node'), false)
  try { validateNativeExecutionToolchain({ ...shell, files: [...shell.files, tool(process.execPath, '/usr/bin/node')] }) }
  catch (error) { if (error.code !== 'NATIVE_EXECUTION_TOOLCHAIN_UNSAFE') throw error; t.skip('running Node is not trusted for this UID'); return }
  const withNode = measureMinimalNativeExecutionToolchain({ nodeBin: process.execPath })
  const node = withNode.files.find(file => file.sandboxPath === '/usr/bin/node')
  assert.equal(node.sourcePath, realpathSync(process.execPath))
  assert.equal(node.sha256, sha256(process.execPath))
  assert.ok(shell.files.every(file => withNode.files.some(candidate => candidate.sandboxPath === file.sandboxPath && candidate.sha256 === file.sha256)))
  assert.throws(() => measureMinimalNativeExecutionToolchain({ nodeBin: '/usr/bin/bash' }), /TOOLCHAIN_NODE_INVALID/)
  assert.throws(() => measureMinimalNativeExecutionToolchain({ nodeBin: 'node' }), /TOOLCHAIN_NODE_INVALID/)
  assert.throws(() => measureMinimalNativeExecutionToolchain({ nodeBin: '/no/such/node' }))
  assert.throws(() => validateNativeExecutionToolchain({ ...withNode, files: withNode.files.map(file => file === node ? { ...file, sha256: 'a'.repeat(64) } : file) }), /TOOLCHAIN_DRIFT/)
})

test('real isolated native Node runs package mjs and reads inputs and writes outputs', { skip: process.env.CYF_NATIVE_NODE_ISOLATION_PROBE !== '1' }, () => {
  const f = fixture()
  try {
    const packageRoot = f.options.skills[0].packageRoot
    writeFileSync(resolve(packageRoot, 'run.mjs'), "import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync('/outputs/node.txt', readFileSync('/inputs/source.txt')); console.log('node-package-ok')\n", { mode: 0o600 })
    const skills = [{ ...f.options.skills[0], packageTreeDigest: skillPackageTreeDigest(packageRoot) }]
    const layout = prepareNativeExecutionLayout({ ...f.options, skills, toolchain: measureMinimalNativeExecutionToolchain({ nodeBin: process.execPath }) })
    const codexHome = mkdir(resolve(f.options.stateRoot, 'engine-home')); writeFileSync(resolve(codexHome, 'config.toml'), buildNativeExecutionCodexConfig(buildTypedInspectionCodexConfig({})), { mode: 0o600 })
    const neutralDirectory = mkdir(resolve(f.options.stateRoot, 'neutral')); const skillsDirectory = mkdir(resolve(f.options.stateRoot, 'skills')); mkdir(resolve(skillsDirectory, 'authorized-helper'))
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/inputs', '--ro-bind', f.options.inputDirectory, '/inputs',
      ...nativeExecutionMountArgs({ layout, engineState: { codexHome }, neutralDirectory, skillsDirectory }), '--setenv', 'HOME', '/state/home', '--setenv', 'CODEX_HOME', '/state/codex-home', '--chdir', '/execution',
      '/usr/bin/node', '/state/codex-home/skills/authorized-helper/run.mjs']
    const result = spawnSync('/usr/bin/bwrap', args, { encoding: 'utf8', env: { LANG: 'C.UTF-8' } })
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'node-package-ok')
    assert.equal(readFileSync(resolve(f.options.draftsDirectory, 'node.txt'), 'utf8'), 'input-bytes')
  } finally { f.cleanup() }
})

test('selected skill configuration is read-only and binds network and configuration digests without persisting secrets in mapping', () => {
  const f = fixture()
  try {
    const skillConfiguration = [{ skillKey: 'authorized-helper', configuration: { apiKey: 'synthetic-secret' }, networkOrigins: ['https://service.invalid'] }]
    const nativeExecution = { ...f.options.nativeExecution, networkAccess: true }
    const layout = prepareNativeExecutionLayout({ ...f.options, nativeExecution, skillConfiguration })
    assert.deepEqual(layout.binding.networkOrigins, ['https://service.invalid'])
    assert.equal(layout.binding.networkAccess, true)
    assert.equal(JSON.stringify(layout.binding).includes('synthetic-secret'), false)
    const engineState = { directory: '/private/request', codexHome: '/private/request/codex-home' }
    const args = nativeExecutionMountArgs({ layout, engineState, neutralDirectory: '/private/neutral', skillsDirectory: '/private/skills', skillConfigurationDirectory: '/private/request/skill-config' })
    const at = args.indexOf('/private/request/skill-config')
    assert.equal(args[at - 1], '--ro-bind'); assert.equal(args[at + 1], '/skill-config')
    assert.ok(args.includes('CYF_SKILL_CONFIG_DIR'))
    assert.match(buildNativeExecutionCodexConfig(buildTypedInspectionCodexConfig({}), { networkAccess: true }), /network_access = true/)
    assert.throws(() => prepareNativeExecutionLayout({ ...f.options, skillConfiguration }), /NETWORK_BINDING_INVALID/)
    assert.throws(() => prepareNativeExecutionLayout({ ...f.options, nativeExecution, skillConfiguration: [{ ...skillConfiguration[0], skillKey: 'unselected' }] }), /CONFIG_BINDING_INVALID/)
    const changed = prepareNativeExecutionLayout({ ...f.options, nativeExecution, skillConfiguration: [{ ...skillConfiguration[0], configuration: { apiKey: 'rotated' } }] })
    assert.notEqual(layout.digest, changed.digest)
  } finally { f.cleanup() }
})

test('native skill configuration is removed on suspend, process exit and profile disposal', async () => {
  for (const close of ['suspend', 'exit', 'dispose']) {
    const f = fixture(); const { runtime } = stubRuntime(f)
    try {
      const skillConfiguration = [{ skillKey: 'authorized-helper', configuration: { apiKey: 'synthetic-secret' }, networkOrigins: [] }]
      const adapter = await open(runtime, f, { skillConfiguration })
      const directory = adapter.spawnArgs.nativeView.skillConfigurationDirectory
      assert.equal(JSON.parse(readFileSync(resolve(directory, 'authorized-helper.json'), 'utf8')).apiKey, 'synthetic-secret')
      if (close === 'suspend') await runtime.suspendAdapter(f.binding.requestKey)
      if (close === 'exit') adapter.emit('exit')
      if (close === 'dispose') await runtime.dispose()
      assert.equal(existsSync(directory), false)
      assert.equal(existsSync(adapter.spawnArgs.engineState.directory), true)
    } finally { await runtime.dispose(); f.cleanup() }
  }
})

test('SCRIPT declaration requires its own successful configured package and restricted network probe; failures retain LOCAL', async () => {
  const f = fixture()
  try {
    const runtime = Object.create(TypedInspectionProfileRuntime.prototype)
    const node = tool('/usr/bin/bash', '/usr/bin/node') // The adapter is mocked; no program is executed.
    Object.assign(runtime, { materializerRoot: mkdir(resolve(f.root, 'script-measurements')), profile: { typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionNetworkConnectTimeoutMs: 1000 }, nativeToolchain: { ...f.options.toolchain, files: [...f.options.toolchain.files, node] }, activeAdapters: new Map() })
    let mode = 'ok', releases = 0, scriptOpens = 0
    runtime.openNativeExecutionAdapter = async (inputs, id, binding, options) => {
      assert.equal(id, binding.requestKey)
      if (options.nativeExecution.networkAccess) {
        scriptOpens++
        assert.equal(options.skills[0].skillKey, 'probe-skill')
        const syntax = spawnSync(process.execPath, ['--check', resolve(options.skills[0].packageRoot, 'probe.mjs')], { encoding: 'utf8' })
        assert.equal(syntax.status, 0, syntax.stderr)
        assert.equal(options.skillConfiguration[0].configuration.marker, 'synthetic-config')
        assert.match(options.skillConfiguration[0].networkOrigins[0], /^https:\/\/127\.0\.0\.1:\d+$/)
        if (mode === 'script-open-fail') throw Error('no script adapter')
        return { nativeExecutionIsolation: { network: { measured: true, nftDefaultDropReadback: true, directInternetBlocked: mode !== 'script-network-fail' } },
          request: async (method, args) => { assert.equal(method, 'command/exec'); assert.equal(args.command[0], '/usr/bin/node'); assert.equal(args.sandboxPolicy.networkAccess, true)
            if (mode === 'script-exec-fail') return { exitCode: 1 }
            writeFileSync(resolve(options.draftsDirectory, 'script-probe.txt'), 'script-ok'); return { exitCode: 0, stdout: 'script-ok\n' } } }
      }
      runtime.activeAdapters.set(id, { egress: { measureAllowedTls: async () => ({ measured: true, tlsVerified: true }) } })
      return { nativeExecutionIsolation: { network: { measured: true, nftDefaultDropReadback: true, directInternetBlocked: true } }, readback: { providerCaTrust: {} },
        request: async () => { writeFileSync(resolve(options.draftsDirectory, 'probe.txt'), readFileSync(resolve(inputs, 'probe.txt'))); return { exitCode: 0, stdout: 'native-declaration-probe' } } }
    }
    runtime.releaseAdapter = async id => { releases++; runtime.activeAdapters.delete(id); if (mode === 'script-cleanup-fail' && id.startsWith('native-script-')) throw Error('cleanup') }
    const declaration = await runtime.measureNativeExecution()
    assert.deepEqual(declaration.supportedToolPolicyRefs, ['NATIVE_SKILL_SCRIPT_V1'])
    assert.deepEqual(declaration.outputMimeTypes, ['text/plain', 'text/markdown', 'text/html', 'application/json', 'image/png'])
    for (mode of ['script-open-fail', 'script-network-fail', 'script-exec-fail', 'script-cleanup-fail']) {
      const local = await runtime.measureNativeExecution()
      assert.equal(local.toolPolicyRef, 'NATIVE_LOCAL_FILES_V1'); assert.equal(Object.hasOwn(local, 'supportedToolPolicyRefs'), false)
      assert.deepEqual(local.outputMimeTypes, ['text/plain', 'text/markdown', 'text/html', 'application/json'])
      assert.ok(runtime.nativeScriptMeasurementFailure)
    }
    assert.equal(scriptOpens, 5); assert.equal(releases, 10)
    assert.deepEqual((await import('node:fs')).readdirSync(runtime.materializerRoot), [])
  } finally { f.cleanup() }
})

test('real SCRIPT declaration uses Node package, read-only config and additional-origin proxy without a model turn', { skip: !realProbe || !process.env.CYF_NATIVE_DECLARATION_PROVIDER_URL }, async () => {
  const f = fixture()
  const runtime = new TypedInspectionProfileRuntime({ profile: { profileId: 'native-script-declaration-test', agentId: 'native-script-declaration-agent',
    codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: f.options.sourceHome,
    typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionProviderId: 'isolation-probe',
    typedInspectionProviderBaseUrl: process.env.CYF_NATIVE_DECLARATION_PROVIDER_URL, typedInspectionNetworkConnectTimeoutMs: 10000 },
    materializerRoot: mkdir(resolve(f.root, 'script-declaration-inputs')), stateRoot: f.options.stateRoot, nativeToolchain: realToolchain({ nodeBin: process.execPath }) })
  // This fixture has only synthetic auth/config; log syscall, path and callsite, never file contents.
  const openMeasured = runtime._openNativeExecutionAdapter.bind(runtime)
  runtime._openNativeExecutionAdapter = async (...args) => {
    try { return await openMeasured(...args) } catch (error) {
      console.log('fixture engine-open failure:', JSON.stringify({ code: error.code, syscall: error.syscall, path: error.path, stack: error.stack?.split('\n').slice(1, 5) }))
      throw error
    }
  }
  try {
    const declaration = await runtime.measureNativeExecution()
    console.log('local measurement failure:', JSON.stringify(runtime.nativeExecutionMeasurementFailure))
    console.log('script measurement failure:', JSON.stringify(runtime.nativeScriptMeasurementFailure))
    assert.equal(declaration?.toolPolicyRef, 'NATIVE_LOCAL_FILES_V1')
    assert.deepEqual(declaration?.supportedToolPolicyRefs, ['NATIVE_SKILL_SCRIPT_V1'])
    assert.deepEqual(declaration?.outputMimeTypes, ['text/plain', 'text/markdown', 'text/html', 'application/json', 'image/png'])
    assert.equal(runtime.activeAdapters.size, 0)
    console.log('real SCRIPT declaration passed; model turn, real credential and paid API: NOT_RUN')
  } finally { await runtime.dispose(); f.cleanup() }
})

test('Office declaration requires actual document reopens; document failure retains existing text/image capability', async () => {
  const { DOCUMENT_PROBE, DOCUMENT_MIMES } = await import('../native-document-toolchain.mjs')
  const f = fixture()
  try {
    const runtime = Object.create(TypedInspectionProfileRuntime.prototype)
    Object.assign(runtime, { materializerRoot: mkdir(resolve(f.root, 'document-measurements')), profile: { typedInspectionProviderNetwork: 'restricted-proxy' },
      nativeToolchain: { ...f.options.toolchain, files: [...f.options.toolchain.files, tool('/usr/bin/bash', DOCUMENT_PROBE)] }, activeAdapters: new Map() })
    let success = true
    runtime._measureNativeSkillScript = async () => true
    runtime.openNativeExecutionAdapter = async (inputs, id, binding, options) => {
      runtime.activeAdapters.set(id, { egress: { measureAllowedTls: async () => ({ measured: true, tlsVerified: true }) } })
      return { nativeExecutionIsolation: { network: { measured: true, nftDefaultDropReadback: true, directInternetBlocked: true } }, readback: { providerCaTrust: {} },
        request: async (_method, args) => {
          if (args.command[0] === '/usr/bin/python3') {
            assert.deepEqual(args.command, ['/usr/bin/python3', '-I', '-B', DOCUMENT_PROBE])
            assert.equal(args.sandboxPolicy.networkAccess, false)
            return { exitCode: success ? 0 : 1, stdout: success ? 'native-documents-ready\n' : '' }
          }
          writeFileSync(resolve(options.draftsDirectory, 'probe.txt'), readFileSync(resolve(inputs, 'probe.txt')))
          return { exitCode: 0, stdout: 'native-declaration-probe' }
        } }
    }
    runtime.releaseAdapter = async id => { runtime.activeAdapters.delete(id) }
    const ready = await runtime.measureNativeExecution()
    assert.deepEqual(ready.outputMimeTypes.slice(-2), DOCUMENT_MIMES)
    assert.ok(ready.outputMimeTypes.includes('image/png'))
    success = false
    const failed = await runtime.measureNativeExecution()
    assert.deepEqual(failed.outputMimeTypes, ['text/plain', 'text/markdown', 'text/html', 'application/json', 'image/png'])
    assert.equal(runtime.nativeDocumentMeasurementFailure.code, 'NATIVE_DOCUMENT_PROBE_FAILED')
    assert.equal(runtime.activeAdapters.size, 0)
  } finally { f.cleanup() }
})
