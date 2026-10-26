/** Approved installed Node scripts run as ordinary Runtime-account subprocesses.
 * No shell or inherited environment credentials; this is NOT a filesystem/network
 * sandbox. Packages cannot choose interpreter, argv or environment. */
import { spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { skillDigest, skillHash, skillId } from '../skill-executor.mjs'
import { parseSkillJson, resolveSkillEntrypoint, validateSkillData, skillPackageTreeDigest } from '../skill-manifest.mjs'
import { validateNativeConversationOutput } from '../conversation-native.mjs'
import { SKILL_INPUT_CARRIERS } from '../skill-execution-store.mjs'
const fail = (code, cause) => { throw Object.assign(new Error(code), { code, ...(cause ? { cause } : {}) }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
const environment = Object.freeze({ LANG: 'C.UTF-8' })
const PRIVATE_MODE = 0o077
function privateDirectory(path) {
  if (!isAbsolute(path || '') || realpathSync(path) !== path) fail('SKILL_LOCAL_PATH_UNSAFE')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || stat.mode & PRIVATE_MODE) fail('SKILL_LOCAL_PATH_UNSAFE')
  return path
}
function trustedFile(path) {
  const absolute = realpathSync(path), stat = lstatSync(absolute)
  if (!stat.isFile() || ![0, process.geteuid()].includes(stat.uid) || stat.mode & 0o022) fail('SKILL_LOCAL_TOOL_UNTRUSTED')
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o002) fail('SKILL_LOCAL_TOOL_UNTRUSTED')
    if (dirname(parent) === parent) break
  }
  return { path: absolute, sha256: skillHash(readFileSync(absolute)), dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) }
}
function readPrivateFile(path) {
  if (!isAbsolute(path || '') || realpathSync(path) !== path) fail('SKILL_LOCAL_PATH_UNSAFE')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true }), bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid()) || before.mode & 0o077n
        || before.size !== BigInt(bytes.length) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('SKILL_LOCAL_PATH_UNSAFE')
    return bytes
  } finally { closeSync(fd) }
}
function packageIdentity(context) {
  if (!isAbsolute(context.packageRoot || '') || realpathSync(context.packageRoot) !== context.packageRoot || !/\.(?:mjs|js)$/.test(context.entrypoint || '')) fail('SKILL_LOCAL_ENTRYPOINT_UNAVAILABLE')
  if (context.packageTreeDigest && skillPackageTreeDigest(context.packageRoot) !== context.packageTreeDigest) fail('SKILL_LOCAL_PACKAGE_CHANGED')
  const script = resolveSkillEntrypoint(context.packageRoot, context.entrypoint)
  return { root: context.packageRoot, script, sha256: skillHash(readFileSync(script)), entrypoint: context.entrypoint }
}
function toolIdentity(nodeBinary) { return { node: trustedFile(nodeBinary) } }
export function buildLocalScriptArgv({ packageRoot, entrypoint }) {
  return ['--no-addons', '--input-type=module', '-e', 'process.umask(0o077); await import(process.argv[1])',
    pathToFileURL(resolve(packageRoot, entrypoint)).href]
}
function childResult(spawnFn, tools, args, request) {
  return new Promise((accept, reject) => {
    let child, error = null
    try { child = spawnFn(tools.node.path, args, { shell: false, cwd: request.outputDirectory, env: { ...environment, HOME: request.outputDirectory, PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (cause) { reject(cause); return }
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
    // Drain stderr but never persist or log untrusted script/provider text.
    child.stderr.resume()
    child.on('error', cause => { error ||= cause })
    child.stdin.on('error', cause => { error ||= cause })
    child.on('close', (code, signal) => {
      if (error) reject(error)
      else if (code !== 0 || signal) reject(Object.assign(new Error('SKILL_LOCAL_PROCESS_FAILED'), { code: 'SKILL_LOCAL_PROCESS_FAILED', exitCode: code, signal }))
      else { try { accept(parseSkillJson(Buffer.concat(chunks))) } catch (cause) { reject(cause) } }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
const probeScript = `import fs from 'node:fs';
let text=''; for await (const chunk of process.stdin) text+=chunk; const request=JSON.parse(text);
fs.writeFileSync(request.outputDirectory+'/probe.txt','probe');
console.log(JSON.stringify({schemaVersion:1,nodeVersion:process.version,
 inputDelivered:fs.readFileSync(request.input,'utf8')==='local-script-probe',
 outputWritten:fs.readFileSync(request.outputDirectory+'/probe.txt','utf8')==='probe',
 privateCwd:process.cwd()===request.outputDirectory,privateHome:process.env.HOME===request.outputDirectory,
 cleanEnvironment:Object.keys(process.env).every(key=>['LANG','HOME','PATH'].includes(key))&&process.env.PATH===''}));`
export function createLocalScriptRunner({ nodeBinary = process.execPath, spawnFn = spawn } = {}) {
  let measurement = null
  const measure = async () => {
    const tools = toolIdentity(nodeBinary), key = skillDigest(tools)
    if (measurement?.key === key) return measurement
    const root = mkdtempSync(resolve(tmpdir(), 'skill-local-probe-'))
    try {
      for (const dir of ['package', 'outputs']) mkdirSync(resolve(root, dir), { mode: 0o700 })
      writeFileSync(resolve(root, 'package/probe.mjs'), probeScript, { mode: 0o400 })
      const input = resolve(root, 'input')
      writeFileSync(input, 'local-script-probe', { mode: 0o400 })
      const readback = await childResult(spawnFn, tools, buildLocalScriptArgv({ packageRoot: resolve(root, 'package'), entrypoint: 'probe.mjs' }),
        { input, outputDirectory: resolve(root, 'outputs') })
      if (readback.schemaVersion !== 1 || typeof readback.nodeVersion !== 'string'
          || ![readback.inputDelivered, readback.outputWritten, readback.privateCwd, readback.privateHome, readback.cleanEnvironment].every(value => value === true)) fail('SKILL_LOCAL_PROCESS_UNAVAILABLE')
      measurement = { key, tools, readback, digest: skillDigest({ tools, readback }) }; return measurement
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  return {
    probe: async context => {
      if (context.inputMimeTypes?.length && !SKILL_INPUT_CARRIERS.includes('local-file')) return { ready: false, reasonCode: 'SKILL_LOCAL_INPUT_CARRIER_UNAVAILABLE' }
      try { const entry = packageIdentity(context), measured = await measure(); return { ready: true, digest: skillDigest({ toolchain: measured.digest, entrypoint: entry.entrypoint, scriptSha256: entry.sha256 }) } }
      catch { return { ready: false, reasonCode: 'SKILL_LOCAL_PROCESS_UNAVAILABLE' } }
    },
    probeTool: async () => { try { return { ready: true, digest: (await measure()).digest } } catch { return { ready: false, reasonCode: 'SKILL_LOCAL_PROCESS_UNAVAILABLE' } } },
    run: async ({ command, descriptor, inputs, parameters, instruction, effects, outputDirectory }) => {
      const entry = packageIdentity({ packageRoot: descriptor.packageRoot, entrypoint: descriptor.manifest.entrypoint, packageTreeDigest: descriptor.packageTreeDigest }), measured = await measure()
      const seen = new Set()
      for (const input of inputs) {
        if (!skillId(input.inputRef) || seen.has(input.inputRef) || !Buffer.isBuffer(input.bytes) || skillHash(input.bytes) !== input.sha256
            || String(input.bytes.length) !== String(input.byteLength) || !readPrivateFile(input.path).equals(input.bytes)) fail('SKILL_LOCAL_INPUT_INVALID')
        seen.add(input.inputRef)
      }
      privateDirectory(outputDirectory)
      const outputRoot = resolve(outputDirectory, 'local-script'); mkdirSync(outputRoot, { recursive: true, mode: 0o700 }); privateDirectory(outputRoot)
      const request = { schemaVersion: 1, executionId: command.executionId, instruction, parameters,
        inputs: inputs.map(input => ({ inputRef: input.inputRef, sha256: input.sha256, byteLength: String(input.byteLength), contentMimeType: input.contentMimeType, path: input.path })), outputDirectory: outputRoot }
      const result = await effects.invoke('local-script', { ...request, entrypoint: entry.entrypoint, scriptSha256: entry.sha256, toolchainDigest: measured.digest }, async () => {
        // Recheck tool/package bytes immediately before the only process launch.
        if (skillDigest(toolIdentity(nodeBinary)) !== measured.key || packageIdentity({ packageRoot: entry.root, entrypoint: entry.entrypoint, packageTreeDigest: descriptor.packageTreeDigest }).sha256 !== entry.sha256) fail('SKILL_LOCAL_TOOL_CHANGED')
        const value = await childResult(spawnFn, measured.tools, buildLocalScriptArgv({ tools: measured.tools, packageRoot: entry.root, entrypoint: entry.entrypoint, inputs, outputDirectory: outputRoot }), request)
        if (!exact(value, ['data', 'artifacts']) || !Array.isArray(value.artifacts)) fail('SKILL_LOCAL_RESULT_INVALID')
        const output = descriptor.manifest.outputs
        if (output.dataSchema) validateSkillData(output.dataSchema, value.data)
        else if (value.data !== null) fail('SKILL_LOCAL_RESULT_INVALID')
        if (output.artifactsRequired && !value.artifacts.length || !output.multiple && value.artifacts.length > 1) fail('SKILL_LOCAL_RESULT_INVALID')
        const ids = new Set(), artifacts = value.artifacts.map(artifact => {
          if (!exact(artifact, ['outputId', 'contentMimeType', 'path']) || !skillId(artifact.outputId) || ids.has(artifact.outputId)
              || !output.mimeTypes.includes(artifact.contentMimeType) || typeof artifact.path !== 'string' || !artifact.path
              || isAbsolute(artifact.path) || artifact.path.split('/').some(part => !part || part === '.' || part === '..')) fail('SKILL_LOCAL_ARTIFACT_INVALID')
          ids.add(artifact.outputId)
          const path = resolve(outputRoot, artifact.path)
          let bytes
          try {
            if (lstatSync(path).isSymbolicLink()) fail('SKILL_LOCAL_ARTIFACT_INVALID')
            const relativePath = relative(outputRoot, realpathSync(path))
            if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) fail('SKILL_LOCAL_ARTIFACT_INVALID')
            bytes = readPrivateFile(path)
          } catch (cause) { fail('SKILL_LOCAL_ARTIFACT_INVALID', cause) }
          if (!validateNativeConversationOutput(artifact.contentMimeType, bytes)) fail('SKILL_LOCAL_ARTIFACT_INVALID')
          return { outputId: artifact.outputId, contentMimeType: artifact.contentMimeType, base64: bytes.toString('base64') }
        })
        return { data: value.data, artifacts, inputReceipts: inputs.map(input => ({ inputRef: input.inputRef, sha256: input.sha256, carrier: 'local-file', delivery: 'DELIVERED' })) }
      })
      return { data: result.data, inputReceipts: result.inputReceipts, artifacts: result.artifacts.map(artifact => ({ outputId: artifact.outputId, contentMimeType: artifact.contentMimeType, bytes: Buffer.from(artifact.base64, 'base64') })) }
    }
  }
}
