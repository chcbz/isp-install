// SAME RuntimeHost, private persistent candidate/admission journal. No DB/API key
// broker, second engine/service, payment, caller-selected config or blind enroll.
import { createHash, randomBytes } from 'node:crypto';
import { constants, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestManifest, runtimeSubjectKey, stableJson, validateManifest } from './manifest.mjs';
import { acquireRuntimeOwnership, requireOwnedPrivateRoot } from './runtime-host.mjs';
import { RuntimeV1Client } from './runtime-client.mjs';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from './security.mjs';
import { hostingError, validateHostingConfig } from './hosting-config.mjs';
import { HOSTING_ASSOCIATION_FIELDS, HOSTING_PROTOCOL, hostingAssociation, hostingEnvelope, positiveEpoch, validateHostingRequest } from './hosting-wire.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const opKey = request => sha(stableJson({ tenantId: request.tenantId, clientId: request.clientId, operationId: request.operationId }));
const same = (a, b) => stableJson(a) === stableJson(b);
const initialFields = ['tenantId', 'clientId', 'ownerJiacn', 'canonicalAgentId', 'bindingId', 'leaseId', 'initialIntentId', 'reservedAt'];
const privateFile = async (path, bytes) => {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
};

export class HostingControl {
  constructor({ host, config, apiOrigin, clientFactory = settings => new RuntimeV1Client(settings), workspacePolicies = new Map(), now = Date.now, logger = () => {} }) {
    this.host = host; this.config = validateHostingConfig(config); this.apiOrigin = apiOrigin; this.clientFactory = clientFactory; this.workspacePolicies = workspacePolicies; this.now = now; this.logger = logger;
    this.path = resolve(config.managedRoot, 'hosting-journal.json'); this.state = null; this.release = null;
    this.gates = new Map(); this.journalGate = Promise.resolve(); this.jobs = new Map(); this.started = new Set(); this.aborters = new Map(); this.live = new Map(); this.closing = false; this.journalFailed = false;
  }
  scopeAllowed(request) { return this.config.scopes.some(scope => ['tenantId', 'clientId', 'ownerJiacn'].every(key => scope[key] === request[key])); }
  subjectAgent(subject) {
    const key = runtimeSubjectKey(subject.manifest); const root = resolve(this.config.managedRoot, key);
    return { subjectKey: key, manifest: subject.manifest, stateRoot: resolve(root, 'state'),
      manifestPath: resolve(root, 'manifest.json'), profilePath: resolve(root, 'profile.json'),
      providerEnvironment: subject.template.providerEnvironment,
      profile: { ...subject.template.profile, profileId: `managed-${key}`, agentId: subject.manifest.canonicalAgentId,
        codexHome: resolve(root, 'home'), codexWorkdir: resolve(root, 'work'), chatWorkdir: resolve(root, 'work'),
        workspaceFallbackWorkdir: resolve(root, 'work') } };
  }
  async initialize() {
    await requireOwnedPrivateRoot(this.config.managedRoot);
    this.release = await acquireRuntimeOwnership(this.config.managedRoot, { hostId: this.host.config.hostId, instanceId: this.host.instanceId, subjectKey: 'managed-control' });
    try {
      const initial = { formatVersion: 1, hostId: this.host.config.hostId, subjects: {}, operations: {} };
      this.state = await readPrivateJson(this.path, null);
      if (!this.state) { await writePrivateJson(this.path, initial, { exclusive: true }); this.state = initial; }
      this.validateJournal();
      return this;
    } catch (cause) { await this.release(); this.release = null; throw cause; }
  }
  validateJournal() {
    const state = this.state;
    if (!state || state.formatVersion !== 1 || state.hostId !== this.host.config.hostId
        || Object.keys(state).sort().join(',') !== 'formatVersion,hostId,operations,subjects'
        || !state.subjects || !state.operations || typeof state.subjects !== 'object' || typeof state.operations !== 'object'
        || Array.isArray(state.subjects) || Array.isArray(state.operations)) throw hostingError('HOSTING_JOURNAL_INVALID');
    const installations = new Set();
    for (const [key, subject] of Object.entries(state.subjects)) {
      if (Object.keys(subject).sort().join(',') !== 'activeOperationKey,enrollmentExpiresAt,enrollmentSecret,enrollmentSecretSha256,initialAssociation,lastSessionGeneration,latestGeneration,manifest,template') throw hostingError('HOSTING_JOURNAL_INVALID');
      if (Object.keys(subject.initialAssociation || {}).sort().join(',') !== [...HOSTING_ASSOCIATION_FIELDS].sort().join(',')) throw hostingError('HOSTING_JOURNAL_INVALID');
      validateManifest(subject.manifest);
      validateHostingRequest({ protocol: HOSTING_PROTOCOL, method: 'prepare', ...subject.initialAssociation });
      validateHostingConfig({ ...this.config, template: subject.template });
      if (!this.scopeAllowed(subject.initialAssociation) || runtimeSubjectKey(subject.manifest) !== key
          || subject.initialAssociation.operationKind !== 'INITIAL' || subject.manifest.manifestVersion !== '1'
          || !/^rti_[0-9a-f]{32}$/.test(subject.manifest.installationId) || !/^[0-9a-f]{64}$/.test(subject.enrollmentSecret)
          || sha(subject.enrollmentSecret) !== subject.enrollmentSecretSha256 || !positiveEpoch(subject.enrollmentExpiresAt)
          || !Number.isSafeInteger(subject.latestGeneration) || subject.latestGeneration < 1
          || !Number.isSafeInteger(subject.lastSessionGeneration) || subject.lastSessionGeneration < 0
          || installations.has(subject.manifest.installationId)
          || ['tenantId', 'clientId', 'canonicalAgentId'].some(field => subject.manifest[field] !== subject.initialAssociation[field])) throw hostingError('HOSTING_JOURNAL_INVALID');
      installations.add(subject.manifest.installationId);
      if (this.host.agents.has(key) || [...this.host.agents.values()].some(item => item.agent.manifest.installationId === subject.manifest.installationId)) throw hostingError('HOSTING_SUBJECT_STATIC_CONFLICT');
    }
    for (const [key, operation] of Object.entries(state.operations)) {
      if (Object.keys(operation).sort().join(',') !== 'admittedAt,association,provisionGeneration,recoveryRequired,subjectKey') throw hostingError('HOSTING_JOURNAL_INVALID');
      if (Object.keys(operation.association || {}).sort().join(',') !== [...HOSTING_ASSOCIATION_FIELDS].sort().join(',')) throw hostingError('HOSTING_JOURNAL_INVALID');
      const association = validateHostingRequest({ protocol: HOSTING_PROTOCOL, method: 'prepare', ...operation.association });
      const subject = state.subjects[operation.subjectKey];
      if (!subject || opKey(association) !== key || runtimeSubjectKey(association) !== operation.subjectKey || !this.scopeAllowed(association)
          || initialFields.some(field => association[field] !== subject.initialAssociation[field])
          || !Number.isSafeInteger(operation.provisionGeneration) || operation.provisionGeneration < 1 || operation.provisionGeneration > subject.latestGeneration
          || association.operationKind === 'INITIAL' && operation.provisionGeneration !== 1
          || association.operationKind === 'REPROVISION' && operation.provisionGeneration <= 1
          || operation.admittedAt !== null && !positiveEpoch(operation.admittedAt) || typeof operation.recoveryRequired !== 'boolean') throw hostingError('HOSTING_JOURNAL_INVALID');
    }
    for (const [subjectKey, subject] of Object.entries(state.subjects)) {
      const operations = Object.entries(state.operations).filter(([, operation]) => operation.subjectKey === subjectKey);
      if (!operations.some(([, operation]) => operation.provisionGeneration === 1 && same(operation.association, subject.initialAssociation))
          || new Set(operations.map(([, operation]) => operation.provisionGeneration)).size !== operations.length
          || Math.max(...operations.map(([, operation]) => operation.provisionGeneration)) !== subject.latestGeneration
          || operations.length !== subject.latestGeneration) throw hostingError('HOSTING_JOURNAL_INVALID');
      if (subject.activeOperationKey !== null) {
        const active = state.operations[subject.activeOperationKey];
        if (!active || active.subjectKey !== subjectKey || active.admittedAt === null) throw hostingError('HOSTING_JOURNAL_INVALID');
      }
    }
  }
  withSubject(key, operation) {
    const prior = this.gates.get(key) || Promise.resolve();
    const result = prior.catch(() => {}).then(operation); this.gates.set(key, result);
    void result.then(() => { if (this.gates.get(key) === result) this.gates.delete(key); }, () => { if (this.gates.get(key) === result) this.gates.delete(key); });
    return result;
  }
  mutate(operation) {
    const result = this.journalGate.catch(() => {}).then(async () => {
      if (this.journalFailed) throw hostingError('HOSTING_JOURNAL_WRITE_UNCONFIRMED');
      const next = structuredClone(this.state); const { value, changed = true } = operation(next);
      if (changed) {
        try { await writePrivateJson(this.path, next); this.state = next; }
        catch { this.journalFailed = true; this.closing = true; throw hostingError('HOSTING_JOURNAL_WRITE_UNCONFIRMED'); }
      }
      return value;
    });
    this.journalGate = result.catch(() => {}); return result;
  }
  prepared(request, operation, subject) {
    return { ...hostingEnvelope(request), outcome: 'PREPARED', installationId: subject.manifest.installationId, manifest: subject.manifest,
      manifestSha256: subject.manifest.manifestSha256.slice(7), enrollmentSecretSha256: subject.enrollmentSecretSha256,
      enrollmentExpiresAt: subject.enrollmentExpiresAt, provisionGeneration: operation.provisionGeneration, hostId: this.host.config.hostId };
  }
  async handle(input) {
    const request = validateHostingRequest(input);
    if (this.closing || !this.state || !this.host.releaseHost || this.host.stopping) throw hostingError('HOSTING_CONTROL_NOT_RUNNING');
    if (!this.scopeAllowed(request)) throw hostingError('HOSTING_SCOPE_REJECTED');
    if (request.method === 'capabilities') return { protocol: HOSTING_PROTOCOL, method: request.method, tenantId: request.tenantId,
      clientId: request.clientId, ownerJiacn: request.ownerJiacn, available: !this.config.template.profile.workspacePolicyId || this.workspacePolicies.has(this.config.template.profile.workspacePolicyId), hostId: this.host.config.hostId };
    const subjectKey = runtimeSubjectKey(request); const key = opKey(request);
    return this.withSubject(subjectKey, async () => {
      if (this.closing) throw hostingError('HOSTING_CONTROL_NOT_RUNNING');
      if (request.method === 'prepare') return this.mutate(state => {
        const prior = state.operations[key];
        if (prior) {
          if (!same(prior.association, hostingAssociation(request))) throw hostingError('HOSTING_OPERATION_CONFLICT');
          return { value: this.prepared(request, prior, state.subjects[prior.subjectKey]), changed: false };
        }
        if (this.config.template.profile.workspacePolicyId && !this.workspacePolicies.has(this.config.template.profile.workspacePolicyId)) throw hostingError('HOSTING_TEMPLATE_PROFILE_INVALID');
        let subject = state.subjects[subjectKey];
        if (request.operationKind === 'INITIAL') {
          if (subject || this.host.agents.has(subjectKey)) throw hostingError('HOSTING_SUBJECT_CONFLICT');
          const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: `rti_${randomBytes(16).toString('hex')}`,
            tenantId: request.tenantId, clientId: request.clientId, canonicalAgentId: request.canonicalAgentId };
          const enrollmentSecret = randomBytes(32).toString('hex'); const enrollmentExpiresAt = this.now() + this.config.enrollmentTtlMs;
          if (!positiveEpoch(enrollmentExpiresAt)) throw hostingError('HOSTING_GENERATION_EXHAUSTED');
          subject = { manifest: { ...unsigned, manifestSha256: digestManifest(unsigned) }, enrollmentSecret,
            enrollmentSecretSha256: sha(enrollmentSecret), enrollmentExpiresAt, initialAssociation: hostingAssociation(request),
            template: structuredClone(this.config.template), latestGeneration: 1, activeOperationKey: null, lastSessionGeneration: 0 };
          state.subjects[subjectKey] = subject;
        } else {
          if (!subject || initialFields.some(field => request[field] !== subject.initialAssociation[field])) throw hostingError('HOSTING_ASSOCIATION_REJECTED');
          if (request.validUntil <= this.now()) throw hostingError('HOSTING_LEASE_EXPIRED');
          if (subject.latestGeneration === Number.MAX_SAFE_INTEGER) throw hostingError('HOSTING_GENERATION_EXHAUSTED');
          subject.latestGeneration++;
        }
        const operation = { association: hostingAssociation(request), subjectKey, provisionGeneration: subject.latestGeneration, admittedAt: null, recoveryRequired: false };
        state.operations[key] = operation;
        return { value: this.prepared(request, operation, subject) };
      });
      const operation = this.state.operations[key]; const subject = this.state.subjects[subjectKey];
      if (!operation || !subject || operation.subjectKey !== subjectKey || !same(operation.association, hostingAssociation(request))
          || request.installationId !== subject.manifest.installationId || request.manifestSha256 !== subject.manifest.manifestSha256.slice(7)
          || request.provisionGeneration !== operation.provisionGeneration) throw hostingError('HOSTING_ASSOCIATION_REJECTED');
      if (request.method === 'ensure' && operation.admittedAt === null) {
        if (request.operationKind === 'REPROVISION' && request.validUntil <= this.now()) throw hostingError('HOSTING_LEASE_EXPIRED');
        await this.mutate(state => {
          const candidate = state.operations[key]; const managed = state.subjects[subjectKey];
          const active = state.operations[managed.activeOperationKey];
          if (active && active.provisionGeneration >= candidate.provisionGeneration) throw hostingError('HOSTING_OPERATION_SUPERSEDED');
          candidate.admittedAt = this.now(); managed.activeOperationKey = key;
          return { value: null };
        });
        this.startOperation(key);
      }
      return this.observe(request, key);
    });
  }
  observe(request, key) {
    const operation = this.state.operations[key]; const subject = this.state.subjects[operation.subjectKey];
    const response = { ...hostingEnvelope(request), installationId: subject.manifest.installationId,
      manifestSha256: subject.manifest.manifestSha256.slice(7), provisionGeneration: operation.provisionGeneration,
      hostId: this.host.config.hostId, outcome: operation.recoveryRequired ? 'RECOVERY_REQUIRED' : 'UNKNOWN' };
    if (operation.recoveryRequired || subject.activeOperationKey !== key || operation.admittedAt === null
        || request.operationKind === 'REPROVISION' && request.validUntil <= this.now()) return response;
    const active = this.live.get(operation.subjectKey); const proof = this.host.agentEvidence(operation.subjectKey);
    if (!active || !active.confirmed || active.key !== key || !proof || ['installationId', 'tenantId', 'clientId', 'canonicalAgentId'].some(field => proof[field] !== subject.manifest[field])
        || proof.hostId !== response.hostId || proof.runtimeInstanceId !== this.host.instanceId
        || !Number.isSafeInteger(proof.sessionGeneration) || proof.sessionGeneration <= active.sessionFloor
        || proof.executorReady !== true || proof.durableReady !== true || !positiveEpoch(proof.registeredAt) || !positiveEpoch(proof.serviceReadyAt)
        || proof.registeredAt < Math.max(operation.association.requestedAt, operation.admittedAt, active.startedAt)
        || proof.serviceReadyAt < proof.registeredAt) return response;
    return { ...response, outcome: 'SERVICE_READY', runtimeInstanceId: proof.runtimeInstanceId, sessionGeneration: proof.sessionGeneration,
      serviceReadyAt: proof.serviceReadyAt, registeredAt: proof.registeredAt, executorReady: true, durableReady: true,
      evidenceRef: `hosting:${request.operationId}:${operation.provisionGeneration}` };
  }
  async materialize(subject) {
    const agent = this.subjectAgent(subject); const root = resolve(this.config.managedRoot, agent.subjectKey);
    try {
      await mkdir(root, { mode: 0o700 });
      await writePrivateJson(resolve(root, 'subject.json'), { manifest: subject.manifest }, { exclusive: true });
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      await requireOwnedPrivateRoot(root);
      if (!same(await readPrivateJson(resolve(root, 'subject.json'), null), { manifest: subject.manifest })) throw hostingError('HOSTING_STATE_UNCONFIRMED');
    }
    for (const path of [agent.stateRoot, agent.profile.codexHome, agent.profile.codexWorkdir]) await ensurePrivateDirectory(path);
    for (const [path, value] of [[agent.manifestPath, subject.manifest], [agent.profilePath, agent.profile]]) {
      const current = await readPrivateJson(path, null);
      if (current && !same(current, value)) throw hostingError('HOSTING_STATE_UNCONFIRMED');
      if (!current) await writePrivateJson(path, value, { exclusive: true });
    }
    // New independent HOME: no auth.json or other user's file is read/copied.
    // A missing config after a partial materialization can be safely filled from
    // the exact durable template; an existing one must remain byte-identical.
    const path = resolve(agent.profile.codexHome, 'config.toml');
    try { await privateFile(path, subject.template.codexConfig); }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || await file.readFile('utf8') !== subject.template.codexConfig) throw hostingError('HOSTING_STATE_UNCONFIRMED');
      } finally { await file.close(); }
    }
    return agent;
  }
  startOperation(key) {
    if (this.started.has(key) || this.closing) return;
    this.started.add(key);
    const operation = this.state.operations[key]; const previous = this.jobs.get(operation.subjectKey) || Promise.resolve();
    // Unblock only a pending predecessor's registration wait; lifecycle mutation
    // still runs behind the subject's gate, retaining its writer ownership.
    if (this.jobs.has(operation.subjectKey)) this.host.agents.get(operation.subjectKey)?.executor?.cancelActivation?.();
    const job = previous.catch(() => {}).then(() => this.runOperation(key)).catch(async cause => {
      if ((this.closing || this.state.subjects[operation.subjectKey].activeOperationKey !== key)
          && cause.code !== 'RUNTIME_ENROLLMENT_RECOVERY_REQUIRED') return;
      try { await this.mutate(state => { state.operations[key].recoveryRequired = true; return { value: null }; }); }
      catch { this.closing = true; } // journal loss cannot be reported as readiness
      this.logger('hosting-operation-recovery-required', { operationId: operation.association.operationId });
    });
    this.jobs.set(operation.subjectKey, job);
    void job.then(() => { this.aborters.delete(key); if (this.jobs.get(operation.subjectKey) === job) this.jobs.delete(operation.subjectKey); });
  }
  async runOperation(key) {
    const operation = this.state.operations[key]; const subject = this.state.subjects[operation.subjectKey];
    if (this.closing || subject.activeOperationKey !== key || operation.recoveryRequired) return;
    if (operation.association.operationKind === 'REPROVISION' && operation.association.validUntil <= this.now()) throw hostingError('HOSTING_LEASE_EXPIRED');
    const aborter = new AbortController(); this.aborters.set(key, aborter);
    const agent = await this.materialize(subject);
    if (this.closing || this.state.subjects[operation.subjectKey].activeOperationKey !== key) return;
    const client = this.clientFactory({ manifest: subject.manifest, stateDir: agent.stateRoot, apiBaseUrl: this.apiOrigin,
      hostId: this.host.config.hostId, runtimeInstanceId: this.host.instanceId });
    let authorization = null;
    try { authorization = await client.loadAuthorization(); }
    catch (cause) { if (cause.code !== 'RUNTIME_ENROLLMENT_REQUIRED') throw cause; }
    // Never reenroll during free reprovision or after a possibly consumed secret.
    if (!authorization && operation.association.operationKind === 'REPROVISION') throw hostingError('HOSTING_AUTHORIZATION_REQUIRED');
    const prior = this.host.agents.get(operation.subjectKey);
    const floor = Math.max(subject.lastSessionGeneration, prior?.executor?.sessionGeneration?.() || 0);
    if (prior) await this.host.reprovisionAgent(agent); else await this.host.ensureAgent(agent);
    if (!authorization) {
      if (this.closing) return;
      if (subject.enrollmentExpiresAt <= this.now()) throw hostingError('HOSTING_ENROLLMENT_EXPIRED');
      await client.enroll(subject.enrollmentSecret, { signal: aborter.signal });
    }
    if (this.closing || this.state.subjects[operation.subjectKey].activeOperationKey !== key) return;
    this.live.set(operation.subjectKey, { key, startedAt: this.now(), sessionFloor: floor, confirmed: false });
    await this.host.activate(operation.subjectKey);
    const proof = this.host.agentEvidence(operation.subjectKey);
    if (proof && Number.isSafeInteger(proof.sessionGeneration)) await this.mutate(state => {
      state.subjects[operation.subjectKey].lastSessionGeneration = Math.max(state.subjects[operation.subjectKey].lastSessionGeneration, proof.sessionGeneration);
      return { value: null };
    });
    const live = this.live.get(operation.subjectKey); if (live?.key === key && !this.closing) live.confirmed = true;
  }
  resumeAdmitted() {
    for (const subject of Object.values(this.state.subjects)) if (subject.activeOperationKey) this.startOperation(subject.activeOperationKey);
  }
  async close() {
    this.closing = true;
    for (const aborter of this.aborters.values()) aborter.abort();
    for (const subjectKey of this.jobs.keys()) this.host.agents.get(subjectKey)?.executor?.cancelActivation?.();
    await Promise.allSettled([...this.gates.values(), ...this.jobs.values()]); await this.journalGate;
  }
  async releaseOwnership() { await this.release?.(); this.release = null; }
}
