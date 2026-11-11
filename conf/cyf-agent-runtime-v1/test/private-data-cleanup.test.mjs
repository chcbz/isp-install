import test from 'node:test';
import { knowledgeClientFactory } from './knowledge-usage-fixture.mjs';
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
    typedInspectionRootDir: resolve(root, 'typed-input'), typedInspectionStateRoot: resolve(root, 'typed-state'),
    nativeExecutionRootDir: resolve(root, 'native-input'), nativeExecutionStateRoot: resolve(root, 'native-state') };
  const typed = Buffer.from(profile.agentId).toString('hex');
  const privateRoots = [work, profile.workspaceFileRootDir, profile.controlledImageHttpLedgerRoot,
    resolve(profile.typedInspectionRootDir, typed), resolve(profile.typedInspectionStateRoot, typed),
    resolve(profile.nativeExecutionRootDir, typed), resolve(profile.nativeExecutionStateRoot, typed)];
  for (const dir of [stateRoot, home, repository, ...privateRoots]) await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const dir of [stateRoot, home, ...privateRoots]) await writeFile(resolve(dir, 'private'), 'original user data');
  await mkdir(resolve(home, 'skills')); await writeFile(resolve(home, 'skills/public'), 'public skill');
  await mkdir(resolve(repository, '.git')); await writeFile(resolve(repository, '.git/history'), 'public commits');
  await writeFile(resolve(stateRoot, 'handover.json'), 'stopped control'); await mkdir(resolve(stateRoot, '.runtime-writer.lock'));
  for (const parent of [profile.typedInspectionRootDir, profile.typedInspectionStateRoot, profile.nativeExecutionRootDir, profile.nativeExecutionStateRoot]) {
    await mkdir(resolve(parent, 'another-agent')); await writeFile(resolve(parent, 'another-agent/private'), 'other owner');
  }
  await symlink(repository, resolve(work, 'link'));
  const fixture = { root, home, stateRoot, repository, privateRoots, options: { agent: { profile, stateRoot, manifest: { canonicalAgentId: 'agent' } },
    apiOrigin: 'https://example.test', instanceId: 'boot', ownerJiacn: 'original', operationId: 'finish', leaseId: 'lease', flushPlatformCosts: async () => ({ confirmed: true }),
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
  for (const parent of [f.options.agent.profile.typedInspectionRootDir, f.options.agent.profile.typedInspectionStateRoot,
    f.options.agent.profile.nativeExecutionRootDir, f.options.agent.profile.nativeExecutionStateRoot])
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

test('configured real knowledge pipeline publishes outside private roots before cleanup and does not spend again on retry', async t => {
  const { createKnowledgeMaintenance } = await import('../lib/knowledge-maintenance.mjs');
  const f = await fixture(t); f.options.agent.subjectKey = 'tenant/client/agent';
  const hostRoot = resolve(f.root, 'host');
  await mkdir(resolve(f.home, 'sessions'), { mode: 0o755 });
  await writeFile(resolve(f.home, 'sessions/one.jsonl'), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Private synthetic experience to generalize.' }]
  } }) + '\n');
  let calls = 0;
  f.options.extractKnowledge = createKnowledgeMaintenance({ apiOrigin: 'https://fixture.invalid', instanceId: 'boot', clientFactory: knowledgeClientFactory(), hostConfig: { stateRoot: hostRoot, agents: [f.options.agent] },
    knowledgeConfig: { endpoint: 'https://fixture.invalid/responses', credential: 'fixture', model: 'gpt-6-luna', channel: 'platform', maxInputBytes: 4096 },
    fetchImpl: async (_url, options) => {
      calls++; assert.equal(f.options.knowledgeStatus, 'REQUESTED');
      assert.equal(await readFile(resolve(f.home, 'private'), 'utf8'), 'original user data');
      const entries = [{ title: 'Validate committed state', guidance: 'Only report completion after durable persistence.' }];
      return { ok: true, status: 200, json: async () => ({ status: 'completed', model: JSON.parse(options.body).model,
        usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(calls === 1 ? { entries } : { safe: true, entries }) }] }] }) };
    } });
  f.options.flushPlatformCosts = f.options.extractKnowledge.flushPlatformCosts;
  assert.deepEqual(await cleanStoppedPrivateData(f.options), { confirmed: true, knowledgeStatus: 'EXTRACTED' });
  assert.equal(calls, 2);
  assert.deepEqual((await readdir(f.home)).sort(), ['config.toml', 'skills']);
  assert.equal((await readdir(resolve(hostRoot, 'public-knowledge'))).length, 1);
  assert.equal((await readdir(resolve(hostRoot, 'platform-usage'))).length, 1);
  assert.equal(await readFile(resolve(f.repository, '.git/history'), 'utf8'), 'public commits');
  assert.deepEqual(await cleanStoppedPrivateData(f.options), { confirmed: true, knowledgeStatus: 'EXTRACTED' });
  assert.equal(calls, 2);
});

test('lost platform usage ACK retains all private data; restart flushes receipt without repeating model spend', async t => {
  const { createKnowledgeMaintenance } = await import('../lib/knowledge-maintenance.mjs');
  const f = await fixture(t); f.options.agent.subjectKey = 'tenant/client/agent';
  await mkdir(resolve(f.home, 'sessions'));
  await writeFile(resolve(f.home, 'sessions/one.jsonl'), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Private synthetic lesson.' }]
  } }) + '\n');
  let spent = 0, outage = true; const sent = [], accepted = new Map();
  const settings = { hostConfig: { stateRoot: resolve(f.root, 'host'), agents: [f.options.agent] },
    apiOrigin: 'https://fixture.invalid', instanceId: 'boot',
    knowledgeConfig: { endpoint: 'https://fixture.invalid/responses', credential: 'fixture', model: 'gpt-6-luna', channel: 'platform', maxInputBytes: 4096 },
    clientFactory: knowledgeClientFactory({ sent, beforeReply: async (body, receipt) => {
      const key = `${receipt.attemptId}:${receipt.revision}`;
      if (accepted.has(key)) assert.deepEqual(accepted.get(key), body); else accepted.set(key, body);
      if (body.observation.phase === 'RESPONDED' && outage) throw new Error('ACK lost after database commit');
    } }),
    fetchImpl: async () => {
      spent++; assert.equal(sent.at(-1).observation.phase, 'STARTED');
      return { ok: true, status: 200, json: async () => ({ id: 'paid-response', model: 'gpt-6-luna', service_tier: 'default', status: 'completed',
        usage: { input_tokens: 21, input_tokens_details: { cached_tokens: 3 }, output_tokens: 9, total_tokens: 30 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"entries":[]}' }] }] }) };
    } };
  f.options.extractKnowledge = createKnowledgeMaintenance(settings);
  f.options.flushPlatformCosts = f.options.extractKnowledge.flushPlatformCosts;
  await assert.rejects(cleanStoppedPrivateData(f.options), /ACK lost/);
  assert.equal(f.options.knowledgeStatus, 'FAILED'); assert.equal(spent, 1);
  for (const root of [f.home, f.stateRoot, ...f.privateRoots]) assert.equal(await readFile(resolve(root, 'private'), 'utf8'), 'original user data');
  outage = false; f.options.extractKnowledge = createKnowledgeMaintenance({ ...settings, instanceId: 'restarted' });
  f.options.flushPlatformCosts = f.options.extractKnowledge.flushPlatformCosts;
  assert.deepEqual(await cleanStoppedPrivateData(f.options), { confirmed: true, knowledgeStatus: 'FAILED' });
  assert.equal(spent, 1); assert.equal(accepted.size, 2); assert.equal(sent.filter(body => body.observation.phase === 'STARTED').length, 1);
  assert.equal(await readFile(resolve(f.repository, '.git/history'), 'utf8'), 'public commits');
  const deliveries = sent.length;
  await cleanStoppedPrivateData(f.options); assert.equal(sent.length, deliveries);
});

test('missing or unconfirmed platform cost drain prevents private erasure', async t => {
  const f = await fixture(t); f.options.knowledgeStatus = 'FAILED';
  delete f.options.flushPlatformCosts;
  await assert.rejects(cleanStoppedPrivateData(f.options), { code: 'RUNTIME_PLATFORM_COST_FLUSH_REQUIRED' });
  f.options.flushPlatformCosts = async () => ({ confirmed: false });
  await assert.rejects(cleanStoppedPrivateData(f.options), { code: 'RUNTIME_PLATFORM_COST_FLUSH_PENDING' });
  assert.equal(await readFile(resolve(f.home, 'private'), 'utf8'), 'original user data');
});
