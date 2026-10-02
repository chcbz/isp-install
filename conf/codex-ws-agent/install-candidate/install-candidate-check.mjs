#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeProfile } from '../agent-client.mjs'
import { buildControlledImageBountyExecutionV3Declaration } from '../controlled-image-bounty-v3-capability.mjs'
import { resolveControlledImageHttpConfig } from '../controlled-image-http-config.mjs'
import { buildNativeProviderCredentialBinding } from '../controlled-image-http-provider-binding.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, '..')
const templatePath = resolve(here, 'wuyong-dual-mode-profile.redacted.json')
const policyTemplatePath = resolve(here, 'controlled-image-api-policy.redacted.json')
const envTemplatePath = resolve(here, 'wuyong-dual-mode.env.redacted')
const evidencePath = resolve(clientRoot, 'evidence/typed-inspection-local-image-gpt-5.6-terra-1f95df2.json')

const PLACEHOLDER = /^__[A-Z0-9_]+__$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const PROVIDER_LANE = 'CONTROLLED_IMAGE_HTTP_V1'
const ACCEPTED_CA_BUNDLE_SHA256 = 'acd28b791f9f338d288efda11d7f192755d4e89f41f0f7c2999bb4d211779fe5'
const API_SOURCE_CONTRACT_COMMIT = '9ab62d6665c695a574b8b3bde9cfff3ea3ca13d4'
const PROVIDER_KEY_ENV = 'CYF_CONTROLLED_IMAGE_API_KEY'
const OWNER_KEY_ENV = 'OPENCLAW_API_KEY'
const CANDIDATE_ENV_KEYS = Object.freeze([
  'WS_URL', OWNER_KEY_ENV, PROVIDER_KEY_ENV, 'DEFAULT_CODEX_PROFILE', 'CODEX_PROFILES_FILE',
  'CODEX_WORKSPACE_POLICIES_FILE', 'COMMAND_INBOX_DIR', 'COMMAND_INBOX_SUCCESS_POLICY',
  'CYF_CONVERSATION_HTTP_POLL_ENABLED', 'CYF_CONVERSATION_IMAGEGEN_ENABLED'
])
const forbiddenPersonaBindings = new Set(['1', '2', '15'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}
const canonicalBytes = value => Buffer.from(JSON.stringify(canonical(value)), 'utf8')
const digestObject = value => `sha256:${sha256(canonicalBytes(value))}`
const fail = message => { throw new Error(message) }
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const readRegular = (path, label) => {
  let stat
  try { stat = lstatSync(path) } catch { fail(`${label}_MISSING`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label}_UNSAFE`)
  return readFileSync(path)
}
const safeRelativePath = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path)
  && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..')
const exactKeySet = (value, expected, label) => {
  if (!value || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail(`${label}_KEY_SET_MISMATCH`)
}
const exactJson = (left, right, label) => {
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) fail(`${label}_MISMATCH`)
}
const requireText = (value, label) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || PLACEHOLDER.test(value)) fail(`${label}_UNFROZEN`)
  return value
}
const policyKey = name => `agent.controlled-image-provider.operator-policies[0].${name}`
const parseCandidateEnv = (text, { allowPlaceholders = false } = {}) => {
  const values = {}
  for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) fail(`ENV_LINE_INVALID:${index + 1}`)
    if (Object.hasOwn(values, match[1])) fail(`ENV_KEY_DUPLICATE:${match[1]}`)
    values[match[1]] = match[2]
  }
  if (Object.keys(values).sort().join('\0') !== [...CANDIDATE_ENV_KEYS].sort().join('\0')) fail('ENV_KEY_SET_MISMATCH')
  for (const secret of [OWNER_KEY_ENV, PROVIDER_KEY_ENV]) {
    const value = values[secret]
    if (!value || /[\r\n\0]/.test(value) || (!allowPlaceholders && PLACEHOLDER.test(value))) fail(`ENV_SECRET_UNAVAILABLE:${secret}`)
  }
  const placeholderWs = allowPlaceholders && PLACEHOLDER.test(values.WS_URL)
  let ws = null
  if (!placeholderWs) {
    try { ws = new URL(values.WS_URL) } catch { fail('ENV_WS_URL_INVALID') }
  }
  if (!placeholderWs && (!['ws:', 'wss:'].includes(ws.protocol) || !ws.hostname || ws.username || ws.password
      || ws.search || ws.hash)) fail('ENV_WS_URL_INVALID')
  const fixed = {
    DEFAULT_CODEX_PROFILE: 'wuyong',
    CODEX_PROFILES_FILE: '/home/isp/apps/codex-ws-agent/codex-profiles.private.json',
    CODEX_WORKSPACE_POLICIES_FILE: '/home/isp/apps/codex-ws-agent/workspace-policies.json',
    COMMAND_INBOX_DIR: '/home/isp/apps/codex-ws-agent/data/inbox',
    COMMAND_INBOX_SUCCESS_POLICY: 'archive',
    CYF_CONVERSATION_HTTP_POLL_ENABLED: 'false',
    CYF_CONVERSATION_IMAGEGEN_ENABLED: 'false'
  }
  for (const [key, expected] of Object.entries(fixed)) if (values[key] !== expected) fail(`ENV_${key}_MISMATCH`)
  return Object.freeze({
    nonSecret: Object.freeze(Object.fromEntries(CANDIDATE_ENV_KEYS
      .filter(key => ![OWNER_KEY_ENV, PROVIDER_KEY_ENV].includes(key)).map(key => [key, values[key]]))),
    secretEnvironmentNames: Object.freeze([OWNER_KEY_ENV, PROVIDER_KEY_ENV])
  })
}

export const validateCandidateEnvironment = (text, options) => parseCandidateEnv(text, options)

export const TEMPLATE_REPLACEMENTS = Object.freeze({
  __EXISTING_WUYONG_AGENT_ID__: 'agt_existing_wuyong_candidate',
  __EXISTING_WUYONG_CODEX_HOME__: '/home/isp/apps/codex-ws-agent/private-homes/wuyong',
  __FROZEN_WORKSPACE_API_ORIGIN__: 'https://api.example.invalid',
  __FROZEN_CONTROLLED_IMAGE_HTTPS_ORIGIN__: 'https://images.example.invalid',
  __FROZEN_CONTROLLED_IMAGE_MODEL_ID__: 'frozen-image-model',
  __SEPARATELY_ISSUED_CONTROLLED_IMAGE_BINDING_ID__: 'controlled-binding-frozen',
  __SEPARATELY_ISSUED_CONTROLLED_IMAGE_BINDING_EPOCH__: '7',
  __EXISTING_CHCBZ_CLIENT_ID__: 'frozen-client-id',
  __EXISTING_CHCBZ_OWNER_JIACN__: 'frozen-owner',
  __FROZEN_OPERATOR_CUSTODY__: 'OWNER_EXTERNAL_ACCOUNT',
  __FROZEN_OPERATOR_ISSUER__: 'frozen-operator',
  __FROZEN_OPERATOR_POLICY_REVISION__: 'policy-revision-1',
  __FROZEN_OPERATOR_POLICY_EXPIRY_EPOCH_MS__: '4102444800000'
})

export const replaceTemplatePlaceholders = (value, replacements = TEMPLATE_REPLACEMENTS) => {
  if (Array.isArray(value)) return value.map(item => replaceTemplatePlaceholders(item, replacements))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, replaceTemplatePlaceholders(item, replacements)]))
  return typeof value === 'string' && Object.hasOwn(replacements, value) ? replacements[value] : value
}

const expectedTypedInspection = profile => {
  const evidence = readJson(evidencePath)
  return Object.freeze({
    schemaVersion: 1,
    contract: 'juyiting-typed-inspection-v1',
    enabled: true,
    profileId: evidence.profile.profileId,
    engineContractId: evidence.profile.engineContractId,
    enginePolicyDigest: evidence.profile.enginePolicyDigest,
    toolPolicyDigest: evidence.profile.toolPolicyDigest,
    inputPolicyDigest: evidence.profile.inputPolicyDigest,
    toolPolicy: 'MANIFEST_READ_ONLY',
    recovery: 'durable-inbox-turn-readback-v1',
    supportedInputs: profile.typedInspectionSupportedInputs
  })
}

const readinessFor = (profile, env) => {
  const controlledConfig = resolveControlledImageHttpConfig(profile, { env })
  const runtime = Object.freeze({
    adapterKind: PROVIDER_LANE,
    configReady: true,
    credentialReady: true,
    httpPollEnabled: true,
    controlledImageV3Ready: true,
    executor: () => {},
    pollProtocol: Object.freeze({ poll: () => {} }),
    controlledConfig
  })
  return { profile, runtime, online: true }
}

export const expectedDeclarations = (profile, env = { [PROVIDER_KEY_ENV]: 'redacted-test-credential' }) => {
  const readiness = readinessFor(profile, env)
  return Object.freeze({
    nativeProviderCredentialBinding: buildNativeProviderCredentialBinding(readiness),
    controlledImageBountyExecutionV3: buildControlledImageBountyExecutionV3Declaration(readiness),
    typedInspection: expectedTypedInspection(profile)
  })
}

const normalizedProjection = profile => Object.freeze({
  profileId: profile.profileId,
  agentId: profile.agentId,
  codexBin: profile.codexBin,
  codexHome: profile.codexHome,
  codexWorkdir: profile.codexWorkdir,
  codexSandbox: profile.codexSandbox,
  codexApproval: profile.codexApproval,
  codexSessionMode: profile.codexSessionMode,
  codexTimeoutMs: profile.codexTimeoutMs,
  chatEngine: profile.chatEngine,
  chatModel: profile.chatModel,
  chatReasoningEffort: profile.chatReasoningEffort,
  appServerEnabled: profile.appServerEnabled,
  appServerSchemaContractId: profile.appServerSchemaContractId,
  typedInspectionEnabled: profile.typedInspectionEnabled,
  typedInspectionApiOrigin: profile.typedInspectionApiOrigin,
  typedInspectionRootDir: profile.typedInspectionRootDir,
  typedInspectionStateRoot: profile.typedInspectionStateRoot,
  typedInspectionProfileId: profile.typedInspectionProfileId,
  typedInspectionEngineContractId: profile.typedInspectionEngineContractId,
  typedInspectionProviderId: profile.typedInspectionProviderId,
  typedInspectionProviderBaseUrl: profile.typedInspectionProviderBaseUrl,
  typedInspectionProviderWireApi: profile.typedInspectionProviderWireApi,
  typedInspectionProviderNetwork: profile.typedInspectionProviderNetwork,
  typedInspectionNetworkConnectTimeoutMs: profile.typedInspectionNetworkConnectTimeoutMs,
  typedInspectionCaBundlePath: profile.typedInspectionCaBundlePath,
  typedInspectionCarrierEvidencePath: profile.typedInspectionCarrierEvidencePath,
  typedInspectionCarrierEvidenceDigest: profile.typedInspectionCarrierEvidenceDigest,
  typedInspectionBwrapBin: profile.typedInspectionBwrapBin,
  typedInspectionSupportedInputs: profile.typedInspectionSupportedInputs,
  workspaceFileApiOrigin: profile.workspaceFileApiOrigin,
  workspaceFileRootDir: profile.workspaceFileRootDir,
  nativeConversationHttpPollEnabled: profile.nativeConversationHttpPollEnabled,
  nativeConversationImageGenerationEnabled: profile.nativeConversationImageGenerationEnabled,
  controlledImageHttpEnabled: profile.controlledImageHttpEnabled,
  controlledImageHttpEndpoint: profile.controlledImageHttpEndpoint,
  controlledImageHttpApiKeyEnv: profile.controlledImageHttpApiKeyEnv,
  controlledImageHttpModelId: profile.controlledImageHttpModelId,
  controlledImageHttpBindingId: profile.controlledImageHttpBindingId,
  controlledImageHttpBindingEpoch: profile.controlledImageHttpBindingEpoch,
  controlledImageHttpLedgerRoot: profile.controlledImageHttpLedgerRoot,
  enabled: profile.enabled,
  isDefault: profile.isDefault
})

export const validateCandidate = ({ rawProfile, apiPolicy, env = { [PROVIDER_KEY_ENV]: 'redacted-test-credential' } }) => {
  if (!Array.isArray(rawProfile) || rawProfile.length !== 1) fail('EXACTLY_ONE_PROFILE_REQUIRED')
  exactKeySet(rawProfile[0], Object.keys(readJson(templatePath)[0]), 'PROFILE')
  if (Object.hasOwn(rawProfile[0], 'apiKey')) fail('PROFILE_SECRET_BYTES_FORBIDDEN')
  const profile = normalizeProfile(rawProfile[0])
  if (profile.profileId !== 'wuyong') fail('EXISTING_WUYONG_PROFILE_REQUIRED')
  requireText(profile.agentId, 'EXISTING_WUYONG_AGENT_ID')
  if (profile.chatModel !== 'gpt-5.6-terra' || profile.typedInspectionProviderId !== 'gpt'
      || profile.typedInspectionProviderBaseUrl !== 'https://codex.chcbz.net/v1'
      || profile.typedInspectionProviderWireApi !== 'responses'
      || profile.typedInspectionProviderNetwork !== 'restricted-proxy'
      || profile.typedInspectionCaBundlePath !== '/etc/pki/tls/certs/ca-bundle.crt'
      || profile.typedInspectionCarrierEvidenceDigest !== 'sha256:d22de19b1b86c988c81deadb2697e5a577fdbc9abb4982ddc015fefa7fd6bdab') {
    fail('TYPED_INSPECTION_EVIDENCE_BINDING_MISMATCH')
  }
  if (profile.typedInspectionEnabled !== true || profile.appServerEnabled !== true
      || profile.nativeConversationHttpPollEnabled !== true
      || profile.nativeConversationImageGenerationEnabled !== false
      || profile.controlledImageHttpEnabled !== true) fail('REQUIRED_RUNTIME_SWITCH_MISMATCH')
  if (profile.controlledImageHttpApiKeyEnv !== PROVIDER_KEY_ENV) fail('CONTROLLED_IMAGE_SECRET_REFERENCE_MISMATCH')
  requireText(profile.controlledImageHttpEndpoint, 'CONTROLLED_IMAGE_ENDPOINT')
  requireText(profile.controlledImageHttpModelId, 'CONTROLLED_IMAGE_MODEL')
  requireText(profile.controlledImageHttpBindingId, 'CONTROLLED_IMAGE_BINDING_ID')
  requireText(profile.controlledImageHttpBindingEpoch, 'CONTROLLED_IMAGE_BINDING_EPOCH')
  if (forbiddenPersonaBindings.has(profile.controlledImageHttpBindingId)) fail('PERSONA_BINDING_REUSE_FORBIDDEN')
  const declarations = expectedDeclarations(profile, env)
  if (declarations.nativeProviderCredentialBinding.enabled !== true
      || declarations.controlledImageBountyExecutionV3.enabled !== true
      || declarations.controlledImageBountyExecutionV3.operations.length !== 2) fail('DECLARATION_NOT_READY')
  if (!apiPolicy || apiPolicy.schemaVersion !== 1 || apiPolicy.sourceContractCommit !== API_SOURCE_CONTRACT_COMMIT
      || !apiPolicy.properties) fail('API_POLICY_INVALID')
  const properties = apiPolicy.properties
  exactKeySet(properties, Object.keys(readJson(policyTemplatePath).properties), 'API_POLICY')
  for (const key of [
    'agent.controlled-image-provider.bridge-enabled', 'agent.controlled-image-provider.enabled',
    'agent.controlled-image-provider.followup-v3-enabled', 'jia.agent.conversation-execution.enabled',
    'jia.chat.service.websocket.enable', 'chat.bounty-bootstrap.enabled', 'chat.bounty-execution.enabled',
    'agent.personal-workspace-storage.enabled', 'agent.task-deliberation-operation.read-enabled',
    'agent.task-requirement-snapshot.read-enabled', 'agent.task-reference-inputs.enabled'
  ]) if (properties[key] !== true) fail(`API_POLICY_FEATURE_DISABLED:${key}`)
  const pairs = [
    ['target-agent-id', profile.agentId], ['provider-lane', PROVIDER_LANE],
    ['binding-id', profile.controlledImageHttpBindingId], ['binding-epoch', profile.controlledImageHttpBindingEpoch],
    ['model-id', profile.controlledImageHttpModelId]
  ]
  for (const [key, expected] of pairs) {
    if (String(properties[policyKey(key)]) !== String(expected)) fail(`API_POLICY_${key.toUpperCase().replaceAll('-', '_')}_MISMATCH`)
  }
  for (const key of ['client-id', 'owner-jiacn', 'custody', 'issuer', 'policy-revision', 'expires-at']) {
    requireText(String(properties[policyKey(key)] ?? ''), `API_POLICY_${key.toUpperCase().replaceAll('-', '_')}`)
  }
  if (properties[policyKey('tenant-id')] !== '0'
      || properties[policyKey('allow-unpriced-external-account')] !== true
      || properties[policyKey('max-outbound-request-attempts')] !== 1) fail('API_POLICY_FIXED_FENCE_MISMATCH')
  if (JSON.stringify(apiPolicy.forbiddenClientWireFields) !== JSON.stringify(['producerRequestRevision']))
    fail('SERVER_REVISION_AUTHORITY_NOT_FROZEN')
  return Object.freeze({ profile, projection: normalizedProjection(profile), declarations })
}

const installerPayload = installerPath => {
  const source = readRegular(installerPath, 'INSTALLER').toString('utf8')
  const match = source.match(/RELEASE_PAYLOAD=\(\n([\s\S]*?)\n\)/)
  if (!match) fail('INSTALLER_PAYLOAD_INVALID')
  const files = match[1].split('\n').map(line => {
    const item = line.match(/^\s+"([^"]+)"$/)
    if (!item || !safeRelativePath(item[1])) fail('INSTALLER_PAYLOAD_INVALID')
    return item[1]
  })
  if (files.length === 0 || new Set(files).size !== files.length) fail('INSTALLER_PAYLOAD_INVALID')
  return Object.freeze({ files: Object.freeze(files), bytes: Buffer.from(source, 'utf8') })
}

const parseManifest = (releaseDir, expectedPaths) => {
  const manifestPath = resolve(releaseDir, 'release-manifest.sha256')
  const text = readRegular(manifestPath, 'RELEASE_MANIFEST').toString('utf8')
  const files = text.trim().split('\n').map(line => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/)
    if (!match || !safeRelativePath(match[2])) fail('RELEASE_MANIFEST_INVALID')
    const actual = sha256(readRegular(resolve(releaseDir, match[2]), 'RELEASE_PAYLOAD'))
    if (actual !== match[1]) fail(`RELEASE_PAYLOAD_HASH_MISMATCH:${match[2]}`)
    return Object.freeze({ path: match[2], sha256: match[1] })
  })
  if (new Set(files.map(file => file.path)).size !== files.length) fail('RELEASE_MANIFEST_INVALID')
  exactJson(files.map(file => file.path), expectedPaths, 'RELEASE_INSTALLER_PAYLOAD')
  return Object.freeze({ files, sha256: sha256(Buffer.from(text, 'utf8')) })
}

const verifyIntegrity = releaseDir => {
  const text = readRegular(resolve(releaseDir, 'release-integrity.sha256'), 'RELEASE_INTEGRITY').toString('utf8')
  const entries = new Map()
  for (const line of text.trim().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})  (release-manifest\.sha256|release-provenance\.json)$/)
    if (!match || entries.has(match[2])) fail('RELEASE_INTEGRITY_INVALID')
    entries.set(match[2], match[1])
  }
  if (entries.size !== 2) fail('RELEASE_INTEGRITY_INVALID')
  for (const [path, expected] of entries) {
    if (sha256(readRegular(resolve(releaseDir, path), 'RELEASE_INTEGRITY_TARGET')) !== expected) fail('RELEASE_INTEGRITY_INVALID')
  }
  return sha256(Buffer.from(text, 'utf8'))
}

export const freezeCandidate = ({ rawProfile, apiPolicy, envText, releaseDir, sourceCommit, sourceTree, installerPath }) => {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '') || !/^[a-f0-9]{40}$/.test(sourceTree || '')) fail('SOURCE_IDENTITY_INVALID')
  const validated = validateCandidate({ rawProfile, apiPolicy })
  const candidateEnv = validateCandidateEnvironment(envText)
  const frozenInstallerPath = requireText(installerPath, 'INSTALLER_PATH')
  const installer = installerPayload(frozenInstallerPath)
  const manifest = parseManifest(releaseDir, installer.files)
  const provenanceBytes = readRegular(resolve(releaseDir, 'release-provenance.json'), 'RELEASE_PROVENANCE')
  const provenance = JSON.parse(provenanceBytes)
  if (provenance.sourceCommit !== sourceCommit || provenance.sourceTree !== sourceTree
      || provenance.payloadCount !== manifest.files.length || provenance.payloadManifestSha256 !== manifest.sha256) fail('RELEASE_PROVENANCE_MISMATCH')
  if (provenance.installerSha256 !== sha256(installer.bytes)) fail('INSTALLER_PROVENANCE_MISMATCH')
  const caBundleSha256 = `sha256:${sha256(readFileSync(validated.profile.typedInspectionCaBundlePath))}`
  if (caBundleSha256 !== `sha256:${ACCEPTED_CA_BUNDLE_SHA256}`) fail('CA_BUNDLE_EVIDENCE_MISMATCH')
  const evidenceBytes = readFileSync(validated.profile.typedInspectionCarrierEvidencePath)
  const evidenceSha256 = `sha256:${sha256(evidenceBytes)}`
  if (evidenceSha256 !== validated.profile.typedInspectionCarrierEvidenceDigest) fail('CARRIER_EVIDENCE_FILE_MISMATCH')
  const carrierEvidence = JSON.parse(evidenceBytes)
  if (!DIGEST.test(carrierEvidence.nativeProbeDigest || '')) fail('CARRIER_NATIVE_PROBE_DIGEST_INVALID')
  const frozen = canonical({
    schemaVersion: 1,
    source: { commit: sourceCommit, tree: sourceTree },
    installerSha256: provenance.installerSha256,
    release: {
      payloadCount: manifest.files.length,
      payloadManifestSha256: manifest.sha256,
      provenanceSha256: sha256(provenanceBytes),
      integritySha256: verifyIntegrity(releaseDir),
      payload: manifest.files
    },
    normalizedNonSecretProfile: validated.projection,
    normalizedNonSecretEnvironment: candidateEnv.nonSecret,
    secretEnvironmentNames: candidateEnv.secretEnvironmentNames,
    publicTrustAndEvidence: { caBundleSha256, carrierEvidenceSha256: evidenceSha256,
      nativeProbeDigest: carrierEvidence.nativeProbeDigest,
      carrierContractDigests: carrierEvidence.cases.map(item => item.carrierContractDigest) },
    apiPolicy: {
      sourceContractCommit: apiPolicy.sourceContractCommit,
      policyRevision: apiPolicy.properties[policyKey('policy-revision')],
      digest: digestObject(apiPolicy.properties),
      properties: apiPolicy.properties,
      forbiddenClientWireFields: apiPolicy.forbiddenClientWireFields
    },
    expectedRegistration: validated.declarations
  })
  return Object.freeze({ ...frozen, freezeDigest: digestObject(frozen) })
}

const payload = value => value?.payload && typeof value.payload === 'object' ? value.payload : value
export const verifyReadback = ({ freeze, registration, presence }) => {
  if (!freeze || freeze.freezeDigest !== digestObject(Object.fromEntries(Object.entries(freeze).filter(([key]) => key !== 'freezeDigest')))) fail('FREEZE_DIGEST_INVALID')
  const expected = freeze.expectedRegistration
  for (const [label, raw] of [['REGISTRATION', registration], ['PRESENCE', presence]]) {
    const value = payload(raw)
    if (!value || value.agentId !== freeze.normalizedNonSecretProfile.agentId) fail(`${label}_AGENT_ID_MISMATCH`)
    exactJson(value.nativeProviderCredentialBinding, expected.nativeProviderCredentialBinding, `${label}_PROVIDER_BINDING`)
    exactJson(value.controlledImageBountyExecutionV3, expected.controlledImageBountyExecutionV3, `${label}_V3`)
    exactJson(value.typedInspection, expected.typedInspection, `${label}_TYPED_INSPECTION`)
  }
  const registrationRuntime = registration.runtimeInstanceId ?? registration.payload?.runtimeInstanceId
  const presenceRuntime = presence.runtimeInstanceId ?? presence.payload?.runtimeInstanceId
  requireText(registrationRuntime, 'REGISTRATION_RUNTIME_INSTANCE_ID')
  if (registrationRuntime !== presenceRuntime) fail('READBACK_RUNTIME_INSTANCE_MISMATCH')
  return Object.freeze({ status: 'PASS', agentId: freeze.normalizedNonSecretProfile.agentId,
    runtimeInstanceId: registrationRuntime, operations: expected.controlledImageBountyExecutionV3.operations.map(item => item.operation) })
}

export const verifyRedactedTemplates = () => {
  const rawProfile = replaceTemplatePlaceholders(readJson(templatePath))
  const apiPolicy = replaceTemplatePlaceholders(readJson(policyTemplatePath))
  const result = validateCandidate({ rawProfile, apiPolicy })
  const envText = readFileSync(envTemplatePath, 'utf8')
  const candidateEnv = validateCandidateEnvironment(envText, { allowPlaceholders: true })
  if (!envText.includes(`${OWNER_KEY_ENV}=__`) || !envText.includes(`${PROVIDER_KEY_ENV}=__`)
      || /(?:sk-|Bearer\s+)[A-Za-z0-9_-]{8,}/.test(envText)) fail('ENV_TEMPLATE_SECRET_LEAK')
  return Object.freeze({ status: 'PASS', profile: result.projection, declarations: result.declarations,
    apiPolicyDigest: digestObject(apiPolicy.properties), secretEnvironmentNames: candidateEnv.secretEnvironmentNames })
}

const option = (args, name) => {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) fail(`MISSING_OPTION:${name}`)
  return args[index + 1]
}

const main = () => {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'verify-template') {
    console.log(JSON.stringify(verifyRedactedTemplates(), null, 2)); return
  }
  if (command === 'freeze') {
    const profile = readJson(option(args, '--profile'))
    const policy = readJson(option(args, '--api-policy'))
    const envText = readFileSync(option(args, '--env-file'), 'utf8')
    const frozen = freezeCandidate({ rawProfile: profile, apiPolicy: policy, envText, releaseDir: resolve(option(args, '--release')),
      sourceCommit: option(args, '--source-commit'), sourceTree: option(args, '--source-tree'),
      installerPath: resolve(option(args, '--installer')) })
    const output = option(args, '--output'); writeFileSync(output, `${JSON.stringify(frozen, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ status: 'PASS', output, freezeDigest: frozen.freezeDigest }))
    return
  }
  if (command === 'readback') {
    const result = verifyReadback({ freeze: readJson(option(args, '--freeze')),
      registration: readJson(option(args, '--registration')), presence: readJson(option(args, '--presence')) })
    console.log(JSON.stringify(result, null, 2)); return
  }
  fail('usage: install-candidate-check.mjs verify-template | freeze --profile FILE --env-file FILE --api-policy FILE --release DIR --installer FILE --source-commit SHA --source-tree SHA --output NEW_FILE | readback --freeze FILE --registration FILE --presence FILE')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
