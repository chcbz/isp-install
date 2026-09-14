import { lstat, mkdir, open, readFile, rename, chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SENSITIVE_KEY = /(?:authorization|secret|token|api[_-]?key|credential|password|provider)/i;
const REDACTED = '[REDACTED]';

export function redact(value, knownSecrets = []) {
  if (typeof value === 'string') {
    return knownSecrets.filter(Boolean).reduce((result, secret) => result.split(secret).join(REDACTED), value)
      .replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`);
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
  const stat = await lstat(fromFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('enrollment secret file must be a regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('enrollment secret file permissions must not grant group or other access');
  const value = (await readFile(fromFile, 'utf8')).trim();
  if (!value) throw new Error('enrollment secret is empty');
  return { value, source: 'file', path: fromFile };
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error(`state directory must be private: ${directory}`);
}

export async function readPrivateJson(path, fallback) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`private state file has unsafe permissions: ${path}`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writePrivateJson(path, value) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  const file = await open(temporary, 'r');
  try { await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
