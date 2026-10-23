import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'

// No path-only/TTL cache: executable bytes are reused only while all kernel
// metadata, including ctime, is unchanged. Each call still opens the actual path.
export const fileStamp = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid'].map(key => String(stat[key])).join(':')
export const createExecutableInspector = ({ cacheResults = true } = {}) => {
  // One entry per observed path (PID reuse replaces, never trusts an old stamp).
  const cache = new Map()
  return async path => {
    const fd = await open(path, 'r')
    try {
      const before = await fd.stat({ bigint: true })
      if (!before.isFile()) throw new Error('EXECUTABLE_NOT_REGULAR')
      const stamp = fileStamp(before); let digest = cacheResults ? cache.get(path) : null
      if (digest?.stamp !== stamp) {
        const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0
        while (BigInt(offset) < before.size) {
          const { bytesRead } = await fd.read(buffer, 0, Number(before.size - BigInt(offset) > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - BigInt(offset)), offset)
          if (!bytesRead) throw new Error('EXECUTABLE_TRUNCATED')
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
        }
        digest = { stamp, sha256: `sha256:${hash.digest('hex')}` }
      }
      if (fileStamp(await fd.stat({ bigint: true })) !== stamp) throw new Error('EXECUTABLE_DRIFT')
      // Reopen after the await boundaries: a cached fd is not proof the current
      // /proc/PID/exe (or lexical path) still resolves to this inode/content.
      const current = await open(path, 'r')
      try { if (fileStamp(await current.stat({ bigint: true })) !== stamp) throw new Error('EXECUTABLE_DRIFT') } finally { await current.close() }
      if (cacheResults) cache.set(path, digest)
      return { dev: String(before.dev), ino: String(before.ino), size: String(before.size), stamp, sha256: digest.sha256 }
    } finally { await fd.close() }
  }
}
