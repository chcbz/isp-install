import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createNativeExecutionRuntime, ensureNativeExecutionProfile, normalizeProfile, publishMeasuredRuntimeCapabilities } from '../agent-client.mjs'
import { NativeExecutionProfileRuntime, nativeExecutionProfile } from '../native-execution-runtime.mjs'
import { TypedInspectionProfileRuntime } from '../typed-inspection-profile.mjs'
import { IsolatedEngineProfileRuntime } from '../isolated-engine-profile.mjs'

const provider = { typedInspectionProviderId: 'operator-provider', typedInspectionProviderBaseUrl: 'https://example.invalid/v1', typedInspectionProviderNetwork: 'restricted-proxy', typedInspectionNetworkConnectTimeoutMs: 3000 }
const profile = { ...provider, profileId: 'native-only', workspaceFileApiOrigin: 'https://api.invalid', workspaceFileRootDir: '/private/subject-a/files' }
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('native-only profile needs no input carriers/materializer and derived roots stay subject-private', () => {
  class Capture { constructor(options) { Object.assign(this, options) } }
  const a = createNativeExecutionRuntime(profile, { scopeDirectory: 'a', Runtime: Capture })
  assert.equal(a.profile.inputCarriers, undefined)
  assert.equal(a.materializerRoot, '/private/subject-a/files/.native-runtime/a/probes')
  assert.equal(a.stateRoot, '/private/subject-a/files/.native-runtime/a/state')
  const b = createNativeExecutionRuntime({ ...profile, workspaceFileRootDir: '/private/subject-b/files' }, { scopeDirectory: 'b', Runtime: Capture })
  assert.notEqual(a.stateRoot, b.stateRoot)
  assert.equal(createNativeExecutionRuntime({ ...profile, workspaceFileApiOrigin: '' }, { scopeDirectory: 'a', Runtime: Capture }), null)
  const legacy = createNativeExecutionRuntime({ ...profile, typedInspectionRootDir: '/private/inputs', typedInspectionStateRoot: '/private/states' }, { scopeDirectory: 'a', Runtime: Capture })
  assert.equal(legacy.stateRoot, resolve('/private/states', 'a')) // preserve existing recovery binding
  assert.equal(legacy.materializerRoot, '/private/inputs/a')
})

test('owners share isolation code, not measurement or execution responsibilities', () => {
  assert.equal(Object.getPrototypeOf(NativeExecutionProfileRuntime.prototype), IsolatedEngineProfileRuntime.prototype)
  assert.equal(Object.getPrototypeOf(TypedInspectionProfileRuntime.prototype), IsolatedEngineProfileRuntime.prototype)
  assert.equal(TypedInspectionProfileRuntime.prototype.openNativeExecutionAdapter, undefined)
  assert.equal(TypedInspectionProfileRuntime.prototype.nativeExecutionDeclaration, undefined)
  assert.equal(NativeExecutionProfileRuntime.prototype.measure, undefined)
  assert.equal(NativeExecutionProfileRuntime.prototype.openAdapter, undefined)
})

test('explicit native provider is normalized without mixing partial overrides with legacy config', () => {
  const legacy = nativeExecutionProfile(profile)
  assert.equal(legacy.typedInspectionProviderId, provider.typedInspectionProviderId)
  assert.deepEqual(legacy.typedInspectionSupportedInputs, [])
  const explicit = normalizeProfile({ ...profile, nativeExecutionProviderId: ' native ', nativeExecutionProviderBaseUrl: 'https://native.invalid/v1', nativeExecutionNetworkConnectTimeoutMs: 2000 }, {}, 0, { isolated: true })
  const native = nativeExecutionProfile(explicit)
  assert.equal(native.typedInspectionProviderId, 'native')
  assert.equal(native.typedInspectionProviderBaseUrl, 'https://native.invalid/v1')
  assert.equal(native.typedInspectionNetworkConnectTimeoutMs, 2000)
  assert.equal(nativeExecutionProfile({ ...profile, nativeExecutionProviderId: 'partial' }).typedInspectionProviderBaseUrl, undefined)
})

test('absent/failed materials do not suppress native measurement; startup single-flights the same owner', async () => {
  const wait = gate(); let initialized = 0, measured = 0, published = 0
  const runtime = { async measureNativeExecution() { measured++; await wait.promise; return { executionProtocolVersion: 5 } } }
  const state = { profile, typedInspectionProfileRuntime: null, typedInspectionProfileFailure: new Error('materials failed'), nativeExecutionProfileRuntime: runtime }
  const options = { initializeToolchain: async owner => { assert.equal(owner, runtime); initialized++ }, publish: (_, current) => { assert.equal(current.nativeExecutionProfileRuntime, runtime); published++ } }
  const first = ensureNativeExecutionProfile(state, options)
  assert.equal(ensureNativeExecutionProfile(state, options), first)
  wait.resolve()
  assert.deepEqual(await first, { executionProtocolVersion: 5 })
  assert.equal(initialized, 1); assert.equal(measured, 1); assert.equal(published, 1)
})

test('missing provider never starts probes or fabricates readiness; native failure leaves inspection untouched', async () => {
  let initialized = 0; const inspection = { declaration: () => ({ supportedInputs: ['text'] }) }
  const state = { profile: { ...profile, nativeExecutionProviderId: 'incomplete' }, typedInspectionProfileRuntime: inspection, nativeExecutionProfileRuntime: { measureNativeExecution() { assert.fail('no authorized provider') } } }
  assert.equal(await ensureNativeExecutionProfile(state, { initializeToolchain: async () => { initialized++ }, publish() {} }), null)
  assert.equal(initialized, 0)
  assert.equal(state.nativeExecutionProfileFailure.code, 'NATIVE_EXECUTION_PROVIDER_CONFIG_REQUIRED')
  assert.deepEqual(inspection.declaration(), { supportedInputs: ['text'] })
})

test('shutdown fences pending initialization and suppresses late capability refresh', async () => {
  const wait = gate(); let measured = 0, published = 0
  const state = { profile, nativeExecutionProfileRuntime: { measureNativeExecution() { measured++; return {} } } }
  const pending = ensureNativeExecutionProfile(state, { initializeToolchain: () => wait.promise, publish() { published++ } })
  await Promise.resolve(); state.profileClosing = true; wait.resolve()
  assert.equal(await pending, null)
  assert.equal(measured, 0); assert.equal(published, 0)
  assert.equal(await ensureNativeExecutionProfile(state), null)
  assert.equal(publishMeasuredRuntimeCapabilities({ runtimeIdentity: {} }, { ...state, runtimeTransport: { refreshCapabilities() { assert.fail('closed owner') } } }), false)
})

test('disposed native owner withdraws cached declaration and settles in-flight measurement', async () => {
  const wait = gate(); const runtime = Object.create(NativeExecutionProfileRuntime.prototype)
  Object.assign(runtime, { _measureNativeExecution: () => wait.promise, activeAdapters: new Map() })
  const pending = runtime.measureNativeExecution()
  const closed = runtime.dispose()
  wait.resolve({ executionProtocolVersion: 5 })
  await closed
  assert.equal(await pending, null)
  assert.equal(runtime.nativeExecutionDeclaration(), null)
  assert.equal(await runtime.measureNativeExecution(), null)
})
