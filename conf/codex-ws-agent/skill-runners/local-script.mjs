/** Installed Node script adapter. No shell, inherited credentials, host HOME or
 * network. Real bubblewrap readback is required before advertising readiness.
 * Packages cannot choose argv, interpreter, environment or sandbox mounts. */
import { spawn } from 'node:child_process'
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
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
function toolIdentity(nodeBinary, bwrapBin) {
  const node = trustedFile(nodeBinary), bwrap = trustedFile(bwrapBin)
  // Interpreter ABI directories only; never /usr, /etc, HOME or artifact state.
  const libraries = ['/lib', '/lib64', '/usr/lib', '/usr/lib64'].filter(existsSync).map(target => {
    const path = realpathSync(target), stat = lstatSync(path)
    if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022) fail('SKILL_LOCAL_TOOL_UNTRUSTED')
    return { path, target, dev: String(stat.dev), ino: String(stat.ino) }
  })
  return { node, bwrap, libraries }
}
export function buildLocalScriptArgv({ tools, packageRoot, entrypoint, inputs, outputDirectory }) {
  const args = ['--unshare-all', '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--ro-bind', tools.node.path, '/runtime/node']
  for (const library of tools.libraries) args.push('--ro-bind', library.path, library.target)
  args.push('--dir', '/skill', '--ro-bind', packageRoot, '/skill', '--dir', '/inputs')
  for (const input of inputs) args.push('--ro-bind', input.path, `/inputs/${input.inputRef}`)
  args.push('--dir', '/outputs', '--bind', outputDirectory, '/outputs', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '',
    '--chdir', '/outputs', '--', '/runtime/node', '--no-addons', '--input-type=module', '-e', 'process.umask(0o077); await import(process.argv[1])', `/skill/${entrypoint}`)
  return args
}
function childResult(spawnFn, tools, args, request) {
  return new Promise((accept, reject) => {
    let child, error = null
    try { child = spawnFn(tools.bwrap.path, args, { shell: false, cwd: '/', env: environment, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (cause) { reject(cause); return }
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
let request = ''; for await (const chunk of process.stdin) request += chunk; const config = JSON.parse(request);
const denied = path => { try { fs.writeFileSync(path, 'tampered'); return false } catch (e) { return ['EROFS', 'EACCES', 'EPERM'].includes(e.code) } };
const interfaces = fs.readFileSync('/proc/net/dev', 'utf8').split(/\\r?\\n/).slice(2).filter(Boolean).map(line => line.split(':')[0].trim());
console.log(JSON.stringify({schemaVersion:1, nodeVersion:process.version,
 inputDelivered:fs.readFileSync('/inputs/probe', 'utf8') === 'local-script-readonly-probe',
 inputReadOnly:denied('/inputs/probe'), packageReadOnly:denied('/skill/probe.mjs'),
 hostHidden:!fs.existsSync(config.hostCanary), secretHomeHidden:!fs.existsSync(config.secretHome),
 networkIsolated:fs.readlinkSync('/proc/self/ns/net') !== config.parentNetwork,
 pidIsolated:fs.readlinkSync('/proc/self/ns/pid') !== config.parentPid,
 capabilitiesDropped:/^CapEff:\\s*0+$/m.test(fs.readFileSync('/proc/self/status','utf8')),
 noRoutes:fs.readFileSync('/proc/net/route', 'utf8').trim().split(/\\r?\\n/).length === 1,
 interfaces, environment:process.env}));`
export function createLocalScriptRunner({ nodeBinary = process.execPath, bwrapBin = '/usr/bin/bwrap', spawnFn = spawn } = {}) {
  let measurement = null
  const measure = async () => {
    const tools = toolIdentity(nodeBinary, bwrapBin), key = skillDigest(tools)
    if (measurement?.key === key) return measurement
    const root = mkdtempSync(resolve(tmpdir(), 'skill-local-probe-'))
    try {
      for (const dir of ['package', 'outputs', 'private-home']) mkdirSync(resolve(root, dir), { mode: 0o700 })
      writeFileSync(resolve(root, 'package/probe.mjs'), probeScript, { mode: 0o400 })
      const input = resolve(root, 'input'), canary = resolve(root, 'canary')
      writeFileSync(input, 'local-script-readonly-probe', { mode: 0o400 }); writeFileSync(canary, 'host-secret-canary', { mode: 0o400 })
      const { readlinkSync } = await import('node:fs')
      const readback = await childResult(spawnFn, tools, buildLocalScriptArgv({ tools, packageRoot: resolve(root, 'package'), entrypoint: 'probe.mjs',
        inputs: [{ inputRef: 'probe', path: input }], outputDirectory: resolve(root, 'outputs') }),
      { hostCanary: canary, secretHome: resolve(root, 'private-home'), parentNetwork: readlinkSync('/proc/self/ns/net'), parentPid: readlinkSync('/proc/self/ns/pid') })
      if (readback.schemaVersion !== 1 || ![readback.inputDelivered, readback.inputReadOnly, readback.packageReadOnly, readback.hostHidden, readback.secretHomeHidden,
        readback.networkIsolated, readback.pidIsolated, readback.capabilitiesDropped, readback.noRoutes].every(value => value === true) || !Array.isArray(readback.interfaces)
          || readback.interfaces.some(name => name !== 'lo') || typeof readback.nodeVersion !== 'string'
          || !object(readback.environment) || Object.keys(readback.environment).some(name => !['LANG', 'HOME', 'PATH', 'PWD'].includes(name))
          || readback.environment.HOME !== '/tmp' || readback.environment.PATH !== '') fail('SKILL_LOCAL_ISOLATION_UNAVAILABLE')
      measurement = { key, tools, readback, digest: skillDigest({ tools, readback }) }; return measurement
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  return {
    probe: async context => {
      if (context.inputMimeTypes?.length && !SKILL_INPUT_CARRIERS.includes('local-file')) return { ready: false, reasonCode: 'SKILL_LOCAL_INPUT_CARRIER_UNAVAILABLE' }
      try { const entry = packageIdentity(context), measured = await measure(); return { ready: true, digest: skillDigest({ toolchain: measured.digest, entrypoint: entry.entrypoint, scriptSha256: entry.sha256 }) } }
      catch { return { ready: false, reasonCode: 'SKILL_LOCAL_ISOLATION_UNAVAILABLE' } }
    },
    probeTool: async () => { try { return { ready: true, digest: (await measure()).digest } } catch { return { ready: false, reasonCode: 'SKILL_LOCAL_ISOLATION_UNAVAILABLE' } } },
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
        inputs: inputs.map(input => ({ inputRef: input.inputRef, sha256: input.sha256, byteLength: String(input.byteLength), contentMimeType: input.contentMimeType, path: `/inputs/${input.inputRef}` })), outputDirectory: '/outputs' }
      const result = await effects.invoke('local-script', { ...request, entrypoint: entry.entrypoint, scriptSha256: entry.sha256, toolchainDigest: measured.digest }, async () => {
        // Recheck tool/package bytes immediately before the only process launch.
        if (skillDigest(toolIdentity(nodeBinary, bwrapBin)) !== measured.key || packageIdentity({ packageRoot: entry.root, entrypoint: entry.entrypoint, packageTreeDigest: descriptor.packageTreeDigest }).sha256 !== entry.sha256) fail('SKILL_LOCAL_TOOL_CHANGED')
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
