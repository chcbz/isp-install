import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readRuntimeProviderEnvironments, createLogger } from '../lib/security.mjs';
import { digestManifest, runtimeSubjectKey } from '../lib/manifest.mjs';
import { runUnifiedRuntime } from '../agent-runtime.mjs';
const key = 'CYF_PROVIDER_IMAGE_API_KEY';
const agent = (id, enabled = true) => ({ subjectKey: createHash('sha256').update(id).digest('hex'),
  profile: { controlledImageHttpEnabled: enabled, controlledImageHttpApiKeyEnv: key } });
async function fixture(t, subjects) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'providers.json');
  await writeFile(path, JSON.stringify({ configVersion: 1, subjects }), { mode: 0o600 });
  return { root, path };
}
test('disabled profiles need no Provider file or process environment fallback', async () => {
  const before = process.env[key]; process.env[key] = 'synthetic-global-must-not-be-used';
  try {
    assert.equal((await readRuntimeProviderEnvironments(undefined, [agent('a', false)])).size, 0);
    await assert.rejects(readRuntimeProviderEnvironments(undefined, [agent('a')]), /RUNTIME_PROVIDER_CONFIG_INVALID/);
  } finally { if (before === undefined) delete process.env[key]; else process.env[key] = before; }
});
test('explicit environments remain isolated by full subject and immutable', async t => {
  const a = agent('tenant-a/client/a'), b = agent('tenant-b/client/a');
  const { path } = await fixture(t, { [a.subjectKey]: { [key]: 'synthetic-a' }, [b.subjectKey]: { [key]: 'synthetic-b' } });
  const map = await readRuntimeProviderEnvironments(path, [a, b]);
  assert.equal(map.get(a.subjectKey)[key], 'synthetic-a'); assert.equal(map.get(b.subjectKey)[key], 'synthetic-b');
  assert.ok(Object.isFrozen(map.get(a.subjectKey)));
});
test('unknown or disabled subjects and missing enabled subject are rejected', async t => {
  const a = agent('a'), b = agent('b'); const { path } = await fixture(t, { [a.subjectKey]: { [key]: 'synthetic-a' } });
  for (const agents of [[b], [a, b], [{ ...a, profile: { ...a.profile, controlledImageHttpEnabled: false } }]])
    await assert.rejects(readRuntimeProviderEnvironments(path, agents), /RUNTIME_PROVIDER_CONFIG_INVALID/);
});
test('canonical private files required; errors never echo file/credential', async t => {
  const a = agent('a'), { root, path } = await fixture(t, { [a.subjectKey]: { [key]: 'synthetic-secret' } });
  await chmod(path, 0o644); await assert.rejects(readRuntimeProviderEnvironments(path, [a]), /^Error: RUNTIME_PROVIDER_CONFIG_INVALID$/);
  await chmod(path, 0o600); const alias = join(root, 'alias'); await symlink(path, alias);
  for (const input of [alias, path + '/missing', 'relative.json']) await assert.rejects(readRuntimeProviderEnvironments(input, [a]), /^Error: RUNTIME_PROVIDER_CONFIG_INVALID$/);
  await writeFile(path, 'invalid-json-synthetic-secret');
  await assert.rejects(readRuntimeProviderEnvironments(path, [a]), /^Error: RUNTIME_PROVIDER_CONFIG_INVALID$/);
});
test('exact schema and image-only key reject arbitrary environment injection', async t => {
  const a = agent('a'), { path } = await fixture(t, {});
  const bad = [null, [], { configVersion: 2, subjects: {} }, { configVersion: 1, subjects: {}, extra: true },
    ...[{ HOME: 'synthetic' }, { PATH: 'synthetic' }, { [key]: 'synthetic', OTHER: 'x' }, { [key]: '' },
      { [key]: ' whitespace ' }, { [key]: 'x\ny' }, { [key]: 1 }].map(values => ({ configVersion: 1, subjects: { [a.subjectKey]: values } }))];
  for (const doc of bad) {
    await writeFile(path, JSON.stringify(doc)); await assert.rejects(readRuntimeProviderEnvironments(path, [a]), /^Error: RUNTIME_PROVIDER_CONFIG_INVALID$/);
  }
});
test('known provider values are removed from logger message text', () => {
  const lines = []; createLogger({ write: v => lines.push(v), knownSecrets: ['synthetic-private'] })('test', { message: 'error synthetic-private', provider: 'synthetic-private' });
  assert.ok(!lines.join('').includes('synthetic-private'));
});
test('unified run passes exact explicit mapping into existing adapters', async t => {
  const { root } = await fixture(t, {});
  await mkdir(join(root, 'host'), { mode: 0o700 }); await mkdir(join(root, 'agent'), { mode: 0o700 });
  const controller = new AbortController(); controller.abort();
  const expected = new Map([['fixture', Object.freeze({ [key]: 'synthetic' })]]); let actual;
  await runUnifiedRuntime({ config: { hostId: 'fixture', stateRoot: join(root, 'host'), agents: [{ subjectKey: runtimeSubjectKey({ tenantId: 't', clientId: 'c', canonicalAgentId: 'a' }), manifest: { tenantId: 't', clientId: 'c', canonicalAgentId: 'a', installationId: 'i' }, stateRoot: join(root, 'agent') }] },
    signal: controller.signal, providerEnvironments: expected,
    createAdapters: async options => { actual = options.providerEnvironments; return { close: async () => {}, heartbeat: async () => {}, createExecutor: () => ({ initialize: async () => {}, activate: async () => {}, ready: () => false, pause: async () => {}, close: async () => {} }) }; } });
  assert.equal(actual, expected);
});
test('systemd canonical configuration templates match and preserve /etc systemd boundary', async () => {
  const template = await readFile(new URL('../systemd/cyf-agent-runtime-v1@.service', import.meta.url), 'utf8');
  const repo = await readFile(new URL('../../../systemd/cyf-agent-runtime-v1@.service', import.meta.url), 'utf8');
  assert.equal(template, repo); assert.ok(!template.includes('/etc/cyf-agent-runtime-v1'));
  assert.ok(template.includes('EnvironmentFile=/home/isp/conf/cyf-agent-runtime-v1/%i.conf'));
});
test('actual CLI validate consumes file and validates enabled image credential without execution', async t => {
  const { root, path } = await fixture(t, {});
  const raw = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: 'rti_fixture', tenantId: 'tenant-a', clientId: 'client-a', canonicalAgentId: 'agent-a' };
  const manifest = { ...raw, manifestSha256: digestManifest(raw) }; const subject = runtimeSubjectKey(manifest);
  const profile = { profileId: 'fixture', agentId: 'agent-a', codexHome: join(root, 'home'), codexWorkdir: join(root, 'work'), codexBin: '/usr/bin/true',
    controlledImageHttpEnabled: true, controlledImageHttpApiKeyEnv: key, controlledImageHttpEndpoint: 'https://provider.example.invalid',
    controlledImageHttpBindingId: 'fixture-binding', controlledImageHttpBindingEpoch: '1', controlledImageHttpModelId: 'fixture-image', controlledImageHttpLedgerRoot: join(root, 'ledger') };
  const manifestPath = join(root, 'manifest.json'), profilePath = join(root, 'profile.json'), configPath = join(root, 'host.json');
  for (const [p, data] of [[manifestPath, manifest], [profilePath, profile], [path, { configVersion: 1, subjects: { [subject]: { [key]: 'synthetic-secret' } } }],
    [configPath, { configVersion: 1, hostId: 'fixture-host', stateRoot: join(root, 'host'), agents: [{ manifestPath, profilePath, stateRoot: join(root, 'agent-state') }] }]])
    await writeFile(p, JSON.stringify(data), { mode: 0o600 });
  const run = env => spawnSync(process.execPath, [new URL('../agent-runtime.mjs', import.meta.url).pathname, 'validate', '--config', configPath], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.notEqual(run({}).status, 0); const result = run({ CYF_RUNTIME_PROVIDER_ENVIRONMENTS_FILE: path });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).valid, true);
  assert.ok(!result.stdout.includes('synthetic-secret'));
});

test('shared skill binding references reuse only existing private full-subject credentials; missing new binding is UNAVAILABLE', async t => {
  const a = { subjectKey: 'a'.repeat(64), manifest: { canonicalAgentId: 'agent-a' }, profile: { agentId: 'agent-a' } }
  const b = { subjectKey: 'b'.repeat(64), manifest: { canonicalAgentId: 'agent-b' }, profile: { agentId: 'agent-b' } }
  const { root, path } = await fixture(t, { [a.subjectKey]: { IMAGE_TOKEN: 'synthetic-a' } })
  const bindings = join(root, 'skill-bindings.json')
  await writeFile(bindings, JSON.stringify({ schemaVersion: 1, providers: { shared: { adapter: 'image-http', endpoint: 'https://images.example.invalid', model: 'gpt-image-1', credentialEnv: 'IMAGE_TOKEN', revision: '1' } }, subjects: { 'agent-a': { providerAliases: { image: 'shared' } }, 'agent-b': { providerAliases: { image: 'shared' } } }, costInfoOverrides: {} }), { mode: 0o600 })
  a.profile.skillBindingsFile = bindings; b.profile.skillBindingsFile = bindings
  const environments = await readRuntimeProviderEnvironments(path, [a, b])
  assert.equal(environments.get(a.subjectKey).IMAGE_TOKEN, 'synthetic-a')
  assert.equal(environments.get(b.subjectKey), undefined)
  const { SkillBindings } = await import('../../codex-bridge/skill-bindings.mjs')
  const missing = new SkillBindings({ file: bindings, credentialEnvironment: environments.get(b.subjectKey) })
  assert.equal((await missing.resolve({ scope: { agentId: 'agent-b' }, alias: 'image' })).ready, false)
  await writeFile(path, JSON.stringify({ configVersion: 1, subjects: { [a.subjectKey]: { IMAGE_TOKEN: 'synthetic-a', HOME: 'injection' } } }))
  await assert.rejects(readRuntimeProviderEnvironments(path, [a, b]), /RUNTIME_PROVIDER_CONFIG_INVALID/)
})

test('installed skill service defaults cover future Agents in the same tenant/client without individual enrollment', async t => {
  const make = (name, tenantId = 't', clientId = 'c') => ({ subjectKey: createHash('sha256').update(name).digest('hex'),
    manifest: { tenantId, clientId, canonicalAgentId: name }, profile: { agentId: name } })
  const a = make('a'), b = make('future-agent'), foreignTenant = make('foreign', 'other'), foreignClient = make('other-client', 't', 'other')
  const { root, path } = await fixture(t, { [a.subjectKey]: { IMAGE_TOKEN: 'synthetic-own' } })
  const file = join(root, 'bindings.json')
  const binding = { adapter: 'image-http', endpoint: 'https://image.example.invalid', model: 'image-model', credentialEnv: 'IMAGE_TOKEN', revision: '1' }
  const publicConfig = { schemaVersion: 1, providers: { shared: binding, private: { ...binding, revision: '2' } }, subjects: {},
    scopes: [{ tenantId: 't', clientId: 'c', providerAliases: { image: 'shared' } }] }
  await writeFile(file, JSON.stringify(publicConfig), { mode: 0o600 })
  const privateConfig = { configVersion: 1, subjects: { [a.subjectKey]: { IMAGE_TOKEN: 'synthetic-own' } },
    scopes: [{ tenantId: 't', clientId: 'c', environment: { IMAGE_TOKEN: 'synthetic-shared' } }] }
  await writeFile(path, JSON.stringify(privateConfig))
  const agents = [a, b, foreignTenant, foreignClient]; agents.forEach(agent => { agent.profile.skillBindingsFile = file })
  const environments = await readRuntimeProviderEnvironments(path, agents)
  assert.equal(environments.get(a.subjectKey).IMAGE_TOKEN, 'synthetic-own')
  assert.equal(environments.get(b.subjectKey).IMAGE_TOKEN, 'synthetic-shared')
  assert.equal(environments.has(foreignTenant.subjectKey), false)
  assert.equal(environments.has(foreignClient.subjectKey), false)
  const { SkillBindings, parseSkillBindings } = await import('../../codex-bridge/skill-bindings.mjs')
  const resolve = async agent => new SkillBindings({ file, credentialEnvironment: environments.get(agent.subjectKey) }).resolve({ scope: { ...agent.manifest, agentId: agent.profile.agentId }, alias: 'image' })
  assert.equal((await resolve(b)).ready, true)
  assert.equal((await resolve(foreignTenant)).ready, false)
  assert.equal((await resolve(foreignClient)).ready, false)
  assert.notEqual((await resolve(a)).digest, (await resolve(b)).digest)
  publicConfig.subjects[b.profile.agentId] = { providerAliases: { image: 'private' } }
  await writeFile(file, JSON.stringify(publicConfig))
  assert.equal((await readRuntimeProviderEnvironments(path, agents)).has(b.subjectKey), false, 'private override must not borrow shared provider credential')
  const duplicate = structuredClone(publicConfig); duplicate.scopes.push(duplicate.scopes[0])
  assert.throws(() => parseSkillBindings(duplicate), /SKILL_BINDINGS_INVALID/)
  privateConfig.scopes.push(privateConfig.scopes[0]); await writeFile(path, JSON.stringify(privateConfig))
  await assert.rejects(readRuntimeProviderEnvironments(path, agents), /RUNTIME_PROVIDER_CONFIG_INVALID/)
  privateConfig.scopes.pop(); privateConfig.scopes[0].environment.HOME = 'injection'; await writeFile(path, JSON.stringify(privateConfig))
  await assert.rejects(readRuntimeProviderEnvironments(path, agents), /RUNTIME_PROVIDER_CONFIG_INVALID/)
})
