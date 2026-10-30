import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeBrowserLaunchOptions } from '../toolchain/browser-session.mjs'
import { measureNativeBrowserToolchain } from '../native-browser-toolchain.mjs'
test('browser uses fixed binary, pipe transport, sandbox and existing proxy without loopback bypass', () => {
  const options = nativeBrowserLaunchOptions('http://10.0.2.2:1234')
  assert.equal(options.executablePath, '/usr/lib/cyf-browser/chromium/chrome-headless-shell')
  assert.equal(options.chromiumSandbox, true)
  assert.equal(options.env.FONTCONFIG_FILE, '/usr/lib/cyf-browser/browser-fonts.conf')
  assert.deepEqual(options.proxy, { server: 'http://10.0.2.2:1234', bypass: '<-loopback>' })
  assert.ok(!options.args.some(value => /remote-debugging-port|ignore-certificate|no-sandbox/.test(value)))
  assert.equal(Object.hasOwn(options, 'userDataDir'), false)
})
test('local browser probe does not invent network authorization or disable TLS verification', () => {
  const options = nativeBrowserLaunchOptions('')
  assert.equal(Object.hasOwn(options, 'proxy'), false)
  for (const proxy of ['https://host:1234', 'http://user:secret@host', 'http://host/path', 'http://host/?secret']) {
    assert.throws(() => nativeBrowserLaunchOptions(proxy), /NATIVE_BROWSER_PROXY_INVALID/)
  }
})
test('missing browser artifact is not an available browser toolchain', () => {
  assert.throws(() => measureNativeBrowserToolchain({ base: { files: [] }, browserRoot: '/nonexistent/cyf-browser' }), { code: 'ENOENT' })
})

// Low-cost target namespace probe. The artifact's fixed browser/SDK must be
// supplied explicitly; skipping this is not browser production acceptance.
test('real browser reads, clicks, fills, uploads, downloads and isolates contexts inside native mounts', { skip: !process.env.CYF_NATIVE_BROWSER_PROBE_ROOT }, async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const { measureMinimalNativeExecutionToolchain, prepareNativeExecutionLayout, nativeExecutionMountArgs } = await import('../native-execution-profile.mjs')
  const { BROWSER_PROBE } = await import('../native-browser-toolchain.mjs')
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-browser-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mkdir = path => { mkdirSync(path, { mode: 0o700 }); return path }
  const toolchainRoot = process.env.CYF_NATIVE_BROWSER_PROBE_ROOT
  const scriptsRoot = mkdir(resolve(root, 'probe-tools'))
  for (const name of ['browser-session.mjs', 'browser-probe.mjs', 'browser-fonts.conf']) copyFileSync(new URL(`../toolchain/${name}`, import.meta.url), resolve(scriptsRoot, name))
  mkdir(resolve(scriptsRoot, 'browser'))
  copyFileSync(new URL('../toolchain/browser/README.md', import.meta.url), resolve(scriptsRoot, 'browser/README.md'))
  const toolchain = measureNativeBrowserToolchain({ base: measureMinimalNativeExecutionToolchain({ nodeBin: process.execPath }),
    scriptsRoot, fontsRoot: resolve(toolchainRoot, 'fonts'), browserRoot: resolve(toolchainRoot, 'chromium'), playwrightRoot: resolve(toolchainRoot, 'node_modules/playwright-core') })
  const execution = mkdir(resolve(root, 'execution')), stateRoot = mkdir(resolve(root, 'state'))
  const options = { inputDirectory: mkdir(resolve(execution, 'inputs')), scratchDirectory: mkdir(resolve(execution, 'scratch')), draftsDirectory: mkdir(resolve(execution, 'drafts')),
    stateRoot, sourceHome: mkdir(resolve(root, 'private-home')), skills: [], toolchain,
    nativeExecution: { executionId: 'browser-probe', tools: [], checkActive() {}, callTool() {} } }
  writeFileSync(resolve(options.inputDirectory, 'probe.txt'), 'native-browser-input', { mode: 0o600 })
  const engineState = { codexHome: mkdir(resolve(stateRoot, 'codex-home')) }
  writeFileSync(resolve(engineState.codexHome, 'config.toml'), '', { mode: 0o600 })
  const layout = prepareNativeExecutionLayout(options)
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/inputs', '--ro-bind', options.inputDirectory, '/inputs',
    ...nativeExecutionMountArgs({ layout, engineState, neutralDirectory: mkdir(resolve(root, 'neutral')), skillsDirectory: mkdir(resolve(root, 'skills')) }),
    '--setenv', 'HOME', '/state/home', '--setenv', 'TMPDIR', '/workspace', '--unsetenv', 'HTTP_PROXY', '--unsetenv', 'HTTPS_PROXY', '--chdir', '/execution', '/usr/bin/node', BROWSER_PROBE]
  const probe = spawnSync('/usr/bin/bwrap', args, { encoding: 'utf8', env: { LANG: 'C.UTF-8', ...(process.env.DEBUG ? { DEBUG: process.env.DEBUG } : {}) } })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout.trim(), 'native-browser-ready')
  assert.equal(readFileSync(resolve(options.inputDirectory, 'probe.txt'), 'utf8'), 'native-browser-input')
  assert.equal(readFileSync(resolve(options.draftsDirectory, 'browser-probe.txt'), 'utf8'), 'native-browser-download')
  assert.equal(readFileSync(resolve(options.draftsDirectory, 'browser-probe.png')).subarray(0,8).toString('hex'), '89504e470d0a1a0a')
})
