import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeToolchainInitializer } from '../native-document-toolchain.mjs'

const tools = () => Object.freeze({ shell: '/bin/bash', files: Object.freeze([]) })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

test('concurrent subjects share one measurement and one immutable manifest, not subject state', async () => {
  const gate = deferred(); let scans = 0, guards = 0
  const initialize = createNativeToolchainInitializer({ measure: () => { scans++; return gate.promise }, verify: value => { guards++; return value }, identity: () => 'same-install' })
  const a = {}, b = {}, manifest = tools()
  const pa = initialize(a), again = initialize(a), pb = initialize(b)
  gate.resolve({ toolchain: manifest, browserFailure: 'OPTIONAL_MISSING' })
  assert.deepEqual(await Promise.all([pa, again, pb]), [manifest, manifest, manifest])
  assert.equal(scans, 1); assert.equal(guards, 2)
  assert.notEqual(a.nativeBrowserMeasurementFailure, b.nativeBrowserMeasurementFailure)
  a.nativeBrowserMeasurementFailure.code = 'SUBJECT_FAILURE'
  assert.equal(b.nativeBrowserMeasurementFailure.code, 'OPTIONAL_MISSING')
  assert.equal(await initialize({}), manifest); assert.equal(scans, 1)
  assert.equal(await initialize(a), manifest); assert.equal(scans, 1)
})

test('disposed subject neither starts work nor cancels a live subject sharing discovery', async () => {
  const gate = deferred(); let scans = 0
  const initialize = createNativeToolchainInitializer({ measure: () => { scans++; return gate.promise }, verify: value => value, identity: () => 'same' })
  assert.equal(await initialize({ disposed: true }), null); assert.equal(scans, 0)
  const a = {}, b = {}; const pa = initialize(a), pb = initialize(b); a.disposed = true
  const manifest = tools(); gate.resolve({ toolchain: manifest })
  assert.equal(await pa, null); assert.equal(await pb, manifest); assert.equal(a.nativeToolchain, undefined); assert.equal(scans, 1)
})

test('failed discovery is shared but does not poison explicit later initialization', async () => {
  const gate = deferred(); let scans = 0
  const initialize = createNativeToolchainInitializer({ measure: () => { scans++; return scans === 1 ? gate.promise : { toolchain: tools() } }, verify: value => value, identity: () => 'same' })
  const a = {}, b = {}; const results = Promise.allSettled([initialize(a), initialize(b)])
  gate.reject(Object.assign(new Error('measurement'), { code: 'TEST_FAILURE' }))
  assert.ok((await results).every(x => x.status === 'rejected')); assert.equal(scans, 1)
  assert.equal(a.nativeToolchainPending, null); assert.equal(b.nativeToolchainPending, null)
  assert.ok(await initialize(a)); assert.equal(scans, 2)
})

test('metadata drift prevents reuse; no active subject manifest is replaced', async () => {
  let drift = false, scans = 0
  const initialize = createNativeToolchainInitializer({ measure: () => { scans++; return { toolchain: tools() } }, verify: value => { if (drift) throw Error('drift'); return value }, identity: () => 'same' })
  const a = {}; const original = await initialize(a); drift = true
  await assert.rejects(initialize({}), /drift/); assert.equal(scans, 1); assert.equal(a.nativeToolchain, original)
  drift = false; const newer = await initialize({}); assert.equal(scans, 2); assert.notEqual(newer, original)
})

test('identity changes cannot attach an old in-flight measurement or grow an identity cache', async () => {
  let identity = 'first', scans = 0; const gate = deferred()
  const initialize = createNativeToolchainInitializer({ measure: () => { scans++; return scans === 1 ? gate.promise : { toolchain: tools() } }, verify: value => value, identity: () => identity })
  const first = initialize({}); await Promise.resolve(); identity = 'second'; gate.resolve({ toolchain: tools() })
  await assert.rejects(first, { code: 'NATIVE_EXECUTION_TOOLCHAIN_IDENTITY_CHANGED' })
  await initialize({}); assert.equal(scans, 2)
  identity = 'first'; await initialize({}); assert.equal(scans, 3)
})
