// Local-script interpreter measurement: full bytes on every call, no trust cache.
import { createHash } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
const fail = () => { throw Object.assign(new Error('SKILL_LOCAL_TOOL_UNTRUSTED'), { code: 'SKILL_LOCAL_TOOL_UNTRUSTED' }) }
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'gid', 'mode', 'nlink']
const same = (a, b) => fields.every(key => a[key] === b[key])
export async function measureLocalToolFile(path) {
  const absolute = realpathSync(path), initial = lstatSync(absolute, { bigint: true })
  if (!initial.isFile() || ![0n, BigInt(process.geteuid())].includes(initial.uid) || initial.mode & 0o022n) fail()
  const parents = []
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    const stat = lstatSync(parent, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o002n) fail()
    parents.push({ path: parent, stat })
    if (dirname(parent) === parent) break
  }
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!same(initial, await file.stat({ bigint: true }))) fail()
    // Bounded buffer is an implementation detail, not a package-size limit.
    const buffer = Buffer.allocUnsafe(1024 * 1024), digest = createHash('sha256')
    let length = 0n
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      digest.update(buffer.subarray(0, bytesRead)); length += BigInt(bytesRead)
    }
    if (length !== initial.size || !same(initial, await file.stat({ bigint: true }))
        || realpathSync(path) !== absolute || !same(initial, lstatSync(absolute, { bigint: true }))) fail()
    for (const parent of parents) {
      const stat = lstatSync(parent.path, { bigint: true })
      // Parent directory contents may legitimately change; ownership, mode and
      // inode must not. Do not reject unrelated sibling-file activity.
      if (!stat.isDirectory() || ['dev', 'ino', 'uid', 'gid', 'mode'].some(key => stat[key] !== parent.stat[key])) fail()
    }
    return { path: absolute, sha256: digest.digest('hex'), dev: String(initial.dev), ino: String(initial.ino), size: String(initial.size) }
  } finally { await file.close() }
}
