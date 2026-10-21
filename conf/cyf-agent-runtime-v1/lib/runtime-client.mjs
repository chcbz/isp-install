import { randomUUID } from 'node:crypto';
import { encodeHttpRequest, decodeHttpResponse, parseStrictJson } from './api-envelope.mjs';
import { readPrivateJson, writePrivateJson } from './security.mjs';

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'
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

// Diagnostics never include messages, URLs, response bodies or credentials.
export function runtimeErrorFacts(error) {
  const codes = []; const seen = new Set();
  for (let cause = error; cause && !seen.has(cause) && seen.size < 8; cause = cause.cause) {
    seen.add(cause);
    if (typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) codes.push(cause.code);
  }
  const status = Number(error?.status);
  return { category: classifyRuntimeError(error).kind, codes: [...new Set(codes)],
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
}

// Session/ACK r1 + canonical projection r2; immutable ACKs have no session/token.
export const RUNTIME_SESSION_TOKEN = /^rts1_[0-9a-f]{64}$/;
export const RUNTIME_ACK_STATUSES = new Set(['RECEIVED', 'STARTED', 'SUCCEEDED', 'FAILED', 'REJECTED']);
const fail = code => Object.assign(new Error(code), { code });
const exact = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const identityFields = ['runtimeInstallationId', 'tenantId', 'clientId', 'canonicalAgentId'];
export const canonicalVersion = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
const positiveVersion = value => canonicalVersion(value) && BigInt(value) > 0n;
export function identityOf(manifest) {
  const { installationId, tenantId, clientId, canonicalAgentId, manifestVersion, manifestSha256 } = manifest;
  return { runtimeInstallationId: installationId, tenantId, clientId, canonicalAgentId, manifestVersion, manifestSha256: manifestSha256.slice(7) };
}
export function normalizeRuntimeOrigin(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('RUNTIME_API_ORIGIN_INVALID');
  return url.origin;
}
export function validateRuntimeSession(value, { manifest, hostId, runtimeInstanceId, previousGeneration = '0' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('RUNTIME_SESSION_INVALID');
  for (const field of identityFields) if (value[field] !== identityOf(manifest)[field]) throw fail('RUNTIME_SESSION_IDENTITY_MISMATCH');
  if (value.hostId !== hostId || value.runtimeInstanceId !== runtimeInstanceId || value.scheme !== 'AgentRuntime'
      || value.status !== 'CHANNEL_PENDING' || value.websocketPath !== '/ws/agent/channel'
      || !RUNTIME_SESSION_TOKEN.test(value.sessionToken) || !positiveVersion(value.sessionGeneration)
      || !canonicalVersion(previousGeneration) || BigInt(value.sessionGeneration) <= BigInt(previousGeneration)) throw fail('RUNTIME_SESSION_PROOF_INVALID');
  // The private session keeps its disk/engine identity name; only explicit wire adapters use runtimeInstallationId.
  return Object.freeze({ installationId: value.runtimeInstallationId, ...Object.fromEntries([...identityFields.filter(field => field !== 'runtimeInstallationId'), 'hostId', 'runtimeInstanceId', 'sessionGeneration', 'scheme', 'sessionToken', 'websocketPath', 'status'].map(field => [field, value[field]])) });
}
export function runtimeSessionHeaders(session) {
  if (!RUNTIME_SESSION_TOKEN.test(session?.sessionToken) || !positiveVersion(session.sessionGeneration)) throw fail('RUNTIME_SESSION_REQUIRED');
  return Object.freeze({ Authorization: `AgentRuntime ${session.sessionToken}`, 'X-Agent-Id': session.canonicalAgentId,
    'X-Agent-Installation-Id': session.installationId, 'X-Agent-Host-Id': session.hostId,
    'X-Agent-Runtime-Id': session.runtimeInstanceId, 'X-Agent-Session-Generation': String(session.sessionGeneration) });
}
export function validateCommandForManifest(command, manifest, status, now = Date.now()) {
  if (!RUNTIME_ACK_STATUSES.has(status) || !command || typeof command !== 'object' || Array.isArray(command)) throw fail('RUNTIME_ACK_INVALID');
  const allowed = [...identityFields, 'messageId', 'correlationId', 'commandId', 'taskId', 'workItemId', 'payloadReference', 'expiresAt'];
  if (Object.keys(command).some(key => !allowed.includes(key))) throw fail('RUNTIME_ACK_FIELD_FORBIDDEN');
  for (const key of ['messageId', 'correlationId', 'commandId', 'taskId']) if (!exact(command[key])) throw fail('RUNTIME_COMMAND_FIELD_REQUIRED');
  for (const key of identityFields) if (command[key] !== identityOf(manifest)[key]) throw fail('RUNTIME_COMMAND_IDENTITY_MISMATCH');
  if (command.workItemId !== null && !exact(command.workItemId)) throw fail('RUNTIME_COMMAND_WORK_INVALID');
  if (command.payloadReference !== null && !exact(command.payloadReference)) throw fail('RUNTIME_COMMAND_REFERENCE_INVALID');
  const expiry = command.expiresAt;
  if (!safeEpoch(expiry)) throw fail('RUNTIME_COMMAND_EXPIRY_INVALID');
  if (expiry <= now && ['RECEIVED', 'STARTED'].includes(status)) throw fail('RUNTIME_COMMAND_EXPIRED');
  return Object.freeze({ ...command });
}
// Private durable command bytes remain unchanged; project only at the HTTP boundary.
export function runtimeAckWireContext(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)
      || Object.keys(command).sort().join(',') !== ['installationId', 'tenantId', 'clientId', 'canonicalAgentId',
        'messageId', 'correlationId', 'commandId', 'taskId', 'workItemId', 'payloadReference', 'expiresAt'].sort().join(',')) throw fail('RUNTIME_ACK_FIELD_FORBIDDEN');
  const expiry = typeof command.expiresAt === 'string' ? Date.parse(command.expiresAt) : NaN;
  if (!safeEpoch(expiry) || new Date(expiry).toISOString() !== command.expiresAt) throw fail('RUNTIME_COMMAND_EXPIRY_INVALID');
  const { installationId, expiresAt, ...facts } = command;
  return Object.freeze({ ...facts, runtimeInstallationId: installationId, expiresAt: expiry });
}
export function validateRuntimeAckResult(result, status, lastConfirmedVersion = null) {
  if (!result || !['ADVANCED', 'PRIOR'].includes(result.kind) || result.status !== status
      || !positiveVersion(result.deliveryVersion)
      || (lastConfirmedVersion !== null && (!positiveVersion(lastConfirmedVersion)
        || BigInt(result.deliveryVersion) < BigInt(lastConfirmedVersion) || result.kind === 'ADVANCED' && BigInt(result.deliveryVersion) <= BigInt(lastConfirmedVersion)))) throw fail('RUNTIME_ACK_COMMIT_UNCONFIRMED');
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

// Exact conversation route/method policy. No encoded aliases, arbitrary nested
// /internal/** route, provider/consent fallback or caller-selected query allowed.
export const skillConversationHttpScope = (endpoint, options = {}) => {
  const decoded = (() => { try { return decodeURIComponent(endpoint.pathname) } catch { return null } })()
  if (decoded === null) return false
  if (!/^\/internal\/agent\/tasks\/(?:conversation-executions|[^/]+\/runs\/[^/]+\/conversation)(?:\/|$)/.test(decoded)) return true
  if (endpoint.search || endpoint.pathname !== decoded) return false
  const method = (options.method || 'GET').toUpperCase()
  if (endpoint.pathname === '/internal/agent/tasks/conversation-executions/commands') return method === 'GET' && options.body == null
  const id = '[A-Za-z0-9][A-Za-z0-9._:-]{0,99}'
  return method === 'POST' && new RegExp(`^/internal/agent/tasks/${id}/runs/${id}/conversation/(?:lease(?:/renew)?|inputs(?:/${id}/content)?|effects/${id}/(?:start|result)|resume|outputs/${id}/content|result-commits/${id}|failure)$`).test(endpoint.pathname)
}

export const materialsChatHttpScope = (endpoint, options = {}) => {
  let decoded; try { decoded = decodeURIComponent(endpoint.pathname) } catch { return false }
  if (!/^\/internal\/agent\/chat\/requests\/.*\/materials(?:\/|$)/.test(decoded)) return true
  const id = '[A-Za-z0-9][A-Za-z0-9._:-]{0,99}'
  return endpoint.pathname === decoded && !endpoint.search && !endpoint.href.includes('?')
    && (options.method || 'GET').toUpperCase() === 'GET' && options.body == null
    && new RegExp(`^/internal/agent/chat/requests/${id}/turns/${id}/materials/inputs/${id}/content$`).test(endpoint.pathname)
}

const ENROLLMENT_AUTHORIZATION = /^rta1_[0-9a-f]{64}$/;
const safeEpoch = value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime());
export function validateEnrollmentResult(response, manifest) {
  const fields = ['runtimeInstallationId', 'tenantId', 'clientId', 'canonicalAgentId', 'manifestVersion', 'manifestSha256', 'enrollmentExpiresAt', 'status', 'lastHeartbeatAt'];
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
  return Object.freeze({ installationId: expected.runtimeInstallationId, runtimeAuthorization: response.runtimeAuthorization });
}
const enrollmentRecovery = () => Object.assign(fail('RUNTIME_ENROLLMENT_RECOVERY_REQUIRED'), { recoveryRequired: true, retryable: false });

export class RuntimeV1Client {
  constructor({ manifest, apiBaseUrl, stateDir, hostId, runtimeInstanceId, fetchFn = globalThis.fetch }) {
    if (typeof fetchFn !== 'function') throw fail('RUNTIME_FETCH_REQUIRED');
    this.manifest = manifest; this.apiBaseUrl = normalizeRuntimeOrigin(apiBaseUrl); this.stateDir = stateDir;
    this.hostId = hostId; this.runtimeInstanceId = runtimeInstanceId; this.fetchFn = fetchFn;
    this.currentSession = null; this.lastGeneration = '0'; this.sessionAbort = null;
  }
  authorizationPath() { return `${this.stateDir}/runtime-authorization.json`; }
  enrollmentAttemptPath() { return `${this.stateDir}/runtime-enrollment-attempt.json`; }
  async request(path, body, headers = {}, { signal } = {}) {
    const requestId = headers['X-Request-Id'] ?? headers['x-request-id'] ?? randomUUID();
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...headers, 'X-Request-Id': requestId },
      body: JSON.stringify(encodeHttpRequest(body, requestId)), ...(signal ? { signal } : {}) });
    if (!response.headers?.get?.('content-type')?.includes('application/json')) {
      throw Object.assign(fail('PROTOCOL_INVALID_RESPONSE'), { status: response.status, requestId, failureClass: 'protocol' });
    }
    return decodeHttpResponse(await response.text(), {
      status: response.status, requestId, responseRequestId: response.headers.get('x-request-id')
    }).value;
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
      await writePrivateJson(this.enrollmentAttemptPath(), { installationId: this.manifest.installationId, tenantId: this.manifest.tenantId, clientId: this.manifest.clientId, canonicalAgentId: this.manifest.canonicalAgentId, manifestVersion: this.manifest.manifestVersion, manifestSha256: this.manifest.manifestSha256.slice(7), status: 'REQUEST_MAY_CONSUME_SECRET' }, { exclusive: true });
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
    if (lastConfirmedVersion !== null && (!positiveVersion(lastConfirmedVersion))) throw fail('RUNTIME_ACK_VERSION_INVALID');
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
        || !e05InternalScope(endpoint, options) || !skillConversationHttpScope(endpoint, options) || !materialsChatHttpScope(endpoint, options)
        || [...endpoint.searchParams.keys()].some(key => /^(?:api[_-]?key|authorization|session[_-]?token|token)$/i.test(key))) throw fail('RUNTIME_NATIVE_SCOPE_INVALID');
    const session = this.currentSession; const proof = this.sessionHeaders();
    const signal = this.sessionAbort?.signal;
    const headers = new Headers(options.headers);
    for (const key of ['x-api-key', 'cookie', 'proxy-authorization', 'origin', ...Object.keys(proof)]) headers.delete(key);
    for (const [key, value] of Object.entries(proof)) headers.set(key, value);
    const requestId = headers.get('X-Request-Id') ?? randomUUID();
    headers.set('X-Request-Id', requestId);
    const method = (options.method || 'GET').toUpperCase();
    let body = options.body;
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    if (['POST', 'PUT', 'PATCH'].includes(method) || method === 'DELETE' && body !== undefined) {
      if (!multipart && (body === undefined || body === null || /application\/json/i.test(headers.get('content-type') || ''))) {
        const data = body == null ? null : parseStrictJson(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
        body = JSON.stringify(encodeHttpRequest(data, requestId));
        headers.set('Content-Type', 'application/json');
      }
    }
    const response = await this.fetchFn(endpoint, { ...options, method, ...(body === undefined ? {} : { body }), redirect: 'error', headers,
      ...(signal ? { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal } : {}) });
    if (this.currentSession !== session) throw fail('RUNTIME_NATIVE_SESSION_CHANGED');
    // Validate correlation without replacing Response or rewriting canonical data/file bytes.
    // Consumers explicitly decode data; failures remain real HTTP responses for their reconciliation policy.
    if (method !== 'HEAD' && ![204, 304].includes(response.status) && /application\/json/i.test(response.headers.get('content-type') || '')) {
      try { decodeHttpResponse(await response.clone().text(), { status: response.status, requestId, responseRequestId: response.headers.get('X-Request-Id') }); }
      catch (error) { if (error.failureClass !== 'http') throw error; }
      if (this.currentSession !== session) throw fail('RUNTIME_NATIVE_SESSION_CHANGED');
    }
    return response;
  }
}
