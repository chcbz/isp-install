import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

import {
  freezeCandidate,
  replaceTemplatePlaceholders,
  validateCandidate,
  validateCandidateEnvironment,
  verifyReadback,
  verifyRedactedTemplates
} from '../install-candidate/install-candidate-check.mjs'

const clientRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(clientRoot, '..', '..')
const installerPath = resolve(repositoryRoot, 'shell/codex_ws_agent_install.sh')
const profileTemplate = resolve(clientRoot, 'install-candidate/wuyong-dual-mode-profile.redacted.json')
const policyTemplate = resolve(clientRoot, 'install-candidate/controlled-image-api-policy.redacted.json')
const evidencePath = resolve(clientRoot, 'evidence/typed-inspection-local-image-gpt-5.6-terra-1f95df2.json')
const envTemplate = resolve(clientRoot, 'install-candidate/wuyong-dual-mode.env.redacted')
const sourceCommit = 'a'.repeat(40)
const sourceTree = 'b'.repeat(40)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const clone = value => structuredClone(value)
const releasePayload = (() => {
  const source = readFileSync(installerPath, 'utf8')
  const match = source.match(/RELEASE_PAYLOAD=\(\n([\s\S]*?)\n\)/)
  assert.ok(match)
  return match[1].split('\n').map(line => line.match(/^\s+"([^"]+)"$/)[1])
})()

const candidateEnv = () => readFileSync(envTemplate, 'utf8')
  .replace('__FROZEN_AGENT_WEBSOCKET_URL__', 'wss://api.example.invalid/ws/agent/channel')
  .replace('__EXISTING_CHCBZ_OWNER_WEBSOCKET_API_KEY_SECRET__', 'owner-secret-not-frozen')
  .replace('__FROZEN_CONTROLLED_IMAGE_PROVIDER_API_KEY_SECRET__', 'provider-secret-not-frozen')

const candidate = () => {
  const rawProfile = replaceTemplatePlaceholders(readJson(profileTemplate))
  rawProfile[0].typedInspectionCarrierEvidencePath = evidencePath
  const apiPolicy = replaceTemplatePlaceholders(readJson(policyTemplate))
  return { rawProfile, apiPolicy }
}

const operatorPolicyProjection = apiPolicy => {
  const key = name => `agent.controlled-image-provider.operator-policies[0].${name}`
  const properties = apiPolicy.properties
  return {
    tenantId: properties[key('tenant-id')], clientId: properties[key('client-id')],
    ownerJiacn: properties[key('owner-jiacn')], targetAgentId: properties[key('target-agent-id')],
    providerLane: properties[key('provider-lane')], bindingId: properties[key('binding-id')],
    bindingEpoch: String(properties[key('binding-epoch')]), modelId: properties[key('model-id')],
    custody: properties[key('custody')], issuer: properties[key('issuer')],
    policyRevision: properties[key('policy-revision')], expiresAt: String(properties[key('expires-at')]),
    allowUnpricedExternalAccount: properties[key('allow-unpriced-external-account')],
    maxOutboundRequestAttempts: properties[key('max-outbound-request-attempts')]
  }
}

const writeOperatorBindingFreeze = (root, apiPolicy, mutate = value => value) => {
  const sourceReference = 'operator-freeze/wuyong-controlled-image-policy-r1'
  const document = mutate({
    schemaVersion: 1,
    artifactType: 'CONTROLLED_IMAGE_OPERATOR_BINDING_FREEZE_V1',
    sourceContractCommit: '9ab62d6665c695a574b8b3bde9cfff3ea3ca13d4',
    sourceReference,
    operatorPolicy: operatorPolicyProjection(apiPolicy)
  })
  const path = resolve(root, 'operator-binding-freeze.json')
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  writeFileSync(path, bytes)
  Object.assign(apiPolicy.providerBindingEvidence, {
    status: 'VERIFIED',
    sourceType: 'API_OPERATOR_POLICY_FREEZE_FILE',
    sourceReference,
    sourceDigest: `sha256:${sha256(bytes)}`
  })
  return path
}

const writeRelease = root => {
  mkdirSync(root, { recursive: true })
  const manifest = releasePayload.map(relative => {
    const path = resolve(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `fixture:${relative}\n`)
    return `${sha256(readFileSync(path))}  ${relative}`
  }).join('\n') + '\n'
  writeFileSync(resolve(root, 'release-manifest.sha256'), manifest)
  const provenance = {
    schemaVersion: 1,
    artifact: 'codex-ws-agent-release',
    sourceCommit,
    sourceTree,
    payloadCount: releasePayload.length,
    payloadManifest: 'release-manifest.sha256',
    payloadManifestSha256: sha256(Buffer.from(manifest)),
    installerSha256: sha256(readFileSync(installerPath))
  }
  writeFileSync(resolve(root, 'release-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  const integrity = [
    `${sha256(readFileSync(resolve(root, 'release-manifest.sha256')))}  release-manifest.sha256`,
    `${sha256(readFileSync(resolve(root, 'release-provenance.json')))}  release-provenance.json`
  ].join('\n') + '\n'
  writeFileSync(resolve(root, 'release-integrity.sha256'), integrity)
}

const frozenFixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-install-candidate-'))
  const release = resolve(root, 'release')
  writeRelease(release)
  const { rawProfile, apiPolicy } = candidate()
  const freeze = freezeCandidate({ rawProfile, apiPolicy, envText: candidateEnv(), releaseDir: release, sourceCommit, sourceTree, installerPath })
  return { root, freeze, rawProfile, apiPolicy, envText: candidateEnv() }
}

test('redacted templates are static-valid synthetic projections without secrets or readiness claims', () => {
  const verified = verifyRedactedTemplates()
  assert.equal(verified.status, 'STATIC_VALID')
  assert.equal(verified.projectionKind, 'SYNTHETIC_EXPECTED_REGISTRATION')
  assert.equal(verified.fullInstallationReadiness, false)
  assert.equal(verified.providerBindingEvidenceStatus, 'UNVERIFIED')
  assert.equal(verified.profile.profileId, 'wuyong')
  assert.equal(verified.syntheticExpectedDeclarations.typedInspection.enabled, true)
  assert.equal(verified.syntheticExpectedDeclarations.nativeProviderCredentialBinding.enabled, true)
  assert.deepEqual(verified.syntheticExpectedDeclarations.controlledImageBountyExecutionV3.operations.map(value => value.operation), [
    'GENERATE_IMAGE', 'EDIT_IMAGE'
  ])
  assert.equal(JSON.stringify(verified.syntheticExpectedDeclarations).includes('producerRequestRevision'), false)
  const env = readFileSync(resolve(clientRoot, 'install-candidate/wuyong-dual-mode.env.redacted'), 'utf8')
  assert.match(env, /^OPENCLAW_API_KEY=__/m)
  assert.match(env, /^CYF_CONTROLLED_IMAGE_API_KEY=__/m)
  assert.equal(env.includes('sk-'), false)
  assert.equal(validateCandidateEnvironment(candidateEnv()).nonSecret.DEFAULT_CODEX_PROFILE, 'wuyong')
  assert.throws(() => validateCandidateEnvironment(`${candidateEnv()}UNKNOWN_SECRET=value\n`), /ENV_KEY_SET_MISMATCH/)
  assert.throws(() => validateCandidateEnvironment(candidateEnv().replace('owner-secret-not-frozen', '__OWNER_SECRET__')), /ENV_SECRET_UNAVAILABLE/)
})

test('binding identity is platform-operator fenced and independent freeze evidence fails closed', async t => {
  for (const bindingId of ['1', '2', '15']) {
    await t.test(`numeric binding ${bindingId} is not rejected across namespaces`, () => {
      const { rawProfile, apiPolicy } = candidate()
      rawProfile[0].controlledImageHttpBindingId = bindingId
      apiPolicy.properties['agent.controlled-image-provider.operator-policies[0].binding-id'] = bindingId
      apiPolicy.providerBindingEvidence.bindingId = bindingId
      const result = validateCandidate({ rawProfile, apiPolicy })
      assert.equal(result.validationStatus, 'STATIC_VALID')
      assert.equal(result.providerBindingEvidenceStatus, 'UNVERIFIED')
    })
  }
  await t.test('arbitrary non-empty receipt labels cannot become VERIFIED', () => {
    const { rawProfile, apiPolicy } = candidate()
    Object.assign(apiPolicy.providerBindingEvidence, {
      status: 'VERIFIED',
      sourceType: 'API_OPERATOR_PROVIDER_BINDING_RECEIPT',
      sourceReference: 'private-receipt/provider-binding-7',
      sourceDigest: `sha256:${'7'.repeat(64)}`
    })
    assert.throws(() => validateCandidate({ rawProfile, apiPolicy }), /PROVIDER_BINDING_SOURCE_TYPE_INVALID/)
  })
  await t.test('VERIFIED requires the actual independent Operator freeze file', () => {
    const { rawProfile, apiPolicy } = candidate()
    Object.assign(apiPolicy.providerBindingEvidence, {
      status: 'VERIFIED', sourceType: 'API_OPERATOR_POLICY_FREEZE_FILE',
      sourceReference: 'operator-freeze/wuyong-controlled-image-policy-r1',
      sourceDigest: `sha256:${'7'.repeat(64)}`
    })
    assert.throws(() => validateCandidate({ rawProfile, apiPolicy }), /PROVIDER_BINDING_OPERATOR_FREEZE_REQUIRED/)
  })
  await t.test('exact Operator freeze bytes and tuple can be VERIFIED', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'cyf-operator-freeze-'))
    try {
      const { rawProfile, apiPolicy } = candidate()
      const path = writeOperatorBindingFreeze(root, apiPolicy)
      const result = validateCandidate({ rawProfile, apiPolicy, operatorBindingFreezePath: path })
      assert.equal(result.providerBindingEvidenceStatus, 'VERIFIED')
      assert.deepEqual(result.operatorBindingEvidence, {
        status: 'VERIFIED', sourceType: 'API_OPERATOR_POLICY_FREEZE_FILE',
        sourceReference: 'operator-freeze/wuyong-controlled-image-policy-r1',
        sourceDigest: apiPolicy.providerBindingEvidence.sourceDigest
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  await t.test('Operator freeze byte digest drift fails closed', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'cyf-operator-freeze-'))
    try {
      const { rawProfile, apiPolicy } = candidate()
      const path = writeOperatorBindingFreeze(root, apiPolicy)
      apiPolicy.providerBindingEvidence.sourceDigest = `sha256:${'7'.repeat(64)}`
      assert.throws(() => validateCandidate({ rawProfile, apiPolicy, operatorBindingFreezePath: path }),
        /PROVIDER_BINDING_SOURCE_DIGEST_MISMATCH/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  await t.test('Operator freeze source reference drift fails closed', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'cyf-operator-freeze-'))
    try {
      const { rawProfile, apiPolicy } = candidate()
      const path = writeOperatorBindingFreeze(root, apiPolicy)
      apiPolicy.providerBindingEvidence.sourceReference = 'operator-freeze/different-policy'
      assert.throws(() => validateCandidate({ rawProfile, apiPolicy, operatorBindingFreezePath: path }),
        /PROVIDER_BINDING_OPERATOR_FREEZE_INVALID/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  await t.test('Operator freeze tuple drift fails closed', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'cyf-operator-freeze-'))
    try {
      const { rawProfile, apiPolicy } = candidate()
      const path = writeOperatorBindingFreeze(root, apiPolicy, value => {
        value.operatorPolicy.bindingEpoch = '8'; return value
      })
      assert.throws(() => validateCandidate({ rawProfile, apiPolicy, operatorBindingFreezePath: path }),
        /PROVIDER_BINDING_OPERATOR_POLICY_MISMATCH/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  await t.test('UNVERIFIED binding cannot carry pseudo-source evidence', () => {
    const { rawProfile, apiPolicy } = candidate()
    apiPolicy.providerBindingEvidence.sourceType = 'persona-binding-row'
    assert.throws(() => validateCandidate({ rawProfile, apiPolicy }), /PROVIDER_BINDING_UNVERIFIED_SOURCE_INVALID/)
  })
  await t.test('provider binding evidence tuple drift', () => {
    const { rawProfile, apiPolicy } = candidate()
    apiPolicy.providerBindingEvidence.bindingEpoch = '8'
    assert.throws(() => validateCandidate({ rawProfile, apiPolicy }), /PROVIDER_BINDING_EVIDENCE_TUPLE_MISMATCH/)
  })
  await t.test('model drift', () => {
    const { rawProfile, apiPolicy } = candidate()
    apiPolicy.properties['agent.controlled-image-provider.operator-policies[0].model-id'] = 'different-model'
    assert.throws(() => validateCandidate({ rawProfile, apiPolicy }), /API_POLICY_MODEL_ID_MISMATCH/)
  })
  await t.test('binding epoch drift', () => {
    const { rawProfile, apiPolicy } = candidate()
    apiPolicy.properties['agent.controlled-image-provider.operator-policies[0].binding-epoch'] = '8'
    assert.throws(() => validateCandidate({ rawProfile, apiPolicy }), /API_POLICY_BINDING_EPOCH_MISMATCH/)
  })
  await t.test('API source contract drift', () => {
    const { rawProfile, apiPolicy } = candidate()
    apiPolicy.sourceContractCommit = 'c'.repeat(40)
    assert.throws(() => validateCandidate({ rawProfile, apiPolicy }), /API_POLICY_INVALID/)
  })
})

test('freeze is stable across release roots and binds source, payload, CA, evidence, and policy without runtime entropy', () => {
  const roots = [mkdtempSync(resolve(tmpdir(), 'cyf-freeze-a-')), mkdtempSync(resolve(tmpdir(), 'cyf-freeze-b-'))]
  try {
    const { rawProfile, apiPolicy } = candidate()
    const freezes = roots.map(root => {
      const release = resolve(root, 'random-release-root')
      writeRelease(release)
      return freezeCandidate({ rawProfile, apiPolicy, envText: candidateEnv(), releaseDir: release, sourceCommit, sourceTree, installerPath })
    })
    assert.deepEqual(freezes[0], freezes[1])
    const freeze = freezes[0]
    assert.equal(freeze.validation.status, 'STATIC_VALID')
    assert.equal(freeze.validation.projectionKind, 'SYNTHETIC_EXPECTED_REGISTRATION')
    assert.equal(freeze.validation.providerBindingEvidenceStatus, 'UNVERIFIED')
    assert.equal(freeze.validation.fullInstallationReadiness, false)
    assert.equal(freeze.source.commit, sourceCommit)
    assert.equal(freeze.source.tree, sourceTree)
    assert.equal(freeze.publicTrustAndEvidence.caBundleSha256, 'sha256:acd28b791f9f338d288efda11d7f192755d4e89f41f0f7c2999bb4d211779fe5')
    assert.equal(freeze.publicTrustAndEvidence.carrierEvidenceSha256, 'sha256:d22de19b1b86c988c81deadb2697e5a577fdbc9abb4982ddc015fefa7fd6bdab')
    assert.equal(freeze.apiPolicy.sourceContractCommit, '9ab62d6665c695a574b8b3bde9cfff3ea3ca13d4')
    assert.equal(freeze.release.payload.length, 55)
    assert.deepEqual(freeze.secretEnvironmentNames, ['OPENCLAW_API_KEY', 'CYF_CONTROLLED_IMAGE_API_KEY'])
    assert.equal(freeze.normalizedNonSecretEnvironment.DEFAULT_CODEX_PROFILE, 'wuyong')
    assert.equal(freeze.normalizedNonSecretEnvironment.WS_URL, 'wss://api.example.invalid/ws/agent/channel')
    const serialized = JSON.stringify(freeze)
    for (const root of roots) assert.equal(serialized.includes(root), false)
    for (const unstable of ['runtimeInstanceId', 'processId', 'randomPort', 'nftCounter', 'turnId']) {
      assert.equal(serialized.includes(unstable), false)
    }
    assert.equal(serialized.includes('redacted-test-credential'), false)
    assert.equal(serialized.includes('owner-secret-not-frozen'), false)
    assert.equal(serialized.includes('provider-secret-not-frozen'), false)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
})

test('freeze binds verified independent Operator evidence without persisting its private path', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cyf-verified-freeze-'))
  try {
    const release = resolve(root, 'release')
    writeRelease(release)
    const { rawProfile, apiPolicy } = candidate()
    const operatorBindingFreezePath = writeOperatorBindingFreeze(root, apiPolicy)
    const freeze = freezeCandidate({ rawProfile, apiPolicy, operatorBindingFreezePath,
      envText: candidateEnv(), releaseDir: release, sourceCommit, sourceTree, installerPath })
    assert.equal(freeze.validation.status, 'STATIC_VALID')
    assert.equal(freeze.validation.providerBindingEvidenceStatus, 'VERIFIED')
    assert.deepEqual(freeze.apiPolicy.operatorBindingEvidence, {
      status: 'VERIFIED', sourceType: 'API_OPERATOR_POLICY_FREEZE_FILE',
      sourceReference: 'operator-freeze/wuyong-controlled-image-policy-r1',
      sourceDigest: apiPolicy.providerBindingEvidence.sourceDigest
    })
    assert.equal(JSON.stringify(freeze).includes(operatorBindingFreezePath), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readback accepts one exact live registration/presence pair and fails closed on drift', () => {
  const fixture = frozenFixture()
  try {
    const payload = {
      agentId: fixture.freeze.normalizedNonSecretProfile.agentId,
      ...clone(fixture.freeze.syntheticExpectedRegistration)
    }
    const registration = { runtimeInstanceId: 'runtime-frozen-1', payload: clone(payload) }
    const presence = { runtimeInstanceId: 'runtime-frozen-1', payload: clone(payload) }
    assert.deepEqual(verifyReadback({ freeze: fixture.freeze, registration, presence }), {
      status: 'READBACK_MATCH',
      providerBindingEvidenceStatus: 'UNVERIFIED',
      agentId: fixture.freeze.normalizedNonSecretProfile.agentId,
      runtimeInstanceId: 'runtime-frozen-1',
      operations: ['GENERATE_IMAGE', 'EDIT_IMAGE']
    })
    const drift = clone(presence)
    drift.payload.controlledImageBountyExecutionV3.operations = drift.payload.controlledImageBountyExecutionV3.operations.slice(0, 1)
    assert.throws(() => verifyReadback({ freeze: fixture.freeze, registration, presence: drift }), /PRESENCE_V3_MISMATCH/)
    const otherProcess = clone(presence)
    otherProcess.runtimeInstanceId = 'runtime-frozen-2'
    assert.throws(() => verifyReadback({ freeze: fixture.freeze, registration, presence: otherProcess }), /READBACK_RUNTIME_INSTANCE_MISMATCH/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('freeze rejects installer and payload drift', async t => {
  const fixture = frozenFixture()
  try {
    await t.test('installer drift', () => {
      const differentInstaller = resolve(fixture.root, 'installer.sh')
      writeFileSync(differentInstaller, `${readFileSync(installerPath, 'utf8')}\n# digest drift\n`)
      assert.throws(() => freezeCandidate({ rawProfile: fixture.rawProfile, apiPolicy: fixture.apiPolicy,
        envText: fixture.envText, releaseDir: resolve(fixture.root, 'release'), sourceCommit, sourceTree, installerPath: differentInstaller }), /INSTALLER_PROVENANCE_MISMATCH/)
    })
    await t.test('payload drift', () => {
      writeFileSync(resolve(fixture.root, 'release/agent-client.mjs'), 'tampered\n')
      assert.throws(() => freezeCandidate({ rawProfile: fixture.rawProfile, apiPolicy: fixture.apiPolicy,
        envText: fixture.envText, releaseDir: resolve(fixture.root, 'release'), sourceCommit, sourceTree, installerPath }), /RELEASE_PAYLOAD_HASH_MISMATCH/)
    })
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
