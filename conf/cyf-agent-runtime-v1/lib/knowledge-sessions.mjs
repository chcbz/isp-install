// Read only the stopped Agent's local conversation messages. File names, session
// metadata, tool results, attachments and engine logs are not knowledge inputs.
import { constants, lstat, open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { requireOwnedPrivateRoot } from './runtime-host.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function* sessionFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

export function createCodexKnowledgeReader({ maxInputBytes }) {
  // Capacity is supplied by the operator's model route, not an arbitrary memory
  // or time gate. Reserve instructions/output headroom when configuring it.
  // 16 accommodates the longest role header plus one UTF-8 scalar.
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 16) fail('KNOWLEDGE_INPUT_CAPACITY_REQUIRED');
  return async function* readConversations(agent) {
    const home = agent?.profile?.codexHome;
    await requireOwnedPrivateRoot(home);
    let sequence = 0;
    for (const folder of ['sessions', 'archived_sessions']) {
      const root = resolve(home, folder);
      // Also reject a symlink at the session-root boundary, not merely its children.
      try {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('KNOWLEDGE_SESSION_ROOT_UNSAFE');
      }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for await (const path of sessionFiles(root)) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let batch = '', size = 0;
        const stream = file.createReadStream({ encoding: 'utf8', autoClose: false });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          if (!(await file.stat()).isFile()) fail('KNOWLEDGE_SESSION_FILE_INVALID');
          for await (const line of lines) {
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch { fail('KNOWLEDGE_SESSION_JSON_INVALID'); }
            const item = event?.type === 'response_item' ? event.payload : null;
            if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role) || !Array.isArray(item.content)) continue;
            for (const content of item.content) {
              if (!['input_text', 'output_text'].includes(content?.type) || typeof content.text !== 'string' || !content.text.trim()) continue;
              const header = `${item.role.toUpperCase()}:\n`;
              const headerBytes = Buffer.byteLength(header);
              const bytes = Buffer.from(content.text);
              if (batch && size < maxInputBytes) { batch += '\n'; size++; }
              let offset = 0;
              while (offset < bytes.length) {
                if (maxInputBytes - size < headerBytes + 4) {
                  yield { batchId: String(sequence++), text: batch }; batch = ''; size = 0;
                }
                const capacity = maxInputBytes - size - headerBytes;
                let end = Math.min(offset + capacity, bytes.length);
                // Never split a UTF-8 scalar; no characters are truncated or replaced.
                while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
                batch += header + bytes.subarray(offset, end).toString('utf8');
                size += headerBytes + end - offset; offset = end;
                if (offset < bytes.length) {
                  yield { batchId: String(sequence++), text: batch }; batch = ''; size = 0;
                }
              }
            }
          }
          if (batch) yield { batchId: String(sequence++), text: batch };
        } finally { lines.close(); stream.destroy(); await file.close(); }
      }
    }
  };
}
