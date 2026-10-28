/** Copy one untrusted sandbox output to a private, not-yet-published snapshot.
 * Linux /proc/self/fd anchors each lookup to its opened parent directory.
 * Caller owns the destination directory and is responsible for publishing,
 * binding the snapshot to the execution, and cleaning the returned file. */
import { constants, closeSync, fstatSync, fsyncSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

const fail = code => { throw Object.assign(new Error(code), { code }) }

export function snapshotNativeArtifact({ draftsDirectory, snapshotDirectory, path }) {
  if (typeof path !== 'string' || !path.startsWith('/outputs/')) fail('NATIVE_ARTIFACT_PATH_INVALID')
  const parts = path.slice('/outputs/'.length).split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) fail('NATIVE_ARTIFACT_PATH_INVALID')
  const directories = []
  let source, target, destination
  try {
    let parent = openSync(draftsDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    directories.push(parent)
    for (const part of parts.slice(0, -1)) {
      parent = openSync(`/proc/self/fd/${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      directories.push(parent)
    }
    source = openSync(`/proc/self/fd/${parent}/${parts[parts.length - 1]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(source, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n) fail('NATIVE_ARTIFACT_SOURCE_INVALID')
    destination = resolve(snapshotDirectory, `snapshot-${randomUUID()}`)
    target = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
    let length = 0n, count
    while ((count = readSync(source, buffer, 0, buffer.length, null)) !== 0) {
      digest.update(buffer.subarray(0, count)); length += BigInt(count)
      for (let offset = 0; offset < count;) offset += writeSync(target, buffer, offset, count - offset)
    }
    const after = fstatSync(source, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.size !== length || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('NATIVE_ARTIFACT_SOURCE_CHANGED')
    fsyncSync(target)
    return { path: destination, byteLength: String(length), sha256: digest.digest('hex') }
  } catch (error) {
    if (target !== undefined && destination) { try { unlinkSync(destination) } catch {} }
    throw error
  } finally {
    if (target !== undefined) closeSync(target)
    if (source !== undefined) closeSync(source)
    for (const fd of directories.reverse()) closeSync(fd)
  }
}
