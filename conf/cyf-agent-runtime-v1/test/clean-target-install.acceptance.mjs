#!/usr/bin/env node
// Standalone opt-in local backend dependency fixture. NOT a *.test.mjs or production installer.
// Owner selfchecks are static only. Main alone runs the actual installation in an exclusive
// non-production root with fixed full payload and explicit tools; no global packages or services.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, release, type } from 'node:os';

export const SOURCE = Object.freeze({ commit: 'd91ebbf436911eac20ffb70cb92192a65c742e11',
  tree: 'b2e3f17ff57e21e2482c0fc54e71dbf4b92dbd82', files: 285 });
const SELF = fileURLToPath(import.meta.url);
const REQUIRED = ['BUILD_ID', 'SOURCE_ARCHIVE', 'SOURCE_SHA256', 'NODE', 'NPM_CLI', 'PYTHON',
  'BASH', 'PATH', 'TOOLCHAIN_PROVENANCE', 'PARENT', 'RECEIPT'];
const RUNTIME_FILES = ['agent-runtime.mjs', 'install.sh', 'validate.sh', 'README.md', 'package.json',
  'runtime.env.example', 'manifest.example.json', 'lib/manifest.mjs', 'lib/runtime-client.mjs',
  'lib/security.mjs', 'lib/runtime-host.mjs', 'lib/execution-adapter.mjs', 'systemd/cyf-agent-runtime-v1@.service'];
const FORMATS = [
  ['png', 'image/png'], ['jpeg', 'image/jpeg'], ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
];
const PROTECTED_ROOTS = ['/home/isp/hosts', '/home/isp/apps', '/home/isp/baks', '/opt/cyf', '/var/lib/cyf-api-flow', '/root/.codex'];
const fail = code => Object.assign(new Error(code), { code });
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const gitObject = (kind, bytes) => digest(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes]), 'sha1');
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
function absolute(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value)) throw fail('INPUT_PATH_NOT_ABSOLUTE_CANONICAL');
  return value;
}
function nonProductionPath(path) {
  if (PROTECTED_ROOTS.some(root => inside(root, path))) throw fail('INPUT_PRODUCTION_OR_PRIVATE_ROOT_FORBIDDEN');
  return path;
}
function memberPath(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw fail('ARCHIVE_MEMBER_UNSAFE');
  return name;
}
function publicUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail('INPUT_REGISTRY_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('INPUT_REGISTRY_URL_PRIVATE_OR_INVALID');
  return url.href;
}
export function origin(value) {
  if (typeof value !== 'string') throw fail('INPUT_TOOL_ORIGIN_INVALID');
  if (/^(local-host|fixed-input):[A-Za-z0-9._/@:+-]+$/.test(value)) return value;
  const url = publicUrl(value);
  if (!url.startsWith('https://')) throw fail('INPUT_TOOL_ORIGIN_INVALID');
  return url;
}
export function parseInputs(env) {
  if (env.CYF_CLEAN_INSTALL !== '1') throw fail('LOCAL_FIXTURE_OPT_IN_REQUIRED');
  if (Object.hasOwn(env, 'CYF_CLEAN_INSTALL_CLOUD_RUN')) throw fail('INPUT_LEGACY_RUN_FORBIDDEN');
  const get = key => env[`CYF_CLEAN_INSTALL_${key}`];
  for (const key of REQUIRED) if (!get(key)) throw fail(`INPUT_REQUIRED_${key}`);
  if (typeof get('BUILD_ID') !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(get('BUILD_ID'))) throw fail('INPUT_BUILD_ID_INVALID');
  if (!/^[a-f0-9]{64}$/.test(get('SOURCE_SHA256'))) throw fail('INPUT_ARCHIVE_DIGEST_INVALID');
  const input = Object.fromEntries(REQUIRED.map(key => [key, get(key)]));
  for (const key of ['SOURCE_ARCHIVE', 'NODE', 'NPM_CLI', 'PYTHON', 'BASH', 'TOOLCHAIN_PROVENANCE', 'PARENT', 'RECEIPT']) nonProductionPath(absolute(input[key]));
  input.PATH = input.PATH.split(':').map(path => {
    nonProductionPath(absolute(path));
    if (path.split('/').some(part => ['node_modules', '.toolchain', '.venv', 'venv'].includes(part))) throw fail('INPUT_PATH_HOST_DEPENDENCY_DIRECTORY');
    return path;
  }).join(':');
  input.NPM_REGISTRY = publicUrl(get('NPM_REGISTRY') || 'https://registry.npmjs.org/');
  input.PIP_INDEX_URL = publicUrl(get('PIP_INDEX_URL') || 'https://pypi.org/simple');
  return input;
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function freshFile(path, contents, mode = 0o600) {
  const fd = await open(path, 'wx', mode);
  try { await fd.writeFile(contents); await fd.sync(); } finally { await fd.close(); }
}
async function canonicalDirectory(path) {
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw fail('INPUT_DIRECTORY_NOT_CANONICAL');
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw fail('INPUT_OUTPUT_ALREADY_EXISTS');
}
export function treeDigest(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.directory ? '/' : '')), Buffer.from(b.name + (b.directory ? '/' : ''))));
  return gitObject('tree', Buffer.concat(sorted.map(entry => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.blob, 'hex')
  ]))));
}
export async function sourceInventory(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    const entries = [];
    for (const name of await readdir(directory)) {
      const relative = memberPath(prefix + name); const path = join(directory, name); const stat = await lstat(path);
      if (stat.isDirectory()) {
        const tree = await walk(path, `${relative}/`);
        entries.push({ name, directory: true, mode: '40000', blob: tree });
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        const bytes = await readFile(path); const mode = stat.mode & 0o111 ? '100755' : '100644';
        const blob = gitObject('blob', bytes);
        entries.push({ name, directory: false, mode, blob });
        files.push({ path: relative, mode, blob, sha256: digest(bytes), bytes: bytes.length });
      } else throw fail('SOURCE_NON_REGULAR_MEMBER');
    }
    if (!entries.length) throw fail('SOURCE_EXTRA_EMPTY_DIRECTORY');
    return treeDigest(entries);
  }
  const tree = await walk(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (tree !== SOURCE.tree || files.length !== SOURCE.files) throw fail('SOURCE_NOT_FULL_FIXED_PAYLOAD_TREE');
  return { tree, files };
}

// Python 3 stdlib-only extraction. No tar subprocess, unsafe
// extractall, links, owner preservation, prefix guessing or host source copy.
export const EXTRACT = String.raw`
import json, os, shutil, sys, tarfile
archive, root, commit = sys.argv[1:]
with tarfile.open(archive, 'r:') as tar:
    assert tar.pax_headers.get('comment') == commit, 'ARCHIVE_COMMIT_NOT_FIXED_PAYLOAD'
    members = tar.getmembers()
    seen = set()
    for entry in members:
        name = entry.name.rstrip('/') if entry.isdir() else entry.name
        parts = name.split('/')
        assert name and not name.startswith('/') and not any(ord(c) < 32 or ord(c) == 127 or c == '\\' for c in name), 'ARCHIVE_NAME_UNSAFE'
        assert all(p and p not in ('.', '..', '.git') for p in parts), 'ARCHIVE_PATH_UNSAFE'
        assert name not in seen and (entry.isfile() or entry.isdir()), 'ARCHIVE_LINK_DUPLICATE_OR_SPECIAL'
        assert not entry.mode & 0o7000, 'ARCHIVE_PRIVILEGED_MODE'
        seen.add(name)
    os.mkdir(root, 0o700)
    for entry in members:
        path = os.path.join(root, entry.name.rstrip('/'))
        assert os.path.commonpath([root, path]) == root
        if entry.isdir():
            os.makedirs(path, mode=0o755, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
            with tar.extractfile(entry) as source, open(path, 'xb') as target:
                shutil.copyfileobj(source, target)
            os.chmod(path, 0o755 if entry.mode & 0o111 else 0o644)
    print(json.dumps({'commit': tar.pax_headers['comment'], 'members': len(members), 'files': sum(m.isfile() for m in members)}, sort_keys=True))
`;
export const BASE_PROBE = String.raw`
import encodings, hashlib, json, os, platform, sys, sysconfig
assert sys.version_info.major == 3, 'BASE_PYTHON_NOT_3'
assert sys.prefix == sys.base_prefix, 'PREEXISTING_VENV_NOT_ALLOWED'
def fact(path):
    real = os.path.realpath(path)
    result = {'path': path, 'realPath': real}
    if os.path.isfile(real):
        with open(real, 'rb') as stream: result['sha256'] = hashlib.sha256(stream.read()).hexdigest()
    return result
print(json.dumps({'version': sys.version, 'executable': fact(sys.executable), 'prefix': sys.prefix,
    'basePrefix': sys.base_prefix, 'stdlib': sysconfig.get_path('stdlib'), 'encodings': fact(encodings.__file__),
    'sysPath': sys.path, 'libc': platform.libc_ver(), 'abi': {k: sysconfig.get_config_var(k) for k in ('SOABI', 'MULTIARCH', 'LDLIBRARY', 'LIBDIR', 'Py_ENABLE_SHARED')}}, sort_keys=True))
`;
export const PYTHON_PROBE = String.raw`
import encodings, hashlib, json, os, platform, site, sys, sysconfig
import pkg_resources
root = os.path.realpath(sys.argv[1])
venv = os.path.join(root, 'codex-ws-agent', '.toolchain')
observed_root = sys.argv[2] if len(sys.argv) > 2 else root
def inside(path, parent):
    return os.path.commonpath([os.path.realpath(path), parent]) == parent
def fact(path):
    real = os.path.realpath(path)
    result = {'path': path, 'realPath': real, 'exists': os.path.exists(real)}
    if os.path.isfile(real):
        with open(real, 'rb') as stream: result['sha256'] = hashlib.sha256(stream.read()).hexdigest()
    return result
assert sys.prefix == venv and sys.prefix != sys.base_prefix, 'TARGET_VENV_PREFIX_INVALID'
assert inside(sys.executable, venv), 'TARGET_PYTHON_OUTSIDE_VENV'
assert site.ENABLE_USER_SITE is False, 'USER_SITE_ENABLED'
assert not any('site-packages' in p and not inside(p, venv) for p in sys.path), 'HOST_SITE_PACKAGES_VISIBLE'
distributions = []
for dist in sorted(pkg_resources.working_set, key=lambda d: d.key):
    assert inside(dist.location, venv) and inside(dist.egg_info, venv), 'HOST_DISTRIBUTION_VISIBLE'
    metadata = {}
    for name in ('METADATA', 'PKG-INFO', 'RECORD', 'installed-files.txt'):
        path = os.path.join(dist.egg_info, name)
        if os.path.isfile(path): metadata[name] = fact(path)
    distributions.append({'name': dist.project_name, 'version': dist.version, 'location': os.path.realpath(dist.location),
        'metadataPath': os.path.realpath(dist.egg_info), 'metadata': metadata})
pins = {}
with open(os.path.join(root, 'codex-ws-agent', 'toolchain', 'requirements.txt')) as requirements:
    for line in requirements:
        line = line.strip()
        if line and not line.startswith('#'):
            name, expected = line.split('==')
            actual = pkg_resources.get_distribution(name).version
            assert actual == expected, 'PINNED_DISTRIBUTION_MISMATCH'
            pins[name] = {'expected': expected, 'actual': actual}
modules = {}
for name in ('docx', 'pptx', 'openpyxl', 'PIL', 'PyPDF2', 'reportlab', 'pip', 'pkg_resources'):
    module = __import__(name)
    assert inside(module.__file__, venv), 'HOST_MODULE_RESOLVED'
    modules[name] = dict(fact(module.__file__), version=getattr(module, '__version__', None))
bin_entries = []
for name in sorted(os.listdir(os.path.join(venv, 'bin'))):
    path = os.path.join(venv, 'bin', name)
    entry = dict(fact(path), name=name, symlink=os.path.islink(path), mode=oct(os.lstat(path).st_mode & 0o777))
    if os.path.islink(path): entry['link'] = os.readlink(path)
    if os.path.isfile(path):
        with open(path, 'rb') as stream: data = stream.read()
        if data.startswith(b'#!'):
            text = data.decode('utf-8', 'replace')
            entry['shebang'] = text.splitlines()[0]
            entry['launcherLines'] = text.splitlines()[:4]
            entry['observedRoot'] = observed_root
            entry['observedRootReferences'] = text.count(observed_root) if observed_root else 0
        elif name in ('activate', 'activate.csh', 'activate.fish'):
            text = data.decode('utf-8', 'replace')
            entry['activationObservedRoot'] = observed_root
            entry['activationRootReferences'] = text.count(observed_root) if observed_root else 0
    bin_entries.append(entry)
with open(os.path.join(venv, 'pyvenv.cfg')) as stream: cfg = stream.read()
print(json.dumps({'executable': fact(sys.executable), 'version': sys.version, 'prefix': sys.prefix,
    'basePrefix': sys.base_prefix, 'baseExecutable': getattr(sys, '_base_executable', None),
    'stdlib': fact(sysconfig.get_path('stdlib')), 'stdlibModules': {n: fact(m.__file__) for n, m in [('os', os), ('encodings', encodings), ('json', json)]},
    'sysPath': sys.path, 'userSiteEnabled': site.ENABLE_USER_SITE, 'libc': platform.libc_ver(),
    'abi': {k: sysconfig.get_config_var(k) for k in ('SOABI', 'MULTIARCH', 'LDLIBRARY', 'LIBDIR', 'Py_ENABLE_SHARED')},
    'distributions': distributions, 'pinsVerified': pins, 'modules': modules, 'pyvenv': dict(fact(os.path.join(venv, 'pyvenv.cfg')), content=cfg),
    'binEntries': bin_entries}, sort_keys=True))
`;
// Only observes the original shell at its publication command. No replacement
// for npm, pip, validate, mv, lock/permission checks or exit status. Not inherited.
export const STAGE_OBSERVER = String.raw`
unset BASH_ENV
ur01_observe_before_publish() {
    if [[ "$1" == 'mv -T -n "$STAGE" "$TARGET"' ]]; then
        "$STAGE/codex-ws-agent/.toolchain/bin/python" -I -B "$CYF_CLEAN_INSTALL_PROBE" "$STAGE" > "$CYF_CLEAN_INSTALL_STAGE_PROOF" || exit "$?"
    fi
    return 0
}
trap 'ur01_observe_before_publish "$BASH_COMMAND"' DEBUG
`;
// Images are synthetic pixels, NOT semantic generation. The frozen helper
// intentionally rejects image create. Documents use its actual create command.
export const IMAGE_CREATE = String.raw`
import sys
from PIL import Image
path, kind = sys.argv[1:]
image = Image.new('RGB', (32, 24), color=(24, 96, 160))
image.putpixel((0, 0), (255, 0, 0))
image.save(path, format=kind)
image.close()
`;
export const REOPEN = String.raw`
import json, sys
def pptx_text_matches(text, instruction):
    # The original producer wraps at 40 columns into paragraphs. Reconstruct
    # layout whitespace only: ALL words and their order must match, not merely
    # a prefix/title. Do not treat create/validate alone as semantic reopen.
    return ' '.join(text.split()) == ' '.join(instruction.split())
kind, path, instruction = sys.argv[1:]
if kind in ('png', 'jpeg'):
    from PIL import Image
    with Image.open(path) as image:
        image.load()
        assert image.size == (32, 24) and image.format == ('PNG' if kind == 'png' else 'JPEG')
        proof = {'format': image.format, 'width': image.width, 'height': image.height, 'mode': image.mode}
elif kind == 'pdf':
    from PyPDF2 import PdfFileReader
    with open(path, 'rb') as stream:
        pdf = PdfFileReader(stream, strict=True)
        assert not pdf.isEncrypted and pdf.getNumPages() == 1
        assert instruction in pdf.getPage(0).extractText()
        proof = {'pages': pdf.getNumPages(), 'syntheticTextMatched': True}
elif kind == 'docx':
    from docx import Document
    document = Document(path)
    assert any(instruction == p.text for p in document.paragraphs)
    proof = {'paragraphs': len(document.paragraphs), 'syntheticTextMatched': True}
elif kind == 'xlsx':
    from openpyxl import load_workbook
    workbook = load_workbook(path, read_only=True, data_only=False)
    assert any(cell == instruction for sheet in workbook for row in sheet.values for cell in row)
    proof = {'sheets': len(workbook.sheetnames), 'syntheticTextMatched': True}
    workbook.close()
elif kind == 'pptx':
    from pptx import Presentation
    presentation = Presentation(path)
    assert any(pptx_text_matches(shape.text, instruction) for slide in presentation.slides for shape in slide.shapes if shape.has_text_frame)
    proof = {'slides': len(presentation.slides), 'syntheticTextMatched': True, 'completeOrderedTextMatched': True}
else:
    raise ValueError('UNSUPPORTED_SYNTHETIC_FORMAT')
print(json.dumps(proof, sort_keys=True))
`;
const NODE_PROBE = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.argv[1]; const engine = resolve(root, 'codex-ws-agent/agent-client.mjs');
assert.equal(realpathSync(process.execPath), resolve(root, 'node/bin/node'));
assert.equal(process.versions.node, '20.20.2');
const module = await import(pathToFileURL(engine));
assert.equal(typeof module.createRuntimeExecutionHost, 'function');
const require = createRequire(engine); const dependencies = {};
for (const name of ['ws', 'yauzl']) {
  const path = realpathSync(require.resolve(name));
  assert.ok(path.startsWith(resolve(root, 'codex-ws-agent/node_modules') + '/'));
  const imported = require(name);
  assert.equal(typeof (name === 'ws' ? imported : imported.open), 'function');
  const packagePath = realpathSync(require.resolve(name + '/package.json'));
  dependencies[name] = { path, packagePath, version: JSON.parse(readFileSync(packagePath)).version };
}
const lock = JSON.parse(readFileSync(resolve(root, 'codex-ws-agent/package-lock.json')));
const distributions = Object.entries(lock.packages).filter(([path]) => path).map(([path, expected]) => {
  const packagePath = realpathSync(resolve(root, 'codex-ws-agent', path, 'package.json'));
  assert.ok(packagePath.startsWith(resolve(root, 'codex-ws-agent/node_modules') + '/'));
  const actual = JSON.parse(readFileSync(packagePath)); assert.equal(actual.version, expected.version);
  return { path, packagePath, version: actual.version, integrity: expected.integrity };
});
const {header, sharedObjects} = process.report.getReport();
console.log(JSON.stringify({node: process.versions.node, executable: process.execPath, engine, dependencies, distributions,
  abi: {arch: process.arch, platform: process.platform, glibcRuntime: header.glibcVersionRuntime,
    glibcCompiler: header.glibcVersionCompiler, osName: header.osName, osRelease: header.osRelease, sharedObjects}}));
`;

function redact(text) {
  // No input credentials/config/environment are accepted or dumped. Still strip
  // URL userinfo/query/fragment if a dependency diagnostic unexpectedly prints it.
  return text.replace(/https?:\/\/[^\s<>"']+/g, raw => {
    try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
    catch { return '[redacted-url]'; }
  }).replace(/((?:token|password|authorization|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[redacted]');
}
async function toolFacts(input, receipt) {
  const raw = await readFile(input.TOOLCHAIN_PROVENANCE, 'utf8');
  const provenance = JSON.parse(raw);
  receipt.toolchainProvenance = { path: input.TOOLCHAIN_PROVENANCE, sha256: digest(raw) };
  if (provenance.format !== 'ur01-clean-install-toolchain-v1'
      || Object.keys(provenance).sort().join(',') !== 'format,tools'
      || Object.keys(provenance.tools || {}).sort().join(',') !== 'bash,node,npm,python') throw fail('INPUT_TOOLCHAIN_PROVENANCE_SCHEMA');
  receipt.toolchain = {};
  for (const [key, envKey] of [['node', 'NODE'], ['npm', 'NPM_CLI'], ['python', 'PYTHON'], ['bash', 'BASH']]) {
    const supplied = provenance.tools[key];
    if (Object.keys(supplied).sort().join(',') !== 'origin,path,sha256' || supplied.path !== input[envKey]
        || !/^[a-f0-9]{64}$/.test(supplied.sha256)) throw fail('INPUT_TOOLCHAIN_PROVENANCE_MISMATCH');
    const path = nonProductionPath(await realpath(supplied.path)); const stat = await lstat(path);
    if (!stat.isFile() || key !== 'npm' && !(stat.mode & 0o111)) throw fail('INPUT_TOOL_NOT_REGULAR_OR_EXECUTABLE');
    const sha256 = await hashFile(path);
    if (sha256 !== supplied.sha256) throw fail('INPUT_TOOL_DIGEST_MISMATCH');
    receipt.toolchain[key] = { path: supplied.path, realPath: path, sha256, origin: origin(supplied.origin) };
  }
  if (await realpath(process.execPath) !== receipt.toolchain.node.realPath || process.versions.node !== '20.20.2') throw fail('HARNESS_MUST_USE_SUPPLIED_NODE_20_20_2');
  if (basename(receipt.toolchain.npm.realPath) !== 'npm-cli.js') throw fail('INPUT_MUST_BE_REAL_NPM_CLI');
  const npmPackage = join(dirname(dirname(receipt.toolchain.npm.realPath)), 'package.json');
  const npm = JSON.parse(await readFile(npmPackage, 'utf8'));
  if (npm.name !== 'npm') throw fail('INPUT_NPM_DISTRIBUTION_INVALID');
  receipt.toolchain.npm.package = { path: npmPackage, sha256: await hashFile(npmPackage), name: npm.name, version: npm.version };
}
export function relocation(stage, target, stageRoot, targetRoot) {
  const normalize = value => JSON.stringify(value).split(stageRoot).join('<artifact>').split(targetRoot).join('<artifact>');
  const staleShebangs = target.binEntries.filter(entry => entry.shebang?.includes(stageRoot));
  // distlib can use a /bin/sh trampoline instead of a long direct shebang.
  const staleLaunchers = target.binEntries.filter(entry => entry.shebang && entry.observedRoot === stageRoot && entry.observedRootReferences > 0);
  const staleLinks = target.binEntries.filter(entry => entry.link?.includes(stageRoot));
  const staleActivationReferences = target.binEntries.filter(entry => entry.activationObservedRoot === stageRoot && entry.activationRootReferences > 0);
  const baseDependencies = { prefix: target.basePrefix, executable: target.baseExecutable,
    stdlib: target.stdlib, stdlibModules: target.stdlibModules, abi: target.abi };
  const distributionsEqual = normalize(stage.distributions) === normalize(target.distributions);
  const modulesEqual = normalize(stage.modules) === normalize(target.modules);
  return { stageRoot, targetRoot, stagePrefix: stage.prefix, targetPrefix: target.prefix,
    basePrefixUnchanged: stage.basePrefix === target.basePrefix, distributionsEqual, modulesEqual,
    binEntriesEqual: normalize(stage.binEntries) === normalize(target.binEntries),
    pyvenvContentUnchanged: stage.pyvenv.content === target.pyvenv.content,
    executableContentUnchanged: stage.executable?.sha256 === target.executable?.sha256,
    staleShebangs, staleLaunchers, staleLinks, staleActivationReferences, baseDependencies, selfContainedPython: false,
    scope: 'venv --copies still depends on the supplied base interpreter/stdlib/system ABI; not a portability assertion' };
}

export const CONSUMER_FAILURE_CODES = Object.freeze([
  'CONSUMER_INPUT_REJECTED', 'CONSUMER_TEST_FAILED', 'CONSUMER_EXECUTION_FAILED'
]);
const CONSUMER_GUARD_CODES = new Set([
  'CONSUMER_SOURCE_NOT_FIXED', 'CONSUMER_SOURCE_CHANGED', 'CONSUMER_TARGET_IDENTITY_CHANGED',
  'CONSUMER_NODE_CHANGED', 'CONSUMER_PAYLOAD_CHANGED', 'CONSUMER_ARTIFACT_CHANGED',
  'CONSUMER_PROJECTION_INVALID', 'CONSUMER_HARNESS_CHANGED'
]);
function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}
// Exact plain data only: no arbitrary fields, getters, symbols or diagnostic
// strings. Do not spread a callback object or reflect a thrown exception.
export function consumerResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('CONSUMER_RESULT_INVALID');
    const keys = Reflect.ownKeys(value).sort();
    const properties = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(properties[key], 'value'))) throw fail('CONSUMER_RESULT_INVALID');
    if (keys.join(',') === 'status' && properties.status.value === 'PASS') return { status: 'PASS' };
    if (keys.join(',') === 'code,status' && properties.status.value === 'FAIL'
        && CONSUMER_FAILURE_CODES.includes(properties.code.value)) return { status: 'FAIL', code: properties.code.value };
  } catch { /* Invalid callback data never gets serialized. */ }
  throw fail('CONSUMER_RESULT_INVALID');
}
async function artifactIdentity(path, expected) {
  const stat = await lstat(path);
  if (!expected || !stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path
      || stat.dev !== expected.dev || stat.ino !== expected.ino) throw fail('CONSUMER_TARGET_IDENTITY_CHANGED');
}
// Full installed file/mode/link digest for the callback's borrowed artifact.
// Only the one UR04 provenance manifest may be newly written by the explicit
// control wrapper. It is NOT installed payload, is never a link, and cannot
// hide changes to any pre-existing member. No metadata is created by this hook.
async function artifactInventory(root, { allowConsumerManifest = false } = {}) {
  const rootStat = await lstat(root);
  const entries = [{ path: '', type: 'directory', mode: rootStat.mode & 0o777, uid: rootStat.uid, gid: rootStat.gid, dev: rootStat.dev, ino: rootStat.ino }];
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relative = memberPath(prefix + name); const path = join(directory, name); const stat = await lstat(path);
      if (!prefix && name === 'ur04-clean-artifact.json') {
        if (!allowConsumerManifest || !stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw fail('CONSUMER_ARTIFACT_CHANGED');
        continue;
      }
      const fact = { path: relative, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, dev: stat.dev, ino: stat.ino };
      if (stat.isSymbolicLink()) {
        const resolved = await realpath(path);
        if (!inside(root, resolved)) throw fail('CONSUMER_ARTIFACT_CHANGED');
        entries.push({ ...fact, type: 'symlink', link: await readlink(path), resolved });
      } else if (stat.isDirectory()) {
        if (await realpath(path) !== path) throw fail('CONSUMER_ARTIFACT_CHANGED');
        entries.push({ ...fact, type: 'directory' }); await walk(path, `${relative}/`);
      } else if (stat.isFile() && await realpath(path) === path) {
        entries.push({ ...fact, type: 'file', bytes: stat.size, sha256: await hashFile(path) });
      } else throw fail('CONSUMER_ARTIFACT_CHANGED');
    }
  }
  await walk(root);
  return digest(JSON.stringify(entries));
}
async function consumerSource(context) {
  const { receipt, input, sourceRoot } = context;
  if (receipt.source.commit !== SOURCE.commit || receipt.source.tree !== SOURCE.tree || receipt.source.files !== SOURCE.files
      || receipt.source.readbackTree !== SOURCE.tree || receipt.source.finalReadbackTree !== SOURCE.tree
      || receipt.source.archive.sha256 !== input.SOURCE_SHA256 || receipt.source.archive.finalSha256 !== input.SOURCE_SHA256
      || receipt.source.archive.expectedSha256 !== input.SOURCE_SHA256) throw fail('CONSUMER_SOURCE_NOT_FIXED');
  try {
    if ((await sourceInventory(sourceRoot)).tree !== SOURCE.tree || await hashFile(input.SOURCE_ARCHIVE) !== input.SOURCE_SHA256) throw fail('CONSUMER_SOURCE_CHANGED');
  } catch { throw fail('CONSUMER_SOURCE_CHANGED'); }
}
async function consumerTarget(context) {
  const { receipt, root, identity, target, targetIdentity } = context;
  if (target !== join(root, 'parent/target') || !receipt.targetPublished || receipt.publication?.target !== target
      || !receipt.publication.stageAbsent || !receipt.publication.installerSourceUnchanged) throw fail('CONSUMER_TARGET_IDENTITY_CHANGED');
  await artifactIdentity(root, identity); await artifactIdentity(target, targetIdentity);
  const nodeBin = join(target, 'node/bin/node'); const nodeStat = await lstat(nodeBin);
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || !(nodeStat.mode & 0o111) || await realpath(nodeBin) !== nodeBin
      || receipt.node?.sha256 !== receipt.toolchain.node.sha256 || await hashFile(nodeBin) !== receipt.node.sha256) throw fail('CONSUMER_NODE_CHANGED');
  return nodeBin;
}
async function consumerPayload(context) {
  const { receipt, sourceRoot, target } = context;
  const adapter = await readFile(join(sourceRoot, 'conf/cyf-agent-runtime-v1/lib/execution-adapter.mjs'), 'utf8');
  const catalog = JSON.parse(adapter.match(/export const EXECUTION_PAYLOAD_FILES = Object\.freeze\((\[[\s\S]*?\])\);/)?.[1] || 'null');
  if (!Array.isArray(catalog) || catalog.length !== 46) throw fail('CONSUMER_PAYLOAD_CHANGED');
  const expected = [...RUNTIME_FILES.map(path => `conf/cyf-agent-runtime-v1/${path}`), ...catalog.map(path => `conf/codex-ws-agent/${memberPath(path)}`)];
  if (JSON.stringify(receipt.source.installInputs) !== JSON.stringify(expected)) throw fail('CONSUMER_PAYLOAD_CHANGED');
  // Bind all original executable/config/doc members to the fixed source.
  // Dependencies/toolchain are covered by the complete pre/post digest.
  for (const sourcePath of expected) {
    const relative = sourcePath.startsWith('conf/cyf-agent-runtime-v1/')
      ? sourcePath.replace('conf/cyf-agent-runtime-v1/', 'runtime/') : sourcePath.slice('conf/'.length);
    const path = join(target, relative); const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path
        || await hashFile(path) !== await hashFile(join(sourceRoot, sourcePath))) throw fail('CONSUMER_PAYLOAD_CHANGED');
  }
}

// Factory validates the explicit callback BEFORE input parsing or filesystem
// effects. Its one-shot closure cannot silently retry a consumer or install.
// Tests call this narrow lifecycle with synthetic files, NOT acceptance().
export function createArtifactConsumer(consumeArtifact) {
  if (consumeArtifact !== undefined && typeof consumeArtifact !== 'function') throw fail('CONSUMER_CALLBACK_INVALID');
  let handled = false;
  return async context => {
    if (consumeArtifact === undefined) return true; // Preserve standalone behavior.
    if (handled) throw fail('CONSUMER_ALREADY_INVOKED');
    handled = true;
    const { receipt } = context;
    const record = receipt.consumer = { status: 'NOT_RUN', calls: 0 };
    if (Object.keys(receipt.acceptance).sort().join(',') !== 'C1,C2,C3,C4'
        || !['C1', 'C2', 'C3', 'C4'].every(key => receipt.acceptance[key]?.status === 'PASS')) {
      record.code = 'CONSUMER_INSTALL_NOT_ACCEPTED'; return false;
    }
    try {
      await consumerSource(context);
      const nodeBin = await consumerTarget(context);
      await consumerPayload(context);
      if (await hashFile(SELF) !== receipt.harness.sha256) throw fail('CONSUMER_HARNESS_CHANGED');
      if (receipt.format !== 'ur01-clean-target-local-fixture-v1' || receipt.localBackendFixtureOnly !== true
          || Object.hasOwn(receipt, 'cloudRun') || Object.hasOwn(receipt.scope || {}, 'cloudOnlyOptIn')
          || typeof receipt.buildId !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(receipt.buildId) || !/^[a-f0-9]{64}$/.test(receipt.node.sha256)
          || !/^[a-f0-9]{64}$/.test(receipt.harness.sha256)) throw fail('CONSUMER_PROJECTION_INVALID');
      const artifactDigest = await artifactInventory(context.target);
      // Explicit insertion order is the snapshot contract. No receipt/env/error
      // object is copied; the final receipt hash does not exist until finally.
      const accepted = {
        format: 'ur01-accepted-local-target-v1', buildId: receipt.buildId,
        target: context.target, nodeBin, nodeSha256: receipt.node.sha256,
        source: { commit: SOURCE.commit, tree: SOURCE.tree, files: SOURCE.files,
          archiveSha256: context.input.SOURCE_SHA256, finalReadbackTree: receipt.source.finalReadbackTree },
        harnessSha256: receipt.harness.sha256,
        checks: { C1: 'PASS', C2: 'PASS', C3: 'PASS', C4: 'PASS' }
      };
      accepted.acceptedSnapshotSha256 = digest(JSON.stringify(accepted));
      deepFreeze(accepted);
      record.acceptedSnapshot = accepted;
      record.calls = 1;
      let result;
      try { result = await consumeArtifact(accepted); }
      catch { record.status = 'FAIL'; record.code = 'CONSUMER_CALLBACK_THREW'; }
      if (record.status !== 'FAIL') {
        try { Object.assign(record, consumerResult(result)); }
        catch { record.status = 'FAIL'; record.code = 'CONSUMER_RESULT_INVALID'; }
      }
      // Even a failed/throwing callback may not silently modify source or
      // installed members. Guard failures are independent of original C1-C4.
      await consumerSource(context); await consumerTarget(context); await consumerPayload(context);
      if (await artifactInventory(context.target, { allowConsumerManifest: true }) !== artifactDigest) throw fail('CONSUMER_ARTIFACT_CHANGED');
      if (await hashFile(SELF) !== receipt.harness.sha256) throw fail('CONSUMER_HARNESS_CHANGED');
      record.integrityReadback = 'PASS';
      return record.status === 'PASS';
    } catch (error) {
      record.status = 'FAIL';
      record.code = CONSUMER_GUARD_CODES.has(error?.code) ? error.code : 'CONSUMER_INTEGRITY_CHECK_FAILED';
      return false;
    }
  };
}

// Pure receipt construction is shared with synthetic schema tests; it performs no IO
// and never substitutes for the actual C1-C4 execution below.
export function localFixtureReceipt(input, harnessSha256) {
  return { format: 'ur01-clean-target-local-fixture-v1', startedAt: new Date().toISOString(),
    source: { ...SOURCE, archive: { path: input.SOURCE_ARCHIVE, expectedSha256: input.SOURCE_SHA256 } },
    harness: { path: SELF, sha256: harnessSha256 }, buildId: input.BUILD_ID, localBackendFixtureOnly: true,
    scope: { productionAcceptance: false,
      excluded: ['service control', 'enrollment', 'Provider', 'Codex business execution', 'old-state migration', 'production Java/DB'] },
    os: { type: type(), release: release(), architecture: arch() },
    steps: [], acceptance: Object.fromEntries(['C1', 'C2', 'C3', 'C4'].map(key => [key, { status: 'NOT_RUN', reason: 'dependency not reached' }])),
    result: 'FAIL' };
}
export async function acceptance(env = process.env, { consumeArtifact } = {}) {
  const consumer = createArtifactConsumer(consumeArtifact);
  const input = parseInputs(env);
  const receipt = localFixtureReceipt(input, await hashFile(SELF));
  let root; let identity; let evidenceOwned = false; let current = 'input-preflight';
  const evidence = `${input.RECEIPT}.evidence`;
  await canonicalDirectory(dirname(input.RECEIPT)); await absent(input.RECEIPT); await absent(evidence);
  // Reserve the new receipt/evidence exclusively, before any installer action.
  const receiptFd = await open(input.RECEIPT, 'wx', 0o600);
  let childEnv;
  async function run(name, executable, args, { cwd = root, environment = childEnv, mustPass = true } = {}) {
    current = name;
    const index = String(receipt.steps.length + 1).padStart(2, '0');
    const record = { name, executable, args, cwd, startedAt: new Date().toISOString() };
    receipt.steps.push(record);
    const stdoutPath = join(evidence, `${index}-${name}.stdout.log`);
    const stderrPath = join(evidence, `${index}-${name}.stderr.log`);
    const stdoutFd = await open(stdoutPath, 'wx', 0o600); const stderrFd = await open(stderrPath, 'wx', 0o600);
    let stdout = ''; let stderr = ''; let childError;
    try {
      const outcome = await new Promise(resolveChild => {
        const child = spawn(executable, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        // Only nonsecret public dependency output / synthetic local material.
        // Retain complete logs; no resource or performance deadline gate.
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
        child.on('error', error => { childError = error.code || 'SPAWN_FAILURE'; });
        child.on('close', (code, signal) => resolveChild({ code, signal }));
      });
      stdout = redact(stdout); stderr = redact(stderr);
      await stdoutFd.writeFile(stdout); await stderrFd.writeFile(stderr);
      await stdoutFd.sync(); await stderrFd.sync();
      Object.assign(record, { exitCode: outcome.code, signal: outcome.signal, error: childError,
        endedAt: new Date().toISOString(), stdout: { path: stdoutPath, sha256: digest(stdout) }, stderr: { path: stderrPath, sha256: digest(stderr) } });
      if (mustPass && (outcome.code !== 0 || childError)) throw fail(`STEP_FAILED_${name}`);
      return { stdout, stderr, ...outcome };
    } finally { await stdoutFd.close(); await stderrFd.close(); }
  }
  async function check(key, body) {
    try { await body(); receipt.acceptance[key] = { status: 'PASS' }; }
    catch (error) { receipt.acceptance[key] = { status: 'FAIL', stage: current, code: error.code || 'ASSERTION_OR_IO_FAILURE' }; }
  }
  try {
    await mkdir(evidence, { mode: 0o700 }); evidenceOwned = true;
    await canonicalDirectory(input.PARENT);
    for (const directory of input.PATH.split(':')) await canonicalDirectory(nonProductionPath(await realpath(directory)));
    await toolFacts(input, receipt);
    if (await realpath(input.SOURCE_ARCHIVE) !== input.SOURCE_ARCHIVE || !(await lstat(input.SOURCE_ARCHIVE)).isFile()) throw fail('INPUT_ARCHIVE_NOT_CANONICAL_REGULAR');
    receipt.source.archive.sha256 = await hashFile(input.SOURCE_ARCHIVE);
    if (receipt.source.archive.sha256 !== input.SOURCE_SHA256) throw fail('INPUT_ARCHIVE_DIGEST_MISMATCH');
    root = await mkdtemp(join(input.PARENT, 'ur01-clean-install-')); await chmod(root, 0o700);
    const stat = await lstat(root); identity = { dev: stat.dev, ino: stat.ino };
    receipt.isolation = { root, mode: '0700', inheritedEnvironment: [], cleanSource: null, cleanTarget: null,
      npmRegistry: input.NPM_REGISTRY, pipIndex: input.PIP_INDEX_URL, cachePolicy: 'new private empty npm cache; pip --no-cache-dir; no inherited configuration' };
    for (const directory of ['home', 'tmp', 'cache', 'config', 'bin', 'parent', 'materials']) await mkdir(join(root, directory), { mode: 0o700 });
    await symlink(receipt.toolchain.node.realPath, join(root, 'bin/node'));
    await freshFile(join(root, 'npm-user.conf'), ''); await freshFile(join(root, 'npm-global.conf'), '');
    childEnv = { PATH: `${join(root, 'bin')}:${input.PATH}`, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PIP_CONFIG_FILE: '/dev/null', PIP_INDEX_URL: input.PIP_INDEX_URL,
      PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1',
      npm_config_userconfig: join(root, 'npm-user.conf'), npm_config_globalconfig: join(root, 'npm-global.conf'),
      npm_config_cache: join(root, 'cache/npm'), npm_config_prefix: join(root, 'npm-prefix'), npm_config_registry: input.NPM_REGISTRY,
      npm_config_update_notifier: 'false' };
    receipt.isolation.childEnvironmentKeys = Object.keys(childEnv).sort();
    try { receipt.os.osRelease = await readFile('/etc/os-release', 'utf8'); } catch { receipt.os.osRelease = null; }
    const base = await run('base-python-stdlib', input.PYTHON, ['-I', '-S', '-B', '-c', BASE_PROBE]);
    receipt.python = { base: JSON.parse(base.stdout) };
    const npm = await run('npm-cli-version', input.NODE, [input.NPM_CLI, '--version']);
    receipt.toolchain.npm.actualVersion = npm.stdout.trim();
    if (receipt.toolchain.npm.actualVersion !== receipt.toolchain.npm.package.version) throw fail('NPM_CLI_VERSION_MISMATCH');
    await run('bash-version', input.BASH, ['--noprofile', '--norc', '--version']);
    for (const [name, binary] of [['node', input.NODE], ['python', input.PYTHON]]) {
      await run(`${name}-dynamic-links-observation`, input.BASH,
        ['--noprofile', '--norc', '-c', 'command -v ldd && ldd "$1"', 'ur01-abi-observation', binary], { mustPass: false });
    }
    const sourceRoot = join(root, 'source');
    const extracted = await run('extract-fixed-source', input.PYTHON, ['-I', '-S', '-B', '-c', EXTRACT, input.SOURCE_ARCHIVE, sourceRoot, SOURCE.commit]);
    receipt.source.archive.extraction = JSON.parse(extracted.stdout);
    current = 'source-tree-readback';
    const inventory = await sourceInventory(sourceRoot);
    receipt.isolation.cleanSource = true;
    receipt.source.readbackTree = inventory.tree; receipt.source.members = inventory.files;
    // Derive the exact frozen original catalog, not another installer list.
    const adapter = await readFile(join(sourceRoot, 'conf/cyf-agent-runtime-v1/lib/execution-adapter.mjs'), 'utf8');
    const catalog = JSON.parse(adapter.match(/export const EXECUTION_PAYLOAD_FILES = Object\.freeze\((\[[\s\S]*?\])\);/)?.[1] || 'null');
    if (!Array.isArray(catalog) || catalog.length !== 46 || RUNTIME_FILES.length !== 13) throw fail('SOURCE_CATALOG_INVALID');
    receipt.source.installInputs = [...RUNTIME_FILES.map(path => `conf/cyf-agent-runtime-v1/${path}`), ...catalog.map(path => `conf/codex-ws-agent/${memberPath(path)}`)];
    await freshFile(join(root, 'python-probe.py'), PYTHON_PROBE);
    await freshFile(join(root, 'stage-observer.sh'), STAGE_OBSERVER);
    const stageProof = join(root, 'stage-proof.json');
    const target = join(root, 'parent/target'); await absent(target); receipt.isolation.cleanTarget = true;
    const installer = join(sourceRoot, 'conf/cyf-agent-runtime-v1/install.sh');
    const installerHash = await hashFile(installer);
    await check('C1', async () => {
      await run('original-install', input.BASH, ['--noprofile', '--norc', '-x', installer,
        '--target', target, '--node', input.NODE, '--npm', input.NPM_CLI, '--python', input.PYTHON],
      { environment: { ...childEnv, BASH_ENV: join(root, 'stage-observer.sh'),
        CYF_CLEAN_INSTALL_PROBE: join(root, 'python-probe.py'), CYF_CLEAN_INSTALL_STAGE_PROOF: stageProof } });
      current = 'stage-publication-proof';
      receipt.python.stage = JSON.parse(await readFile(stageProof, 'utf8'));
      const stageRoot = dirname(dirname(receipt.python.stage.prefix));
      if (dirname(stageRoot) !== dirname(target) || !basename(stageRoot).startsWith('.cyf-agent-runtime.stage.')) throw fail('STAGE_PROOF_NOT_OWNED');
      receipt.publication = { stageRoot, target, stageAbsent: false, installerSourceUnchanged: await hashFile(installer) === installerHash };
      await absent(stageRoot); receipt.publication.stageAbsent = true;
      if ((await readdir(dirname(target))).join(',') !== 'target' || !receipt.publication.installerSourceUnchanged) throw fail('INSTALLER_OR_STAGE_CLEANUP_MISMATCH');
      const install = receipt.steps.find(step => step.name === 'original-install');
      const output = await readFile(install.stdout.path, 'utf8');
      if (!output.includes(`Runtime artifact closure validation passed: ${stageRoot}`)
          || !output.includes(`Runtime artifact closure validation passed: ${target}`)) throw fail('ORIGINAL_TWO_PHASE_VALIDATION_NOT_OBSERVED');
      await run('target-final-validate', input.BASH, ['--noprofile', '--norc', join(target, 'runtime/validate.sh'), '--root', target]);
    });
    // A published-but-invalid target remains a failure, never called rollback.
    // Probe other dimensions if publication actually happened; otherwise NOT_RUN.
    let published = false; let targetIdentity;
    try { const stat = await lstat(target); published = stat.isDirectory() && !stat.isSymbolicLink() && await realpath(target) === target;
      if (published) targetIdentity = { dev: stat.dev, ino: stat.ino }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    receipt.targetPublished = published;
    if (published) {
      if (!receipt.python.stage) {
        try { receipt.python.stage = JSON.parse(await readFile(stageProof, 'utf8')); } catch { /* C3 must report lack of proof, not skip/pass. */ }
      }
      await check('C2', async () => {
        const localNode = join(target, 'node/bin/node');
        const proof = await run('target-node-engine-ws-yauzl', localNode, ['--input-type=module', '-e', NODE_PROBE, target]);
        receipt.node = JSON.parse(proof.stdout); receipt.node.sha256 = await hashFile(localNode);
        if (receipt.node.sha256 !== receipt.toolchain.node.sha256) throw fail('ARTIFACT_NODE_NOT_SUPPLIED_BINARY');
      });
      const python = join(target, 'codex-ws-agent/.toolchain/bin/python');
      const helper = join(target, 'codex-ws-agent/toolchain/delivery_tool.py');
      await check('C3', async () => {
        const observedStageRoot = receipt.python.stage ? dirname(dirname(receipt.python.stage.prefix)) : '';
        const proof = await run('target-python-relocation', python, ['-I', '-B', join(root, 'python-probe.py'), target, observedStageRoot]);
        receipt.python.target = JSON.parse(proof.stdout);
        const health = await run('target-helper-health', python, ['-I', '-B', helper, 'health']);
        receipt.python.health = JSON.parse(health.stdout);
        if (!receipt.python.health.ok || !receipt.python.stage) throw fail('PYTHON_HEALTH_OR_STAGE_PROOF_MISSING');
        const stageRoot = dirname(dirname(receipt.python.stage.prefix));
        receipt.python.relocation = relocation(receipt.python.stage, receipt.python.target, stageRoot, target);
        const result = receipt.python.relocation;
        if (!result.basePrefixUnchanged || !result.distributionsEqual || !result.modulesEqual || !result.pyvenvContentUnchanged
            || !result.executableContentUnchanged || !result.binEntriesEqual || result.staleShebangs.length || result.staleLaunchers.length
            || result.staleLinks.length || result.staleActivationReferences.length) throw fail('VENV_RELOCATION_DEFECT');
        if (receipt.python.target.basePrefix !== receipt.python.base.basePrefix) throw fail('TARGET_BASE_PYTHON_MISMATCH');
        // Run the installed generated CLI itself, not python -m pip. This is
        // additional launcher evidence, not a replacement for health/relocation
        // or the six real format create/validate/reopen checks below.
        const pip = await run('target-pip-direct-cli', join(target, 'codex-ws-agent/.toolchain/bin/pip'), ['--isolated', '--version']);
        if (!pip.stdout.startsWith('pip ') || !pip.stdout.includes(join(target, 'codex-ws-agent/.toolchain/lib/'))
            || pip.stdout.includes(stageRoot)) throw fail('TARGET_PIP_LAUNCHER_NOT_LOCAL');
        receipt.python.directCli = { path: join(target, 'codex-ws-agent/.toolchain/bin/pip'), output: pip.stdout.trim(), status: 'PASS' };
      });
      await check('C4', async () => {
        receipt.delivery = []; const instruction = 'UR01 synthetic clean-install acceptance material';
        for (const [extension, mime] of FORMATS) {
          const path = join(root, `materials/synthetic.${extension}`);
          const entry = { extension, mime, path, producer: ['png', 'jpeg'].includes(extension) ? 'target Pillow synthetic pixels (not semantic image generation)' : 'original delivery helper create' };
          receipt.delivery.push(entry);
          // Independent formats continue after an individual failure.
          try {
            if (['png', 'jpeg'].includes(extension)) await run(`create-${extension}`, python, ['-I', '-B', '-c', IMAGE_CREATE, path, extension === 'png' ? 'PNG' : 'JPEG']);
            else await run(`create-${extension}`, python, ['-I', '-B', helper, 'create', '--mime', mime, '--output', path, '--instruction', instruction]);
            await run(`validate-${extension}`, python, ['-I', '-B', helper, 'validate', '--mime', mime, '--file', path]);
            const reopened = await run(`reopen-${extension}`, python, ['-I', '-B', '-c', REOPEN, extension, path, instruction]);
            entry.reopen = JSON.parse(reopened.stdout); entry.sha256 = await hashFile(path); entry.bytes = (await lstat(path)).size; entry.status = 'PASS';
          } catch (error) { entry.status = 'FAIL'; entry.stage = current; entry.code = error.code || 'ASSERTION_OR_IO_FAILURE'; }
        }
        if (receipt.delivery.some(entry => entry.status !== 'PASS')) throw fail('DELIVERY_FORMAT_FAILURE');
      });
    }
    current = 'final-source-readback';
    // The installer/imports must not have adopted or modified the source tree.
    receipt.source.finalReadbackTree = (await sourceInventory(sourceRoot)).tree;
    receipt.source.archive.finalSha256 = await hashFile(input.SOURCE_ARCHIVE);
    if (receipt.source.archive.finalSha256 !== input.SOURCE_SHA256) throw fail('SOURCE_ARCHIVE_CHANGED');
    receipt.result = Object.values(receipt.acceptance).every(check => check.status === 'PASS') ? 'PASS' : 'FAIL';
    if (consumeArtifact !== undefined) {
      current = 'artifact-consumer';
      if (!await consumer({ receipt, input, sourceRoot, root, identity, target, targetIdentity })) receipt.result = 'FAIL';
    }
  } catch (error) {
    receipt.failure = { stage: current, code: error.code || 'ASSERTION_OR_IO_FAILURE' };
    receipt.result = 'FAIL';
  } finally {
    receipt.cleanup = { scope: 'only mkdtemp-exclusive root; evidence/receipt retained', root: root || null, removed: false };
    if (root && identity) {
      try {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino || await realpath(root) !== root) throw fail('CLEANUP_ROOT_OWNERSHIP_LOST');
        await rm(root, { recursive: true, force: false });
        receipt.cleanup.removed = true;
      } catch (error) { receipt.cleanup.code = error.code || 'CLEANUP_IO_FAILURE'; receipt.result = 'FAIL'; }
    }
    receipt.evidenceRetained = evidenceOwned ? evidence : null;
    receipt.endedAt = new Date().toISOString();
    try { await receiptFd.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await receiptFd.sync(); }
    finally { await receiptFd.close(); }
  }
  console.log(JSON.stringify({ result: receipt.result, receipt: input.RECEIPT, acceptance: receipt.acceptance }));
  return receipt.result === 'PASS' ? 0 : 1;
}

export function describe() {
  return { format: 'ur01-clean-target-local-fixture-input-v1', source: SOURCE,
    command: '"$CYF_CLEAN_INSTALL_NODE" /absolute/candidate/conf/cyf-agent-runtime-v1/test/clean-target-install.acceptance.mjs',
    requiredEnvironment: ['CYF_CLEAN_INSTALL=1', ...REQUIRED.map(key => `CYF_CLEAN_INSTALL_${key}`)],
    optionalEnvironment: ['CYF_CLEAN_INSTALL_NPM_REGISTRY', 'CYF_CLEAN_INSTALL_PIP_INDEX_URL'],
    toolchainProvenance: { format: 'ur01-clean-install-toolchain-v1', tools: Object.fromEntries(['node', 'npm', 'python', 'bash'].map(name => [name,
      { path: '/absolute/explicit/tool', sha256: '<64 lowercase hex>', origin: 'fixed-input:immutable-tool-input' }])) },
    toolOrigins: ['local-host:/absolute/actual/tool', 'fixed-input:immutable-tool-input', 'https://public.example/tool'],
    archive: { format: 'uncompressed git archive --format=tar; no prefix; full fixed payload tree',
      trackedFiles: SOURCE.files, reconstructedTree: SOURCE.tree, runtimeFiles: RUNTIME_FILES.map(path => `conf/cyf-agent-runtime-v1/${path}`),
      executionCatalog: 'all 46 original EXECUTION_PAYLOAD_FILES from frozen execution-adapter.mjs' },
    receipt: ['source.archive/member modes/blob/SHA256/tree readback', 'harness SHA256', 'format=ur01-clean-target-local-fixture-v1', 'buildId', 'localBackendFixtureOnly=true', 'os/ABI',
      'toolchain actual paths/origins/SHA256/npm distribution', 'isolation and childEnvironmentKeys (not values)',
      'steps exit/signal/sanitized log SHA256', 'publication', 'python base/stage/target/health/distributions/modules/pyvenv/shebang/relocation',
      'node engine/ws/yauzl/lock distributions/ABI', 'delivery synthetic create/validate/reopen/hash', 'acceptance C1-C4', 'optional independent consumer/snapshot/integrityReadback', 'failure', 'cleanup', 'result'],
    consumer: { invocation: 'acceptance(env, { consumeArtifact }) explicit function only; never env/code loading',
      success: { status: 'PASS' }, failure: { status: 'FAIL', code: CONSUMER_FAILURE_CODES },
      snapshotFormat: 'ur01-accepted-local-target-v1', identity: 'buildId',
      snapshot: 'ordered JSON excluding acceptedSnapshotSha256; not final receipt SHA; borrowed target until await settles',
      cleanup: 'unchanged default and failure finally; only ur04-clean-artifact.json may be added to target' },
    boundaries: 'standalone explicit local backend fixture only; Main-owned private non-production install and awaited consumer; no global packages/services/enroll/Provider/old state; NOT_RUN is not PASS; stale stage shebang is FAIL, no automatic repair' };
}
export function invocationMode(args, env) {
  if (env.NODE_TEST_CONTEXT !== undefined) return 'node-test-not-acceptance';
  if (args.length === 1 && args[0] === '--selfcheck') return 'selfcheck';
  if (args.length === 1 && args[0] === '--describe') return 'describe';
  if (args.length === 0) return 'local-fixture';
  throw fail('USAGE_ONLY_SELFCHECK_DESCRIBE_OR_EXPLICIT_LOCAL_FIXTURE');
}
export function selfcheck() {
  let checks = 0;
  const yes = body => { body(); checks++; };
  const env = Object.fromEntries(REQUIRED.map(key => [`CYF_CLEAN_INSTALL_${key}`, '/tmp/input']));
  Object.assign(env, { CYF_CLEAN_INSTALL: '1', CYF_CLEAN_INSTALL_BUILD_ID: 'SYNTHETIC-static-local-build',
    CYF_CLEAN_INSTALL_SOURCE_SHA256: 'a'.repeat(64), CYF_CLEAN_INSTALL_PATH: '/usr/bin:/bin' });
  yes(() => assert.equal(parseInputs(env).NPM_REGISTRY, 'https://registry.npmjs.org/'));
  yes(() => assert.throws(() => parseInputs({}), { code: 'LOCAL_FIXTURE_OPT_IN_REQUIRED' }));
  for (const key of REQUIRED) yes(() => { const invalid = { ...env }; delete invalid[`CYF_CLEAN_INSTALL_${key}`]; assert.throws(() => parseInputs(invalid), { code: `INPUT_REQUIRED_${key}` }); });
  for (const path of ['relative', '/tmp/../bad', '/tmp/x\n', '/tmp//bad']) yes(() => assert.throws(() => absolute(path)));
  for (const path of ['../x', 'x/../y', '/x', '.git/config', 'x//y', 'x\\y', 'x\n']) yes(() => assert.throws(() => memberPath(path)));
  for (const url of ['https://user:secret@example.com/', 'https://example.com/?token=private', 'https://example.com/#private', 'file:///tmp/x']) yes(() => assert.throws(() => publicUrl(url)));
  for (const parent of ['/home/isp/hosts/cyf', '/root/.codex', '/var/lib/cyf-api-flow']) yes(() => assert.throws(() => parseInputs({ ...env, CYF_CLEAN_INSTALL_PARENT: parent }), { code: 'INPUT_PRODUCTION_OR_PRIVATE_ROOT_FORBIDDEN' }));
  yes(() => assert.equal(treeDigest([]), '4b825dc642cb6eb9a060e54bf8d69288fbee4904'));
  yes(() => assert.equal(gitObject('blob', Buffer.from('test content\n')), 'd670460b4b4aece5915caf5c68d12f560a9fe3e4'));
  yes(() => assert.equal(inside('/tmp/a', '/tmp/another'), false));
  yes(() => assert.equal(redact('https://user:secret@example.com/x?token=private#z'), 'https://example.com/x'));
  yes(() => assert.equal(redact('authorization=secret'), 'authorization=[redacted]'));
  const proof = path => ({ prefix: `${path}/codex-ws-agent/.toolchain`, basePrefix: '/base', baseExecutable: '/base/bin/python',
    stdlib: '/base/lib/python', stdlibModules: {}, abi: {}, distributions: [{ name: 'Pillow', path: `${path}/site` }],
    modules: { PIL: `${path}/site/PIL` }, pyvenv: { content: 'home = /base' }, binEntries: [] });
  yes(() => assert.equal(relocation(proof('/stage'), proof('/target'), '/stage', '/target').distributionsEqual, true));
  yes(() => { const target = proof('/target'); target.binEntries.push({ shebang: '#!/stage/codex-ws-agent/.toolchain/bin/python' }); assert.equal(relocation(proof('/stage'), target, '/stage', '/target').staleShebangs.length, 1); });
  yes(() => { const target = proof('/target'); target.binEntries.push({ activationObservedRoot: '/stage', activationRootReferences: 1 }); assert.equal(relocation(proof('/stage'), target, '/stage', '/target').staleActivationReferences.length, 1); });
  yes(() => assert.equal(relocation(proof('/stage'), proof('/target'), '/stage', '/target').binEntriesEqual, true));
  yes(() => { const target = proof('/target'); target.binEntries.push({ sha256: 'changed' }); assert.equal(relocation(proof('/stage'), target, '/stage', '/target').binEntriesEqual, false); });
  yes(() => assert.equal(RUNTIME_FILES.length, 13));
  yes(() => { const target = proof('/target'); target.binEntries.push({ shebang: '#!/bin/sh', observedRoot: '/stage', observedRootReferences: 1 }); assert.equal(relocation(proof('/stage'), target, '/stage', '/target').staleLaunchers.length, 1); });
  yes(() => assert.throws(() => parseInputs({ ...env, CYF_CLEAN_INSTALL_PATH: '/tmp/node_modules/.bin' }), { code: 'INPUT_PATH_HOST_DEPENDENCY_DIRECTORY' }));
  yes(() => assert.equal(FORMATS.length, 6));
  yes(() => assert.throws(() => createArtifactConsumer(null), { code: 'CONSUMER_CALLBACK_INVALID' }));
  yes(() => assert.deepEqual(consumerResult({ status: 'PASS' }), { status: 'PASS' }));
  yes(() => assert.throws(() => consumerResult({ status: 'PASS', token: 'not-allowed' }), { code: 'CONSUMER_RESULT_INVALID' }));
  yes(() => assert.throws(() => consumerResult({ status: 'FAIL', code: 'raw-secret' }), { code: 'CONSUMER_RESULT_INVALID' }));
  yes(() => assert.equal(invocationMode([], { NODE_TEST_CONTEXT: 'child', CYF_CLEAN_INSTALL: '1' }), 'node-test-not-acceptance'));
  yes(() => assert.equal(invocationMode(['--selfcheck'], {}), 'selfcheck'));
  yes(() => assert.equal(invocationMode(['--describe'], {}), 'describe'));
  yes(() => assert.equal(invocationMode([], {}), 'local-fixture'));
  yes(() => assert.throws(() => invocationMode(['--unknown'], {}), { code: 'USAGE_ONLY_SELFCHECK_DESCRIBE_OR_EXPLICIT_LOCAL_FIXTURE' }));
  yes(() => assert.equal(parseInputs(env).BUILD_ID, env.CYF_CLEAN_INSTALL_BUILD_ID));
  yes(() => { const legacy = { ...env, CYF_CLEAN_INSTALL_CLOUD_RUN: 'retired-input' }; delete legacy.CYF_CLEAN_INSTALL_BUILD_ID; assert.throws(() => parseInputs(legacy), { code: 'INPUT_LEGACY_RUN_FORBIDDEN' }); });
  yes(() => assert.throws(() => parseInputs({ ...env, CYF_CLEAN_INSTALL_CLOUD_RUN: 'retired-input' }), { code: 'INPUT_LEGACY_RUN_FORBIDDEN' }));
  for (const value of [false, 7, '', 'build with space', 'build\nsecret']) yes(() => assert.throws(() => parseInputs({ ...env, CYF_CLEAN_INSTALL_BUILD_ID: value }), { code: value === '' || value === false ? 'INPUT_REQUIRED_BUILD_ID' : 'INPUT_BUILD_ID_INVALID' }));
  for (const value of ['local-host:/usr/bin/python3', 'fixed-input:node20.20.2/sha256-abc', 'https://public.example/tool']) yes(() => assert.equal(origin(value), value));
  for (const value of ['flow-input:node', 'system-image:python', 'http://public.example/tool', 'https://user:secret@public.example/tool', 'https://public.example/tool?token=private', 'local-host:', 'fixed-input:secret?token=x']) yes(() => assert.throws(() => origin(value)));
  yes(() => { const receipt = localFixtureReceipt(parseInputs(env), 'b'.repeat(64)); assert.equal(receipt.format, 'ur01-clean-target-local-fixture-v1'); assert.equal(receipt.buildId, env.CYF_CLEAN_INSTALL_BUILD_ID); assert.equal(receipt.localBackendFixtureOnly, true); assert.equal(Object.hasOwn(receipt, 'cloudRun'), false); assert.equal(Object.hasOwn(receipt.scope, 'cloudOnlyOptIn'), false); assert.equal(Object.values(receipt.acceptance).every(check => check.status === 'NOT_RUN'), true); });
  yes(() => assert.equal(describe().requiredEnvironment.includes('CYF_CLEAN_INSTALL_CLOUD_RUN'), false));
  // No directories created, no subprocesses/tools/install/npm/pip/venv invoked.
  return { staticAssertions: checks, result: 'PASS', localFixtureAcceptance: 'NOT_RUN' };
}
const direct = process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null) === SELF;
if (direct) {
  try {
    const mode = invocationMode(process.argv.slice(2), process.env);
    if (mode === 'selfcheck') console.log(JSON.stringify(selfcheck()));
    else if (mode === 'describe') console.log(JSON.stringify(describe(), null, 2));
    else if (mode === 'local-fixture') process.exitCode = await acceptance();
    else console.error(JSON.stringify({ localFixtureAcceptance: 'NOT_RUN', code: 'STANDALONE_LOCAL_FIXTURE_NOT_A_NODE_TEST',
      note: 'Node may smoke-load this module; that file result is NOT C1-C4 evidence. Use explicit *.test.mjs selectors for default tests.' }));
  } catch (error) {
    console.error(JSON.stringify({ result: 'FAIL', code: error.code || 'ASSERTION_OR_IO_FAILURE', localFixtureAcceptance: 'NOT_RUN' }));
    process.exitCode = 1;
  }
}
