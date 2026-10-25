import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { AppServerAdapter, measureCodexAppServerBinaryAsync } from '../app-server-adapter.mjs'

test('worker measurement yields; exact measured state can spawn; same-size/mtime tampering fails closed', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-integrity-worker-')); chmodSync(root, 0o700)
  try {
    const bundle = '{"fixture":"worker"}\n'; const expected = { cliVersion: 'worker-test', bundleSha256: createHash('sha256').update(bundle).digest('hex') }
    mkdirSync(resolve(root, 'bin'), { mode: 0o700 }); mkdirSync(resolve(root, 'codex-resources'), { mode: 0o700 })
    const resource = resolve(root, 'codex-resources', 'helper'); writeFileSync(resource, 'trusted', { mode: 0o400 })
    const bin = resolve(root, 'bin', 'codex')
    const program = `#!/usr/bin/env node\nconst fs=require('fs'),p=require('path');if(process.argv[2]==='--version'){process.stdout.write('codex-cli worker-test\\n');process.exit(0)}const i=process.argv.indexOf('--out');fs.writeFileSync(p.join(process.argv[i+1],'codex_app_server_protocol.schemas.json'),${JSON.stringify(bundle)});\n`
    writeFileSync(bin, program, { mode: 0o700 }); const profile = { codexBin: bin, codexHome: root }
    const companion = resolve(root, 'bin', 'codex-code-mode-host'); writeFileSync(companion, '#!/bin/sh\necho companion-ok\n', { mode: 0o700 })
    let ticks = 0; const interval = setInterval(() => ticks++, 1)
    let measurement
    try { measurement = await measureCodexAppServerBinaryAsync(profile, { expected }) } finally { clearInterval(interval) }
    assert.ok(ticks > 0); assert.equal(measurement.measured, true)
    assert.equal(Object.keys(measurement).includes('snapshotPath'), false)
    const copiedCompanion = resolve(measurement.snapshotPath, '..', 'codex-code-mode-host')
    assert.equal(spawnSync(copiedCompanion, [], { encoding: 'utf8' }).stdout.trim(), 'companion-ok')
    assert.notEqual(statSync(companion).ino, statSync(copiedCompanion).ino)
    let spawned = 0
    const spawnFn = () => { spawned++; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null; return child }
    await assert.rejects(AppServerAdapter.spawnAsync(profile, { schemaMeasurement: measurement, spawnFn, shouldSpawn: () => false }), error => error.code === 'APP_SERVER_START_CANCELLED')
    assert.equal(spawned, 0)
    await AppServerAdapter.spawnAsync(profile, { schemaMeasurement: measurement, spawnFn }); assert.equal(spawned, 1)
    const helperBefore = statSync(companion); writeFileSync(companion, '#!/bin/sh\necho companion-no\n'); utimesSync(companion, helperBefore.atime, helperBefore.mtime)
    await assert.rejects(AppServerAdapter.spawnAsync(profile, { schemaMeasurement: measurement, spawnFn }), error => error.code === 'APP_SERVER_BINARY_UNTRUSTED' && error.trustReason === 'CODEX_APP_SERVER_COMPANION_DRIFT')
    assert.equal(spawned, 1)
    writeFileSync(companion, '#!/bin/sh\necho companion-ok\n')
    const resourceBefore = statSync(resource); chmodSync(resource, 0o600); writeFileSync(resource, 'changed'); chmodSync(resource, 0o400); utimesSync(resource, resourceBefore.atime, resourceBefore.mtime)
    await assert.rejects(AppServerAdapter.spawnAsync(profile, { schemaMeasurement: measurement, spawnFn }), error => error.code === 'APP_SERVER_BINARY_UNTRUSTED' && error.trustReason === 'CODEX_APP_SERVER_RESOURCE_DRIFT')
    assert.equal(spawned, 1)
    chmodSync(resource, 0o600); writeFileSync(resource, 'trusted'); chmodSync(resource, 0o400)
    const before = statSync(bin); writeFileSync(bin, program.replace('worker-test', 'broken-test')); utimesSync(bin, before.atime, before.mtime)
    await assert.rejects(AppServerAdapter.spawnAsync(profile, { schemaMeasurement: measurement, spawnFn }), error => error.code === 'APP_SERVER_BINARY_UNTRUSTED')
    assert.equal(spawned, 1)
    await assert.rejects(measureCodexAppServerBinaryAsync({ codexBin: resolve(root, 'missing'), codexHome: root }), error => error.code === 'APP_SERVER_BINARY_UNTRUSTED')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
