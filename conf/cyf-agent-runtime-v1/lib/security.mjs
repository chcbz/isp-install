import { constants, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SENSITIVE_KEY = /(?:authorization|secret|token|api[_-]?key|credential|password|provider)/i;
const REDACTED = '[REDACTED]';

export function redact(value, knownSecrets = []) {
  if (typeof value === 'string') {
    return knownSecrets.filter(Boolean).reduce((result, secret) => result.split(secret).join(REDACTED), value)
      .replace(/(?:Bearer|AgentRuntime)\s+[^\s,;]+/gi, `Authorization ${REDACTED}`)
      .replace(/rts1_[0-9a-f]{64}/g, REDACTED);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, knownSecrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, SENSITIVE_KEY.test(key) ? REDACTED : redact(item, knownSecrets)
  ]));
  return value;
}

export function createLogger({ write = console.error, knownSecrets = [] } = {}) {
  return (event, details = {}) => write(JSON.stringify({ event, ...redact(details, knownSecrets) }));
}

export async function readEnrollmentSecret(env = process.env) {
  const fromEnv = env.CYF_RUNTIME_V1_ENROLLMENT_SECRET;
  const fromFile = env.CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE;
  if (fromEnv && fromFile) throw new Error('configure exactly one enrollment secret source');
  if (fromEnv) {
    const value = fromEnv.trim();
    if (!value) throw new Error('enrollment secret is empty');
    return { value, source: 'environment' };
  }
  if (!fromFile) throw new Error('enrollment secret must be supplied through protected environment or file');
  const value = (await readPrivateBytes(fromFile)).trim();
  if (!value) throw new Error('enrollment secret is empty');
  return { value, source: 'file', path: fromFile };
}

// No-follow descriptor reads, current UID, canonical ancestors and identity readback.
// These checks prevent accidental alias/adoption, not hostile same-UID isolation.
async function canonical(path) {
  const absolute = resolve(path);
  if (await realpath(absolute) !== absolute) throw new Error('private state path must not contain symlinks');
  return absolute;
}
async function readPrivateBytes(path) {
  const absolute = await canonical(path);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || (before.mode & 0o077n) !== 0n) throw new Error('private state file has unsafe permissions or ownership');
    const bytes = await file.readFile('utf8');
    const after = await file.stat({ bigint: true });
    const current = await lstat(absolute, { bigint: true });
    await canonical(absolute);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('private state file changed during read');
    return bytes;
  } finally { await file.close(); }
}
export async function ensurePrivateDirectory(directory) {
  // Validate existing parent chain before creating only private state directories.
  let parent = resolve(directory);
  while (true) {
    try { await canonical(parent); break; } catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await canonical(directory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error('state directory must be private and owned');
}
export async function readPrivateJson(path, fallback) {
  try { return JSON.parse(await readPrivateBytes(path)); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writePrivateJson(path, value) {
  const parent = dirname(resolve(path));
  await ensurePrivateDirectory(parent);
  const identity = await lstat(parent, { bigint: true });
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  try {
    await canonical(parent);
    const current = await lstat(parent, { bigint: true });
    if (identity.dev !== current.dev || identity.ino !== current.ino) throw new Error('private directory ownership changed');
    try { await readPrivateBytes(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, path);
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
