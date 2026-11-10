// Public installed skill inventory, not execution authorization or pricing.
// Native discovery owns YAML/plugin/repository precedence; the management journal
// supplements disabled packages hidden from discovery. Historical versions are excluded.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn as spawnProcess } from 'node:child_process'
import { AppServerAdapter, measureCodexAppServerBinaryAsync } from './app-server-adapter.mjs'

const fail = () => { throw Object.assign(new Error('SKILL_INVENTORY_UNCONFIRMED'), { code: 'SKILL_INVENTORY_UNCONFIRMED' }) }
const sha = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f]/.test(value)
const ordered = rows => rows.sort((a, b) => a.skillKey < b.skillKey ? -1 : a.skillKey > b.skillKey ? 1 : 0)
const journalFacts = rows => JSON.stringify(ordered(rows.map(row => ({ skillKey: row.skillKey,
  installationId: row.installationId, packageTreeDigest: row.packageTreeDigest, skillVersion: row.skillVersion, enabled: row.enabled }))))

export function skillInventorySnapshot({ discovery, managed = [], cwd, codexHome }) {
  if (!Array.isArray(discovery?.data) || discovery.data.length !== 1 || discovery.data[0].cwd !== cwd
      || !Array.isArray(discovery.data[0].skills) || !Array.isArray(discovery.data[0].errors) || discovery.data[0].errors.length) fail()
  const rows = new Map(), managedViews = new Map(), nativePaths = new Map()
  for (const row of managed) {
    if (row.active !== true || typeof row.enabled !== 'boolean' || !text(row.skillKey) || !text(row.installationId)
        || !text(row.packageTreeDigest) || rows.has(row.skillKey)) fail()
    const installation = { skillInstallationId: row.installationId, productVersionId: row.productVersionId,
      skillVersion: row.skillVersion, kind: row.kind, packageSha256: row.packageSha256, manifestSha256: row.manifestSha256 }
    if (!text(installation.productVersionId) || !text(installation.skillVersion)
        || !['INSTRUCTION', 'EXECUTABLE'].includes(installation.kind) || !/^[0-9a-f]{64}$/.test(installation.packageSha256)
        || (installation.kind === 'INSTRUCTION' ? installation.manifestSha256 !== null : !/^[0-9a-f]{64}$/.test(installation.manifestSha256))) fail()
    rows.set(row.skillKey, { skillKey: row.skillKey, source: 'MANAGED', revision: sha(JSON.stringify([
      row.installationId, row.packageTreeDigest, row.skillVersion, row.enabled])), enabled: row.enabled, installation })
    managedViews.set(resolve(codexHome, 'skills', row.skillKey, 'SKILL.md'), row)
  }
  for (const skill of discovery.data[0].skills) {
    if (!text(skill.name) || !text(skill.path) || typeof skill.enabled !== 'boolean' || !text(skill.scope)) fail()
    if (skill.scope === 'system') continue // Engine tools are not paid installations.
    const known = managedViews.get(skill.path)
    if (known) {
      if (known.skillKey !== skill.name || known.enabled !== skill.enabled) fail()
      continue
    }
    const path = realpathSync(skill.path)
    if (nativePaths.get(skill.name) === path) continue
    // A collision is not evidence for silently dropping a billable skill kind.
    if (rows.has(skill.name)) fail()
    nativePaths.set(skill.name, path)
    rows.set(skill.name, { skillKey: skill.name, source: 'NATIVE', revision: sha(readFileSync(path)), enabled: skill.enabled, installation: null })
  }
  const skills = ordered([...rows.values()])
  return Object.freeze({ inventoryVersion: '1', inventorySha256: sha(JSON.stringify(skills)),
    installedSkillCount: String(skills.length), skills: Object.freeze(skills.map(Object.freeze)) })
}

export async function observeInstalledSkillInventory({ profile, manager = null,
  measure = measureCodexAppServerBinaryAsync, spawn = (p, options) => AppServerAdapter.spawnAsync(p, { ...options,
    spawnFn: (command, args, settings) => spawnProcess(command, args, { ...settings,
      env: { ...settings.env, HOME: dirname(p.codexHome) } }) }) }) {
  const before = manager?.listInstalledSkills() || []
  const schemaMeasurement = await measure(profile)
  const adapter = await spawn(profile, { cwd: profile.codexWorkdir, schemaMeasurement })
  try {
    await adapter.initialize({ catalogOnly: true })
    const discovery = await adapter.request('skills/list', { cwds: [profile.codexWorkdir], forceReload: true })
    const after = manager?.listInstalledSkills() || []
    if (journalFacts(before) !== journalFacts(after)) fail()
    return skillInventorySnapshot({ discovery, managed: after, cwd: profile.codexWorkdir, codexHome: profile.codexHome })
  } finally { await adapter.shutdown() }
}
