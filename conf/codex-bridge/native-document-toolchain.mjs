/** RB-03/05: fixed document libraries in the existing file-manifest sandbox.
 * No host directory mount, package installation, or document workflow selection. */
import { spawnSync } from 'node:child_process'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, lstatSync, existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureMinimalNativeExecutionToolchain, validateNativeExecutionToolchain, validateNativeExecutionToolchainAsync } from './native-execution-profile.mjs'

export const DOCUMENT_MIMES = Object.freeze(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
export const DOCUMENT_PROBE = '/usr/lib/cyf-documents/document_probe.py'
const root = fileURLToPath(new URL('.', import.meta.url))
const fail = code => { throw Object.assign(new Error(code), { code }) }
const pin = (sourcePath, sandboxPath) => {
  const source = realpathSync(sourcePath)
  return { sourcePath: source, sandboxPath, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') }
}

export function measureNativeDocumentToolchain({ base, pythonBin = resolve(root, '.toolchain/bin/python'), requirementsPath = resolve(root, 'toolchain/requirements.txt'), probePath = resolve(root, 'toolchain/document_probe.py') }) {
  const files = [...base.files, pin(pythonBin, '/usr/bin/python3')]
  // The installed venv can still reference an external base interpreter. Check
  // that protected base location before Python imports any of its stdlib.
  const config = resolve(dirname(pythonBin), '../pyvenv.cfg')
  validateNativeExecutionToolchain({ shell: base.shell, files })
  if (existsSync(config)) {
    validateNativeExecutionToolchain({ shell: base.shell, files: [...files, pin(config, '/usr/lib/cyf-documents/pyvenv.cfg')] })
    const home = /^home\s*=\s*(.+)$/m.exec(readFileSync(config, 'utf8'))?.[1]?.trim()
    if (!home || resolve(home) !== home || realpathSync(home) !== home) fail('NATIVE_DOCUMENT_BASE_UNSAFE')
    for (let cursor = home; ; cursor = dirname(cursor)) {
      const stat = lstatSync(cursor)
      if (!stat.isDirectory() || ![0, process.geteuid()].includes(stat.uid) || stat.mode & 0o022) fail('NATIVE_DOCUMENT_BASE_UNSAFE')
      if (cursor === '/' || (stat.uid === process.geteuid() && (stat.mode & 0o077) === 0)) break
    }
    validateNativeExecutionToolchain({ shell: base.shell, files: [...files, pin(resolve(home, 'python3'), '/usr/lib/cyf-documents/base-python')] })
  } else {
    // Frozen artifacts have no venv redirect. Verify their local stdlib paths
    // before starting Python, rather than trusting an external build prefix.
    const prefix = resolve(dirname(pythonBin), '..')
    const libraries = ['lib', 'lib64'].flatMap(name => {
      const directory = resolve(prefix, name)
      return existsSync(directory) ? readdirSync(directory).filter(name => /^python3\.\d+$/.test(name)).map(name => resolve(directory, name)) : []
    })
    if (!libraries.length) fail('NATIVE_DOCUMENT_BASE_UNSAFE')
    for (const library of libraries) {
      validateNativeExecutionToolchain({ shell: base.shell, files: [...files, pin(resolve(library, 'os.py'), '/usr/lib/cyf-documents/os.py'), pin(resolve(library, 'encodings/__init__.py'), '/usr/lib/cyf-documents/encodings.py')] })
    }
  }
  const measured = spawnSync(pythonBin, ['-I', '-B', '-c', `import json, os, sys, sysconfig, pkg_resources
wanted = {'python-docx', 'openpyxl'}
requirements = []
for line in open(sys.argv[1]):
 line = line.strip()
 if line and not line.startswith('#') and line.split('==')[0] in wanted:
  requirements.append(line)
assert len(requirements) == len(wanted), 'DOCUMENT_REQUIREMENTS_MISSING'
packages = set()
for dist in pkg_resources.require(requirements):
 for name in dist.get_metadata('top_level.txt').splitlines():
  if name.strip(): packages.add(name.strip())
print(json.dumps({'version': '%s.%s' % sys.version_info[:2], 'stdlib': sysconfig.get_path('stdlib'), 'platlib': sysconfig.get_path('platlib'), 'packages': sorted(packages), 'prefix': sys.prefix, 'basePrefix': sys.base_prefix, 'platlibdir': os.path.basename(os.path.dirname(sysconfig.get_path('stdlib')))}))`, requirementsPath], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
  if (measured.status !== 0) fail('NATIVE_DOCUMENT_TOOLCHAIN_UNAVAILABLE')
  const info = JSON.parse(measured.stdout)
  if (!/^3\.\d+$/.test(info.version) || !['lib', 'lib64'].includes(info.platlibdir)) fail('NATIVE_DOCUMENT_TOOLCHAIN_INVALID')
  if (!existsSync(config) && (info.prefix !== resolve(dirname(pythonBin), '..') || info.basePrefix !== info.prefix || !info.stdlib.startsWith(info.prefix + '/'))) fail('NATIVE_DOCUMENT_BASE_UNSAFE')
  // Use the interpreter's actual library directory convention. -I can then find
  // its standard library without trusting PYTHONPATH or a user site directory.
  const library = `/usr/${info.platlibdir}/python${info.version}`
  const omitted = new Set(['__pycache__', 'test', 'tests', 'idlelib', 'tkinter', 'ensurepip', 'pip', 'setuptools', 'pkg_resources', '_distutils_hack'])
  const walk = (source, target, standard = false) => {
    for (const item of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // The desktop tkinter package is omitted above; its native GUI extension
      // must also stay outside this headless document dependency closure.
      if ((standard && /^_tkinter(?:\.|$)/.test(item.name)) || omitted.has(item.name) || /\.(?:pyc|pyo)$/.test(item.name) || (standard && item.name === 'site-packages')) continue
      const path = resolve(source, item.name), dest = `${target}/${item.name}`
      if (item.isDirectory()) walk(path, dest, standard)
      else if (item.isFile()) files.push(pin(path, dest))
      else fail('NATIVE_DOCUMENT_TOOLCHAIN_UNSAFE')
    }
  }
  walk(realpathSync(info.stdlib), library, true)
  for (const name of info.packages) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('NATIVE_DOCUMENT_PACKAGE_INVALID')
    const source = resolve(realpathSync(info.platlib), name)
    if (lstatSync(source).isSymbolicLink()) fail('NATIVE_DOCUMENT_TOOLCHAIN_UNSAFE')
    walk(source, `${library}/site-packages/${name}`)
  }
  files.push(pin(probePath, DOCUMENT_PROBE))
  // Shared objects may reference bundled libraries outside /usr. Only those
  // measured dependencies are copied into the namespace, never their parents.
  validateNativeExecutionToolchain({ shell: base.shell, files })
  const ldd = realpathSync('/usr/bin/ldd')
  validateNativeExecutionToolchain({ shell: base.shell, files: [...base.files, pin(ldd, '/usr/bin/ldd')] })
  const targets = new Map(files.map(file => [file.sandboxPath, file]))
  const binaries = files.filter(file => file.sandboxPath === '/usr/bin/python3' || /\.so(?:\.\d+)*$/.test(file.sandboxPath))
  for (const binary of binaries) {
    const result = spawnSync(ldd, [binary.sourcePath], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    if (result.status !== 0 || /=> not found/.test(result.stdout)) throw Object.assign(new Error('NATIVE_DOCUMENT_DEPENDENCIES_UNVERIFIED'), { code: 'NATIVE_DOCUMENT_DEPENDENCIES_UNVERIFIED', file: binary.sourcePath, diagnostic: result.stdout || result.stderr })
    for (const path of result.stdout.match(/\/[^\s()]+/g) || []) {
      const target = /^\/(?:usr\/)?lib(?:64)?\//.test(path) ? path : `/usr/lib/${basename(path)}`
      const file = pin(path, target), old = targets.get(target)
      if (old && old.sha256 !== file.sha256) fail('NATIVE_DOCUMENT_LIBRARY_CONFLICT')
      if (!old) { targets.set(target, file); files.push(file) }
    }
  }
  return validateNativeExecutionToolchain({ shell: base.shell, files })
}

// Library discovery/ldd/hash IO runs off the WS/event-loop thread. Its result is
// a local immutable-tool manifest, not registration payload or model input.
if (!isMainThread && workerData?.kind === 'native-document-measurement') {
  try {
    const base = measureMinimalNativeExecutionToolchain({ nodeBin: process.execPath })
    try { parentPort.postMessage({ toolchain: measureNativeDocumentToolchain({ base }) }) }
    catch (error) { parentPort.postMessage({ toolchain: base, documentFailure: error.code || 'NATIVE_DOCUMENT_TOOLCHAIN_UNAVAILABLE' }) }
  } catch (error) { parentPort.postMessage({ code: error.code || 'NATIVE_EXECUTION_TOOLCHAIN_REQUIRED' }) }
}

export async function initializeNativeToolchain(runtime) {
  if (runtime.nativeToolchainPending) return runtime.nativeToolchainPending
  if (runtime.nativeToolchain) return runtime.nativeToolchain
  const pending = new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { kind: 'native-document-measurement' } })
    let result
    worker.once('message', value => { result = value })
    worker.once('error', error => { result = { code: error.code || 'NATIVE_EXECUTION_TOOLCHAIN_REQUIRED' } })
    worker.once('exit', async () => {
      if (!result?.toolchain) { reject(Object.assign(new Error(result?.code || 'NATIVE_EXECUTION_TOOLCHAIN_REQUIRED'), { code: result?.code || 'NATIVE_EXECUTION_TOOLCHAIN_REQUIRED' })); return }
      if (result.documentFailure) {
        runtime.nativeDocumentMeasurementFailure = { stage: 'toolchain', code: result.documentFailure }
        console.warn(`native documents unavailable | code=${runtime.nativeDocumentMeasurementFailure.code}`)
      }
      // Missing optional libraries must not remove existing text/image tools.
      try {
        const verified = await validateNativeExecutionToolchainAsync(result.toolchain)
        if (!runtime.disposed) runtime.nativeToolchain = verified
        resolve(runtime.nativeToolchain || null)
      } catch (error) { reject(error) }
    })
  })
  runtime.nativeToolchainPending = pending
  try { return await pending } finally { if (runtime.nativeToolchainPending === pending) runtime.nativeToolchainPending = null }
}
