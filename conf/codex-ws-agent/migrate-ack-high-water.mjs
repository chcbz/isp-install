#!/usr/bin/env node
// Explicit offline conversion only. The running Agent never deletes legacy evidence.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip, createGunzip } from 'node:zlib'
import { AckOutbox } from './agent-client.mjs'
import { canonicalSha256 } from './chat-runtime.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const markerName = /^\d{20}\.json$/
const syncDirectory = (fs, path) => {
  const fd = fs.openSync(path, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
const same = (a, b) => canonicalSha256(a) === canonicalSha256(b)
const parseLegacyMarker = (name, text, agentId) => {
  const record = JSON.parse(text)
  const sequence = Number(name.slice(0, 20))
  if (!markerName.test(name) || !Number.isSafeInteger(sequence) || sequence <= 0
      || record?.formatVersion !== 1 || record.agentId !== agentId || record.queueSequence !== sequence) {
    throw new Error(`Invalid legacy ACK high-water marker: ${name}`)
  }
  return sequence
}

async function readBackup(path, agentId) {
  const input = createReadStream(path)
  const decoder = createGunzip()
  // Propagate source errors through the stream consumed by readline as well.
  input.on('error', error => decoder.destroy(error))
  const lines = createInterface({ input: input.pipe(decoder), crlfDelay: Infinity })
  const digest = createHash('sha256')
  const markers = new Map()
  let header, footer, maximum = 0
  try {
    for await (const line of lines) {
      const row = JSON.parse(line)
      if (footer) throw new Error('Backup data follows its footer')
      if (!header) {
        if (row.kind !== 'header' || row.formatVersion !== 1 || row.agentId !== agentId
            || row.sequence?.formatVersion !== 1 || !Number.isSafeInteger(row.sequence.lastSequence)
            || row.sequence.lastSequence < 0 || row.initialized?.formatVersion !== 1
            || row.initialized.agentId !== agentId) throw new Error('Invalid ACK backup header')
        header = row
      } else if (row.kind === 'marker') {
        const sequence = parseLegacyMarker(row.fileName, row.contents, agentId)
        if (markers.has(row.fileName)) throw new Error('Duplicate marker in ACK backup')
        markers.set(row.fileName, hash(row.contents))
        maximum = Math.max(maximum, sequence)
      } else if (row.kind === 'footer') {
        footer = row
        if (row.count !== markers.size || row.maximum !== maximum
            || row.snapshotDigest !== digest.digest('hex')
            || maximum !== header.sequence.lastSequence) throw new Error('ACK backup integrity/high-water conflict')
        continue
      } else throw new Error('Invalid ACK backup row')
      digest.update(`${line}\n`)
    }
    if (!header || !footer) throw new Error('Incomplete ACK backup')
  } finally {
    lines.close(); input.destroy(); decoder.destroy()
  }
  return { header, footer, markers, digest: canonicalSha256({ header, footer }) }
}

async function writeBackup(outbox, path, header, names) {
  const fs = outbox.fs
  const parent = dirname(path)
  // Do not change the permissions of an existing shared backup directory.
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    syncDirectory(fs, parent); syncDirectory(fs, dirname(parent))
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const digest = createHash('sha256')
  let maximum = 0
  const rows = function * () {
    const first = `${JSON.stringify(header)}\n`; digest.update(first); yield first
    for (const fileName of names) {
      const source = resolve(outbox.highWaterDir, fileName)
      const metadata = fs.lstatSync(source)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Expected a regular legacy marker: ${fileName}`)
      const contents = fs.readFileSync(source, 'utf8')
      maximum = Math.max(maximum, parseLegacyMarker(fileName, contents, outbox.profile.agentId))
      const line = `${JSON.stringify({ kind: 'marker', fileName, contents })}\n`
      digest.update(line); yield line
    }
    yield `${JSON.stringify({ kind: 'footer', count: names.length, maximum, snapshotDigest: digest.digest('hex') })}\n`
  }
  try {
    await pipeline(Readable.from(rows()), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    const fd = fs.openSync(temporary, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (fs.existsSync(path)) throw new Error('Refusing to overwrite an existing ACK backup')
    fs.renameSync(temporary, path); syncDirectory(fs, parent)
  } catch (error) {
    // A failed attempt has not published any migration intent or deleted source.
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    throw error
  }
}

export async function migrateAckHighWater(outbox, { backupPath, onPhase = () => {} }) {
  const fs = outbox.fs
  backupPath = resolve(backupPath)
  // Resolve existing ancestors so a symlinked backup parent cannot put the
  // archive back inside the storage that will later be restored/cleaned.
  let ancestor = dirname(backupPath)
  const suffix = [basename(backupPath)]
  while (!fs.existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
  const physicalBackup = resolve(fs.realpathSync(ancestor), ...suffix)
  const physicalRoot = fs.realpathSync(outbox.rootDir)
  if (physicalBackup === physicalRoot || physicalBackup.startsWith(`${physicalRoot}/`)) {
    throw new Error('ACK backup must be outside the profile storage root')
  }
  for (const directory of [outbox.acksDir, outbox.quarantineDir, outbox.highWaterDir]) {
    const metadata = fs.lstatSync(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Expected a real ACK directory: ${directory}`)
  }
  outbox._acquireSequenceLock('offline-high-water-migration')
  try {
    outbox._assertHealthy()
    const records = outbox._scanPendingRecords({ failOnInvalid: true })
    outbox._assertHealthy()
    let initialized = outbox._readInitialized()
    let state = outbox._readSequenceState()
    let intent = fs.existsSync(outbox.highWaterIntentPath) ? outbox._readIntent() : null
    if (!intent && initialized?.formatVersion === 2) {
      outbox._initializeLocked()
      return { alreadyMigrated: true, lastSequence: outbox.highWaterState.lastSequence }
    }
    if (intent && (intent.kind !== 'migrate' || intent.backupPath !== backupPath)) {
      throw new Error('Existing ACK intent is not this offline migration; no evidence changed')
    }
    const evidenceNames = fs.readdirSync(outbox.highWaterDir)
    for (const name of evidenceNames) {
      if (!markerName.test(name) && !['initialized.json', 'checkpoint.json', 'intent.json'].some(target => name === target || name.startsWith(`${target}.tmp-`))
          && !/^\d{20}\.json\.tmp-\d+-[0-9a-f-]+$/.test(name)) throw new Error(`Unexpected legacy ACK evidence: ${name}`)
    }
    const names = evidenceNames.filter(name => markerName.test(name)).sort()
    if (!intent) {
      if (initialized?.formatVersion !== 1 || state?.formatVersion !== 1
          || fs.existsSync(outbox.highWaterCheckpointPath)) throw new Error('Expected a complete unmigrated ACK state')
      outbox._validatePendingSequences(records, state.lastSequence)
      const header = { kind: 'header', formatVersion: 1, agentId: outbox.profile.agentId, sequence: state, initialized }
      if (!fs.existsSync(backupPath)) await writeBackup(outbox, backupPath, header, names)
    }
    const backupMetadata = fs.lstatSync(backupPath)
    if (!backupMetadata.isFile() || backupMetadata.isSymbolicLink() || (backupMetadata.mode & 0o777) !== 0o600) {
      throw new Error('ACK backup must be a private regular file (0600)')
    }
    const backup = await readBackup(backupPath, outbox.profile.agentId)
    outbox._assertHealthy()
    // Validate all remaining source before writes/deletion. On resume it may be
    // a subset of the complete compressed backup, but never different evidence.
    for (const fileName of names) {
      const path = resolve(outbox.highWaterDir, fileName)
      const metadata = fs.lstatSync(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()
          || hash(fs.readFileSync(path, 'utf8')) !== backup.markers.get(fileName)) {
        throw new Error(`ACK source/backup conflict: ${fileName}`)
      }
    }
    if (!intent) {
      if (names.length !== backup.markers.size || !same(state, backup.header.sequence)
          || !same(initialized, backup.header.initialized)) throw new Error('ACK backup does not match the complete current source')
      const next = outbox._newCheckpoint(randomUUID(), state.lastSequence, randomUUID())
      outbox._writeIntent({ kind: 'migrate', previous: null, next, fileName: null, record: null,
        backupPath, backupDigest: backup.digest })
      intent = outbox._readIntent()
    }
    if (intent.backupDigest !== backup.digest || intent.next.lastSequence !== backup.footer.maximum) {
      throw new Error('Migration journal/backup conflict')
    }
    const checkpoint = outbox._readEvidence(outbox.highWaterCheckpointPath)
    if (checkpoint) outbox._validateCheckpoint(checkpoint, outbox.highWaterCheckpointPath)
    const checkpointAdvanced = checkpoint?.digest === intent.next.digest
    const stateAdvanced = state?.digest === intent.next.digest
    const initializedAdvanced = initialized?.formatVersion === 2 && initialized.storageId === intent.next.storageId
    if ((checkpoint && !checkpointAdvanced) || (!stateAdvanced && !same(state, backup.header.sequence))
        || (!initializedAdvanced && !same(initialized, backup.header.initialized))
        || (stateAdvanced && !checkpointAdvanced) || (initializedAdvanced && !stateAdvanced)
        || (names.length !== backup.markers.size && !initializedAdvanced)) {
      throw new Error('Migration evidence is not a valid commit/cleanup prefix')
    }
    outbox._validatePendingSequences(records, intent.next.lastSequence)
    onPhase('backup-verified')
    if (!checkpointAdvanced) writeDurable(outbox, outbox.highWaterCheckpointPath, intent.next)
    onPhase('checkpoint')
    if (!stateAdvanced) writeDurable(outbox, outbox.sequencePath, intent.next)
    onPhase('counter')
    if (!initializedAdvanced) outbox._writeInitialized(intent.next)
    onPhase('initialized')
    for (const fileName of names) {
      const path = resolve(outbox.highWaterDir, fileName)
      fs.unlinkSync(path)
      // Keep progress recoverable across a power loss; deletion is idempotent.
      syncDirectory(fs, outbox.highWaterDir)
      onPhase('legacy-marker-removed')
    }
    for (const name of evidenceNames.filter(name => /^\d{20}\.json\.tmp-\d+-[0-9a-f-]+$/.test(name))) {
      const path = resolve(outbox.highWaterDir, name)
      if (!fs.lstatSync(path).isFile()) throw new Error('Invalid legacy temporary evidence')
      fs.unlinkSync(path); syncDirectory(fs, outbox.highWaterDir)
    }
    outbox._cleanupEvidenceTempsLocked()
    outbox._validateHighWaterLayoutLocked()
    fs.unlinkSync(outbox.highWaterIntentPath); syncDirectory(fs, outbox.highWaterDir)
    outbox._validatedSequenceState(records)
    return { alreadyMigrated: false, lastSequence: intent.next.lastSequence,
      legacyMarkers: backup.markers.size, backupPath, backupDigest: backup.digest, backupBytes: backupMetadata.size }
  } finally {
    outbox._releaseSequenceLock()
  }
}

// Same durability contract as the Agent's atomic writer, with no runtime install.
function writeDurable(outbox, path, value) {
  const fs = outbox.fs
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temporary, path); syncDirectory(fs, dirname(path))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = name => args[args.indexOf(name) + 1]
  if (args.length !== 6 || !['--root-dir', '--agent-id', '--backup-path'].every(name => args.includes(name) && value(name) && !value(name).startsWith('--'))) {
    console.error(`Usage: node ${basename(process.argv[1])} --root-dir <stopped-profile-root> --agent-id <agent> --backup-path <outside-root.jsonl.gz>`)
    process.exitCode = 2
  } else {
    try {
      const outbox = new AckOutbox({ rootDir: value('--root-dir'), profile: { agentId: value('--agent-id') } })
      console.log(JSON.stringify(await migrateAckHighWater(outbox, { backupPath: value('--backup-path') })))
    } catch (error) { console.error(`ACK migration stopped: ${error.message}`); process.exitCode = 1 }
  }
}
