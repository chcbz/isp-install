import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const CONTROLLED_IMAGE_GPT_CLI_ADAPTER = 'GPT_IMAGE_CLI_V1'
const SHA256 = /^[a-f0-9]{64}$/
const text = value => typeof value === 'string' ? value : ''

export class ControlledImageGptCliConfigError extends Error {
  constructor (code, message) { super(message); this.name = 'ControlledImageGptCliConfigError'; this.code = code }
}

const fail = (code, message) => { throw new ControlledImageGptCliConfigError(code, message) }
const digestFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const resolveFrozenFile = (value, expectedDigest, { executable = false, preserveConfiguredPath = false, label }) => {
  if (!value || value !== value.trim() || !isAbsolute(value) || resolve(value) !== value || !SHA256.test(expectedDigest || '')) {
    fail('CONTROLLED_IMAGE_CLI_PATH_INVALID', `${label} path and digest must be explicit`)
  }
  let path
  try { path = realpathSync(value) } catch { fail('CONTROLLED_IMAGE_CLI_PATH_INVALID', `${label} is unavailable`) }
  const info = statSync(path)
  if (!info.isFile()) fail('CONTROLLED_IMAGE_CLI_PATH_UNSAFE', `${label} must resolve to a regular file`)
  if (executable) {
    try { accessSync(path, fsConstants.X_OK) } catch { fail('CONTROLLED_IMAGE_CLI_PATH_UNSAFE', `${label} is not executable`) }
  }
  if (digestFile(path) !== expectedDigest) fail('CONTROLLED_IMAGE_CLI_DIGEST_MISMATCH', `${label} digest does not match the operator declaration`)
  return Object.freeze({ path: preserveConfiguredPath ? resolve(value) : path, resolvedPath: path })
}

const resolveFrozenDirectory = (value, label) => {
  if (!value || value !== value.trim() || !isAbsolute(value) || resolve(value) !== value) fail('CONTROLLED_IMAGE_CLI_PATH_INVALID', `${label} must be canonical and absolute`)
  let path
  try { path = realpathSync(value) } catch { fail('CONTROLLED_IMAGE_CLI_PATH_INVALID', `${label} is unavailable`) }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('CONTROLLED_IMAGE_CLI_PATH_UNSAFE', `${label} must be a real directory`)
  }
  return path
}

export const normalizeControlledImageGptCliProfile = (profile = {}, fallback = {}) => Object.freeze({
  controlledImageExecutorKind: text(profile.controlledImageExecutorKind ?? fallback.controlledImageExecutorKind),
  controlledImageCliPython: text(profile.controlledImageCliPython ?? fallback.controlledImageCliPython),
  controlledImageCliPythonSha256: text(profile.controlledImageCliPythonSha256 ?? fallback.controlledImageCliPythonSha256),
  controlledImageCliRunner: text(profile.controlledImageCliRunner ?? fallback.controlledImageCliRunner),
  controlledImageCliRunnerSha256: text(profile.controlledImageCliRunnerSha256 ?? fallback.controlledImageCliRunnerSha256),
  controlledImageCliVerifier: text(profile.controlledImageCliVerifier ?? fallback.controlledImageCliVerifier),
  controlledImageCliVerifierSha256: text(profile.controlledImageCliVerifierSha256 ?? fallback.controlledImageCliVerifierSha256),
  controlledImageCliCodexDir: text(profile.controlledImageCliCodexDir ?? fallback.controlledImageCliCodexDir),
  controlledImageCliImageGenSha256: text(profile.controlledImageCliImageGenSha256 ?? fallback.controlledImageCliImageGenSha256)
})

export const resolveControlledImageGptCliConfig = profile => {
  const normalized = normalizeControlledImageGptCliProfile(profile)
  if (normalized.controlledImageExecutorKind !== CONTROLLED_IMAGE_GPT_CLI_ADAPTER) return Object.freeze({ enabled: false })
  const python = resolveFrozenFile(normalized.controlledImageCliPython, normalized.controlledImageCliPythonSha256,
    { executable: true, preserveConfiguredPath: true, label: 'controlled image CLI Python' })
  const codexDir = resolveFrozenDirectory(normalized.controlledImageCliCodexDir, 'controlled image CLI Codex root')
  const expectedRunner = resolve(codexDir, 'skills/gpt-image-cli/scripts/run.py')
  const expectedVerifier = resolve(codexDir, 'skills/gpt-image-cli/scripts/verify_images.py')
  if (normalized.controlledImageCliRunner !== expectedRunner || normalized.controlledImageCliVerifier !== expectedVerifier) {
    fail('CONTROLLED_IMAGE_CLI_PATH_INVALID', 'controlled image CLI runner and verifier must belong to the frozen Codex root')
  }
  const runner = resolveFrozenFile(normalized.controlledImageCliRunner, normalized.controlledImageCliRunnerSha256,
    { label: 'controlled image CLI runner' })
  const verifier = resolveFrozenFile(normalized.controlledImageCliVerifier, normalized.controlledImageCliVerifierSha256,
    { label: 'controlled image CLI verifier' })
  const imageGen = resolveFrozenFile(resolve(codexDir, 'skills/.system/imagegen/scripts/image_gen.py'),
    normalized.controlledImageCliImageGenSha256, { label: 'controlled image bundled image CLI' })
  return Object.freeze({
    enabled: true,
    adapterKind: CONTROLLED_IMAGE_GPT_CLI_ADAPTER,
    python: python.path,
    pythonResolved: python.resolvedPath,
    pythonSha256: normalized.controlledImageCliPythonSha256,
    runner: runner.path,
    runnerSha256: normalized.controlledImageCliRunnerSha256,
    verifier: verifier.path,
    verifierSha256: normalized.controlledImageCliVerifierSha256,
    codexDir,
    imageGen: imageGen.path,
    imageGenSha256: normalized.controlledImageCliImageGenSha256
  })
}

export const controlledImageGptCliConfigurationErrors = profile => {
  const kind = normalizeControlledImageGptCliProfile(profile).controlledImageExecutorKind
  if (!kind || kind === 'CONTROLLED_IMAGE_HTTP_V1') return []
  if (kind !== CONTROLLED_IMAGE_GPT_CLI_ADAPTER) return ['controlledImageExecutorKind is unsupported']
  try { resolveControlledImageGptCliConfig(profile); return [] } catch (error) {
    return [error instanceof ControlledImageGptCliConfigError ? error.message : 'controlled image GPT CLI configuration is invalid']
  }
}
