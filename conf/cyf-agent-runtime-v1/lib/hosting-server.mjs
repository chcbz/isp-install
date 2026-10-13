// Private AF_UNIX stream, exactly one newline-terminated JSON exchange. This is
// a control boundary INSIDE the existing process, not another Runtime/broker.
import { createServer } from 'node:net';
import { chmod, chown, lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import { HostingControl } from './hosting-control.mjs';
import { canonicalHostingPath, hostingError } from './hosting-config.mjs';
import { HOSTING_METHODS, HOSTING_PROTOCOL, parseHostingJson } from './hosting-wire.mjs';

export async function requireHostingSocketParent(config) {
  const parent = dirname(config.socketPath); await canonicalHostingPath(parent);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.gid !== config.socketGid
      || ![0o710, 0o750].includes(stat.mode & 0o777)) throw hostingError('HOSTING_SOCKET_PARENT_UNSAFE');
  return stat;
}
const reasonCodes = new Set(['HOSTING_WIRE_INVALID', 'HOSTING_DUPLICATE_FIELD', 'HOSTING_FIELD_FORBIDDEN', 'HOSTING_SCOPE_REJECTED',
  'HOSTING_CONTROL_NOT_RUNNING', 'HOSTING_OPERATION_CONFLICT', 'HOSTING_SUBJECT_CONFLICT', 'HOSTING_ASSOCIATION_REJECTED',
  'HOSTING_LEASE_EXPIRED', 'HOSTING_GENERATION_EXHAUSTED', 'HOSTING_OPERATION_SUPERSEDED']);
export function hostingRejection(method, cause) {
  return { protocol: HOSTING_PROTOCOL, method: HOSTING_METHODS.includes(method) ? method : null, outcome: 'REJECTED',
    reasonCode: reasonCodes.has(cause?.code) ? cause.code : 'HOSTING_CONTROL_ERROR' };
}
export async function startHostingServer({ control }) {
  const config = control.config; await requireHostingSocketParent(config);
  // Never unlink an existing listener, stale socket, symlink or unknown file.
  try { await lstat(config.socketPath); throw hostingError('HOSTING_SOCKET_EXISTS'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const connections = new Set(); let shuttingDown = false; let identity;
  const server = createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {}); let bytes = Buffer.alloc(0); let received = false;
    socket.on('data', chunk => {
      if (received || shuttingDown) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]); const newline = bytes.indexOf(10);
      if (newline < 0) return;
      received = true;
      void (async () => {
        let method = null;
        try {
          if (bytes.length !== newline + 1) throw hostingError('HOSTING_WIRE_INVALID');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline));
          const request = parseHostingJson(text); method = request?.method;
          const result = await control.handle(request);
          if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`);
        } catch (cause) { if (!socket.destroyed) socket.end(`${JSON.stringify(hostingRejection(method, cause))}\n`); }
      })();
    });
    socket.on('end', () => { if (!received) socket.destroy(); });
  });
  // Binding occurs synchronously inside listen; create under 0600 first so there
  // is never a world-accessible window before the explicitly configured group.
  const mask = process.umask(0o177);
  const listening = new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
  try { server.listen(config.socketPath); } finally { process.umask(mask); }
  await listening;
  try {
    await chown(config.socketPath, process.getuid(), config.socketGid); await chmod(config.socketPath, 0o660);
    await requireHostingSocketParent(config);
    identity = await lstat(config.socketPath, { bigint: true });
    if (await realpath(config.socketPath) !== config.socketPath || !identity.isSocket() || identity.uid !== BigInt(process.getuid())
        || identity.gid !== BigInt(config.socketGid) || (identity.mode & 0o777n) !== 0o660n) throw hostingError('HOSTING_SOCKET_UNSAFE');
  } catch (cause) { await new Promise(resolve => server.close(resolve)); throw cause; }
  let closePromise;
  return {
    control,
    close: () => closePromise ||= (async () => {
      shuttingDown = true; for (const socket of connections) socket.destroy();
      const current = await lstat(config.socketPath, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw hostingError('HOSTING_SOCKET_OWNERSHIP_LOST');
      await new Promise((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve()));
      await control.close();
    })()
  };
}
export async function createHostingControlServer(options) {
  const control = new HostingControl(options);
  await control.initialize();
  try {
    const server = await startHostingServer({ control }); control.resumeAdmitted(); return server;
  } catch (cause) { await control.close(); await control.releaseOwnership(); throw cause; }
}
