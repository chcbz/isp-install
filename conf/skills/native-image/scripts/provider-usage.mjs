// Protocol helper only. The host supplies an execution-private journal directory;
// no task, wallet, currency or API authentication is handled by this skill.
import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
function persist(directory, name, value) {
  const temporary = resolve(directory, `.tmp-${randomUUID()}`)
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, resolve(directory, name))
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(dir) } finally { closeSync(dir) }
}
export function beginProviderUsage({ directory, config, mode }) {
  if (!directory) return null // Standalone helper has no host journal; do not invent one.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const invocationId = randomUUID()
  const base = { schemaVersion: 1, invocationId, protocol: 'openai-images-v1',
    channel: config.usageChannel ?? null, tier: config.usageTier ?? null,
    priceVersion: config.usagePriceVersion ?? null, requestedModel: config.model, operation: mode }
  persist(directory, `${invocationId}-started.json`, { ...base, phase: 'STARTED', observedAt: Date.now(), evidence: null })
  let done = false
  return { complete(evidence) {
    if (done) return
    done = true // Never replace received usage with null if persistence itself fails.
    persist(directory, `${invocationId}-terminal.json`, { ...base, phase: 'TERMINAL', observedAt: Date.now(), evidence })
  } }
}
