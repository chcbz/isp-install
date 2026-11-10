import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillInstallManager, defaultSkillInstallStateRoot } from '../../codex-bridge/skill-install-manager.mjs';
import { binding, profile, headers, packageFixture, command, activate } from '../../codex-bridge/test/fixtures/skill-management-fixture.mjs';
import { replyMessage } from '../../codex-bridge/message-envelope.mjs';
import { cleanStoppedRuntimeState } from '../lib/private-state-cleanup.mjs';

async function fixture(t, install = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'private-state-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = resolve(root, 'state'), home = resolve(root, 'home'), repository = resolve(root, 'repository');
  for (const path of [stateRoot, home, repository]) await mkdir(path, { mode: 0o700 });
  const agent = { stateRoot, profile: profile(home), manifest: { tenantId: binding.scope.tenantId,
    clientId: binding.scope.clientId, canonicalAgentId: binding.scope.agentId, installationId: binding.fence.installationId } };
  await mkdir(resolve(stateRoot, '.runtime-writer.lock')); await writeFile(resolve(stateRoot, '.runtime-writer.lock/owner.json'), 'owned lock');
  await writeFile(resolve(stateRoot, 'handover.json'), 'original stopped control');
  await writeFile(resolve(stateRoot, 'session.json'), 'old session secret');
  await mkdir(resolve(stateRoot, 'inbox/chat-workdirs'), { recursive: true });
  await writeFile(resolve(stateRoot, 'inbox/chat-workdirs/private'), 'private work');
  await writeFile(resolve(repository, 'source'), 'shared project');
  await symlink(repository, resolve(stateRoot, 'private-link'));
  const options = { agent, apiOrigin: 'http://127.0.0.1:8080', instanceId: 'cleanup-boot', ownerJiacn: binding.scope.ownerJiacn,
    operationId: 'finish', publicRepositoryRoots: [repository] };
  let manager;
  if (install) {
    const pkg = packageFixture(); const settings = { profile: agent.profile,
      stateRoot: defaultSkillInstallStateRoot(resolve(stateRoot, 'inbox'), agent.profile, 'ws://127.0.0.1:8080'),
      wsUrl: 'ws://127.0.0.1:8080', runtimeInstanceId: binding.fence.runtimeInstanceId, getRuntimeHeaders: () => headers(binding),
      fetchFn: async () => new Response(pkg.bytes, { headers: { 'content-length': String(pkg.bytes.length), 'content-type': 'application/octet-stream' } }) };
    manager = new SkillInstallManager(settings); manager.initialize(); manager.bindSession(binding);
    manager.verifyCandidate = async () => ({ readiness: 'READY' });
    const prepare = command(pkg.target); await manager.handle(prepare); await manager.handle(activate(prepare));
    manager.bindSession(null);
  }
  return { root, stateRoot, home, repository, options, manager };
}
function acknowledge(manager) {
  for (const { envelope } of manager.pendingResults()) manager.acknowledgeResultReceipt(replyMessage(envelope,
    'work.result.receipt', `receipt_${envelope.messageId}`, 'E0', 'committed', { schemaVersion: 2,
      skillChangeId: envelope.data.skillChangeId, commandId: envelope.data.commandId, attempt: envelope.data.attempt, receiptStatus: 'ACCEPTED' }));
}

test('stopped state cleanup removes credentials and inbox without following links, preserving lifecycle ownership', async t => {
  const f = await fixture(t);
  assert.deepEqual(await cleanStoppedRuntimeState(f.options), { stateCleaned: true });
  assert.deepEqual((await readdir(f.stateRoot)).sort(), ['.runtime-writer.lock', 'handover.json']);
  assert.equal(await readFile(resolve(f.stateRoot, '.runtime-writer.lock/owner.json'), 'utf8'), 'owned lock');
  assert.equal(await readFile(resolve(f.stateRoot, 'handover.json'), 'utf8'), 'original stopped control');
  assert.equal(await readFile(resolve(f.repository, 'source'), 'utf8'), 'shared project');
  await cleanStoppedRuntimeState(f.options);
});

test('stopped state cleanup retires exact manager and preserves installed packages while removing adjacent private chats', async t => {
  const f = await fixture(t, true); acknowledge(f.manager);
  const publicSkill = await readFile(resolve(f.home, 'skills/repo-test/SKILL.md'));
  await cleanStoppedRuntimeState(f.options);
  const journal = JSON.parse(await readFile(f.manager.statePath));
  assert.equal(journal.identity, null); assert.deepEqual(journal.commands, {}); assert.equal(journal.retirement.operationId, 'finish');
  assert.equal(f.manager.listInstalledSkills().length, 1);
  assert.deepEqual(await readFile(resolve(f.home, 'skills/repo-test/SKILL.md')), publicSkill);
  await assert.rejects(readFile(resolve(f.stateRoot, 'inbox/chat-workdirs/private')), { code: 'ENOENT' });
  await cleanStoppedRuntimeState(f.options);
  assert.equal(f.manager.listInstalledSkills().length, 1);
});

test('unreceived management facts or wrong owner prevent state deletion', async t => {
  const f = await fixture(t, true);
  await assert.rejects(cleanStoppedRuntimeState(f.options), { code: 'SKILL_RELATIONSHIP_RESULTS_PENDING' });
  acknowledge(f.manager);
  await assert.rejects(cleanStoppedRuntimeState({ ...f.options, ownerJiacn: 'different-owner' }));
  assert.equal(await readFile(resolve(f.stateRoot, 'session.json'), 'utf8'), 'old session secret');
  assert.equal(await readFile(resolve(f.stateRoot, 'inbox/chat-workdirs/private'), 'utf8'), 'private work');
});

test('shared repository overlap is rejected before deleting state', async t => {
  const f = await fixture(t);
  await assert.rejects(cleanStoppedRuntimeState({ ...f.options, publicRepositoryRoots: [f.stateRoot] }), { code: 'RUNTIME_STATE_PUBLIC_REPOSITORY_OVERLAP' });
  assert.equal(await readFile(resolve(f.stateRoot, 'session.json'), 'utf8'), 'old session secret');
});
