// One serialized worker for expensive measurements; no transport/credentials or
// request processing live here. The main thread keeps serving proxies/heartbeats.
import { parentPort } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { measureCodexAppServerBinary, verifyCodexAppServerBinaryIdentity, binaryVerificationState } from './app-server-adapter.mjs'
parentPort.on('message', ({ id, operation, profile, measurement, environment, expected }) => {
  try {
    let result = measurement
    if (operation === 'measure') result = measureCodexAppServerBinary(profile, { ...(expected ? { expected } : {}), ...(environment ? { spawnSyncFn: (bin, args, options) => spawnSync(bin, args, { ...options, env: environment }) } : {}) })
    else if (operation === 'verify') verifyCodexAppServerBinaryIdentity(profile, measurement)
    else throw new Error('UNKNOWN_BINARY_INTEGRITY_OPERATION')
    parentPort.postMessage({ id, result: { ...result, snapshotPath: result.snapshotPath }, verification: binaryVerificationState(result) })
  } catch (error) { parentPort.postMessage({ id, error: { message: error.message, code: error.code, trustReason: error.trustReason } }) }
})
