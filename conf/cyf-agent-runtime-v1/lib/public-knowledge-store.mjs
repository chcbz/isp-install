// Host-owned public Agent knowledge and PLATFORM-only usage receipts. These roots
// are siblings of per-Agent private roots, not under CODEX_HOME or user workdirs.
import { createHash } from 'node:crypto';
import { constants, open, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readPrivateJson, writePrivateJson } from './security.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const same = (a, b) => digest(a) === digest(b);

async function append(path, value) {
  try { await writePrivateJson(path, value, { exclusive: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const retained = await readPrivateJson(path, null);
    if (!same(retained, value)) fail('KNOWLEDGE_RETAINED_FACT_CONFLICT');
    // A prior response may have been lost between link() and directory fsync().
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export function createPublicKnowledgeStore({ hostStateRoot, privateRoots }) {
  if (typeof hostStateRoot !== 'string' || resolve(hostStateRoot) !== hostStateRoot || !Array.isArray(privateRoots))
    fail('KNOWLEDGE_STORAGE_ROOT_INVALID');
  for (const root of privateRoots) {
    if (typeof root !== 'string' || resolve(root) !== root || overlaps(hostStateRoot, root))
      fail('KNOWLEDGE_STORAGE_PRIVATE_OVERLAP');
  }
  const subjectDirectory = (kind, subjectKey) => {
    if (typeof subjectKey !== 'string' || !subjectKey.trim()) fail('KNOWLEDGE_SUBJECT_REQUIRED');
    return resolve(hostStateRoot, kind, digest(subjectKey));
  };
  return {
    publish: async ({ agent, operationId, entries }) => {
      if (typeof operationId !== 'string' || !operationId.trim() || !Array.isArray(entries)
          || entries.some(entry => !entry || typeof entry !== 'object'
            || Object.keys(entry).sort().join(',') !== 'guidance,title'
            || ['title', 'guidance'].some(key => typeof entry[key] !== 'string' || !entry[key].trim())))
        fail('KNOWLEDGE_ARTIFACT_INVALID');
      const path = resolve(subjectDirectory('public-knowledge', agent?.subjectKey), `${digest(operationId)}.json`);
      // No source conversation, user identity, paths, credentials or raw draft.
      await append(path, { formatVersion: 1, entries });
    },
    platformCostJournal: ({ subjectKey, leaseId, operationId }) => {
      if ([leaseId, operationId].some(value => typeof value !== 'string' || !value.trim()))
        fail('KNOWLEDGE_COST_BINDING_INVALID');
      const root = resolve(subjectDirectory('platform-usage', subjectKey), digest([leaseId, operationId]));
      const binding = { formatVersion: 1, subjectKey, leaseId, operationId };
      const prepare = () => append(resolve(root, 'binding.json'), binding);
      const pathFor = event => {
        if (event?.costBearer !== 'PLATFORM' || typeof event.attemptId !== 'string' || !event.attemptId
            || !['started', 'responded'].includes(event.receiptId)
            || event.phase !== event.receiptId.toUpperCase()) fail('KNOWLEDGE_COST_BINDING_INVALID');
        return resolve(root, digest(event.attemptId), `${event.receiptId}.json`);
      };
      return {
        record: async event => { await prepare(); await append(pathFor(event), event); },
        acknowledge: async (event, receipt) => {
          const path = pathFor(event);
          if (!same(await readPrivateJson(path, null), event)) fail('KNOWLEDGE_COST_BINDING_INVALID');
          await append(`${path}.ack`, { receiptSha256: digest(event), receipt });
        },
        pending: async function* () {
          // Scan only this stopped relationship/handover, never all Agent history.
          await prepare();
          for (const child of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!/^[a-f0-9]{64}$/.test(child.name)) continue;
            if (!child.isDirectory()) fail('KNOWLEDGE_COST_BINDING_INVALID');
            for (const phase of ['started', 'responded']) {
              const path = resolve(root, child.name, `${phase}.json`);
              const event = await readPrivateJson(path, null);
              if (!event) continue;
              if (pathFor(event) !== path) fail('KNOWLEDGE_COST_BINDING_INVALID');
              const ack = await readPrivateJson(`${path}.ack`, null);
              if (ack && ack.receiptSha256 !== digest(event)) fail('KNOWLEDGE_RETAINED_FACT_CONFLICT');
              if (!ack) yield event;
            }
          }
        }
      };
    }
  };
}
