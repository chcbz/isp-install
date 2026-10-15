// runtime-hosting-v1: frozen 2026-10-10. No credentials/paths/commands accepted.
import { parseStrictTypedOutcomeJson } from '../../codex-ws-agent/juyiting-typed-outcome.mjs';
import { validateMessage, replyMessage } from './message-envelope.mjs';
import { randomUUID } from 'node:crypto';
import { hostingError, exactHostingId } from './hosting-config.mjs';
export const HOSTING_PROTOCOL = 'runtime-hosting-v1';
export const HOSTING_METHODS = Object.freeze(['capabilities', 'prepare', 'ensure', 'observe']);
export const HOSTING_ASSOCIATION_FIELDS = Object.freeze(['tenantId', 'clientId', 'ownerJiacn', 'canonicalAgentId', 'bindingId',
  'leaseId', 'initialIntentId', 'operationId', 'operationKind', 'reservedAt', 'requestedAt', 'validUntil']);
export const HOSTING_CANDIDATE_FIELDS = Object.freeze(['installationId', 'manifestSha256', 'provisionGeneration']);
export const positiveEpoch = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const fail = () => { throw hostingError('HOSTING_WIRE_INVALID'); };

// Reuse the mature duplicate/Unicode-safe parser; sanitize its diagnostic, which
// can contain a raw duplicate property name. No original message/cause escapes.
export function parseHostingJson(text) {
  if (typeof text !== 'string') throw hostingError('HOSTING_WIRE_INVALID');
  try { return parseStrictTypedOutcomeJson(text); }
  catch (cause) { throw hostingError(cause.code === 'TYPED_OUTCOME_DUPLICATE_KEY' ? 'HOSTING_DUPLICATE_FIELD' : 'HOSTING_WIRE_INVALID'); }
}
export function validateHostingAssociation(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.protocol !== HOSTING_PROTOCOL
      || !HOSTING_METHODS.includes(request.method)) fail();
  const allowed = ['protocol', 'method', ...(request.method === 'capabilities' ? ['tenantId', 'clientId', 'ownerJiacn'] : HOSTING_ASSOCIATION_FIELDS),
    ...(['ensure', 'observe'].includes(request.method) ? HOSTING_CANDIDATE_FIELDS : [])];
  if (Object.keys(request).sort().join(',') !== allowed.sort().join(',')) throw hostingError('HOSTING_FIELD_FORBIDDEN');
  const ids = request.method === 'capabilities' ? ['tenantId', 'clientId', 'ownerJiacn'] : HOSTING_ASSOCIATION_FIELDS.slice(0, 8);
  if (ids.some(field => !exactHostingId(request[field]))) fail();
  if (request.method !== 'capabilities') {
    if (!['INITIAL', 'REPROVISION'].includes(request.operationKind) || !positiveEpoch(request.reservedAt) || !positiveEpoch(request.requestedAt)
        || request.requestedAt < request.reservedAt
        || request.operationKind === 'INITIAL' && (request.operationId !== request.initialIntentId || request.validUntil !== null)
        || request.operationKind === 'REPROVISION' && (request.operationId === request.initialIntentId || !positiveEpoch(request.validUntil)
          || request.validUntil <= request.requestedAt)) fail();
    if (['ensure', 'observe'].includes(request.method) && (!/^rti_[0-9a-f]{32}$/.test(request.installationId)
        || !/^[0-9a-f]{64}$/.test(request.manifestSha256) || !Number.isSafeInteger(request.provisionGeneration) || request.provisionGeneration < 1)) fail();
  }
  return Object.freeze({ ...request });
}
export const hostingAssociation = request => Object.fromEntries(HOSTING_ASSOCIATION_FIELDS.map(key => [key, request[key]]));
export const hostingEnvelope = request => ({ protocol: HOSTING_PROTOCOL, method: request.method, ...hostingAssociation(request) });

// Public UDS messages are closed protocolVersion=1 envelopes. The journal keeps its private schema.
export function validateHostingRequest(message) {
  validateMessage(message);
  if (Object.hasOwn(message, 'correlationId') || !HOSTING_METHODS.some(method => message.messageType === `hosting.${method}`)
      || !message.data || typeof message.data !== 'object' || Array.isArray(message.data)) fail();
  const method = message.messageType.slice('hosting.'.length);
  const data = { ...message.data };
  if (['protocol', 'method', 'installationId', 'validUntil'].some(key => Object.hasOwn(data, key))) fail();
  if (Object.hasOwn(data, 'validUntilAt')) { data.validUntil = data.validUntilAt; delete data.validUntilAt; }
  if (Object.hasOwn(data, 'runtimeInstallationId')) { data.installationId = data.runtimeInstallationId; delete data.runtimeInstallationId; }
  if (Object.hasOwn(data, 'provisionGeneration')) {
    if (typeof data.provisionGeneration !== 'string' || !/^[1-9][0-9]*$/.test(data.provisionGeneration)
        || BigInt(data.provisionGeneration) > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    data.provisionGeneration = Number(data.provisionGeneration); // existing private journal range, checked before conversion
  }
  return validateHostingAssociation({ protocol: HOSTING_PROTOCOL, method, ...data });
}
export function hostingReply(message, result) {
  const { protocol, method, ...data } = result;
  if (protocol !== HOSTING_PROTOCOL || message.messageType !== `hosting.${method}`) fail();
  if (Object.hasOwn(data, 'validUntil')) { data.validUntilAt = data.validUntil; delete data.validUntil; }
  if (Object.hasOwn(data, 'installationId')) { data.runtimeInstallationId = data.installationId; delete data.installationId; }
  for (const field of ['provisionGeneration', 'sessionGeneration']) {
    if (Object.hasOwn(data, field)) {
      if (typeof data[field] === 'number') {
        if (!Number.isSafeInteger(data[field]) || data[field] < 1) fail();
        data[field] = String(data[field]);
      } else if (typeof data[field] !== 'string' || !/^[1-9][0-9]*$/.test(data[field]) || BigInt(data[field]) > 9223372036854775807n) fail();
    }
  }
  return replyMessage(message, `${message.messageType}.result`, randomUUID(), 'E0', 'ok', data);
}
