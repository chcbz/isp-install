import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  CONTROLLED_IMAGE_GPT_CLI_ADAPTER,
  controlledImageGptCliConfigurationErrors,
  resolveControlledImageGptCliConfig
} from '../controlled-image-gpt-cli-config.mjs'

const sha = path => createHash('sha256').update(requireRead(path)).digest('hex')
const requireRead = path => { const fs = process.getBuiltinModule('node:fs'); return fs.readFileSync(path) }

const fixture = t => {
  const root = mkdtempSync(resolve(tmpdir(), 'controlled-cli-config-'))
  const codexDir = resolve(root, 'codex')
  const imageGen = resolve(codexDir, 'skills/.system/imagegen/scripts/image_gen.py')
  const python = resolve(root, 'python')
  const runner = resolve(codexDir, 'skills/gpt-image-cli/scripts/run.py')
  const verifier = resolve(codexDir, 'skills/gpt-image-cli/scripts/verify_images.py')
  mkdirSync(resolve(imageGen, '..'), { recursive: true, mode: 0o700 })
  mkdirSync(resolve(runner, '..'), { recursive: true, mode: 0o700 })
  for (const [path, bytes] of [[python, '#!/bin/sh\nexit 0\n'], [runner, 'runner\n'], [verifier, 'verifier\n'], [imageGen, 'imagegen\n']]) {
    writeFileSync(path, bytes, { mode: path === python ? 0o500 : 0o400 })
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = overrides => ({
    controlledImageExecutorKind: CONTROLLED_IMAGE_GPT_CLI_ADAPTER,
    controlledImageCliPython: python,
    controlledImageCliPythonSha256: sha(python),
    controlledImageCliRunner: runner,
    controlledImageCliRunnerSha256: sha(runner),
    controlledImageCliVerifier: verifier,
    controlledImageCliVerifierSha256: sha(verifier),
    controlledImageCliCodexDir: codexDir,
    controlledImageCliImageGenSha256: sha(imageGen),
    ...overrides
  })
  return { root, python, runner, verifier, imageGen, codexDir, profile }
}

test('explicit frozen Python and unmodified skill artifacts resolve as one CLI adapter', t => {
  const f = fixture(t)
  const config = resolveControlledImageGptCliConfig(f.profile())
  assert.equal(config.enabled, true)
  assert.equal(config.adapterKind, 'GPT_IMAGE_CLI_V1')
  assert.equal(config.python, f.python)
  assert.equal(config.imageGen, f.imageGen)
})

test('missing selection stays disabled while digest drift and non-file scripts fail closed', t => {
  const f = fixture(t)
  assert.deepEqual(resolveControlledImageGptCliConfig({}), { enabled: false })
  assert.throws(() => resolveControlledImageGptCliConfig(f.profile({ controlledImageCliRunnerSha256: '0'.repeat(64) })),
    error => error.code === 'CONTROLLED_IMAGE_CLI_DIGEST_MISMATCH')
  assert.throws(() => resolveControlledImageGptCliConfig(f.profile({ controlledImageCliVerifier: f.codexDir })),
    error => error.code === 'CONTROLLED_IMAGE_CLI_PATH_INVALID')
  assert.throws(() => resolveControlledImageGptCliConfig(f.profile({
    controlledImageCliRunner: f.python, controlledImageCliRunnerSha256: sha(f.python)
  })), error => error.code === 'CONTROLLED_IMAGE_CLI_PATH_INVALID')
})

test('venv symlink target is hashed but the configured invocation path is preserved', t => {
  const f = fixture(t)
  const venv = resolve(f.root, 'venv')
  const invocation = resolve(venv, 'bin/python')
  mkdirSync(resolve(venv, 'bin'), { recursive: true, mode: 0o700 })
  symlinkSync(f.python, invocation)
  const config = resolveControlledImageGptCliConfig(f.profile({
    controlledImageCliPython: invocation,
    controlledImageCliPythonSha256: sha(realpathSync(invocation))
  }))
  assert.equal(config.python, invocation)
  assert.equal(config.pythonResolved, f.python)
  assert.notEqual(config.python, config.pythonResolved)
})

test('unknown explicit adapter selection fails closed instead of becoming direct HTTP', t => {
  const f = fixture(t)
  const profile = f.profile({ controlledImageExecutorKind: 'TYPO_ADAPTER' })
  assert.deepEqual(resolveControlledImageGptCliConfig(profile), { enabled: false })
  assert.deepEqual(controlledImageGptCliConfigurationErrors(profile), ['controlledImageExecutorKind is unsupported'])
})
