import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArguments, prepareEnrollment } from '../shell/cyf_runtime_enrollment_prepare.mjs';
import { validateManifest, runtimeSubjectKey } from '../conf/cyf-agent-runtime-v1/lib/manifest.mjs';

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'cyf-enrollment-test-'));
  await chmod(parent, 0o700); t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, input: { tenantId: 'region-east', clientId: 'client-test', canonicalAgentId: 'agent-test', output: join(parent, 'candidate'), expiresAt: Date.now() + 60000 } };
}

test('candidate matches real manifest and API digest formats; no secrets in handoff', async t => {
  const { input } = await fixture(t); const result = await prepareEnrollment(input);
  const json = async name => JSON.parse(await readFile(join(input.output, name), 'utf8'));
  const manifest = validateManifest(await json('manifest.json'));
  const handoff = await json('handoff.json'); const request = await json('installation-request.json');
  const secret = (await readFile(join(input.output, 'enrollment-secret'), 'utf8')).trim();
  assert.deepEqual(handoff, { scope: { tenantId: input.tenantId, clientId: input.clientId, canonicalAgentId: input.canonicalAgentId }, request });
  assert.equal(manifest.tenantId, 'region-east'); assert.equal(manifest.manifestSha256, `sha256:${request.manifestSha256}`);
  assert.match(request.installationId, /^rti_[a-f0-9]{32}$/);
  assert.equal(request.enrollmentSecretSha256, createHash('sha256').update(secret).digest('hex'));
  assert.equal((await readFile(join(input.output, 'subject-key.txt'), 'utf8')).trim(), runtimeSubjectKey(manifest));
  assert.equal(JSON.stringify(handoff).includes(secret), false); assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await lstat(input.output)).mode & 0o777, 0o700);
  for (const file of result.files) assert.equal((await lstat(join(input.output, file))).mode & 0o777, 0o600);
  assert.equal(result.registered, false); assert.equal(result.enrolled, false);
});

test('never overwrites an existing candidate', async t => {
  const { input } = await fixture(t); await prepareEnrollment(input);
  const before = await readFile(join(input.output, 'enrollment-secret'));
  await assert.rejects(prepareEnrollment(input), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(input.output, 'enrollment-secret')), before);
});

test('rejects symlink parent and output without mutating target', async t => {
  const { input, parent } = await fixture(t);
  await symlink(parent, join(parent, 'link'));
  await assert.rejects(prepareEnrollment({ ...input, output: join(parent, 'link', 'candidate') }), { code: 'PREPARE_PARENT_UNSAFE' });
  await symlink(parent, input.output);
  await assert.rejects(prepareEnrollment(input), { code: 'EEXIST' });
});

test('rejects unsafe parent permissions', async t => {
  const { input, parent } = await fixture(t); await chmod(parent, 0o777);
  await assert.rejects(prepareEnrollment(input), { code: 'PREPARE_PARENT_UNSAFE' });
});

test('invalid scope/expiry/path cannot create candidate', async t => {
  const { input } = await fixture(t);
  for (const patch of [{tenantId:''}, {tenantId:'x\ny'}, {clientId:'x'.repeat(51)}, {canonicalAgentId:' agent'}, {expiresAt:0}, {expiresAt:Infinity}, {output:'relative'}]) {
    await assert.rejects(prepareEnrollment({...input,...patch}));
  }
  await assert.rejects(lstat(input.output), {code:'ENOENT'});
});

test('explicit CLI arguments only, no default identity or expiry', () => {
  const args = ['--tenant-id','0','--client-id','c','--agent-id','a','--output','/tmp/test','--expires-at','1791880000000'];
  assert.equal(parseArguments(args).tenantId, '0');
  for (const invalid of [[], args.slice(0,-1), [...args,'--tenant-id','other'], [...args,'--token','secret'], args.map(x => x === '1791880000000' ? '1e12' : x)]) assert.throws(() => parseArguments(invalid));
});

test('CLI produces only public summary, and errors do not echo supplied values', async t => {
  const { input } = await fixture(t);
  const script = fileURLToPath(new URL('../shell/cyf_runtime_enrollment_prepare.mjs', import.meta.url));
  const args = ['--tenant-id',input.tenantId,'--client-id',input.clientId,'--agent-id',input.canonicalAgentId,'--output',input.output,'--expires-at',String(input.expiresAt)];
  const proc = spawnSync(process.execPath, [script,...args], {encoding:'utf8'});
  assert.equal(proc.status,0,proc.stderr); assert.equal(JSON.parse(proc.stdout).prepared,true);
  const secret = (await readFile(join(input.output,'enrollment-secret'),'utf8')).trim();
  assert.equal((proc.stdout+proc.stderr).includes(secret),false);
  const bad = spawnSync(process.execPath,[script,'--secret','do-not-log-me'],{encoding:'utf8'});
  assert.equal(bad.status,1); assert.equal((bad.stdout+bad.stderr).includes('do-not-log-me'),false);
});

test('guide profile/host snippet and prepared secret are accepted by actual Runtime readers', async t => {
  const { input, parent } = await fixture(t); await prepareEnrollment(input);
  const { mkdir, writeFile } = await import('node:fs/promises');
  const cfg = join(parent, 'config'); const state = join(parent, 'state');
  await mkdir(cfg, { mode: 0o700 });
  for (const leaf of ['host', 'subject/runtime', 'subject/workspace', 'subject/private-runs']) await mkdir(join(state,leaf),{recursive:true,mode:0o700});
  const guide = await readFile(new URL('../docs/cyf-agent-runtime-v1-self-host.md',import.meta.url),'utf8');
  const snippet = guide.split("--input-type=module <<'JS'\n")[1]?.split('\nJS')[0];
  assert.ok(snippet,'guide profile generator exists');
  const env={...process.env,CFG:cfg,SUBJECT:'subject',CANDIDATE:input.output,STATE:state,CODEX_BIN:'/usr/bin/false',
    CODEX_HOME_PATH:join(parent,'private-codex-home'),CODEX_MODEL:'fixture-model',API_ORIGIN:'https://fixture.invalid',
    INSTANCE:'fixture',HOST_ID:'fixture-host',AGENT_ID:input.canonicalAgentId};
  const proc=spawnSync(process.execPath,['--input-type=module'],{input:snippet,env,encoding:'utf8'});
  assert.equal(proc.status,0,proc.stderr);
  const {readRuntimeHostConfig}=await import('../conf/cyf-agent-runtime-v1/lib/manifest.mjs');
  const {readEnrollmentSecret}=await import('../conf/cyf-agent-runtime-v1/lib/security.mjs');
  const host=await readRuntimeHostConfig(join(cfg,'fixture.host.json'));
  assert.equal(host.agents[0].manifest.tenantId,input.tenantId);
  assert.equal(host.agents[0].profile.nativeConversationTextFileEnabled,true);
  assert.equal(host.agents[0].subjectKey,(await readFile(join(input.output,'subject-key.txt'),'utf8')).trim());
  const secret=await readEnrollmentSecret({CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE:join(input.output,'enrollment-secret')});
  const request=JSON.parse(await readFile(join(input.output,'installation-request.json'),'utf8'));
  assert.equal(createHash('sha256').update(secret.value).digest('hex'),request.enrollmentSecretSha256);
});
