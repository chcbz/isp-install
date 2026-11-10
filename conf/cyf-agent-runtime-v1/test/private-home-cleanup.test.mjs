import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanStoppedCodexHome } from '../lib/private-home-cleanup.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'private-home-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = resolve(root, 'home'), repository = resolve(root, 'shared-project');
  await mkdir(home, { mode: 0o700 }); await mkdir(repository, { mode: 0o700 });
  await mkdir(resolve(repository, '.git')); await writeFile(resolve(repository, '.git/history'), 'public commits');
  await writeFile(resolve(repository, 'source'), 'public code with uncommitted work');
  await mkdir(resolve(home, 'skills')); await writeFile(resolve(home, 'skills/public-skill'), 'retained package');
  const agent = { profile: { codexHome: home, codexWorkdir: repository } };
  return { root, home, repository, agent, publicFiles: { 'config.toml': 'model = "test"\n' } };
}

test('stopped HOME cleanup removes all private classes, rebuilds trusted public files and leaves project history untouched', async t => {
  const f = await fixture(t);
  for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'auth.json', 'config.toml', 'history.jsonl', 'unknown-private-format'])
    await writeFile(resolve(f.home, name), 'old owner private');
  for (const name of ['sessions', 'shell_snapshots', 'memories', 'tmp', 'logs']) {
    await mkdir(resolve(f.home, name)); await writeFile(resolve(f.home, name, 'private'), 'private');
  }
  await symlink(f.repository, resolve(f.home, 'workspace-link'));
  f.publicFiles['auth.json'] = '{"public":"synthetic operator credential"}\n';
  assert.deepEqual(await cleanStoppedCodexHome({ ...f, publicRepositoryRoots: [f.repository] }), { homeCleaned: true });
  assert.deepEqual((await readdir(f.home)).sort(), ['auth.json', 'config.toml', 'skills']);
  for (const [name, bytes] of Object.entries(f.publicFiles)) {
    assert.equal(await readFile(resolve(f.home, name), 'utf8'), bytes);
    assert.equal((await stat(resolve(f.home, name))).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(resolve(f.home, 'skills/public-skill'), 'utf8'), 'retained package');
  assert.equal(await readFile(resolve(f.repository, '.git/history'), 'utf8'), 'public commits');
  assert.equal(await readFile(resolve(f.repository, 'source'), 'utf8'), 'public code with uncommitted work');
  await cleanStoppedCodexHome({ ...f, publicRepositoryRoots: [f.repository] });
  assert.deepEqual((await readdir(f.home)).sort(), ['auth.json', 'config.toml', 'skills']);
});

test('HOME cleanup rejects public-repository overlap and missing public baseline before deleting anything', async t => {
  const f = await fixture(t); await writeFile(resolve(f.home, 'private'), 'still present');
  for (const repository of [f.home, f.root, resolve(f.home, 'project')])
    await assert.rejects(cleanStoppedCodexHome({ ...f, publicRepositoryRoots: [repository] }), { code: 'RUNTIME_HOME_PUBLIC_REPOSITORY_OVERLAP' });
  for (const publicFiles of [null, {}, { 'config.toml': '' }, { 'config.toml': 'valid', '../escape': 'bad' }])
    await assert.rejects(cleanStoppedCodexHome({ ...f, publicFiles }), { code: 'RUNTIME_HOME_PUBLIC_BASELINE_REQUIRED' });
  assert.equal(await readFile(resolve(f.home, 'private'), 'utf8'), 'still present');
});

test('HOME cleanup refuses symlink roots and skill roots without following or removing the target', async t => {
  const f = await fixture(t); const alias = resolve(f.root, 'alias'); await symlink(f.home, alias);
  await assert.rejects(cleanStoppedCodexHome({ ...f, agent: { profile: { codexHome: alias } } }), { code: 'RUNTIME_ROOT_UNSAFE' });
  await rm(resolve(f.home, 'skills'), { recursive: true }); await symlink(f.repository, resolve(f.home, 'skills'));
  await assert.rejects(cleanStoppedCodexHome(f), { code: 'RUNTIME_PUBLIC_SKILLS_ROOT_UNSAFE' });
  assert.equal(await readFile(resolve(f.repository, '.git/history'), 'utf8'), 'public commits');
});

test('HOME cleanup retry removes interrupted public writes and does not retain unconfigured old credentials', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.home, '.public-interrupted.tmp'), 'partial secret');
  await writeFile(resolve(f.home, 'auth.json'), 'old private credential');
  await cleanStoppedCodexHome(f);
  assert.deepEqual((await readdir(f.home)).sort(), ['config.toml', 'skills']);
});
