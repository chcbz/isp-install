#!/usr/bin/env node
// Test-only JSONL bridge for the API owned-MySQL fixture. Not a Runtime service,
// installer, authentication shortcut, public protocol or executable model lane.
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { SkillInstallManager } from '../../skill-install-manager.mjs'
import { SkillRegistry } from '../../skill-registry.mjs'
import { fromAgentWire, toAgentWire } from '../../agent-message-wire.mjs'
import { validateManagement } from '../../skill-management-wire.mjs'
import { parseStrictJson } from '../../api-envelope.mjs'

const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const bytes = value => {
  if (typeof value !== 'string') fail('BRIDGE_BASE64_REQUIRED')
  const raw = Buffer.from(value, 'base64')
  if (raw.toString('base64') !== value) fail('BRIDGE_BASE64_INVALID')
  return raw
}
const digest = value => createHash('sha256').update(value).digest('hex')
let settings, manager, registry
const packages = new Map()
const emitEnvelope = envelope => {
  const raw = JSON.stringify(toAgentWire(envelope))
  output({ kind: envelope.messageType === 'command.ack' ? 'ack' : 'result', wireBase64: Buffer.from(raw).toString('base64') })
  return true
}
const headers = () => ({ Authorization: `AgentRuntime rts1_${'a'.repeat(64)}`, 'X-Agent-Id': settings.scope.agentId,
  'X-Agent-Installation-Id': settings.fence.installationId, 'X-Agent-Host-Id': settings.fence.hostId,
  'X-Agent-Runtime-Id': settings.fence.runtimeInstanceId, 'X-Agent-Session-Generation': settings.fence.sessionGeneration })
const addPackage = item => {
  validateManagement('Id', item.skillInstallationId)
  if (/[\\/%?#]/u.test(item.skillInstallationId)) fail('BRIDGE_PACKAGE_ID_INVALID')
  const path = `/internal/agent/skill-installations/${item.skillInstallationId}/package`, data = bytes(item.base64)
  if (packages.has(path) && !packages.get(path).equals(data)) fail('BRIDGE_PACKAGE_IMMUTABLE')
  packages.set(path, data)
}
const publishCatalog = async () => {
  const skillExecution = await registry.refresh()
  if (!skillExecution) fail('BRIDGE_CATALOG_UNAVAILABLE')
  const value = { agentId: settings.scope.agentId, runtimeInstallationId: settings.fence.installationId, runtimeInstanceId: settings.fence.runtimeInstanceId,
    sessionGeneration: settings.fence.sessionGeneration, skillExecution }
  validateManagement('CapabilityAdapterInput', value)
  output({ kind: 'catalog', value })
}
const boot = fence => {
  manager?.bindSession(null); registry?.setSession(null)
  settings.fence = fence
  // Optional, explicit fake dependency boundary. Probes do not call Codex or a
  // provider; execution always throws. Never use this as real model readiness.
  const runners = new Map()
  if (settings.testExecutableReadiness === true) for (const runner of ['native-model', 'local-script', 'provider-operation'])
    runners.set(runner, { probe: () => ({ ready: true, digest: digest(`test-only:${runner}`) }), run: () => fail('BRIDGE_EXECUTION_FORBIDDEN') })
  registry = new SkillRegistry({ scope: settings.scope, loadInstalled: () => manager.listInstalledSkills(),
    loadRetained: skillInstallationId => manager.listInstalledSkills({ includeRetained: true, skillInstallationId }), runnerRegistry: runners,
    resolveBinding: settings.testExecutableReadiness === true ? ({ alias }) => ({ ready: true, scope: settings.scope,
      bindingId: 'bridge_fixture_binding', revision: '1', digest: digest(`test-only-binding:${alias}`) }) : null,
    toolProbes: new Map(['node', 'python3', 'bwrap'].map(name => [name, () => settings.testExecutableReadiness === true
      ? { ready: true, digest: digest(`test-only-tool:${name}`) } : { ready: false }])) })
  registry.setSession(fence)
  manager = new SkillInstallManager({ profile: { profileId: settings.profileId, agentId: settings.scope.agentId,
    codexHome: resolve(settings.root, 'home') }, stateRoot: resolve(settings.root, 'state'), wsUrl: settings.wsUrl,
    enabled: true, runtimeInstanceId: fence.runtimeInstanceId, getRuntimeHeaders: headers, sendResultFn: emitEnvelope,
    fetchFn: async (url, request) => {
      if (url.origin !== settings.apiOrigin || request.method !== 'GET' || request.redirect !== 'error' || !packages.has(url.pathname)) fail('BRIDGE_PACKAGE_NOT_REGISTERED')
      const data = packages.get(url.pathname)
      return new Response(data, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) } })
    } })
  manager.initialize(); manager.bindSession({ scope: settings.scope, fence })
  manager.verifyCandidate = async row => (await registry.measureInstallation(row)).item
}
const initialize = async input => {
  if (settings) fail('BRIDGE_ALREADY_INITIALIZED')
  if (!isAbsolute(input.root || '') || resolve(input.root) !== input.root) fail('BRIDGE_CANONICAL_ROOT_REQUIRED')
  const origin = new URL(input.apiOrigin)
  if (origin.origin !== input.apiOrigin || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol)) fail('BRIDGE_ORIGIN_INVALID')
  const root = input.root, marker = resolve(root, '.smc1-node-test-peer.json')
  let ancestor = root
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) fail('BRIDGE_CANONICAL_ROOT_REQUIRED')
  const identity = { kind: 'SM-C1-NODE-TEST-PEER', profileId: input.profileId, scope: input.scope, apiOrigin: input.apiOrigin }
  if (existsSync(root)) {
    const stat = lstatSync(root)
    if (stat.uid !== process.geteuid() || stat.mode & 0o077 || stat.isSymbolicLink()) fail('BRIDGE_PRIVATE_ROOT_REQUIRED')
    if (readdirSync(root).length && (!existsSync(marker) || JSON.stringify(JSON.parse(readFileSync(marker))) !== JSON.stringify(identity))) fail('BRIDGE_ROOT_NOT_OWNED')
  } else mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
  if (!existsSync(resolve(root, 'home'))) mkdirSync(resolve(root, 'home'), { mode: 0o700 })
  settings = { ...input, wsUrl: `${input.apiOrigin.replace(/^http/, 'ws')}/ws/agent/channel` }
  for (const item of input.packages || []) addPackage(item)
  boot(input.fence)
  output({ kind: 'ready', dependencyBoundary: input.testExecutableReadiness === true ? 'TEST_PROBES_NO_EXECUTION' : 'NO_EXECUTABLE_RUNNERS' })
  await publishCatalog()
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let input
  try {
    input = parseStrictJson(line)
    if (input.op === 'init') await initialize(input)
    else {
      if (!manager) fail('BRIDGE_INIT_REQUIRED')
      switch (input.op) {
        case 'receive': {
          const raw = bytes(input.wireBase64)
          // Validate the original bytes through the actual public consumer first;
          // never JSON.parse/re-stringify a Java command before that boundary.
          fromAgentWire(new TextDecoder('utf-8', { fatal: true }).decode(raw))
          await manager.handle(raw); await publishCatalog(); break
        }
        case 'putPackage': addPackage(input); break
        case 'catalog': await publishCatalog(); break
        case 'restart': boot(input.fence); await publishCatalog(); break
        case 'replay': {
          manager.replayAcks(); const replayToken = {}
          while (manager.replayResults(emitEnvelope, { replayToken }) === manager.maxReplayBatch) {}
          await publishCatalog(); break
        }
        case 'resolveTask': {
          const b = input.taskSkillBinding, entry = await registry.requireExact(b, { taskBinding: b, allowUnavailable: true })
          const row = entry.descriptor
          output({ kind: 'taskPackage', value: Object.fromEntries(['skillInstallationId', 'productVersionId', 'skillKey', 'skillVersion',
            'packageSha256', 'manifestSha256', 'approvedPermissionsSha256'].map(key => [key, row[key]])) }); break
        }
        default: fail('BRIDGE_OPERATION_INVALID')
      }
    }
    output({ kind: 'done', id: input.id ?? null })
  } catch (error) {
    // No command, credential, package or filesystem content in diagnostics.
    output({ kind: 'error', id: input?.id ?? null, code: error.code || 'BRIDGE_REJECTED' })
  }
}
