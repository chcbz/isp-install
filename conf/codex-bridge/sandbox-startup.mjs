// bwrap owns this extra pipe; app-server's protocol remains on stdin/stdout.
// --unshare-all keeps bwrap's PID-namespace reaper alive for the sandbox lifetime.
const failure = code => Object.assign(new Error(code), { code })
export function observeSandboxStartup(child) {
  const stream = child?.stdio?.[3]
  if (!stream) throw failure('TYPED_INSPECTION_SANDBOX_INFO_PIPE_REQUIRED')
  const startup = new Promise((resolve, reject) => {
    let text = ''; let settled = false
    const cleanup = () => {
      stream.off('data', data); stream.off('end', end); stream.off('close', closed); stream.off('error', failed)
      child.off('exit', lost); child.off('error', failed)
    }
    const finish = (error, value) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(value) }
    const data = chunk => { text += chunk.toString('utf8') }
    const failed = error => finish(error)
    const lost = () => finish(failure('TYPED_INSPECTION_EGRESS_OWNER_LOST'))
    const closed = () => finish(failure('TYPED_INSPECTION_SANDBOX_INFO_INCOMPLETE'))
    const end = () => {
      try {
        const info = JSON.parse(text)
        if (!Number.isSafeInteger(info['child-pid']) || info['child-pid'] <= 0 ||
            !Number.isSafeInteger(info['net-namespace']) || info['net-namespace'] <= 0) throw failure('TYPED_INSPECTION_SANDBOX_INFO_INVALID')
        finish(null, Object.freeze({ pid: info['child-pid'], netNamespaceIno: String(info['net-namespace']) }))
      } catch { finish(failure('TYPED_INSPECTION_SANDBOX_INFO_INVALID')) }
    }
    stream.on('data', data); stream.once('end', end); stream.once('close', closed); stream.once('error', failed)
    child.once('exit', lost); child.once('error', failed)
    if (child.exitCode !== null) lost()
  })
  // The pipe may fail before the async binary measurement's caller awaits it.
  // Keep the rejection available to every consumer without an unhandled rejection.
  startup.catch(() => {})
  Object.defineProperty(child, 'sandboxStartup', { value: startup })
  return child
}

export async function waitForSandboxStartup(child, signal) {
  if (!child?.sandboxStartup) throw failure('TYPED_INSPECTION_SANDBOX_INFO_PIPE_REQUIRED')
  if (signal?.aborted) throw failure('TYPED_INSPECTION_EGRESS_CANCELLED')
  if (!signal) return child.sandboxStartup
  let aborted
  try {
    return await Promise.race([child.sandboxStartup, new Promise((_, reject) => {
      aborted = () => reject(failure('TYPED_INSPECTION_EGRESS_CANCELLED'))
      signal.addEventListener('abort', aborted, { once: true })
    })])
  } finally { signal.removeEventListener('abort', aborted) }
}
