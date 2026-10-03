/** Preserve an already-produced image before attempting native result transport.
 * This is NOT a provider retry queue. Only server-authorized result
 * recovery may acknowledge these bytes; a retained record grants no lease.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  realpathSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { NativeConversationError, validateNativeConversationOutput } from './conversation-native.mjs'
import { buildOutputCommit } from './workspace-file-bridge.mjs'
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

const readPrivateFile = (path, expectedLength) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid()
        || (before.mode & 0o077) !== 0 || (expectedLength !== undefined && before.size !== expectedLength)) fail()
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (bytes.length !== before.size || before.size !== after.size || before.ino !== after.ino
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail()
    return bytes
  } finally { closeSync(fd) }
}

/** Scope only this Agent/profile. No Provider, credential read, source material read or upload. */
export const retainedControlledImageDeliveriesV3 = ({ rootDirectory, apiOrigin, agentId }) => {
  try {
    if (!isAbsolute(rootDirectory) || resolve(rootDirectory) !== rootDirectory) fail()
    if (!existsSync(rootDirectory)) return []
    privateDirectory(rootDirectory)
    const result = []
    for (const entry of readdirSync(rootDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const runDirectory = resolve(rootDirectory, entry.name)
      const delivery = resolve(runDirectory, 'delivery')
      const receiptPath = resolve(delivery, 'receipt.json')
      if (!existsSync(receiptPath)) continue // In-progress/never-produced runs are not recoverable outputs.
      privateDirectory(runDirectory); privateDirectory(delivery)
      const receiptBytes = readPrivateFile(receiptPath)
      const record = JSON.parse(receiptBytes.toString('utf8'))
      if (record.schemaVersion !== 1 || record.state !== 'DELIVERY_PENDING' || record.providerReplayAllowed !== false
          || record.apiOrigin !== apiOrigin || record.agentId !== agentId || !record.command
          || typeof record.command.runId !== 'string' || !entry.name.startsWith(`${record.command.runId}-`)
          || record.commandSha256 !== hash(Buffer.from(canonicalContextJsonV1(record.command), 'utf8'))
          || record.output?.outputId !== 'output_1' || record.output.contentType !== 'image/png'
          || record.output.filename !== 'output_1.png' || !Number.isSafeInteger(record.output.byteLength)
          || record.output.byteLength < 1 || !/^[a-f0-9]{64}$/.test(record.output.sha256 || '')) fail()
      const bytes = readPrivateFile(resolve(delivery, 'output_1.png'), record.output.byteLength)
      if (hash(bytes) !== record.output.sha256 || !validateNativeConversationOutput('image/png', bytes)) fail()
      const receiptSha256 = hash(receiptBytes)
      const { manifestId } = buildOutputCommit({ taskId: record.command.taskId, runId: record.command.runId,
        uploads: [{ outputId: 'output_1', sha256: record.output.sha256, length: record.output.byteLength }] })
      const ackPath = resolve(delivery, 'committed.json')
      let acknowledged = false
      if (existsSync(ackPath)) {
        const ack = JSON.parse(readPrivateFile(ackPath).toString('utf8'))
        if (ack.schemaVersion !== 1 || ack.state !== 'COMMITTED' || ack.receiptSha256 !== receiptSha256
            || ack.commandSha256 !== record.commandSha256 || ack.sha256 !== record.output.sha256
            || ack.byteLength !== record.output.byteLength || ack.manifestId !== manifestId) fail()
        acknowledged = true
      }
      result.push(Object.freeze({ runDirectory, receiptSha256, record, acknowledged }))
    }
    return result
  } catch { fail() }
}

/** Keep the original paid-result bytes/receipt; append an exact server-ack marker instead of deleting. */
export const acknowledgeRetainedControlledImageDeliveryV3 = ({ retained, manifestId, apiOrigin, agentId }) => {
  try {
    const current = retainedControlledImageDeliveriesV3({ rootDirectory: dirname(retained.runDirectory), apiOrigin, agentId })
      .find(item => item.runDirectory === retained.runDirectory && item.receiptSha256 === retained.receiptSha256)
    if (!current || !/^pwe_m_[a-f0-9]{64}$/.test(manifestId)) fail()
    if (current.acknowledged) return
    const delivery = resolve(current.runDirectory, 'delivery')
    privateFile(resolve(delivery, 'committed.json'), Buffer.from(JSON.stringify({ schemaVersion: 1, state: 'COMMITTED',
      receiptSha256: current.receiptSha256, commandSha256: current.record.commandSha256, manifestId,
      sha256: current.record.output.sha256, byteLength: current.record.output.byteLength }) + '\n'))
    syncDirectory(delivery)
  } catch { fail() }
}
