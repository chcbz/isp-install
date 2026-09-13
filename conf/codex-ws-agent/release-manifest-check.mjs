import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASE_VERSION = /^1\.1\.0-m4\.20260913\.1$/
const SHA256 = /^[0-9a-f]{64}$/
const SAFE_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.[A-Za-z0-9][A-Za-z0-9._-]*)$/
const EXPECTED_FILES = Object.freeze([
  ['agent-client.mjs', 'agent-client.mjs', '0644'],
  ['work-item-lease.mjs', 'work-item-lease.mjs', '0644'],
  ['task-context-pack.mjs', 'task-context-pack.mjs', '0644'],
  ['registration-ack.mjs', 'registration-ack.mjs', '0644'],
  ['skill-install-manager.mjs', 'skill-install-manager.mjs', '0644'],
  ['managed-host.mjs', 'managed-host.mjs', '0644'],
  ['workspace-manager.mjs', 'workspace-manager.mjs', '0644'],
  ['install-policy-check.mjs', 'install-policy-check.mjs', '0644'],
  ['release-manifest-check.mjs', 'release-manifest-check.mjs', '0644'],
  ['package.json', 'package.json', '0644'],
  ['package-lock.json', 'package-lock.json', '0644'],
  ['README.md', 'README.md', '0644'],
  ['env.example', '.env.example', '0644'],
  ['codex-home.example.toml', 'codex-home.example.toml', '0644'],
  ['workspace-policies.example.json', 'workspace-policies.example.json', '0640']
])

const fail = message => { throw new Error(`RELEASE_MANIFEST_INVALID: ${message}`) }
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const readRegular = (path, expectedMode = null) => {
  const status = lstatSync(path)
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) fail(`unsafe release file ${path}`)
  if (expectedMode !== null && (status.mode & 0o777) !== Number.parseInt(expectedMode, 8)) {
    fail(`mode mismatch for ${path}`)
  }
  return readFileSync(path)
}

export const verifyReleaseManifest = ({ root, layout = 'source' }) => {
  if (!['source', 'release'].includes(layout)) fail('layout must be source or release')
  const manifestPath = resolve(root, 'release-manifest.json')
  let manifest
  try { manifest = JSON.parse(readRegular(manifestPath).toString('utf8')) } catch (error) {
    if (String(error?.message || '').startsWith('RELEASE_MANIFEST_INVALID:')) throw error
    fail('manifest is unavailable or malformed')
  }
  if (!exactKeys(manifest, ['schemaVersion', 'releaseVersion', 'files'])
      || manifest.schemaVersion !== 1 || !RELEASE_VERSION.test(manifest.releaseVersion)
      || !Array.isArray(manifest.files) || manifest.files.length !== EXPECTED_FILES.length) {
    fail('manifest envelope or release version differs from the frozen candidate')
  }
  const packageJson = JSON.parse(readRegular(resolve(root, layout === 'source' ? 'package.json' : 'package.json'),
    layout === 'release' ? '0644' : null).toString('utf8'))
  if (packageJson.version !== manifest.releaseVersion) fail('package version does not match releaseVersion')

  const observed = new Set()
  for (let index = 0; index < EXPECTED_FILES.length; index += 1) {
    const [source, target, mode] = EXPECTED_FILES[index]
    const entry = manifest.files[index]
    if (!exactKeys(entry, ['source', 'target', 'mode', 'sha256'])
        || entry.source !== source || entry.target !== target || entry.mode !== mode
        || !SAFE_NAME.test(entry.source) || !SAFE_NAME.test(entry.target) || !SHA256.test(entry.sha256)
        || observed.has(entry.target)) {
      fail(`file catalog mismatch at index ${index}`)
    }
    observed.add(entry.target)
    const selected = layout === 'source' ? entry.source : entry.target
    let bytes
    try { bytes = readRegular(resolve(root, selected), layout === 'release' ? entry.mode : null) } catch (error) {
      if (String(error?.message || '').startsWith('RELEASE_MANIFEST_INVALID:')) throw error
      fail(`required release file unavailable: ${selected}`)
    }
    if (hash(bytes) !== entry.sha256) fail(`digest mismatch for ${selected}`)
  }
  return Object.freeze({ releaseVersion: manifest.releaseVersion, fileCount: manifest.files.length,
    manifestSha256: hash(readRegular(manifestPath)) })
}

const args = process.argv.slice(2)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let layout = 'source'
  if (args.length === 2 && args[0] === '--layout') layout = args[1]
  else if (args.length !== 0) fail('usage: release-manifest-check.mjs [--layout source|release]')
  const result = verifyReleaseManifest({ root: process.cwd(), layout })
  console.log(`release manifest valid | version=${result.releaseVersion} | files=${result.fileCount} | sha256=${result.manifestSha256}`)
}
