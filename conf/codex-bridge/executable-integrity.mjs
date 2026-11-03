import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'

// No path-only/TTL cache. A new PID can map the same unchanged executable;
// ctime and permissions remain part of its identity, not merely size/mtime.
export const fileStamp = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid'].map(key => String(stat[key])).join(':')
export const createExecutableInspector = ({ cacheResults = true, openFile = open } = {}) => {
  // The ordinary launch uses two executables (wrapper and engine). Keep only
  // their recent digests, never file bytes or an ever-growing list of PID paths.
  // Eviction only causes a fresh measurement; it never rejects an executable.
  const cache = new Map(), pending = new Map()
  return async path => {
    const fd = await openFile(path, 'r')
    let ownedMeasurement = null, stamp
    try {
      const before = await fd.stat({ bigint: true })
      if (!before.isFile()) throw new Error('EXECUTABLE_NOT_REGULAR')
      stamp = fileStamp(before)
      let digest = cacheResults ? cache.get(stamp) : null
      if (!digest) {
        let measurement = cacheResults ? pending.get(stamp) : null
        if (!measurement) {
          measurement = (async () => {
            const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0
            while (BigInt(offset) < before.size) {
              const { bytesRead } = await fd.read(buffer, 0, Number(before.size - BigInt(offset) > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - BigInt(offset)), offset)
              if (!bytesRead) throw new Error('EXECUTABLE_TRUNCATED')
              hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
            }
            if (fileStamp(await fd.stat({ bigint: true })) !== stamp) throw new Error('EXECUTABLE_DRIFT')
            return { stamp, sha256: `sha256:${hash.digest('hex')}` }
          })()
          if (cacheResults) { ownedMeasurement = measurement; pending.set(stamp, measurement) }
        }
        digest = await measurement
      }
      if (fileStamp(await fd.stat({ bigint: true })) !== stamp) throw new Error('EXECUTABLE_DRIFT')
      // Reopen after await boundaries: neither a cached digest nor an open fd
      // proves that this caller's /proc/PID/exe still maps the measured file.
      const current = await openFile(path, 'r')
      try { if (fileStamp(await current.stat({ bigint: true })) !== stamp) throw new Error('EXECUTABLE_DRIFT') } finally { await current.close() }
      if (cacheResults) {
        cache.delete(stamp); cache.set(stamp, digest)
        while (cache.size > 2) cache.delete(cache.keys().next().value)
      }
      return { dev: String(before.dev), ino: String(before.ino), size: String(before.size), stamp, sha256: digest.sha256 }
    } finally {
      if (ownedMeasurement && pending.get(stamp) === ownedMeasurement) pending.delete(stamp)
      await fd.close()
    }
  }
}

// Both egress ownership and App Server readback use the same content evidence.
// Their independent process/namespace/binding checks are intentionally retained.
export const inspectExecutable = createExecutableInspector()
