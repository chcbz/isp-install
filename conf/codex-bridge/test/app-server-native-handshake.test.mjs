import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { AppServerAdapter, measureCodexAppServerBinaryAsync } from '../app-server-adapter.mjs'
import { typedDeliberationAdapterReady } from '../juyiting-typed-outcome.mjs'

// Explicit local integration probe: an empty private HOME, no credentials,
// provider/model turn, production state or shared Codex installation mutation.
test('actual configured CLI initializes without a version/schema contract', { skip: process.env.CYF_CODEX_NATIVE_HANDSHAKE !== '1' }, async t => {
  const home = mkdtempSync(resolve(tmpdir(), 'cyf-native-handshake-')); chmodSync(home, 0o700)
  const profile = { codexBin: process.env.CYF_CODEX_BIN || '/usr/local/bin/codex', codexHome: home }
  let adapter
  try {
    const measurement = await measureCodexAppServerBinaryAsync(profile)
    assert.equal(measurement.schemaContractId, null); assert.equal(measurement.bundleSha256, null)
    adapter = await AppServerAdapter.spawnAsync(profile, { cwd: home, schemaMeasurement: measurement })
    const readback = await adapter.initialize()
    assert.ok(readback.initialize); assert.equal(readback.processExecutable.measured, true)
    assert.equal(typedDeliberationAdapterReady(profile, adapter), true)
    t.diagnostic(JSON.stringify({ cliVersion: measurement.cliVersion, binarySha256: measurement.binarySha256, initialized: true, modelTurnStarted: false }))
  } finally {
    await adapter?.shutdown({ timeoutMs: 1000 })
    rmSync(home, { recursive: true, force: true })
  }
})
