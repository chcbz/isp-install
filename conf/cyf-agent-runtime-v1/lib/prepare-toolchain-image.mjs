// Installation-only layout preparation. No downloads, compilation, activation,
// credentials or request-time copies. Consume the already verified toolchain.
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const bridge = resolve(dirname(fileURLToPath(import.meta.url)), '../../codex-bridge')
const profile = await import(pathToFileURL(resolve(bridge, 'native-execution-profile.mjs')))
const fail = code => { throw Object.assign(new Error(code), { code }) }

export function prepareToolchainImage({ directory, toolchain, documentFailure, browserFailure }) {
  const fixed = profile.validateNativeExecutionToolchain(toolchain)
  const parent = dirname(directory)
  if (resolve(directory) !== directory || realpathSync(parent) !== parent) fail('NATIVE_TOOLCHAIN_IMAGE_DESTINATION_UNSAFE')
  const stat = lstatSync(parent)
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || stat.mode & 0o022) fail('NATIVE_TOOLCHAIN_IMAGE_DESTINATION_UNSAFE')
  // Claim only our destination atomically; never overwrite/adopt a prior image.
  // Failed preparation removes only this exclusively created directory.
  try { mkdirSync(directory, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') fail('NATIVE_TOOLCHAIN_IMAGE_EXISTS'); throw error }
  try {
    const root = resolve(directory, 'rootfs'); mkdirSync(root, { mode: 0o755 })
    for (const file of fixed.files) {
      const target = `${root}${file.sandboxPath}`
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
      copyFileSync(file.sourcePath, target, constants.COPYFILE_EXCL)
      chmodSync(target, lstatSync(file.sourcePath).mode & 0o777)
    }
    const manifest = { schemaVersion: 1, shell: fixed.shell,
      files: fixed.files.map(({ sandboxPath, sha256 }) => ({ sandboxPath, sha256 })),
      ...(documentFailure ? { documentFailure } : {}), ...(browserFailure ? { browserFailure } : {}) }
    writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o644 })
    // Verify actual copied bytes/closure, not source hashes applied to a receipt.
    const result = profile.validateNativeExecutionToolchain(profile.readNativeToolchainImage(directory).toolchain)
    chmodSync(directory, 0o755)
    return { files: result.files.length, mounts: profile.nativeToolchainMountArgs(result).filter(arg => arg === '--ro-bind').length,
      manifestSha256: createHash('sha256').update(readFileSync(resolve(directory, 'manifest.json'))).digest('hex') }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}

export async function prepareInstalledToolchain(root) {
  if (resolve(root) !== root || realpathSync(root) !== root || resolve(bridge) !== resolve(root, 'codex-bridge')) fail('NATIVE_TOOLCHAIN_INSTALL_ROOT_INVALID')
  // The existing release owner holds its lock and verifies fixed Run artifacts
  // before this step. Host ELF dependencies are measured on the target host,
  // not substituted with the build worker's libc or downloaded here.
  const { measureNativeDocumentToolchain } = await import(pathToFileURL(resolve(bridge, 'native-document-toolchain.mjs')))
  const { measureNativeBrowserToolchain } = await import(pathToFileURL(resolve(bridge, 'native-browser-toolchain.mjs')))
  let toolchain = profile.measureMinimalNativeExecutionToolchain({ nodeBin: resolve(root, 'node/bin/node') })
  let documentFailure, browserFailure
  if (existsSync(resolve(bridge, '.toolchain'))) toolchain = measureNativeDocumentToolchain({ base: toolchain })
  else documentFailure = 'NATIVE_DOCUMENT_TOOLCHAIN_UNAVAILABLE'
  if (existsSync(resolve(bridge, '.browser-toolchain'))) toolchain = measureNativeBrowserToolchain({ base: toolchain })
  else browserFailure = 'NATIVE_BROWSER_TOOLCHAIN_UNAVAILABLE'
  return prepareToolchainImage({ directory: resolve(bridge, '.sandbox-toolchain'), toolchain, documentFailure, browserFailure })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--root') fail('USAGE_PREPARE_TOOLCHAIN_IMAGE_ROOT')
  console.log(JSON.stringify(await prepareInstalledToolchain(process.argv[3])))
}
