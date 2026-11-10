// Storage step for the stopped handover, after evidence delivery, skill retirement
// and the knowledge-extraction attempt. Not a standalone relationship-release API.
// publicFiles must come from the operator/template, never the old HOME or wire input.
import { constants, lstat, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireOwnedPrivateRoot } from './runtime-host.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export async function validateStoppedHomeCleanup({ agent, publicFiles, publicRepositoryRoots = [] }) {
  const home = agent?.profile?.codexHome;
  if (typeof home !== 'string' || resolve(home) !== home) fail('RUNTIME_HOME_CLEANUP_ROOT_INVALID');
  // Config availability is established before deleting private state. Missing auth
  // means credentials are supplied by trusted environment; old auth is not retained.
  if (!publicFiles || typeof publicFiles['config.toml'] !== 'string'
      || !publicFiles['config.toml'].trim()
      || Object.entries(publicFiles).some(([name, bytes]) => !['config.toml', 'auth.json'].includes(name) || typeof bytes !== 'string'))
    fail('RUNTIME_HOME_PUBLIC_BASELINE_REQUIRED');
  for (const root of publicRepositoryRoots) {
    if (typeof root !== 'string' || resolve(root) !== root) fail('RUNTIME_PUBLIC_REPOSITORY_ROOT_INVALID');
    if (overlaps(home, root)) fail('RUNTIME_HOME_PUBLIC_REPOSITORY_OVERLAP');
  }
  await requireOwnedPrivateRoot(home);
  const skills = resolve(home, 'skills');
  try {
    const stat = await lstat(skills);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RUNTIME_PUBLIC_SKILLS_ROOT_UNSAFE');
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  return home;
}
export async function cleanStoppedCodexHome(options) {
  const home = await validateStoppedHomeCleanup(options), { publicFiles } = options;
  // Do not enumerate a fixed list of Codex filenames: that misses SQLite sidecars,
  // memories, snapshots and future private files. Keep only classified public skills.
  // rm on a child symlink unlinks it; it does not traverse into a shared repository.
  for (const name of await readdir(home)) {
    if (name !== 'skills') await rm(resolve(home, name), { recursive: true, force: true });
  }
  for (const [name, bytes] of Object.entries(publicFiles)) {
    const temporary = resolve(home, `.public-${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, resolve(home, name)); }
    catch (cause) { await unlink(temporary).catch(() => {}); throw cause; }
  }
  const directory = await open(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  // Other private roots, control state and final durable receipt are separate steps.
  return { homeCleaned: true };
}
