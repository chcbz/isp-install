/** Preserve an already-produced image before attempting native result transport.
 * This is NOT a provider retry queue. Only a future server-authorized result
 * recovery path may retransmit these bytes; a retained record grants no lease.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { NativeConversationError, validateNativeConversationOutput } from './conversation-native.mjs'
import { canonicalContextJsonV1 } from './conversation-reference-inputs-v3.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw new NativeConversationError('CONVERSATION_OUTPUT_PERSISTENCE_UNCERTAIN') }
const privateDirectory = path => {
  const st = lstatSync(path)
  if (!st.isDirectory() || realpathSync(path) !== path || st.uid !== process.geteuid()
      || (st.mode & 0o077) !== 0) fail()
}
const syncDirectory = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
const privateFile = (path, bytes) => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid() || (before.mode & 0o077) !== 0) fail()
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

export const retainControlledImageDeliveryV3 = ({ runDirectory, command, output, apiOrigin, agentId }) => {
  try {
    if (!isAbsolute(runDirectory) || resolve(runDirectory) !== runDirectory
        || output?.outputId !== 'output_1' || output?.contentType !== 'image/png'
        || !validateNativeConversationOutput('image/png', output.bytes)) fail()
    privateDirectory(runDirectory)
    const delivery = resolve(runDirectory, 'delivery')
    // Exclusive creation refuses pre-existing directories, links and files.
    // Never overwrite a recovery record, even when a previous write was partial.
    mkdirSync(delivery, { mode: 0o700 })
    privateDirectory(delivery)
    const record = {
      schemaVersion: 1,
      state: 'DELIVERY_PENDING',
      providerReplayAllowed: false,
      apiOrigin,
      agentId,
      command,
      commandSha256: hash(Buffer.from(canonicalContextJsonV1(command), 'utf8')),
      output: { outputId: 'output_1', contentType: 'image/png', filename: 'output_1.png',
        byteLength: output.bytes.length, sha256: hash(output.bytes) }
    }
    privateFile(resolve(delivery, 'output_1.png'), output.bytes)
    // Receipt is written last: an incomplete directory is not a valid recovery record.
    privateFile(resolve(delivery, 'receipt.json'), Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
    syncDirectory(delivery)
    syncDirectory(runDirectory)
    syncDirectory(dirname(runDirectory))
    return Object.freeze(record)
  } catch { fail() }
}
