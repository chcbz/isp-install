import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createLocalScriptRunner } from '../skill-runners/local-script.mjs'
import { skillHash } from '../skill-executor.mjs'
import { skillPackageTreeDigest } from '../skill-manifest.mjs'
import { SkillEffects, SkillExecutionStore, SKILL_INPUT_CARRIERS } from '../skill-execution-store.mjs'
const fixture = (t, body) => {
  const root = mkdtempSync(resolve(tmpdir(), 'skill-local-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const directory of ['package', 'outputs', 'inputs', 'private-home']) mkdirSync(resolve(root, directory), { mode: 0o700 })
  writeFileSync(resolve(root, 'package/main.mjs'), body, { mode: 0o400 })
  const bytes = Buffer.from('真实受权输入 abc\n'), inputPath = resolve(root, 'inputs/input_1')
  writeFileSync(inputPath, bytes, { mode: 0o400 })
  writeFileSync(resolve(root, 'private-home/auth.json'), 'host-token-must-not-be-visible', { mode: 0o600 })
  const command = { executionId: 'pwe_local', snapshotDigest: 'a'.repeat(64), inputRefs: ['input_1'] }
  const descriptor = { packageRoot: resolve(root, 'package'), manifest: { entrypoint: 'main.mjs',
    outputs: { dataSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, mimeTypes: ['text/plain'], multiple: false, artifactsRequired: false } } }
  const input = { inputRef: 'input_1', path: inputPath, contentMimeType: 'text/plain', bytes, byteLength: String(bytes.length), sha256: skillHash(bytes) }
  const request = { command, descriptor, inputs: [input], instruction: 'do not execute $(touch /tmp/shell-executed)', parameters: { label: 'x; curl evil.test' },
    outputDirectory: resolve(root, 'outputs'), effects: { invoke: async (_id, _request, fn) => fn() } }
  return { root, request, context: { entrypoint: 'main.mjs', packageRoot: descriptor.packageRoot }, input }
}
const readRequest = `let text=''; for await (const chunk of process.stdin) text+=chunk; const request=JSON.parse(text);`
const measured = async (t, runner, context) => {
  const probe = await runner.probe(context)
  assert.equal(probe.ready, true, probe.reasonCode)
  assert.match(probe.digest, /^[0-9a-f]{64}$/); return true
}

test('missing interpreter or invalid package entry never advertises READY', async t => {
  const f = fixture(t, 'console.log(JSON.stringify({data:{},artifacts:[]}))')
  for (const options of [{ nodeBinary: '/no-such-owned-fixture/node' }])
    assert.deepEqual(await createLocalScriptRunner(options).probe(f.context), { ready: false, reasonCode: 'SKILL_LOCAL_PROCESS_UNAVAILABLE' })
  for (const entrypoint of ['../main.mjs', '/etc/passwd', 'main.sh', 'main.mjs;evil'])
    assert.equal((await createLocalScriptRunner().probe({ ...f.context, entrypoint })).ready, false)
})

test('real ordinary subprocess receives input bytes and private HOME without inherited tokens; host/network are not sandboxed', async t => {
  const server = createServer(); await new Promise(accept => server.listen(0, '127.0.0.1', accept)); t.after(() => new Promise(accept => server.close(accept)))
  const body = `import fs from 'node:fs'; import net from 'node:net'; ${readRequest}
    const connected = await new Promise(accept => { const socket=net.connect(request.parameters.port,'127.0.0.1'); socket.on('connect',()=>{socket.destroy();accept(true)}); socket.on('error',()=>accept(false)); });
    const content=fs.readFileSync(request.inputs[0].path,'utf8'); fs.writeFileSync(request.outputDirectory+'/document.txt',content+'实际脚本正文');
    console.log(JSON.stringify({data:{content,env:process.env,
      hostHomeVisible:fs.existsSync(request.parameters.hostHome),hostConnected:connected,instruction:request.instruction,label:request.parameters.label},
      artifacts:[{outputId:'output_1',contentMimeType:'text/plain',path:'document.txt'}]}));`
  const f = fixture(t, body), calls = []
  f.request.parameters.port = server.address().port; f.request.parameters.hostHome = resolve(f.root, 'private-home')
  const old = process.env.CYF_PROVIDER_TOKEN; process.env.CYF_PROVIDER_TOKEN = 'synthetic-never-inherited'
  try {
    const runner = createLocalScriptRunner({ spawnFn: (binary, argv, options) => { calls.push({ binary, argv, options }); return spawn(binary, argv, options) } })
    if (!await measured(t, runner, f.context)) return
    const result = await runner.run(f.request)
    assert.equal(result.data.content, f.input.bytes.toString('utf8'))
    assert.equal(result.data.hostHomeVisible, true); assert.equal(result.data.hostConnected, true)
    assert.equal(result.data.env.CYF_PROVIDER_TOKEN, undefined); assert.equal(result.data.env.HOME, resolve(f.request.outputDirectory, 'local-script')); assert.equal(result.data.env.PATH, '')
    assert.equal(result.data.instruction, f.request.instruction); assert.equal(result.data.label, f.request.parameters.label)
    assert.equal(result.artifacts[0].bytes.toString('utf8'), f.input.bytes.toString('utf8') + '实际脚本正文')
    assert.deepEqual(result.inputReceipts, [{ inputRef: 'input_1', sha256: f.input.sha256, carrier: 'local-file', delivery: 'DELIVERED' }])
    assert.deepEqual(readFileSync(f.input.path), f.input.bytes)
    for (const { binary, argv, options } of calls) {
      assert.equal(binary, realpathSync(process.execPath)); assert.equal(options.shell, false); assert.deepEqual(options.env, { LANG: 'C.UTF-8', HOME: options.cwd, PATH: '' })
      assert.ok(argv.includes('--input-type=module')); assert.ok(!argv.includes('/bin/sh'))
      assert.ok(!argv.some(arg => arg.includes(f.request.parameters.label) || arg.includes(f.request.instruction)))
    }
  } finally { if (old === undefined) delete process.env.CYF_PROVIDER_TOKEN; else process.env.CYF_PROVIDER_TOKEN = old }
})

test('invalid hash, nonprivate input or symlink fails before package process launch', async t => {
  const f = fixture(t, `console.log(JSON.stringify({data:{},artifacts:[]}))`), launches = []
  const runner = createLocalScriptRunner({ spawnFn: (...args) => { launches.push(args); return spawn(...args) } })
  if (!await measured(t, runner, f.context)) return
  const initial = launches.length
  f.input.sha256 = '0'.repeat(64); await assert.rejects(runner.run(f.request), /SKILL_LOCAL_INPUT_INVALID/)
  f.input.sha256 = skillHash(f.input.bytes); chmodSync(f.input.path, 0o644); await assert.rejects(runner.run(f.request), /SKILL_LOCAL_PATH_UNSAFE/)
  chmodSync(f.input.path, 0o400); const path = resolve(f.root, 'inputs/alias'); symlinkSync(f.input.path, path); f.input.path = path
  await assert.rejects(runner.run(f.request), /SKILL_LOCAL_PATH_UNSAFE/); assert.equal(launches.length, initial)
})

test('script cannot forge input receipts, declare escaping/symlink outputs or report invalid data', async t => {
  for (const body of [
    `console.log(JSON.stringify({data:{},artifacts:[],inputReceipts:[]}));`,
    `console.log(JSON.stringify({data:{},artifacts:[{outputId:'output_1',contentMimeType:'text/plain',path:'../../etc/passwd'}]}));`,
    `import fs from 'node:fs';${readRequest}fs.symlinkSync(request.inputs[0].path,request.outputDirectory+'/link');console.log(JSON.stringify({data:{},artifacts:[{outputId:'output_1',contentMimeType:'text/plain',path:'link'}]}));`,
    `console.log(JSON.stringify({data:'not an object',artifacts:[]}));`
  ]) {
    const f = fixture(t, body), runner = createLocalScriptRunner()
    if (!await measured(t, runner, f.context)) return
    await assert.rejects(runner.run(f.request), /SKILL_(?:LOCAL|PARAMETERS)/)
  }
})

test('local effect result/data/actual artifact bytes recover durably without reexecuting the script', async t => {
  const f = fixture(t, `import fs from 'node:fs';${readRequest}fs.writeFileSync(request.outputDirectory+'/file.txt','真实已保存正文');console.log(JSON.stringify({data:{label:request.parameters.label},artifacts:[{outputId:'output_1',contentMimeType:'text/plain',path:'file.txt'}]}));`), launches = []
  const runner = createLocalScriptRunner({ spawnFn: (...args) => { launches.push(args); return spawn(...args) } })
  if (!await measured(t, runner, f.context)) return
  const store = new SkillExecutionStore({ rootDirectory: resolve(f.root, 'store'), scope: { agentId: 'agent' }, command: f.request.command })
  let starts = 0, reports = 0
  f.request.effects = new SkillEffects({ store, checkLease: () => {}, start: async () => { starts++; return { schemaVersion: 1, disposition: 'NEW', status: 'START_RECORDED', providerRequestId: null, resultDigest: null } },
    report: async (_id, body) => { reports++; return { schemaVersion: 1, disposition: 'KNOWN', status: body.status, providerRequestId: body.providerRequestId, resultDigest: body.resultDigest } } })
  const first = await runner.run(f.request), count = launches.length
  rmSync(resolve(f.request.outputDirectory, 'local-script/file.txt'))
  const recovered = await runner.run(f.request)
  assert.deepEqual(first, recovered); assert.equal(starts, 1); assert.equal(reports, 2); assert.equal(launches.length, count)
  assert.equal(first.artifacts[0].bytes.toString('utf8'), '真实已保存正文')
})

test('nonzero process error is retained as UNKNOWN; a second attempt does not start the script again', async t => {
  const f = fixture(t, `process.exit(7)`), runner = createLocalScriptRunner()
  if (!await measured(t, runner, f.context)) return
  const store = new SkillExecutionStore({ rootDirectory: resolve(f.root, 'store'), scope: { agentId: 'agent' }, command: f.request.command })
  let starts = 0
  f.request.effects = new SkillEffects({ store, checkLease: () => {}, start: async () => { starts++; return { schemaVersion: 1, disposition: starts === 1 ? 'NEW' : 'RECORDED', status: 'START_RECORDED', providerRequestId: null, resultDigest: null } },
    report: async (_id, body) => ({ schemaVersion: 1, disposition: 'KNOWN', ...body }) })
  await assert.rejects(runner.run(f.request), error => error.code === 'SKILL_RESULT_UNKNOWN' && error.cause.code === 'SKILL_LOCAL_PROCESS_FAILED' && error.cause.exitCode === 7)
  await assert.rejects(runner.run(f.request), error => error.code === 'SKILL_RESULT_UNKNOWN' && !error.cause)
  assert.equal(starts, 2) // only effect registration/query: second RECORDED never launches
})

test('zero-material local script persists a real result envelope without invented input receipts', async t => {
  const f = fixture(t, `console.log(JSON.stringify({data:{answer:'真实无资料脚本结果'},artifacts:[]}));`), runner = createLocalScriptRunner()
  if (!await measured(t, runner, f.context)) return
  f.request.inputs = []; f.request.command.inputRefs = []
  const result = await runner.run(f.request), store = new SkillExecutionStore({ rootDirectory: resolve(f.root, 'store'), scope: { agentId: 'agent' }, command: f.request.command })
  const persisted = store.persistResult(f.request.descriptor, result)
  assert.deepEqual(persisted.result.inputReceipts, []); assert.deepEqual(persisted.result.data, { answer: '真实无资料脚本结果' }); assert.deepEqual(store.loadResult(), persisted)
})


test('declared local input capability cannot be READY until the shared receipt contract permits local-file', async t => {
  const f = fixture(t, `console.log(JSON.stringify({data:{},artifacts:[]}));`), runner = createLocalScriptRunner()
  if (!SKILL_INPUT_CARRIERS.includes('local-file')) {
    assert.deepEqual(await runner.probe({ ...f.context, inputMimeTypes: ['text/plain'] }), { ready: false, reasonCode: 'SKILL_LOCAL_INPUT_CARRIER_UNAVAILABLE' })
  } else if (await measured(t, runner, f.context)) {
    assert.equal((await runner.probe({ ...f.context, inputMimeTypes: ['text/plain'] })).ready, true)
  }
})


test('local-file receipt and genuine bytes close durable result persistence/reconstruction and cannot masquerade as native input', async t => {
  const f = fixture(t, `import fs from 'node:fs';${readRequest}console.log(JSON.stringify({data:{source:fs.readFileSync(request.inputs[0].path,'utf8')},artifacts:[]}));`), runner = createLocalScriptRunner()
  if (!await measured(t, runner, { ...f.context, inputMimeTypes: ['text/plain'] })) return
  f.request.descriptor.manifest.runner = 'local-script'
  const result = await runner.run(f.request)
  const options = { rootDirectory: resolve(f.root, 'store'), scope: { agentId: 'agent' }, command: f.request.command }, store = new SkillExecutionStore(options)
  store.write('inputs-snapshot', { inputs: [{ inputRef: f.input.inputRef, sha256: f.input.sha256, byteLength: f.input.byteLength }] })
  const persisted = store.persistResult(f.request.descriptor, result)
  assert.equal(persisted.result.inputReceipts[0].carrier, 'local-file'); assert.deepEqual(new SkillExecutionStore(options).loadResult(), persisted)
  for (const runner of ['native-model', 'provider-operation', undefined])
    assert.throws(() => store.persistResult({ ...f.request.descriptor, manifest: { ...f.request.descriptor.manifest, runner } }, result), /SKILL_RESULT_INPUT_RECEIPT_INVALID/)
  assert.throws(() => store.persistResult(f.request.descriptor, { ...result, inputReceipts: [{ ...result.inputReceipts[0], sha256: '0'.repeat(64) }] }), /SKILL_RESULT_INPUT_RECEIPT_INVALID/)
})

test('ZIP-verified package dependency replacement after real probe prevents effect registration/process launch', async t => {
  const f = fixture(t, 'console.log(JSON.stringify({data:{},artifacts:[]}));'), launches = []
  const expected = skillPackageTreeDigest(f.request.descriptor.packageRoot)
  f.context.packageTreeDigest = expected; f.request.descriptor.packageTreeDigest = expected
  const runner = createLocalScriptRunner({ spawnFn: (...args) => { launches.push(args); return spawn(...args) } })
  if (!await measured(t, runner, f.context)) return
  const count = launches.length
  f.request.effects = { invoke: async () => assert.fail('changed package must not register an effect') }
  writeFileSync(resolve(f.context.packageRoot, 'dependency.mjs'), 'throw new Error("injected")', { mode: 0o400 })
  await assert.rejects(runner.run(f.request), /SKILL_LOCAL_PACKAGE_CHANGED/)
  assert.equal((await runner.probe(f.context)).ready, false)
  assert.equal(launches.length, count)
})
