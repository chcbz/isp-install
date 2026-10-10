import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostingFixture, code } from './hosting-fixture.mjs';
import { canonicalHostingPath, readHostingConfig, validateHostingConfig } from '../lib/hosting-config.mjs';
import { readRuntimeHostConfig } from '../lib/manifest.mjs';
import { normalizeProfile, profileConfigurationErrors } from '../../codex-ws-agent/agent-client.mjs';
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

async function configFixture(t) {
  const f = await hostingFixture(t); const config = structuredClone(f.controlConfig);
  const bin = resolve(f.root, 'trusted-codex'); await copyFile('/usr/bin/true', bin); await chmod(bin, 0o755);
  config.template.profile.codexBin = bin;
  const path = resolve(f.root, 'hosting.json');
  const save = () => writeFile(path, JSON.stringify(config), { mode: 0o600 }); await save();
  return { ...f, config, path, bin, save, read: () => readHostingConfig(path, f.hostConfig) };
}

test('operator example is valid standalone managed template, with correct schema/profile and exact API GID pair', async () => {
  const example = JSON.parse(await readFile(resolve(sourceRoot, 'hosting-control.example.json'), 'utf8'));
  assert.equal(validateHostingConfig(example), example);
  const profile = normalizeProfile({ ...example.template.profile, profileId: 'example', agentId: 'agt_example', codexHome: '/private/home', codexWorkdir: '/private/work' }, {}, 0, { isolated: true });
  assert.deepEqual(profileConfigurationErrors(profile), []);
  const guide = await readFile(resolve(sourceRoot, 'HOSTING-CONTROL.md'), 'utf8');
  assert.match(guide, /agent\.hosting-rent\.managed\.socket-group-gid=1000/); assert.equal(example.socketGid, 1000);
  assert.equal(example.template.profile.nativeConversationHttpPollEnabled, false);
});

test('hosting config read validates private template and binary without executing, creating HOME or mutating journal', async t => {
  const f = await configFixture(t); const before = await readdir(f.config.managedRoot);
  const result = await f.read(); assert.deepEqual(result, f.config);
  assert.deepEqual(await readdir(f.config.managedRoot), before);
  assert.equal(result.template.profile.codexHome, undefined);
});

test('optional host schema is strict and backwards static source remains valid; hosting path loads frozen local config', async t => {
  const f = await configFixture(t); const entries = [];
  for (let i = 0; i < f.peers.length; i++) {
    const agent = f.peers[i]; const manifestPath = resolve(f.root, `manifest-${i}.json`); const profilePath = resolve(f.root, `profile-${i}.json`);
    await writeFile(manifestPath, JSON.stringify(agent.manifest), { mode: 0o600 }); await writeFile(profilePath, JSON.stringify(agent.profile), { mode: 0o600 });
    entries.push({ manifestPath, profilePath, stateRoot: agent.stateRoot });
  }
  const path = resolve(f.root, 'host.json'); const raw = { configVersion: 1, hostId: f.hostConfig.hostId, stateRoot: f.hostConfig.stateRoot, agents: entries };
  const read = async value => { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return readRuntimeHostConfig(path); };
  assert.equal((await read(raw)).hostingControl, undefined);
  const loaded = await read({ ...raw, hostingControlPath: f.path }); assert.deepEqual(loaded.hostingControl, f.config); assert.equal(Object.isFrozen(loaded.hostingControl.template), true);
  await assert.rejects(read({ ...raw, hostingControlPath: f.path, hostingControl: {} }), code('RUNTIME_HOST_CONFIG_INVALID'));
});

test('managed template denies identity, credential, HOME, path, command and environment inheritance fields', async t => {
  const f = await configFixture(t);
  for (const field of ['profileId', 'agentId', 'codexHome', 'codexWorkdir', 'workspaceFileRootDir', 'apiKey', 'runtimeAuthorization', 'runtimeProviderEnvironment', 'command']) {
    const value = structuredClone(f.config); value.template.profile[field] = 'synthetic-never-accepted'; assert.throws(() => validateHostingConfig(value), code('HOSTING_TEMPLATE_INVALID'));
  }
  for (const key of ['HOME', 'CODEX_HOME', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'CYF_MANAGED_PROVIDER_', 'CYF_MANAGED_PROVIDER_bad']) {
    const value = structuredClone(f.config); value.template.providerEnvironment[key] = 'synthetic'; assert.throws(() => validateHostingConfig(value), code('HOSTING_TEMPLATE_INVALID'));
  }
  for (const change of [{ configVersion: 2 }, { socketGid: -1 }, { socketGid: 1.1 }, { enrollmentTtlMs: 0 }, { scopes: [] }, { unknown: true }]) assert.throws(() => validateHostingConfig({ ...f.config, ...change }));
  const duplicate = structuredClone(f.config); duplicate.scopes.push(duplicate.scopes[0]); assert.throws(() => validateHostingConfig(duplicate), code('HOSTING_CONFIG_SCOPE_DUPLICATE'));
});

test('provider config requires one exact independent provider with managed env, no raw auth/include/alternate provider', async t => {
  const f = await configFixture(t); const toml = f.config.template.codexConfig;
  for (const value of ['', 'model_provider = "openai"\n', toml.replace('env_key = "CYF_MANAGED_PROVIDER_API_KEY"', 'env_key = "OPENAI_API_KEY"'),
    toml.replace('https://', 'http://'), toml.replace('no-network.invalid', 'user:secret@no-network.invalid'), toml.replace('/v1"', '/v1?token=synthetic"'),
    toml.replace('requires_openai_auth = false', 'requires_openai_auth = true'), toml + 'requires_openai_auth = true\n',
    toml + '[model_providers.other]\nenv_key = "OPENAI_API_KEY"\n', toml + 'include = "/other/user/home"\n',
    toml + 'http_headers = { Authorization = "raw-secret" }\n', toml + 'env_key = "CYF_MANAGED_PROVIDER_API_KEY"\n',
    toml.replace('model_provider = "managed"', 'model_provider = "different"'), toml + 'wire_api = "chat"\n',
    toml.replace('env_key = "CYF_MANAGED_PROVIDER_API_KEY"', 'env_key = "CYF_MANAGED_PROVIDER_MISSING"')]) {
    const config = structuredClone(f.config); config.template.codexConfig = value; assert.throws(() => validateHostingConfig(config));
  }
});

test('config files, binary, private roots and socket parent must be canonical, owned and correctly permissioned', async t => {
  const f = await configFixture(t);
  await chmod(f.path, 0o640); await assert.rejects(f.read()); await chmod(f.path, 0o600);
  const alias = resolve(f.root, 'alias.json'); await symlink(f.path, alias); await assert.rejects(readHostingConfig(alias, f.hostConfig), code('HOSTING_CONFIG_PATH_UNSAFE'));
  const directoryAlias = resolve(f.root, 'directory-alias'); await symlink(resolve(f.root, 'socket'), directoryAlias);
  await assert.rejects(canonicalHostingPath(resolve(directoryAlias, 'missing-child')), code('HOSTING_CONFIG_PATH_UNSAFE'));
  await chmod(f.bin, 0o777); await assert.rejects(f.read(), code('HOSTING_TEMPLATE_BINARY_UNSAFE')); await chmod(f.bin, 0o755);
  const binAlias = resolve(f.root, 'binary-alias'); await symlink(f.bin, binAlias); f.config.template.profile.codexBin = binAlias; await f.save(); await assert.rejects(f.read(), code('HOSTING_CONFIG_PATH_UNSAFE'));
  f.config.template.profile.codexBin = f.bin; await f.save();
  await chmod(f.config.managedRoot, 0o750); await assert.rejects(f.read(), code('HOSTING_CONFIG_ROOT_UNSAFE')); await chmod(f.config.managedRoot, 0o700);
  await chmod(resolve(f.root, 'socket'), 0o770); await assert.rejects(f.read(), code('HOSTING_SOCKET_PARENT_UNSAFE')); await chmod(resolve(f.root, 'socket'), 0o750);
  assert.deepEqual(await f.read(), f.config);
});

test('managedRoot cannot alias host, static subject, HOME/workdir or socket parent; malformed profile fails pure validation', async t => {
  const f = await configFixture(t); const original = f.config.managedRoot;
  for (const root of [f.hostConfig.stateRoot, f.peers[0].stateRoot, f.peers[0].profile.codexHome, f.peers[0].profile.codexWorkdir, resolve(f.root, 'socket'), f.root]) {
    f.config.managedRoot = root; await f.save(); await assert.rejects(f.read(), code('HOSTING_CONFIG_ROOTS_OVERLAP'));
  }
  f.config.managedRoot = original; f.config.template.profile.codexSandbox = 'bad'; await f.save(); await assert.rejects(f.read(), code('HOSTING_TEMPLATE_PROFILE_INVALID'));
});

test('single source installer/validator explicitly collate control payload and tmpfiles; source service parity and reboot ordering', async () => {
  const install = await readFile(resolve(sourceRoot, 'install.sh'), 'utf8'); const validate = await readFile(resolve(sourceRoot, 'validate.sh'), 'utf8');
  for (const path of ['lib/hosting-config.mjs', 'lib/hosting-wire.mjs', 'lib/hosting-control.mjs', 'lib/hosting-server.mjs', 'hosting-control.example.json', 'HOSTING-CONTROL.md', 'systemd/cyf-agent-runtime-v1-hosting.tmpfiles.conf.example']) {
    assert.ok(install.includes(path), path); assert.ok(validate.includes(path), path); assert.ok((await readFile(resolve(sourceRoot, path))).length > 0);
  }
  assert.doesNotMatch(install, /(?:^|\n)\s*(?:systemctl|systemd-tmpfiles|chown)\s/m);
  const service = await readFile(resolve(sourceRoot, 'systemd/cyf-agent-runtime-v1@.service'), 'utf8');
  const rootService = await readFile(resolve(sourceRoot, '../../systemd/cyf-agent-runtime-v1@.service'), 'utf8'); assert.equal(service, rootService);
  assert.match(service, /After=.*systemd-tmpfiles-setup\.service/);
  const tmpfiles = await readFile(resolve(sourceRoot, 'systemd/cyf-agent-runtime-v1-hosting.tmpfiles.conf.example'), 'utf8');
  assert.match(tmpfiles, /d \/run\/cyf-agent-runtime-v1\/unified 0750 root isp/); assert.match(tmpfiles, /d \/var\/lib\/cyf-agent-runtime-v1-managed\/unified 0700 root root/);
});
