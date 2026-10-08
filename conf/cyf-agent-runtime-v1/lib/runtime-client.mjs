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
  if (error?.code === 'RUNTIME_ENROLLMENT_RECOVERY_REQUIRED') return { kind: 'recovery-required' };
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

// Session/ACK r1 + canonical projection r2; immutable ACKs have no session/token.
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
  for (const key of ['messageId', 'correlationId', 'commandId', 'taskId', 'expiresAt']) if (!exact(command[key])) throw fail('RUNTIME_COMMAND_FIELD_REQUIRED');
  for (const key of identityFields) if (command[key] !== manifest[key]) throw fail('RUNTIME_COMMAND_IDENTITY_MISMATCH');
  if (command.workItemId !== null && !exact(command.workItemId)) throw fail('RUNTIME_COMMAND_WORK_INVALID');
  if (command.payloadReference !== null && !exact(command.payloadReference)) throw fail('RUNTIME_COMMAND_REFERENCE_INVALID');
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

// Only the three existing target-only E05 lease methods live outside the native
// /internal/agent prefix. actorAgentId confirms this manifest, never selects one.
const isReassignmentLeaseEndpoint = (endpoint, options, manifest) => {
  const match = /^\/agent\/tasks\/([^/]+)\/work-items\/([^/]+)\/reassignments\/([^/]+)\/lease(?:\/(?:start|heartbeat))?$/.exec(endpoint.pathname);
  if (!match || typeof options.method !== 'string' || options.method.toUpperCase() !== 'POST') return false;
  try {
    if (match.slice(1).some(segment => {
      const value = decodeURIComponent(segment);
      return !exact(value) || [...value].length > 100 || /[\/\\%?#]/u.test(value);
    })) return false;
  } catch { return false; }
  const query = [...endpoint.searchParams];
  return query.length === 1 && query[0][0] === 'actorAgentId' && query[0][1] === manifest.canonicalAgentId;
};

// The new E05 internal namespace is narrower than unrelated native APIs.
// No caller-selected actor, query, encoded alias or GET body is accepted.
const e05InternalScope = (endpoint, options) => {
  let decoded;
  try { decoded = decodeURIComponent(endpoint.pathname); } catch { return false; }
  if (!/^\/internal\/agent\/tasks\/.*\/reassignments/.test(decoded)) return true;
  const match = /^\/internal\/agent\/tasks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,99})\/work-items\/([A-Za-z0-9][A-Za-z0-9._:-]{0,99})\/reassignments\/([A-Za-z0-9][A-Za-z0-9._:-]{0,99})\/commands\/([A-Za-z0-9][A-Za-z0-9._:-]{0,99})\/(lease|result-commit)$/.exec(endpoint.pathname);
  const method = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET';
  return !!match && !endpoint.href.includes('?') && (method === 'GET' && options.body == null
    || method === 'POST' && match[5] === 'result-commit');
};

const ENROLLMENT_AUTHORIZATION = /^rta1_[0-9a-f]{64}$/;
const safeEpoch = value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime());
export function validateEnrollmentResult(response, manifest) {
  const fields = ['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'manifestVersion', 'manifestSha256', 'enrollmentExpiresAt', 'status', 'lastHeartbeatAt'];
  const installation = response?.installation;
  if (!response || typeof response !== 'object' || Array.isArray(response)
      || Object.keys(response).sort().join(',') !== 'installation,runtimeAuthorization'
      || !installation || typeof installation !== 'object' || Array.isArray(installation)
      || Object.keys(installation).sort().join(',') !== [...fields].sort().join(',')
      || !exact(response.runtimeAuthorization) || !ENROLLMENT_AUTHORIZATION.test(response.runtimeAuthorization)) throw fail('RUNTIME_ENROLLMENT_RESPONSE_INVALID');
  const expected = identityOf(manifest);
  if (Object.keys(expected).some(key => installation[key] !== expected[key])
      || installation.status !== 'ACTIVE' || !safeEpoch(installation.enrollmentExpiresAt)
      || installation.lastHeartbeatAt !== null && !safeEpoch(installation.lastHeartbeatAt)) throw fail('RUNTIME_ENROLLMENT_RESPONSE_INVALID');
  return Object.freeze({ installationId: expected.installationId, runtimeAuthorization: response.runtimeAuthorization });
}
const enrollmentRecovery = () => Object.assign(fail('RUNTIME_ENROLLMENT_RECOVERY_REQUIRED'), { recoveryRequired: true, retryable: false });

export class RuntimeV1Client {
  constructor({ manifest, apiBaseUrl, stateDir, hostId, runtimeInstanceId, fetchFn = globalThis.fetch }) {
    if (typeof fetchFn !== 'function') throw fail('RUNTIME_FETCH_REQUIRED');
    this.manifest = manifest; this.apiBaseUrl = normalizeRuntimeOrigin(apiBaseUrl); this.stateDir = stateDir;
    this.hostId = hostId; this.runtimeInstanceId = runtimeInstanceId; this.fetchFn = fetchFn;
    this.currentSession = null; this.lastGeneration = 0; this.sessionAbort = null;
  }
  authorizationPath() { return `${this.stateDir}/runtime-authorization.json`; }
  enrollmentAttemptPath() { return `${this.stateDir}/runtime-enrollment-attempt.json`; }
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
    // Never replace an existing authorization or replay a possibly consumed secret,
    // even after a new process starts. The marker contains only public manifest identity.
    if (await readPrivateJson(this.authorizationPath(), null)) throw fail('RUNTIME_ENROLLMENT_AUTHORIZATION_EXISTS');
    if (await readPrivateJson(this.enrollmentAttemptPath(), null)) throw enrollmentRecovery();
    try {
      await writePrivateJson(this.enrollmentAttemptPath(), { ...identityOf(this.manifest), status: 'REQUEST_MAY_CONSUME_SECRET' }, { exclusive: true });
    } catch (error) { if (error.code === 'EEXIST') throw enrollmentRecovery(); throw error; }
    try {
      const response = await this.request('/agent/runtime/v1/enroll', { ...identityOf(this.manifest), enrollmentSecret }, {}, options);
      const valid = validateEnrollmentResult(response, this.manifest);
      await writePrivateJson(this.authorizationPath(), valid);
      const persisted = await readPrivateJson(this.authorizationPath(), null);
      if (persisted?.installationId !== valid.installationId || persisted?.runtimeAuthorization !== valid.runtimeAuthorization) throw enrollmentRecovery();
      return { installationId: valid.installationId }; // no token in logs/CLI/public view
    } catch { throw enrollmentRecovery(); } // no transport/parser/OS error can leak credentials or trigger an automatic retry
  }
  async session(options = {}) {
    if (!exact(this.hostId) || !exact(this.runtimeInstanceId) || this.hostId === this.runtimeInstanceId) throw fail('RUNTIME_HOST_PROOF_REQUIRED');
    this.invalidateSession();
    const response = await this.request('/agent/runtime/v1/session', { ...identityOf(this.manifest), hostId: this.hostId, runtimeInstanceId: this.runtimeInstanceId },
      { Authorization: `Bearer ${await this.loadAuthorization()}` }, options);
    this.currentSession = validateRuntimeSession(response, { manifest: this.manifest, hostId: this.hostId, runtimeInstanceId: this.runtimeInstanceId, previousGeneration: this.lastGeneration });
    this.sessionAbort = new AbortController();
    this.lastGeneration = this.currentSession.sessionGeneration;
    return this.currentSession;
  }
  invalidateSession() { this.sessionAbort?.abort(); this.sessionAbort = null; this.currentSession = null; }
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
        || !(endpoint.pathname.startsWith('/internal/agent/') || isReassignmentLeaseEndpoint(endpoint, options, this.manifest))
        || !e05InternalScope(endpoint, options)
        || [...endpoint.searchParams.keys()].some(key => /^(?:api[_-]?key|authorization|session[_-]?token|token)$/i.test(key))) throw fail('RUNTIME_NATIVE_SCOPE_INVALID');
    const session = this.currentSession; const proof = this.sessionHeaders();
    const signal = this.sessionAbort?.signal;
    const headers = new Headers(options.headers);
    for (const key of ['x-api-key', 'cookie', 'proxy-authorization', 'origin', ...Object.keys(proof)]) headers.delete(key);
    for (const [key, value] of Object.entries(proof)) headers.set(key, value);
    const response = await this.fetchFn(endpoint, { ...options, redirect: 'error', headers,
      ...(signal ? { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal } : {}) });
    if (this.currentSession !== session) throw fail('RUNTIME_NATIVE_SESSION_CHANGED');
    return response;
  }
}
