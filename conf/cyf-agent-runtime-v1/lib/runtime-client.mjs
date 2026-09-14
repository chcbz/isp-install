import { readPrivateJson, writePrivateJson } from './security.mjs';

const ACK_STATES = ['RECEIVED', 'STARTED', 'SUCCEEDED', 'FAILED', 'REJECTED'];
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'REJECTED']);
const REQUIRED_COMMAND_FIELDS = [
  'messageId', 'correlationId', 'commandId', 'taskId', 'workItemId',
  'tenantId', 'clientId', 'canonicalAgentId', 'payloadReference', 'expiresAt'
];

function identityOf(manifest) {
  const { installationId, tenantId, clientId, canonicalAgentId, manifestVersion, manifestSha256 } = manifest;
  return { installationId, tenantId, clientId, canonicalAgentId, manifestVersion, manifestSha256 };
}

function normalizeBaseUrl(apiBaseUrl) {
  const url = new URL(apiBaseUrl);
  if ([...url.searchParams.keys()].some(key => key.toLowerCase().replace(/[-_]/g, '') === 'apikey')) {
    throw new Error('legacy api_key URL configuration is not supported');
  }
  return url.toString().replace(/\/$/, '');
}

export function validateCommandForManifest(command, manifest, status, now = Date.now()) {
  if (!ACK_STATES.includes(status)) throw new Error(`unsupported ACK status: ${status}`);
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('command must be an object');
  for (const key of REQUIRED_COMMAND_FIELDS) {
    if (typeof command[key] !== 'string' || command[key].trim() === '') throw new Error(`command requires ${key}`);
  }
  for (const key of ['tenantId', 'clientId', 'canonicalAgentId']) {
    if (command[key] !== manifest[key]) throw new Error(`command ${key} does not match Runtime v1 identity`);
  }
  const expiresAt = Date.parse(command.expiresAt);
  if (Number.isNaN(expiresAt)) throw new Error('command expiresAt must be an ISO timestamp');
  if (expiresAt <= now && status !== 'REJECTED') throw new Error('expired command may only be rejected');
  return { ...command };
}

export class RuntimeV1Client {
  constructor({ manifest, apiBaseUrl, stateDir, fetchFn = globalThis.fetch }) {
    if (typeof fetchFn !== 'function') throw new Error('Node 20 fetch is required');
    this.manifest = manifest;
    this.apiBaseUrl = normalizeBaseUrl(apiBaseUrl);
    this.stateDir = stateDir;
    this.fetchFn = fetchFn;
  }

  authorizationPath() { return `${this.stateDir}/runtime-authorization.json`; }
  pendingAcksPath() { return `${this.stateDir}/pending-acks.json`; }

  async request(path, body, authorization) {
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
      body: JSON.stringify(body)
    });
    let json = {};
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (contentType.includes('application/json')) json = await response.json();
    else if (response.status !== 204) json = { message: await response.text() };
    if (!response.ok) {
      const error = new Error(`Runtime v1 API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  async loadAuthorization() {
    const state = await readPrivateJson(this.authorizationPath(), null);
    if (!state || typeof state.runtimeAuthorization !== 'string' || !state.runtimeAuthorization) throw new Error('Runtime v1 enrollment is required');
    return state.runtimeAuthorization;
  }

  async enroll(enrollmentSecret) {
    if (typeof enrollmentSecret !== 'string' || !enrollmentSecret.trim()) throw new Error('enrollment secret is required');
    const response = await this.request('/agent/runtime/v1/enroll', { ...identityOf(this.manifest), enrollmentSecret: enrollmentSecret.trim() });
    if (typeof response.runtimeAuthorization !== 'string' || !response.runtimeAuthorization) throw new Error('enroll response lacks runtimeAuthorization');
    await writePrivateJson(this.authorizationPath(), { installationId: this.manifest.installationId, runtimeAuthorization: response.runtimeAuthorization });
    return response;
  }

  async session(health = 'HEALTHY') {
    return this.request('/agent/runtime/v1/session', { ...identityOf(this.manifest), health }, await this.loadAuthorization());
  }

  async heartbeat(health = 'HEALTHY') {
    return this.request('/agent/runtime/v1/heartbeat', { ...identityOf(this.manifest), health }, await this.loadAuthorization());
  }

  async queueAck(command, status, now) {
    const valid = validateCommandForManifest(command, this.manifest, status, now);
    const store = await readPrivateJson(this.pendingAcksPath(), { version: 1, pending: [], completed: [] });
    if (!Array.isArray(store.pending) || !Array.isArray(store.completed)) throw new Error('invalid pending ACK store');
    const completed = store.completed.find(candidate => candidate?.messageId === valid.messageId);
    if (completed) {
      if (completed.status !== status) throw new Error('terminal ACK cannot be changed');
      return { queued: false, completed: true };
    }
    let record = store.pending.find(candidate => candidate.command.messageId === valid.messageId);
    if (!record) {
      if (status !== 'RECEIVED' && status !== 'REJECTED') throw new Error('first ACK must be RECEIVED or REJECTED');
      record = { command: valid, acks: [] };
      store.pending.push(record);
    }
    const previous = record.acks.at(-1)?.status;
    if (previous === status) return { queued: false, duplicate: true };
    if (previous && TERMINAL.has(previous)) throw new Error('terminal ACK cannot be changed');
    if (previous === 'RECEIVED' && !['STARTED', 'REJECTED'].includes(status)) throw new Error('ACK state must advance monotonically');
    if (previous === 'STARTED' && !['SUCCEEDED', 'FAILED'].includes(status)) throw new Error('ACK state must advance monotonically');
    record.acks.push({ status });
    await writePrivateJson(this.pendingAcksPath(), store);
    return { queued: true };
  }

  async flushAcks() {
    const authorization = await this.loadAuthorization();
    const store = await readPrivateJson(this.pendingAcksPath(), { version: 1, pending: [], completed: [] });
    const remaining = [];
    for (const record of store.pending) {
      let delivered = 0;
      try {
        for (const ack of record.acks) {
          const response = await this.request(
            `/agent/runtime/v1/commands/${encodeURIComponent(record.command.messageId)}/acks`,
            { ...record.command, status: ack.status }, authorization
          );
          if (response.result && !['ADVANCED', 'PRIOR'].includes(response.result)) throw new Error('unexpected ACK result');
          delivered += 1;
        }
      } catch {
        remaining.push({ ...record, acks: record.acks.slice(delivered) });
      }
      if (delivered === record.acks.length && TERMINAL.has(record.acks.at(-1)?.status)) store.completed.push({ messageId: record.command.messageId, status: record.acks.at(-1).status });
      else if (delivered === record.acks.length) remaining.push(record);
    }
    store.pending = remaining;
    store.completed = [...new Map(store.completed.map(item => [item.messageId, item])).values()];
    await writePrivateJson(this.pendingAcksPath(), store);
    return { pending: remaining.length };
  }
}
