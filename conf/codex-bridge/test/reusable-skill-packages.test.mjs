import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SkillInstallManager } from '../skill-install-manager.mjs'
import { SkillRegistry } from '../skill-registry.mjs'
import { zip, hash, binding, profile, headers, command, activate } from './fixtures/skill-management-fixture.mjs'

for (const skillKey of ['document-workbench', 'browser-workbench', 'image-understanding', 'web-research', 'skill-management', 'text-file', 'analysis']) {
  test(`${skillKey}: same ordinary package installs independently for two agents and resolves only its authorized binding`, async t => {
    const version = ['text-file', 'analysis'].includes(skillKey) ? '1.1.0' : '1.0.0'
    const source = new URL(`../../skills/${skillKey}/`, import.meta.url), entries = []
    const collect = (prefix = '') => {
      for (const entry of readdirSync(new URL(prefix || './', source), { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`
        if (entry.isDirectory()) collect(`${name}/`)
        else { assert.ok(entry.isFile()); entries.push({ name, data: readFileSync(new URL(name, source)) }) }
      }
    }
    collect()
    assert.ok(entries.every(e => e.name === 'SKILL.md' || e.name.startsWith('references/')))
    const bytes = zip(entries), root = mkdtempSync(resolve(tmpdir(), 'cyf-reusable-skills-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const installed = []
    for (const agentId of ['agt_alpha', 'agt_beta']) {
      const home = resolve(root, agentId, 'home'); mkdirSync(home, { recursive: true })
      const session = { scope: { ...binding.scope, agentId }, fence: { ...binding.fence, installationId: `rti_${agentId}` } }
      const target = { skillInstallationId: `si_${agentId}`, productVersionId: `spv_${skillKey}_1_0_0`, skillVersion: version,
        packageSha256: hash(bytes), manifestSha256: null, byteLength: String(bytes.length), kind: 'INSTRUCTION' }
      let downloads = 0
      const manager = new SkillInstallManager({ profile: { ...profile(home), agentId }, stateRoot: resolve(root, agentId, 'state'),
        wsUrl: 'ws://127.0.0.1:8080/ws/agent/channel', runtimeInstanceId: session.fence.runtimeInstanceId,
        getRuntimeHeaders: () => headers(session), sendResultFn: () => true,
        fetchFn: async url => {
          assert.equal(url.pathname, `/internal/agent/skill-installations/${target.skillInstallationId}/package`)
          downloads++
          return new Response(bytes, { headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' } })
        } })
      manager.initialize(); manager.bindSession(session)
      const prepare = command(target, { ...session.scope, runtimeInstallationId: session.fence.installationId, skillKey })
      assert.equal((await manager.handle(prepare)).resultEnvelope.data.evidence.outcome, 'PREPARED')
      const result = (await manager.handle(activate(prepare))).resultEnvelope.data.evidence
      assert.equal(result.outcome, 'APPLIED'); assert.equal(result.readiness, 'NOT_EXECUTABLE')
      assert.equal(downloads, 1)
      for (const entry of entries) assert.deepEqual(readFileSync(resolve(home, 'skills', skillKey, entry.name)), entry.data)
      const registry = new SkillRegistry({ scope: session.scope, loadInstalled: () => manager.listInstalledSkills(),
        loadRetained: id => manager.listInstalledSkills({ includeRetained: true, skillInstallationId: id }) })
      registry.setSession(session.fence)
      const row = manager.listInstalledSkills()[0]
      const taskBinding = { executionId: `execution_${agentId}`, taskGrantId: `grant_${agentId}`, taskGrantVersion: '1', agentId, skillKey,
        skillInstallationId: target.skillInstallationId, productVersionId: target.productVersionId, skillVersion: target.skillVersion,
        packageSha256: target.packageSha256, manifestSha256: null, approvedPermissionsSha256: row.approvedPermissionsSha256 }
      const resolved = await registry.requireNativePackage(row, { taskBinding })
      assert.equal(resolved.descriptor.skillInstallationId, target.skillInstallationId)
      installed.push({ registry, row, taskBinding })
    }
    assert.notEqual(installed[0].row.packageRoot, installed[1].row.packageRoot)
    assert.equal(installed[0].row.packageSha256, installed[1].row.packageSha256)
    await assert.rejects(installed[1].registry.requireNativePackage(installed[0].row, { taskBinding: installed[0].taskBinding }),
      { code: 'SKILL_EXECUTION_BINDING_CHANGED' })
    console.log(`${skillKey}: ${bytes.length} fixture ZIP bytes; two temporary agents; no production installation or model call`)
  })
}
