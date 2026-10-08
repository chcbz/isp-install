// UR-01 local host contract, not a wire DTO. Lock order: lifetime host/Agent
// ownership -> per-Agent lifecycle gate -> executor's existing short store locks.
// No filesystem lock is taken around a network wait. No stale lock is stolen.
import { randomUUID } from 'node:crypto';
import { constants, open, lstat, realpath, mkdir, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { readRuntimeHostConfig, runtimeSubjectKey } from './manifest.mjs';

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
  constructor({ config, instanceId = randomUUID(), createExecutor, logger = () => {} }) {
    if (typeof createExecutor !== 'function' || !config?.agents?.length) throw error('RUNTIME_HOST_CONFIG_REQUIRED');
    if (typeof instanceId !== 'string' || !instanceId || instanceId === config.hostId) throw error('RUNTIME_INSTANCE_ID_INVALID');
    this.config = config; this.instanceId = instanceId; this.createExecutor = createExecutor; this.logger = logger;
    this.agents = new Map(config.agents.map(agent => [runtimeSubjectKey(agent.manifest), {
      agent, phase: 'STOPPED', executor: null, release: null, gate: Promise.resolve(), reasonCode: null
    }]));
    this.releaseHost = null; this.startPromise = null; this.stopPromise = null; this.stopping = false;
  }

  snapshot() {
    return { hostId: this.config.hostId, instanceId: this.instanceId, agents: [...this.agents.entries()].map(([subjectKey, state]) => ({
      subjectKey, installationId: state.agent.manifest.installationId, phase: state.phase,
      // Local initialization is not authentication or execution-channel readiness.
      ready: state.phase === 'READY' && state.executor?.ready?.() === true, reasonCode: state.reasonCode
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
      state.phase = 'STARTING';
      try {
        state.release = await acquireRuntimeOwnership(state.agent.stateRoot, {
          hostId: this.config.hostId, instanceId: this.instanceId, subjectKey: key
        });
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
    })));
    return this.snapshot();
  }

  // This is an internal executor boundary. Session DTO validation is supplied by
  // the frozen wire adapter, never inferred by this lifecycle host.
  activate(key, session) {
    return this.withAgent(key, async state => {
      if (this.stopping || state.phase !== 'INITIALIZED') throw error('RUNTIME_AGENT_NOT_INITIALIZED');
      try {
        await state.executor.activate(session);
        if (state.executor.ready() !== true) throw error('RUNTIME_AGENT_NOT_READY');
        state.phase = 'READY';
      } catch (cause) {
        state.phase = 'ISOLATED'; state.reasonCode = 'RUNTIME_AGENT_AUTHORIZATION_FAILED';
        await state.executor.pause?.(); throw cause;
      }
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
