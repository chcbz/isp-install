// Generic invocation evidence transport. No image protocol, pricing or task orchestration.
import { constants, openSync, closeSync, fstatSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { skillDigest } from './skill-executor.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function pendingProviderUsage(store) {
  const directory = resolve(store.directory, 'scratch/.provider-usage')
  let files
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || realpathSync(directory) !== directory || stat.uid !== process.geteuid() || stat.mode & 0o077) fail('SKILL_STORE_UNSAFE')
    files = readdirSync(directory)
  } catch (error) { if (error.code === 'ENOENT') files = []; else throw error }
  const pending = []
  const names = new Set(files.filter(name => /^[a-f0-9-]{36}-started\.json$/.test(name)))
  for (const name of readdirSync(store.directory)) if (/^provider-usage-[a-f0-9-]{36}-started\.json$/.test(name)) names.add(name.slice('provider-usage-'.length))
  for (const filename of [...names].sort()) {
    const id = filename.slice(0, -13)
    for (const phase of ['started', 'terminal']) {
      const sourceName = `${id}-${phase}.json`, key = `provider-usage-${id}-${phase}`
      // Copy each complete source once into the host-owned execution journal.
      let observation = store.read(key)
      if (!observation) {
        if (!files.includes(sourceName)) break
        const fd = openSync(resolve(directory, sourceName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid() || stat.mode & 0o077) fail('SKILL_STORE_UNSAFE')
          try { observation = JSON.parse(readFileSync(fd, 'utf8')) } catch { fail('PROVIDER_USAGE_SOURCE_INVALID') }
        } finally { closeSync(fd) }
        if (observation.invocationId !== id || observation.phase !== phase.toUpperCase()) fail('PROVIDER_USAGE_SOURCE_INVALID')
        store.write(key, observation)
      }
      const payload = { executionId: store.command.executionId, observation }
      const evidenceSha256 = skillDigest(payload), receiptName = `${key}-receipt`
      const receipt = store.read(receiptName)
      if (receipt) {
        if (receipt.evidenceSha256 !== evidenceSha256) fail('NATIVE_USAGE_RECEIPT_CONFLICT')
        continue
      }
      pending.push({ payload, evidenceSha256, receiptName, endpoint: 'provider-usage' })
      break // Ordered start/terminal revisions; independent of business ACK.
    }
  }
  return pending
}
