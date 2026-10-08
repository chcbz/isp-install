import { readPrivateJson, writePrivateJson } from './security.mjs';

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
]);
const PERMANENT_TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export function classifyRuntimeError(error) {
  if (error?.name === 'AbortError') return { kind: 'cancelled' };
  if (error?.code === 'REBINDS_REQUIRED') return { kind: 'rebind' };
  const status = Number(error?.status);
  if (status === 401 || status === 403) return { kind: 'authorization', status };
  if (status === 408 || status === 429 || status >= 500 && status <= 599) return { kind: 'transient-http', status };
  if (status) return { kind: 'permanent-http', status };
  const causes = [];
  for (let cause = error; cause; cause = cause.cause) causes.push(cause);
  if (causes.some(cause => PERMANENT_TLS_CODES.has(cause.code)
      || typeof cause.code === 'string' && (cause.code.startsWith('ERR_TLS_') || cause.code.startsWith('ERR_SSL_')))) {
    return { kind: 'permanent' };
  }
  if (causes.some(cause => TRANSIENT_NETWORK_CODES.has(cause.code))) return { kind: 'transient-network' };
  return { kind: 'permanent' };
}

// Wire r1: API fixture87c894dc; immutable business ACKs have no session/token.
export const RUNTIME_SESSION_TOKEN = /^rts1_[0-9a-f]{64}$/;
export const RUNTIME_ACK_STATUSES = new Set(['RECEIVED', 'STARTED', 'SUCCEEDED', 'FAILED', 'REJECTED']);
const fail = code => Object.assign(new Error(code), { code });
const exact = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const identityFields = ['installationId', 'tenantId', 'clientId', 'canonicalAgentId'];
export function identityOf(manifest) {
  const { installationId, tenantId, clientId, canonicalAgentId, manifestVersion, manifestSha256 } = manifest;
  return { installationId, tenantId, clientId, canonicalAgentId, manifestVersion, manifestSha256: manifestSha256.slice(7) };
}
export function normalizeRuntimeOrigin(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('RUNTIME_API_ORIGIN_INVALID');
  return url.origin;
}
export function validateRuntimeSession(value, { manifest, hostId, runtimeInstanceId, previousGeneration = 0 }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('RUNTIME_SESSION_INVALID');
  for (const field of identityFields) if (value[field] !== manifest[field]) throw fail('RUNTIME_SESSION_IDENTITY_MISMATCH');
  if (value.hostId !== hostId || value.runtimeInstanceId !== runtimeInstanceId || value.scheme !== 'AgentRuntime'
      || value.status !== 'CHANNEL_PENDING' || value.websocketPath !== '/ws/agent/channel'
      || !RUNTIME_SESSION_TOKEN.test(value.sessionToken) || !Number.isSafeInteger(value.sessionGeneration)
      || value.sessionGeneration <= previousGeneration) throw fail('RUNTIME_SESSION_PROOF_INVALID');
  return Object.freeze(Object.fromEntries([...identityFields, 'hostId', 'runtimeInstanceId', 'sessionGeneration', 'scheme', 'sessionToken', 'websocketPath', 'status'].map(field => [field, value[field]])));
}
export function runtimeSessionHeaders(session) {
  if (!RUNTIME_SESSION_TOKEN.test(session?.sessionToken) || !Number.isSafeInteger(session.sessionGeneration) || session.sessionGeneration < 1) throw fail('RUNTIME_SESSION_REQUIRED');
  return Object.freeze({ Authorization: `AgentRuntime ${session.sessionToken}`, 'X-Agent-Id': session.canonicalAgentId,
    'X-Agent-Installation-Id': session.installationId, 'X-Agent-Host-Id': session.hostId,
    'X-Agent-Runtime-Id': session.runtimeInstanceId, 'X-Agent-Session-Generation': String(session.sessionGeneration) });
}
export function validateCommandForManifest(command, manifest, status, now = Date.now()) {
  if (!RUNTIME_ACK_STATUSES.has(status) || !command || typeof command !== 'object' || Array.isArray(command)) throw fail('RUNTIME_ACK_INVALID');
  const allowed = [...identityFields, 'messageId', 'correlationId', 'commandId', 'taskId', 'workItemId', 'payloadReference', 'expiresAt'];
  if (Object.keys(command).some(key => !allowed.includes(key))) throw fail('RUNTIME_ACK_FIELD_FORBIDDEN');
  for (const key of ['messageId', 'correlationId', 'commandId', 'taskId', 'payloadReference', 'expiresAt']) if (!exact(command[key])) throw fail('RUNTIME_COMMAND_FIELD_REQUIRED');
  for (const key of identityFields) if (command[key] !== manifest[key]) throw fail('RUNTIME_COMMAND_IDENTITY_MISMATCH');
  if (command.workItemId !== null && !exact(command.workItemId)) throw fail('RUNTIME_COMMAND_WORK_INVALID');
  const expiry = Date.parse(command.expiresAt);
  if (!Number.isFinite(expiry)) throw fail('RUNTIME_COMMAND_EXPIRY_INVALID');
  if (expiry <= now && ['RECEIVED', 'STARTED'].includes(status)) throw fail('RUNTIME_COMMAND_EXPIRED');
  return Object.freeze({ ...command });
}
export function validateRuntimeAckResult(result, status, lastConfirmedVersion = null) {
  if (!result || !['ADVANCED', 'PRIOR'].includes(result.kind) || result.status !== status
      || !Number.isSafeInteger(result.deliveryVersion) || result.deliveryVersion < 1
      || (lastConfirmedVersion !== null && (!Number.isSafeInteger(lastConfirmedVersion) || lastConfirmedVersion < 1
        || result.deliveryVersion < lastConfirmedVersion || result.kind === 'ADVANCED' && result.deliveryVersion <= lastConfirmedVersion))) throw fail('RUNTIME_ACK_COMMIT_UNCONFIRMED');
  return Object.freeze({ kind: result.kind, status: result.status, deliveryVersion: result.deliveryVersion });
}

export class RuntimeV1Client {
  constructor({ manifest, apiBaseUrl, stateDir, hostId, runtimeInstanceId, fetchFn = globalThis.fetch }) {
    if (typeof fetchFn !== 'function') throw fail('RUNTIME_FETCH_REQUIRED');
    this.manifest = manifest; this.apiBaseUrl = normalizeRuntimeOrigin(apiBaseUrl); this.stateDir = stateDir;
    this.hostId = hostId; this.runtimeInstanceId = runtimeInstanceId; this.fetchFn = fetchFn;
    this.currentSession = null; this.lastGeneration = 0;
  }
  authorizationPath() { return `${this.stateDir}/runtime-authorization.json`; }
  async request(path, body, headers = {}, { signal } = {}) {
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    if (!response.ok) throw Object.assign(fail('RUNTIME_HTTP_REJECTED'), { status: response.status });
    if (!response.headers?.get?.('content-type')?.includes('application/json')) throw fail('RUNTIME_RESPONSE_INVALID');
    const json = await response.json();
    if (!json || typeof json !== 'object' || Array.isArray(json) || !Object.hasOwn(json, 'data') || !json.data || typeof json.data !== 'object') throw fail('RUNTIME_RESPONSE_INVALID');
    return json.data;
  }
  async loadAuthorization() {
    const state = await readPrivateJson(this.authorizationPath(), null);
    if (!state) throw fail('RUNTIME_ENROLLMENT_REQUIRED');
    if (state.installationId !== this.manifest.installationId || !exact(state.runtimeAuthorization)) throw fail('RUNTIME_INSTALLATION_AUTH_INVALID');
    return state.runtimeAuthorization;
  }
  async enroll(enrollmentSecret, options = {}) {
    if (!exact(enrollmentSecret)) throw fail('RUNTIME_ENROLLMENT_SECRET_INVALID');
    const response = await this.request('/agent/runtime/v1/enroll', { ...identityOf(this.manifest), enrollmentSecret }, {}, options);
    if (!exact(response.runtimeAuthorization) || response.installationId !== this.manifest.installationId) throw fail('RUNTIME_ENROLLMENT_RESPONSE_INVALID');
    await writePrivateJson(this.authorizationPath(), { installationId: this.manifest.installationId, runtimeAuthorization: response.runtimeAuthorization });
    return { installationId: this.manifest.installationId }; // do not expose installation token to logs/CLI
  }
  async session(options = {}) {
    if (!exact(this.hostId) || !exact(this.runtimeInstanceId) || this.hostId === this.runtimeInstanceId) throw fail('RUNTIME_HOST_PROOF_REQUIRED');
    this.currentSession = null;
    const response = await this.request('/agent/runtime/v1/session', { ...identityOf(this.manifest), hostId: this.hostId, runtimeInstanceId: this.runtimeInstanceId },
      { Authorization: `Bearer ${await this.loadAuthorization()}` }, options);
    this.currentSession = validateRuntimeSession(response, { manifest: this.manifest, hostId: this.hostId, runtimeInstanceId: this.runtimeInstanceId, previousGeneration: this.lastGeneration });
    this.lastGeneration = this.currentSession.sessionGeneration;
    return this.currentSession;
  }
  invalidateSession() { this.currentSession = null; }
  sessionHeaders() { return runtimeSessionHeaders(this.currentSession); }
  websocketOptions() { return { headers: this.sessionHeaders(), followRedirects: false }; }
  websocketUrl() {
    if (!this.currentSession) throw fail('RUNTIME_SESSION_REQUIRED');
    const url = new URL(this.currentSession.websocketPath, this.apiBaseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
  async heartbeat(health = 'HEALTHY', options = {}) {
    return this.request('/agent/runtime/v1/heartbeat', { ...identityOf(this.manifest), health }, { Authorization: `Bearer ${await this.loadAuthorization()}` }, options);
  }
  async acknowledge(command, status, lastConfirmedVersion = null, options = {}) {
    if (lastConfirmedVersion !== null && (!Number.isSafeInteger(lastConfirmedVersion) || lastConfirmedVersion < 1)) throw fail('RUNTIME_ACK_VERSION_INVALID');
    const valid = validateCommandForManifest(command, this.manifest, status);
    const session = this.currentSession; const headers = this.sessionHeaders();
    const result = await this.request(`/agent/runtime/v1/commands/${encodeURIComponent(valid.messageId)}/acks`, {
      ...valid, hostId: session.hostId, runtimeInstanceId: session.runtimeInstanceId, sessionGeneration: session.sessionGeneration,
      deliveryVersion: lastConfirmedVersion, status
    }, headers, options);
    // A response racing a session rotation cannot confirm work under its successor.
    if (this.currentSession !== session) throw fail('RUNTIME_ACK_SESSION_CHANGED');
    return validateRuntimeAckResult(result, status, lastConfirmedVersion);
  }
  async nativeFetch(url, options = {}) {
    const endpoint = new URL(url);
    if (endpoint.origin !== this.apiBaseUrl || endpoint.username || endpoint.password || endpoint.hash
        || !endpoint.pathname.startsWith('/internal/agent/')
        || [...endpoint.searchParams.keys()].some(key => /^(?:api[_-]?key|authorization|session[_-]?token|token)$/i.test(key))) throw fail('RUNTIME_NATIVE_SCOPE_INVALID');
    const headers = new Headers(options.headers);
    for (const key of ['x-api-key', 'origin', ...Object.keys(this.sessionHeaders())]) headers.delete(key);
    for (const [key, value] of Object.entries(this.sessionHeaders())) headers.set(key, value);
    return this.fetchFn(endpoint, { ...options, redirect: 'error', headers });
  }
}
