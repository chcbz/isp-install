/** Browser dependencies are fixed, shared, per-file read-only mounts (RB-03/05).
 * Optional browser failure must not remove the existing document/image tools. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateNativeExecutionToolchain } from './native-execution-profile.mjs'
const root = fileURLToPath(new URL('.', import.meta.url))
export const BROWSER_ROOT = '/usr/lib/cyf-browser'
export const BROWSER_PROBE = `${BROWSER_ROOT}/browser-probe.mjs`
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function measureNativeBrowserToolchain({ base, browserRoot = resolve(root, '.browser-toolchain/chromium'), playwrightRoot = resolve(root, '.browser-toolchain/node_modules/playwright-core'), fontsRoot = resolve(root, '.browser-toolchain/fonts'), scriptsRoot = resolve(root, 'toolchain') }) {
  const files = [...base.files]
  const pin = (sourcePath, sandboxPath) => {
    const source = realpathSync(sourcePath)
    files.push({ sourcePath: source, sandboxPath, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') })
  }
  const libraries = []
  const walk = (source, target) => {
    for (const item of readdirSync(source, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = resolve(source, item.name), dest = `${target}/${item.name}`
      if (item.isDirectory()) walk(path, dest)
      else if (item.isFile()) { pin(path, dest); if (/\.so(?:\.|$)/.test(item.name)) libraries.push(path) }
      else fail('NATIVE_BROWSER_TOOLCHAIN_UNSAFE')
    }
  }
  if (!lstatSync(resolve(browserRoot, 'chrome-headless-shell')).isFile()) fail('NATIVE_BROWSER_EXECUTABLE_REQUIRED')
  walk(browserRoot, `${BROWSER_ROOT}/chromium`)
  walk(playwrightRoot, `${BROWSER_ROOT}/playwright`)
  walk(fontsRoot, `${BROWSER_ROOT}/fonts`)
  for (const name of ['browser-session.mjs', 'browser-probe.mjs', 'browser-fonts.conf']) pin(resolve(scriptsRoot, name), `${BROWSER_ROOT}/${name}`)
  pin(resolve(scriptsRoot, 'browser/README.md'), `${BROWSER_ROOT}/README.md`)
  // Verify ownership/parents/hash before executing ldd against the fixed binaries.
  validateNativeExecutionToolchain({ shell: base.shell, files })
  const binaries = [resolve(browserRoot, 'chrome-headless-shell'), ...libraries]
  let nssModulesAdded = false
  for (const path of binaries) {
    const measured = spawnSync('/usr/bin/ldd', [path], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    if (measured.status !== 0 || measured.error || /not found/.test(measured.stdout)) fail('NATIVE_BROWSER_DEPENDENCIES_UNAVAILABLE')
    for (const library of measured.stdout.match(/\/[^\s()]+/g) || []) {
      const target = library.startsWith(browserRoot + '/') ? `${BROWSER_ROOT}/chromium/${library.slice(browserRoot.length + 1)}` : library
      if (!files.some(file => file.sandboxPath === target)) pin(library, target)
      // NSS loads its software crypto modules dynamically, outside ELF DT_NEEDED.
      // They are part of the browser TLS dependency closure, not host profiles.
      if (!nssModulesAdded && library.endsWith('/libnss3.so')) {
        nssModulesAdded = true
        for (const name of ['libsoftokn3.so', 'libfreeblpriv3.so']) {
          const modulePath = resolve(dirname(library), name)
          if (!files.some(file => file.sandboxPath === modulePath)) pin(modulePath, modulePath)
          binaries.push(modulePath)
        }
        validateNativeExecutionToolchain({ shell: base.shell, files })
      }
    }
  }
  return validateNativeExecutionToolchain({ shell: base.shell, files })
}
