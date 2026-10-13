import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const runtime = 'conf/cyf-agent-runtime-v1/';
const managedRoot = '/home/isp/state/cyf-agent-runtime-v1-managed/unified';

test('hosting example and tmpfiles use the same canonical private state root', async () => {
  const example = JSON.parse(await read(runtime + 'hosting-control.example.json'));
  assert.equal(example.managedRoot, managedRoot);
  const tmpfiles = await read(runtime + 'systemd/cyf-agent-runtime-v1-hosting.tmpfiles.conf.example');
  for (const path of [managedRoot.slice(0, managedRoot.lastIndexOf('/')), managedRoot]) {
    assert.ok(tmpfiles.split('\n').some(line => line === `d ${path} 0700 root root - -`));
  }
  assert.doesNotMatch(tmpfiles, /\/var\/lib\/cyf/);
  assert.doesNotMatch(tmpfiles, /^\s*[LLaAbB]\s/m);
});

test('both packaged and root service templates use the external configuration root', async () => {
  const service = await read(runtime + 'systemd/cyf-agent-runtime-v1@.service');
  assert.equal(service, await read('systemd/cyf-agent-runtime-v1@.service'));
  assert.match(service, /^EnvironmentFile=\/home\/isp\/conf\/cyf-agent-runtime-v1\/%i\.conf$/m);
  assert.doesNotMatch(service, /\/etc\/cyf-agent-runtime-v1|\/var\/lib\/cyf/);
});

test('MySQL actual installer-generated config and template both retain binlog for three days', async () => {
  const installer = await read('shell/mysql_install.sh');
  const generated = installer.match(/^cat > \$INSTALL_PREFIX\/my\.cnf << EOF\n([\s\S]*?)^EOF$/m);
  assert.ok(generated, 'inspect the actual config heredoc without executing the installer');
  for (const config of [generated[1], await read('conf/mysql/my.cnf')]) {
    const active = config.split('\n').filter(line => !/^\s*[#;]/.test(line)).join('\n');
    const values = [...active.matchAll(/^\s*binlog_expire_logs_seconds\s*=\s*(\d+)\s*$/gm)];
    assert.equal(values.length, 1);
    assert.equal(values[0][1], '259200');
    assert.doesNotMatch(active, /^\s*expire_logs_days\s*=/m);
  }
});
