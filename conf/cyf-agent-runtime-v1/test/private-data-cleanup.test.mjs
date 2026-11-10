import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanStoppedPrivateData } from '../lib/private-data-cleanup.mjs';
import { cleanStoppedMaterials } from '../lib/private-material-cleanup.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'private-data-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = resolve(root, 'state'), home = resolve(root, 'home'), work = resolve(root, 'work'), repository = resolve(root, 'repository');
  const profile = { profileId: 'test', agentId: 'agent', codexHome: home, codexWorkdir: repository, chatWorkdir: work, workspaceFallbackWorkdir: work,
    workspaceFileRootDir: resolve(root, 'native'), controlledImageHttpLedgerRoot: resolve(root, 'image'),
    typedInspectionRootDir: resolve(root, 'typed-input'), typedInspectionStateRoot: resolve(root, 'typed-state') };
  const typed = Buffer.from(profile.agentId).toString('hex');
  const privateRoots = [work, profile.workspaceFileRootDir, profile.controlledImageHttpLedgerRoot,
    resolve(profile.typedInspectionRootDir, typed), resolve(profile.typedInspectionStateRoot, typed)];
  for (const dir of [stateRoot, home, repository, ...privateRoots]) await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const dir of [stateRoot, home, ...privateRoots]) await writeFile(resolve(dir, 'private'), 'original user data');
  await mkdir(resolve(home, 'skills')); await writeFile(resolve(home, 'skills/public'), 'public skill');
  await mkdir(resolve(repository, '.git')); await writeFile(resolve(repository, '.git/history'), 'public commits');
  await writeFile(resolve(stateRoot, 'handover.json'), 'stopped control'); await mkdir(resolve(stateRoot, '.runtime-writer.lock'));
  for (const parent of [profile.typedInspectionRootDir, profile.typedInspectionStateRoot]) {
    await mkdir(resolve(parent, 'another-agent')); await writeFile(resolve(parent, 'another-agent/private'), 'other owner');
  }
  await symlink(repository, resolve(work, 'link'));
  const fixture = { root, home, stateRoot, repository, privateRoots, options: { agent: { profile, stateRoot, manifest: {} },
    apiOrigin: 'https://example.test', instanceId: 'boot', ownerJiacn: 'original', operationId: 'finish',
    publicRepositoryRoots: [repository], publicFiles: { 'config.toml': 'model="test"' } } };
  fixture.options.recordKnowledgeStatus = async status => { fixture.options.knowledgeStatus = status; };
  return fixture;
}

test('aggregate cleanup attempts extraction before erasure and clears all owned roots while preserving public and other-agent files', async t => {
  const f = await fixture(t); let extractions = 0;
  f.options.extractKnowledge = async ({ ownerJiacn, operationId }) => {
    extractions++; assert.equal(ownerJiacn, 'original'); assert.equal(operationId, 'finish');
    assert.equal(await readFile(resolve(f.home, 'private'), 'utf8'), 'original user data');
    return { confirmed: true };
  };
  assert.deepEqual(await cleanStoppedPrivateData(f.options), { confirmed: true, knowledgeStatus: 'EXTRACTED' });
  assert.equal(extractions, 1);
  for (const root of f.privateRoots) assert.deepEqual(await readdir(root), []);
  assert.deepEqual((await readdir(f.home)).sort(), ['config.toml', 'skills']);
  assert.deepEqual((await readdir(f.stateRoot)).sort(), ['.runtime-writer.lock', 'handover.json']);
  assert.equal(await readFile(resolve(f.repository, '.git/history'), 'utf8'), 'public commits');
  for (const parent of [f.options.agent.profile.typedInspectionRootDir, f.options.agent.profile.typedInspectionStateRoot])
    assert.equal(await readFile(resolve(parent, 'another-agent/private'), 'utf8'), 'other owner');
});

test('extraction failure does not prevent cleanup or leak raw diagnostics into its receipt', async t => {
  const f = await fixture(t);
  f.options.extractKnowledge = async () => { throw new Error('synthetic private conversation must not escape'); };
  assert.deepEqual(await cleanStoppedPrivateData(f.options), { confirmed: true, knowledgeStatus: 'FAILED' });
  for (const root of f.privateRoots) assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await cleanStoppedPrivateData(f.options), { confirmed: true, knowledgeStatus: 'FAILED' });
});

test('missing adapter or public baseline and a bad later material root do not erase earlier roots', async t => {
  const f = await fixture(t);
  await assert.rejects(cleanStoppedPrivateData(f.options), { code: 'RUNTIME_KNOWLEDGE_ADAPTER_REQUIRED' });
  f.options.extractKnowledge = async () => { throw new Error('must not reach extraction'); };
  await assert.rejects(cleanStoppedPrivateData({ ...f.options, publicFiles: {} }), { code: 'RUNTIME_HOME_PUBLIC_BASELINE_REQUIRED' });
  f.options.agent.profile.controlledImageHttpLedgerRoot = f.repository;
  await assert.rejects(cleanStoppedPrivateData(f.options), { code: 'RUNTIME_PRIVATE_MATERIAL_PUBLIC_OVERLAP' });
  for (const root of [f.home, f.stateRoot, ...f.privateRoots]) assert.equal(await readFile(resolve(root, 'private'), 'utf8'), 'original user data');
});

test('material cleanup refuses ancestors of lifecycle state and does not follow a configured symlink root', async t => {
  const f = await fixture(t), profile = f.options.agent.profile;
  profile.chatWorkdir = f.root;
  await assert.rejects(cleanStoppedMaterials(f.options), { code: 'RUNTIME_PRIVATE_MATERIAL_PUBLIC_OVERLAP' });
  const alias = resolve(f.root, 'alias'); await symlink(f.privateRoots[0], alias); profile.chatWorkdir = alias;
  await assert.rejects(cleanStoppedMaterials(f.options), { code: 'RUNTIME_ROOT_UNSAFE' });
  assert.equal(await readFile(resolve(f.privateRoots[0], 'private'), 'utf8'), 'original user data');
});

test('unknown prior knowledge call is recorded failed without calling provider again, then cleanup continues', async t => {
  const f = await fixture(t); f.options.knowledgeStatus = 'REQUESTED'; let calls = 0;
  f.options.extractKnowledge = async () => { calls++; return { confirmed: true }; };
  assert.deepEqual(await cleanStoppedPrivateData(f.options), { confirmed: true, knowledgeStatus: 'FAILED' });
  assert.equal(calls, 0); assert.equal(f.options.knowledgeStatus, 'FAILED');
});

test('failure to persist knowledge request prevents provider calls and all deletion', async t => {
  const f = await fixture(t); let calls = 0;
  f.options.recordKnowledgeStatus = async () => { throw new Error('journal unavailable'); };
  f.options.extractKnowledge = async () => { calls++; return { confirmed: true }; };
  await assert.rejects(cleanStoppedPrivateData(f.options), /journal unavailable/);
  assert.equal(calls, 0); assert.equal(await readFile(resolve(f.home, 'private'), 'utf8'), 'original user data');
});
