// UR-01 local host contract, not a wire DTO. Lock order: lifetime host/Agent
// ownership -> per-Agent lifecycle gate -> executor's existing short store locks.
// No filesystem lock is taken around a network wait. No stale lock is stolen.
import { randomUUID } from 'node:crypto';
import { constants, open, lstat, realpath, mkdir, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { readRuntimeHostConfig, runtimeSubjectKey, validateManifest, stableJson } from './manifest.mjs';
import { readPrivateJson, writePrivateJson } from './security.mjs';

const error = code => Object.assign(new Error(code), { code });
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

// Require operator-created private roots; never repair or adopt an unknown root.
export async function requireOwnedPrivateRoot(path) {
  const canonical = await realpath(path);
  const stat = await lstat(path);
  if (!isAbsolute(path) || canonical !== path || !stat.isDirectory()
      || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw error('RUNTIME_ROOT_UNSAFE');
  return stat;
}

export async function acquireRuntimeOwnership(root, { hostId, instanceId, subjectKey = null }) {
  const rootIdentity = await requireOwnedPrivateRoot(root);
  const lockPath = resolve(root, '.runtime-writer.lock');
  // Directory publication provides cross-process exclusivity. An interrupted
  // owner-file write intentionally leaves a lock requiring stopped-writer repair.
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (cause) { if (cause.code === 'EEXIST') throw error('RUNTIME_WRITER_BUSY'); throw cause; }
  await syncDirectory(root);
  const owner = { formatVersion: 1, hostId, instanceId, subjectKey, pid: process.pid, nonce: randomUUID() };
  const bytes = `${JSON.stringify(owner)}\n`;
  const ownerPath = resolve(lockPath, 'owner.json');
  const descriptor = await open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await descriptor.writeFile(bytes); await descriptor.sync(); } finally { await descriptor.close(); }
  await syncDirectory(lockPath); await syncDirectory(root);
  const identity = await lstat(lockPath, { bigint: true });
  let releasePromise = null;
  const releaseOwned = async () => {
    const currentRoot = await requireOwnedPrivateRoot(root);
    if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) throw error('RUNTIME_WRITER_OWNERSHIP_LOST');
    const current = await lstat(lockPath, { bigint: true });
    const file = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let actual;
    try { const stat = await file.stat(); if (!stat.isFile()) throw error('RUNTIME_WRITER_OWNERSHIP_LOST'); actual = await file.readFile('utf8'); }
    finally { await file.close(); }
    if (current.dev !== identity.dev || current.ino !== identity.ino || actual !== bytes) throw error('RUNTIME_WRITER_OWNERSHIP_LOST');
    await unlink(ownerPath); await rmdir(lockPath); await syncDirectory(root);
  };
  return () => releasePromise || (releasePromise = releaseOwned());
}

export class RuntimeHost {
  constructor({ config, instanceId = randomUUID(), createExecutor, flushEvidence, cleanPrivateData, admitRelationship, logger = () => {} }) {
    if (typeof createExecutor !== 'function' || !config?.agents?.length) throw error('RUNTIME_HOST_CONFIG_REQUIRED');
    if (typeof instanceId !== 'string' || !instanceId || instanceId === config.hostId) throw error('RUNTIME_INSTANCE_ID_INVALID');
    this.config = config; this.instanceId = instanceId; this.createExecutor = createExecutor; this.flushEvidence = flushEvidence; this.cleanPrivateData = cleanPrivateData; this.admitRelationship = admitRelationship; this.logger = logger;
    this.agents = new Map(config.agents.map(agent => [runtimeSubjectKey(agent.manifest), {
      agent, phase: 'STOPPED', executor: null, release: null, gate: Promise.resolve(), reasonCode: null
    }]));
    this.releaseHost = null; this.startPromise = null; this.stopPromise = null; this.stopping = false;
  }

  snapshot() {
    return { hostId: this.config.hostId, instanceId: this.instanceId, agents: [...this.agents.entries()].map(([subjectKey, state]) => ({
      subjectKey, installationId: state.agent.manifest.installationId, phase: state.phase,
      // Local initialization is not authentication or execution-channel readiness.
      ready: !state.quiesceRequested && ['READY', 'INITIALIZED'].includes(state.phase) && state.executor?.ready?.() === true, reasonCode: state.reasonCode
    })) };
  }

  withAgent(key, operation) {
    const state = this.agents.get(key);
    if (!state) return Promise.reject(error('RUNTIME_AGENT_UNKNOWN'));
    const next = state.gate.catch(() => {}).then(() => operation(state));
    state.gate = next.catch(() => {});
    return next;
  }

  start() {
    if (this.stopPromise) return Promise.reject(error('RUNTIME_HOST_STOPPED'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startAll();
    return this.startPromise;
  }

  async startAll() {
    this.releaseHost = await acquireRuntimeOwnership(this.config.stateRoot, { hostId: this.config.hostId, instanceId: this.instanceId });
    // Each Agent may initialize independently. One bad local state never grants
    // it a channel, but does not tear down the other initialized Agents.
    await Promise.all([...this.agents.keys()].map(key => this.withAgent(key, async state => {
      if (this.stopping) return;
      await this.initializeAgent(key, state);
    })));
    return this.snapshot();
  }


  async initializeAgent(key, state) {
      state.phase = 'STARTING';
      try {
        state.release ||= await acquireRuntimeOwnership(state.agent.stateRoot, {
          hostId: this.config.hostId, instanceId: this.instanceId, subjectKey: key
        });
        const handover = await readPrivateJson(resolve(state.agent.stateRoot, 'handover.json'), undefined);
        const admission = await readPrivateJson(resolve(state.agent.stateRoot, 'relationship-admission.json'), undefined);
        if (admission !== undefined) {
          this.requireAdmissionRecord(key, admission);
          if (![admission.previousManifest.manifestSha256, admission.manifest.manifestSha256].includes(state.agent.manifest.manifestSha256))
            throw error('RUNTIME_ADMISSION_IDENTITY_CONFLICT');
          if (admission.phase !== 'COMMITTED' || admission.manifest.manifestSha256 !== state.agent.manifest.manifestSha256 || handover !== undefined) {
            state.quiesceRequested = true; state.phase = 'QUIESCED';
            return; // A restart cannot revive either side of an unfinished admission.
          }
        }
        if (handover !== undefined) {
          this.requireHandoverRecord(key, state, handover);
          state.handover = handover; state.quiesceRequested = true;
          state.phase = handover.phase === 'QUIESCED' ? 'QUIESCED' : 'QUIESCING';
          return; // Ownership retained. Restart is not permission to resume old execution.
        }
        if (state.quiesceRequested) { state.phase = 'QUIESCING'; return; }
        state.executor = await this.createExecutor({ agent: state.agent, instanceId: this.instanceId, subjectKey: key });
        if (!state.executor || ['initialize', 'activate', 'ready', 'pause', 'close'].some(method => typeof state.executor[method] !== 'function')) throw error('RUNTIME_EXECUTOR_INVALID');
        await state.executor.initialize();
        state.phase = 'INITIALIZED'; // wire authorization must explicitly activate it later
      } catch (cause) {
        state.phase = 'ISOLATED'; state.reasonCode = 'RUNTIME_AGENT_INITIALIZATION_FAILED';
        // If close fails, retain writer ownership; possible live execution is not
        // permission to release the root for another host.
        try { await state.executor?.close?.(); await state.release?.(); state.release = null; }
        catch { state.reasonCode = 'RUNTIME_AGENT_STOP_UNCONFIRMED'; }
        this.logger('runtime-agent-isolated', { subjectKey: key, reasonCode: state.reasonCode });
      }
  }

  // Full subject identity and canonical roots are validated locally before admission.
  // Control callers supply only generated, trusted-template entries, never wire config.
  ensureAgent(agent, { recreate = false } = {}) {
    try {
      if (this.stopping || !this.releaseHost) throw error('RUNTIME_HOST_NOT_RUNNING');
      validateManifest(agent.manifest);
      const key = runtimeSubjectKey(agent.manifest);
      if (agent.subjectKey !== key || agent.profile.agentId !== agent.manifest.canonicalAgentId) throw error('RUNTIME_AGENT_IDENTITY_INVALID');
      const prior = this.agents.get(key);
      if (prior && (stableJson(prior.agent.manifest) !== stableJson(agent.manifest)
          || prior.agent.stateRoot !== agent.stateRoot || stableJson(prior.agent.profile) !== stableJson(agent.profile))) throw error('RUNTIME_AGENT_IDENTITY_CONFLICT');
      const roots = candidate => [candidate.stateRoot, ...['codexHome', 'codexWorkdir', 'chatWorkdir', 'workspaceFallbackWorkdir',
        'workspaceFileRootDir', 'typedInspectionRootDir', 'typedInspectionStateRoot', 'controlledImageHttpLedgerRoot'].map(field => candidate.profile[field]).filter(Boolean)];
      const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      for (const path of roots(agent)) {
        if (!isAbsolute(path) || resolve(path) !== path || overlaps(path, this.config.stateRoot)) throw error('RUNTIME_PATH_INVALID');
        for (const [otherKey, other] of this.agents) {
          if (otherKey !== key && (other.agent.manifest.installationId === agent.manifest.installationId
              || roots(other.agent).some(root => overlaps(path, root)))) throw error('RUNTIME_AGENT_ROOTS_OVERLAP');
        }
      }
      if (!prior) this.agents.set(key, { agent, phase: 'STOPPED', executor: null, release: null, gate: Promise.resolve(), reasonCode: null });
      // Interrupt only the subject's registration wait, before queuing shutdown.
      // No ownership/engine state is released outside the lifecycle gate.
      if (recreate) prior?.executor?.cancelActivation?.();
      return this.withAgent(key, async state => {
        if (this.stopping) throw error('RUNTIME_HOST_STOPPED');
        if (state.quiesceRequested) throw error('RUNTIME_HANDOVER_PENDING');
        for (const path of roots(state.agent)) await requireOwnedPrivateRoot(path);
        if (recreate) {
          await state.executor?.pause?.(); await state.executor?.close?.();
          state.executor = null; state.phase = 'STOPPED'; state.reasonCode = null;
          // Retain Agent writer ownership throughout replacement.
        }
        if (state.phase === 'STOPPED') await this.initializeAgent(key, state);
        if (state.quiesceRequested) throw error('RUNTIME_HANDOVER_PENDING');
        if (!['INITIALIZED', 'READY'].includes(state.phase)) throw error(state.reasonCode || 'RUNTIME_AGENT_NOT_INITIALIZED');
        return state;
      });
    } catch (cause) { return Promise.reject(cause); }
  }

  reprovisionAgent(agent) { return this.ensureAgent(agent, { recreate: true }); }

  requireAdmissionRecord(key, record) {
    if (!record || record.formatVersion !== 1 || record.subjectKey !== key
        || !['PREPARED', 'COMMITTED'].includes(record.phase)
        || ['operationId', 'handoverId', 'leaseId', 'previousOwnerJiacn', 'ownerJiacn'].some(field => typeof record[field] !== 'string' || !record[field].trim()))
      throw error('RUNTIME_ADMISSION_STATE_INVALID');
    validateManifest(record.previousManifest); validateManifest(record.manifest);
    if (runtimeSubjectKey(record.previousManifest) !== key || runtimeSubjectKey(record.manifest) !== key
        || record.previousManifest.installationId === record.manifest.installationId)
      throw error('RUNTIME_ADMISSION_IDENTITY_CONFLICT');
  }

  // Trusted control transition, not a public request DTO. Keep the same writer
  // lock and roots across private identity replacement; no enrollment here.
  readmitAgent(previousAgent, agent, association, materialize) {
    try {
      if (this.stopping || !this.releaseHost) throw error('RUNTIME_HOST_NOT_RUNNING');
      const key = runtimeSubjectKey(agent.manifest);
      const intent = { formatVersion: 1, subjectKey: key, ...association,
        previousManifest: previousAgent.manifest, manifest: agent.manifest, phase: 'PREPARED' };
      this.requireAdmissionRecord(key, intent);
      if (agent.subjectKey !== key || previousAgent.subjectKey !== key || agent.profile.agentId !== agent.manifest.canonicalAgentId
          || agent.stateRoot !== previousAgent.stateRoot || stableJson(agent.profile) !== stableJson(previousAgent.profile)
          || typeof materialize !== 'function' || typeof this.admitRelationship !== 'function')
        throw error('RUNTIME_ADMISSION_IDENTITY_CONFLICT');
      const roots = candidate => [candidate.stateRoot, candidate.profile.codexHome, candidate.profile.codexWorkdir];
      const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      for (const path of roots(agent)) {
        if (!isAbsolute(path) || resolve(path) !== path || overlaps(path, this.config.stateRoot)) throw error('RUNTIME_PATH_INVALID');
        for (const [otherKey, other] of this.agents) if (otherKey !== key && (other.agent.manifest.installationId === agent.manifest.installationId
            || roots(other.agent).some(root => overlaps(path, root)))) throw error('RUNTIME_AGENT_ROOTS_OVERLAP');
      }
      if (!this.agents.has(key)) this.agents.set(key, { agent: previousAgent, phase: 'STOPPED', executor: null, release: null, gate: Promise.resolve(), reasonCode: null });
      return this.withAgent(key, async state => {
        if (this.stopping) throw error('RUNTIME_HOST_STOPPED');
        if (state.agent.stateRoot !== agent.stateRoot || stableJson(state.agent.profile) !== stableJson(agent.profile)
            || ![previousAgent.manifest.manifestSha256, agent.manifest.manifestSha256].includes(state.agent.manifest.manifestSha256))
          throw error('RUNTIME_ADMISSION_IDENTITY_CONFLICT');
        const path = resolve(agent.stateRoot, 'relationship-admission.json'), handoverPath = resolve(agent.stateRoot, 'handover.json');
        for (const root of roots(agent)) await requireOwnedPrivateRoot(root);
        state.release ||= await acquireRuntimeOwnership(agent.stateRoot, { hostId: this.config.hostId, instanceId: this.instanceId, subjectKey: key });
        let record = await readPrivateJson(path, undefined);
        if (record !== undefined) {
          this.requireAdmissionRecord(key, record);
          if (stableJson({ ...record, phase: 'PREPARED' }) !== stableJson(intent)) throw error('RUNTIME_ADMISSION_IDENTITY_CONFLICT');
          if (record.phase === 'COMMITTED' && state.agent.manifest.manifestSha256 === agent.manifest.manifestSha256 && state.executor) return state;
        }
        if (state.executor) throw error('RUNTIME_HANDOVER_STOP_REQUIRED');
        const handover = await readPrivateJson(handoverPath, undefined);
        if (handover !== undefined) {
          this.requireHandoverRecord(key, { agent: previousAgent }, handover);
          if (handover.cleanupComplete !== true || handover.operationId !== association.handoverId
              || handover.cleanupLeaseId !== association.leaseId || handover.evidenceOwnerJiacn !== association.previousOwnerJiacn)
            throw error('RUNTIME_ADMISSION_CLEANUP_REQUIRED');
        } else if (record?.phase !== 'COMMITTED') throw error('RUNTIME_ADMISSION_CLEANUP_REQUIRED');
        state.quiesceRequested = true; state.phase = 'QUIESCED';
        if (!record) { await writePrivateJson(path, intent, { exclusive: true }); record = intent; }
        await materialize(previousAgent, agent);
        await this.admitRelationship({ previousAgent, agent, operationId: association.handoverId,
          previousOwnerJiacn: association.previousOwnerJiacn, ownerJiacn: association.ownerJiacn });
        if (record.phase !== 'COMMITTED') await writePrivateJson(path, { ...intent, phase: 'COMMITTED' });
        // The committed receipt keeps the original cleanup identity for crash recovery.
        // Delete only this checked old marker, never public files or private roots.
        if (handover !== undefined) { await unlink(handoverPath); await syncDirectory(agent.stateRoot); }
        state.agent = agent; state.handover = null; state.handoverOperation = null;
        state.quiesceRequested = false; state.phase = 'STOPPED'; state.reasonCode = null;
        await this.initializeAgent(key, state);
        if (state.phase !== 'INITIALIZED') throw error(state.reasonCode || 'RUNTIME_AGENT_NOT_INITIALIZED');
        return state;
      });
    } catch (cause) { return Promise.reject(cause); }
  }

  agentEvidence(key) {
    const state = this.agents.get(key);
    return !this.stopping && !state?.quiesceRequested && ['READY', 'INITIALIZED'].includes(state?.phase) && state.executor?.ready?.() === true
      ? state.executor.evidence?.() || null : null;
  }

  // This is an internal executor boundary. Session DTO validation is supplied by
  // the frozen wire adapter, never inferred by this lifecycle host.
  activate(key, session) {
    return this.withAgent(key, async state => {
      if (this.stopping || state.quiesceRequested || state.phase !== 'INITIALIZED') throw error('RUNTIME_AGENT_NOT_INITIALIZED');
      try {
        await state.executor.activate(session);
        state.phase = state.executor.ready() === true ? 'READY' : 'INITIALIZED';
        state.reasonCode = state.executor.ready() === true ? null : 'RUNTIME_ADAPTER_UNAVAILABLE';
      } catch (cause) {
        state.phase = 'ISOLATED'; state.reasonCode = 'RUNTIME_AGENT_AUTHORIZATION_FAILED';
        await state.executor.pause?.(); throw cause;
      }
    });
  }

  requireHandoverRecord(key, state, record) {
    const manifest = state.agent.manifest;
    if (!record || typeof record !== 'object' || record.formatVersion !== 1 || record.subjectKey !== key
        || record.installationId !== manifest.installationId || record.manifestSha256 !== manifest.manifestSha256
        || typeof record.operationId !== 'string' || !record.operationId.trim()
        || record.evidenceOwnerJiacn !== undefined && (typeof record.evidenceOwnerJiacn !== 'string' || !record.evidenceOwnerJiacn.trim() || record.evidenceOwnerJiacn !== record.evidenceOwnerJiacn.trim())
        || record.evidenceAccepted !== undefined && (record.evidenceAccepted !== true || !record.evidenceOwnerJiacn || record.phase !== 'QUIESCED')
        || record.knowledgeStatus !== undefined && (!['REQUESTED', 'EXTRACTED', 'FAILED'].includes(record.knowledgeStatus) || record.evidenceAccepted !== true)
        || record.cleanupComplete !== undefined && (record.cleanupComplete !== true || record.evidenceAccepted !== true)
        || !['REQUESTED', 'QUIESCED'].includes(record.phase)) throw error('RUNTIME_HANDOVER_STATE_INVALID');
  }

  // Trusted local lifecycle boundary. The authenticated control adapter must bind
  // operationId to the current business relationship; this host never decides rent.
  // Trusted controller supplies the original owner from the authenticated relationship.
  // A source-delivery receipt is not a private-cleanup or relationship-release receipt.
  flushAgentEvidence(key, { installationId, operationId, ownerJiacn } = {}) {
    return this.withAgent(key, async state => {
      if (this.stopping || !this.releaseHost || !state.release) throw error('RUNTIME_HANDOVER_OWNERSHIP_REQUIRED');
      const path = resolve(state.agent.stateRoot, 'handover.json');
      const record = await readPrivateJson(path, undefined);
      this.requireHandoverRecord(key, state, record);
      if (installationId !== record.installationId || operationId !== record.operationId
          || typeof ownerJiacn !== 'string' || !ownerJiacn.trim() || ownerJiacn !== ownerJiacn.trim()
          || record.evidenceOwnerJiacn && record.evidenceOwnerJiacn !== ownerJiacn) throw error('RUNTIME_HANDOVER_IDENTITY_CONFLICT');
      if (record.phase !== 'QUIESCED' || state.executor) throw error('RUNTIME_HANDOVER_STOP_REQUIRED');
      if (record.evidenceAccepted !== true) {
        if (typeof this.flushEvidence !== 'function') throw error('RUNTIME_USAGE_DELIVERY_UNAVAILABLE');
        // Bind even a failed attempt to its original owner before external I/O.
        if (!record.evidenceOwnerJiacn) {
          record.evidenceOwnerJiacn = ownerJiacn;
          await writePrivateJson(path, record);
        }
        const result = await this.flushEvidence({ agent: state.agent, ownerJiacn });
        if (result?.confirmed !== true) return { confirmed: false };
        record.evidenceAccepted = true;
        await writePrivateJson(path, record);
        state.handover = record;
      }
      return { confirmed: true };
    });
  }

  // The trusted storage adapter owns public/private classification and must finish
  // skill retirement and every private root before confirming. No default erasure
  // of codexWorkdir: it may be the shared project repository. This receipt alone
  // neither releases the business relationship nor permits another executor.
  cleanAgentPrivateData(key, { installationId, operationId, ownerJiacn, leaseId } = {}) {
    return this.withAgent(key, async state => {
      if (this.stopping || !this.releaseHost || !state.release) throw error('RUNTIME_HANDOVER_OWNERSHIP_REQUIRED');
      const path = resolve(state.agent.stateRoot, 'handover.json');
      const record = await readPrivateJson(path, undefined);
      this.requireHandoverRecord(key, state, record);
      if (installationId !== record.installationId || operationId !== record.operationId
          || !ownerJiacn || ownerJiacn !== record.evidenceOwnerJiacn) throw error('RUNTIME_HANDOVER_IDENTITY_CONFLICT');
      if (record.phase !== 'QUIESCED' || state.executor) throw error('RUNTIME_HANDOVER_STOP_REQUIRED');
      if (record.evidenceAccepted !== true) throw error('RUNTIME_HANDOVER_EVIDENCE_REQUIRED');
      if (typeof leaseId !== 'string' || !leaseId.trim() || record.cleanupLeaseId && record.cleanupLeaseId !== leaseId)
        throw error('RUNTIME_HANDOVER_IDENTITY_CONFLICT');
      if (!record.cleanupLeaseId) {
        record.cleanupLeaseId = leaseId;
        await writePrivateJson(path, record);
        state.handover = record;
      }
      if (record.cleanupComplete !== true) {
        if (typeof this.cleanPrivateData !== 'function') throw error('RUNTIME_PRIVATE_CLEANUP_UNAVAILABLE');
        const result = await this.cleanPrivateData({ agent: state.agent, ownerJiacn, operationId, leaseId,
          knowledgeStatus: record.knowledgeStatus,
          recordKnowledgeStatus: async status => {
            if (!['REQUESTED', 'EXTRACTED', 'FAILED'].includes(status)) throw error('RUNTIME_KNOWLEDGE_STATE_INVALID');
            record.knowledgeStatus = status;
            await writePrivateJson(path, record);
            state.handover = record;
          } });
        if (result?.confirmed !== true) return { confirmed: false };
        // The adapter must preserve this control journal and lifetime writer lock.
        // Persist only after successful deletion; failures retry the same operation.
        record.cleanupComplete = true;
        if (['EXTRACTED', 'FAILED'].includes(result.knowledgeStatus)) record.knowledgeStatus = result.knowledgeStatus;
        await writePrivateJson(path, record);
        state.handover = record;
      }
      return { confirmed: true };
    });
  }

  quiesceAgent(key, { installationId, operationId } = {}) {
    const state = this.agents.get(key);
    if (!state) return Promise.reject(error('RUNTIME_AGENT_UNKNOWN'));
    if (this.stopping || !this.releaseHost) return Promise.reject(error('RUNTIME_HOST_NOT_RUNNING'));
    if (installationId !== state.agent.manifest.installationId || typeof operationId !== 'string' || !operationId.trim())
      return Promise.reject(error('RUNTIME_HANDOVER_IDENTITY_CONFLICT'));
    if (state.handoverOperation && state.handoverOperation !== operationId
        || state.handover && state.handover.operationId !== operationId) return Promise.reject(error('RUNTIME_HANDOVER_CONFLICT'));
    state.handoverOperation = operationId; state.quiesceRequested = true;
    // Registration may be waiting inside the lifecycle gate; cancel only this
    // subject's activation before joining the gate (same as owned reprovision).
    state.executor?.cancelActivation?.();
    return this.withAgent(key, async current => {
      if (this.stopping) throw error('RUNTIME_HOST_STOPPED');
      if (!current.release) throw error('RUNTIME_HANDOVER_OWNERSHIP_REQUIRED');
      const path = resolve(current.agent.stateRoot, 'handover.json');
      // Read back on retry, including an ambiguous durable write. Never overwrite
      // an unknown intent after a process restart or interrupted publication.
      let record = await readPrivateJson(path, undefined);
      if (record !== undefined) {
        this.requireHandoverRecord(key, current, record);
        if (record.operationId !== operationId) throw error('RUNTIME_HANDOVER_CONFLICT');
      } else {
        record = { formatVersion: 1, subjectKey: key, installationId,
          manifestSha256: current.agent.manifest.manifestSha256, operationId, phase: 'REQUESTED' };
        await writePrivateJson(path, record, { exclusive: true });
      }
      current.handover = record; current.phase = 'QUIESCING';
      if (record.phase !== 'QUIESCED') {
        await current.executor?.pause();
        await current.executor?.close();
        record = { ...record, phase: 'QUIESCED' };
        await writePrivateJson(path, record);
      }
      current.executor = null; current.handover = record; current.phase = 'QUIESCED'; current.reasonCode = null;
      // Keep the writer lock throughout future private cleanup. QUIESCED is not
      // a cleanup receipt and does not authorize a fresh invitation/activation.
      return { subjectKey: key, installationId, operationId, phase: 'QUIESCED' };
    });
  }

  isolate(key, reasonCode = 'RUNTIME_AGENT_AUTHORIZATION_REVOKED') {
    return this.withAgent(key, async state => {
      state.phase = 'ISOLATED'; state.reasonCode = reasonCode;
      await state.executor?.pause?.();
      await state.executor?.close?.();
      // Keep the root lock until explicit host stop; no concurrent re-adoption.
    });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.stopAll();
    return this.stopPromise;
  }

  async stopAll() {
    try { await this.startPromise; } catch {}
    const results = await Promise.allSettled([...this.agents.keys()].map(key => this.withAgent(key, async state => {
      state.phase = 'STOPPING';
      await state.executor?.pause?.();
      await state.executor?.close?.();
      await state.release?.(); state.release = null; state.phase = 'STOPPED';
    })));
    const failure = results.find(item => item.status === 'rejected');
    if (failure) throw error('RUNTIME_HOST_STOP_UNCONFIRMED'); // retain host lock
    await this.releaseHost?.(); this.releaseHost = null;
    return this.snapshot();
  }
}

export async function createRuntimeHost({ configPath, ...options }) {
  const config = await readRuntimeHostConfig(configPath);
  return new RuntimeHost({ ...options, config });
}
