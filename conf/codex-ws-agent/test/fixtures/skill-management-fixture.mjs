import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { managementDigest } from '../../skill-management-wire.mjs'
import { parseSkillManifest } from '../../skill-manifest.mjs'
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const examples = JSON.parse(readFileSync(new URL('./skill-management/management-contract-v1.examples.json', import.meta.url)))
export const binding = { scope: { tenantId: '0', clientId: 'client_demo', ownerJiacn: 'owner_demo', agentId: 'agt_demo' },
  fence: { installationId: 'rti_demo', hostId: 'host_demo', runtimeInstanceId: 'boot_demo', sessionGeneration: '1' } }
export const profile = home => ({ profileId: 'profile_demo', agentId: 'agt_demo', codexHome: home, apiKey: '' })
export const headers = b => ({ Authorization: `AgentRuntime rts1_${'a'.repeat(64)}`, 'X-Agent-Id': b.scope.agentId,
 'X-Agent-Installation-Id': b.fence.installationId, 'X-Agent-Host-Id': b.fence.hostId,
 'X-Agent-Runtime-Id': b.fence.runtimeInstanceId, 'X-Agent-Session-Generation': b.fence.sessionGeneration })
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export const zip = entries => {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8')
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data || '', 'utf8')
    const crc = crc32(data)
    const flags = 0x0800
    const mode = item.mode ?? (item.name.endsWith('/') ? 0o040755 : 0o100644)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

export const skillDocument = (skillKey = 'repo-test', version = '1.0.0') => (
  `---\nname: ${skillKey}\ndescription: Run focused authorized repository tests.\nmetadata:\n  version: "${version}"\n---\n\n# ${skillKey}\n`
)

export const packageFixture = ({ version = '1.0.0', executable = false, entries = null } = {}) => {
  const raw = JSON.parse(readFileSync(new URL('./skill-manifest-contract-v1.json', import.meta.url))).cases.find(c => c.id === 'image-edit')
  const manifest = JSON.parse(raw.json); manifest.skillKey = 'repo-test'; manifest.skillVersion = version
  manifest.runner = 'native-model'; manifest.requirements = {}
  manifest.inputs = { minItems: 0, maxItems: 0, acceptedMimeTypes: ['text/plain'] }
  manifest.outputs = { mimeTypes: [], multiple: false, artifactsRequired: false,
    dataSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }
  const parsed = parseSkillManifest(JSON.stringify(manifest), { skillKey: manifest.skillKey, skillVersion: version })
  const bytes = zip(entries || [{ name: 'SKILL.md', data: skillDocument('repo-test', version) },
    ...(executable ? [{ name: 'manifest.json', data: JSON.stringify(manifest) }] : [])])
  return { bytes, manifest: executable ? parsed : null, target: { skillInstallationId: `si_${version}`, productVersionId: `spv_${version}`,
    skillVersion: version, packageSha256: hash(bytes), manifestSha256: executable ? parsed.manifestSha256 : null,
    byteLength: String(bytes.length), kind: executable ? 'EXECUTABLE' : 'INSTRUCTION' } }
}
let nextId = 0
export function command(target, changes = {}) {
  const sample = examples.cases.find(c => c.name === 'prepare-command').value
  const data = { ...structuredClone(sample.data), commandId: `cmd_${++nextId}`, skillChangeId: 'sc_install',
    action: 'INSTALL', source: null, skillKey: 'repo-test', fencingToken: '1', skillRevision: '1', target,
    downloadPath: `/internal/agent/skill-installations/${target.skillInstallationId}/package`, ...changes }
  if (data.phase !== 'PREPARE') delete data.downloadPath
  const { commandSha256, deliveryEpoch, ...preimage } = data
  data.commandSha256 = managementDigest('cyf.skill.command.v2', preimage)
  return { protocolVersion: 1, requestId: `req_${data.commandId}`, messageId: `msg_${data.commandId}`, messageType: 'command.dispatch', data }
}
export const activate = prepared => command(prepared.data.target, { ...prepared.data, commandId: `cmd_activate_${++nextId}`, phase: 'ACTIVATE',
  preparedCommandId: prepared.data.commandId, preparedSha256: managementDigest('cyf.skill.prepared.v1', Object.fromEntries(
    ['skillChangeId','attempt','source','target','approvedPermissionsSha256'].map(key => [key, prepared.data[key]]))) })

export const policy = (target, revision, enabled) => command(target, { commandType: 'SKILL_SET_ENABLED', phase: 'POLICY',
  action: enabled ? 'ENABLE' : 'DISABLE', source: target, desiredEnabled: enabled, skillChangeId: `sc_policy_${revision}`,
  skillRevision: String(revision), fencingToken: String(revision) })
export const reconcile = original => {
  const { preparedCommandId, preparedSha256, downloadPath, ...data } = original.data
  return command(original.data.target, { ...data, commandId: `read_${++nextId}`, commandType: 'SKILL_RECONCILE', phase: 'READ', observedCommandId: original.data.commandId })
}
