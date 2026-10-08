// Offline source-entry acceptance; no installed services, package install or Provider calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '../../..');
const text = path => readFileSync(resolve(repo, path), 'utf8');
const dictionary = (source, name) => Object.fromEntries([...source.match(new RegExp(`declare -A ${name}=\\(\\n([\\s\\S]*?)\\n\\)`))[1]
  .matchAll(/\["([^"]+)"\]="([^"]+)"/g)].map(match => [match[1], match[2]]));

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'ur01-install-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appRoot = resolve(root, 'artifact-parent'); const calls = resolve(root, 'other-component-called');
  for (const path of ['shell', 'conf/cyf-agent-runtime-v1', 'home', 'bin', 'artifact-parent/cyf-agent-runtime-v1']) mkdirSync(resolve(root, path), { recursive: true });
  // Actual dispatcher/current Runtime source, with test-only no-effects generic helpers.
  // No actual common.sh or package/service helper can be invoked by these tests.
  copyFileSync(resolve(repo, 'install.sh'), resolve(root, 'install.sh'));
  copyFileSync(resolve(repo, 'shell/cyf_agent_runtime_v1_install.sh'), resolve(root, 'shell/cyf_agent_runtime_v1_install.sh'));
  copyFileSync(resolve(repo, 'conf/cyf-agent-runtime-v1/install.sh'), resolve(root, 'conf/cyf-agent-runtime-v1/install.sh'));
  chmodSync(resolve(root, 'conf/cyf-agent-runtime-v1/install.sh'), 0o755);
  writeFileSync(resolve(root, 'shell/common.sh'), 'check_root() { :; }\ndetect_os() { :; }\nshow_os_info() { :; }\n');
  writeFileSync(resolve(root, 'shell/nginx_install.sh'), `#!/bin/bash\nprintf 'called\\n' > '${calls}'\nexit 0\n`);
  const node = resolve(root, 'bin/node'); const npm = resolve(root, 'bin/npm'); const python = resolve(root, 'bin/python');
  writeFileSync(node, '#!/bin/bash\nprintf "99.0.0\\n"\n');
  for (const path of [npm, python]) writeFileSync(path, '#!/bin/bash\nexit 37\n');
  for (const path of [node, npm, python]) chmodSync(path, 0o755);
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(root, 'home'), LANG: 'C.UTF-8',
    CYF_RUNTIME_V1_INSTANCE: 'offline-main', CYF_RUNTIME_V1_INSTALL_TEST_MODE: '1', CYF_RUNTIME_V1_TEST_APP_ROOT: appRoot,
    CYF_RUNTIME_V1_NODE_BIN: node, CYF_RUNTIME_V1_NPM_CLI: npm, CYF_RUNTIME_V1_PYTHON_BIN: python,
    OPENCLAW_API_KEY: 'obsolete-secret-must-not-be-used', START_CODEX_WS_AGENT: 'y' };
  return { root, calls, appRoot, env, run: (args, extraEnv = {}, input = 'y\n') => spawnSync('/bin/bash', [resolve(root, 'install.sh'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...env, ...extraEnv }, input }) };
}

test('registry/profile/list converge only the Agent entry; unrelated component mappings and profile order remain', () => {
  const source = text('install.sh'); const mapping = dictionary(source, 'COMPONENT_SCRIPTS'); const profiles = dictionary(source, 'PROFILES');
  assert.equal(mapping['codex-ws-agent'], undefined); assert.equal(mapping.codex, undefined);
  assert.equal(mapping['cyf-agent-runtime-v1'], 'cyf_agent_runtime_v1_install.sh'); assert.equal(mapping['runtime-v1'], mapping['cyf-agent-runtime-v1']);
  const unrelated = { jdk: 'jdk', java: 'jdk', maven: 'maven', mvn: 'maven', node: 'node', nodejs: 'node', python: 'python', py: 'python',
    git: 'git', mysql: 'mysql', redis: 'redis', nginx: 'nginx', php: 'php', rabbitmq: 'rabbitmq', openldap: 'openldap', ldap: 'openldap',
    elasticsearch: 'elasticsearch', es: 'elasticsearch', jenkins: 'jenkins', nexus: 'nexus', pureftpd: 'pureftpd', ftp: 'pureftpd', xray: 'xray', 'xray-core': 'xray' };
  for (const [key, component] of Object.entries(unrelated)) assert.equal(mapping[key], `${component}_install.sh`, key);
  assert.equal(Object.keys(mapping).length, Object.keys(unrelated).length + 2);
  assert.deepEqual(profiles, { 'web-server': 'nginx php mysql redis', 'dev-env': 'jdk maven git node python', 'db-server': 'mysql redis rabbitmq',
    'ci-cd': 'jdk maven git jenkins nexus', agent: 'cyf-agent-runtime-v1',
    full: 'jdk maven node python git mysql redis nginx php rabbitmq openldap elasticsearch jenkins nexus pureftpd cyf-agent-runtime-v1' });
  assert.match(text('shell/sh_list.txt'), /^cyf_agent_runtime_v1_install\.sh /m);
  assert.doesNotMatch(text('shell/sh_list.txt'), /^codex_ws_agent_install\.sh /m);
});

test('legacy dispatcher names fail before any component call even in a mixed request', t => {
  const f = fixture(t);
  for (const args of [['codex'], ['codex-ws-agent'], ['nginx', 'codex'], ['codex-ws-agent', 'nginx']]) {
    const result = f.run(args);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`); assert.match(result.stderr, /UNIFIED_RUNTIME_ENTRY_REQUIRED/);
    assert.equal(existsSync(f.calls), false); assert.deepEqual(readdirSync(resolve(f.appRoot, 'cyf-agent-runtime-v1')), []);
    assert.equal(`${result.stdout}${result.stderr}`.includes('obsolete-secret-must-not-be-used'), false);
  }
});

test('agent profile/canonical component/current alias reach the real pinned Runtime installer and propagate its rejection', t => {
  const f = fixture(t);
  for (const args of [['--profile', 'agent'], ['cyf-agent-runtime-v1'], ['runtime-v1']]) {
    const result = f.run(args);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Runtime requires pinned Node 20\.20\.2/);
    assert.equal(existsSync(f.calls), false); assert.deepEqual(readdirSync(resolve(f.appRoot, 'cyf-agent-runtime-v1')), []);
    assert.equal(`${result.stdout}${result.stderr}`.includes('obsolete-secret-must-not-be-used'), false);
  }
  const missing = f.run(['--profile', 'agent'], { CYF_RUNTIME_V1_INSTANCE: '' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /CYF_RUNTIME_V1_INSTANCE must be a safe non-empty instance name/);
  assert.deepEqual(readdirSync(resolve(f.appRoot, 'cyf-agent-runtime-v1')), []);
});

test('interactive Runtime rejection and unrelated component failure propagate without changing their install mapping', t => {
  const f = fixture(t);
  const menu = f.run(['--select'], {}, '');
  const selection = menu.stdout.match(/(?:^|\n)\s*(\d+)\) cyf-agent-runtime-v1(?:\n|$)/);
  assert.ok(selection, menu.stdout);
  assert.equal(menu.stdout.includes('codex-ws-agent'), false);
  const failed = f.run(['--select'], {}, `${selection[1]}\ny\n`);
  assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stderr, /Runtime requires pinned Node 20\.20\.2/);
  assert.equal(existsSync(f.calls), false);
  assert.deepEqual(readdirSync(resolve(f.appRoot, 'cyf-agent-runtime-v1')), []);
  writeFileSync(resolve(f.root, 'shell/nginx_install.sh'), '#!/bin/bash\nexit 17\n');
  assert.equal(f.run(['nginx']).status, 1, 'existing non-Agent component failure cannot be reported as process success');
});

test('help/list expose current Runtime prerequisites without installing anything', t => {
  const f = fixture(t);
  for (const args of [['--help'], ['--list']]) {
    const result = f.run(args); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agent/); assert.match(result.stdout, /Runtime/);
    assert.equal(existsSync(f.calls), false); assert.deepEqual(readdirSync(resolve(f.appRoot, 'cyf-agent-runtime-v1')), []);
    assert.equal(result.stdout.includes('codex-ws-agent'), false);
  }
});

test('no legacy unit source remains; current single-artifact units and installation guides name only the unified path', () => {
  for (const name of ['systemd/codex-ws-agent.service', 'systemd/codex-ws-agent@.service']) assert.equal(existsSync(resolve(repo, name)), false);
  const current = text('systemd/cyf-agent-runtime-v1@.service');
  assert.equal(current, text('conf/cyf-agent-runtime-v1/systemd/cyf-agent-runtime-v1@.service'));
  assert.match(current, /^ExecStart=.*\/node\/bin\/node .*\/runtime\/agent-runtime\.mjs run --config .*%i\.host\.json$/m);
  assert.equal(current.includes('/usr/bin/env node'), false); assert.equal(current.includes('agent-client.mjs'), false);
  const guide = text('skills/codex-ws-agent-install/SKILL.md'); assert.match(guide, /shell\/cyf_agent_runtime_v1_install\.sh/);
  assert.equal(guide.includes('shell/codex_ws_agent_install.sh'), false); assert.equal(guide.includes('/home/isp/bin/codex_ws_agent.sh start'), false);
  const grouped = text('skills/install-profile/SKILL.md');
  assert.match(grouped, /`agent`: `cyf-agent-runtime-v1`/);
  assert.match(grouped, /shell\/cyf_agent_runtime_v1_install\.sh/);
  assert.equal(grouped.includes('node codex-ws-agent'), false); assert.equal(grouped.includes('OPENCLAW_API_KEY'), false);
  assert.match(grouped, /MYSQL_ROOT_PASSWORD/); assert.match(grouped, /nginx php mysql redis/);
  const historical = text('conf/codex-ws-agent/install-candidate/INSTALL-CANDIDATE.md'); assert.match(historical, /NOT an installer/);
  assert.equal(historical.includes('--installer shell/codex_ws_agent_install.sh'), false);
  assert.equal(historical.includes('node current/agent-client.mjs'), false);
});
