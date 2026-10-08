// Wire r1 boundary, API fixture87c894dc. One transport/client per full subject.
// Session credentials live only here; outbound work checkpoints hold no proof.
import { randomUUID } from 'node:crypto';
import { RuntimeV1Client, classifyRuntimeError } from './runtime-client.mjs';
const adapterError = code => Object.assign(new Error(code), { code });
const wait = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});

export async function createExecutionAdapterFactory({ config, instanceId, apiOrigin, workspacePolicies,
  providerEnvironments, loadEngine, socketFactory, clientFactory, logger = () => {} } = {}) {
  const module = await (loadEngine || (() => import('../../codex-ws-agent/agent-client.mjs')))();
  const Socket = socketFactory || await module.loadWebSocketClient();
  const { RegistrationAckObserver } = await import('../../codex-ws-agent/registration-ack.mjs');
  const engine = module.createRuntimeExecutionHost({ agents: config.agents, runtimeInstanceId: instanceId,
    apiOrigin, workspacePolicies, providerEnvironments, webSocketClient: Socket });
  const attached = new Map();
  return {
    createExecutor: options => {
      const executor = engine.createExecutor(options);
      const client = (clientFactory || (settings => new RuntimeV1Client(settings)))({ manifest: options.agent.manifest,
        apiBaseUrl: apiOrigin, stateDir: options.agent.stateRoot, hostId: config.hostId, runtimeInstanceId: instanceId });
      let socket = null; let observer = null; let abort = null; let loop = null; let channelConfirmed = false;
      let admitted = true; let activation = null; let resolveActivated; let rejectActivated; let closed = null;
      let ingress = Promise.resolve(); let requestTypes = []; let declaredHealthy = false;
      const durable = () => executor.durableStateHealthy() === true;
      const usable = () => executor.readyCommandTypes().length > 0 || executor.chatReady();
      const ready = () => admitted && channelConfirmed && declaredHealthy && durable() && usable() && socket?.readyState === 1;
      const send = envelope => {
        if (!client.currentSession || socket?.readyState !== 1 || envelope.messageType === 'command.ack') return false;
        const session = client.currentSession;
        const current = { ...envelope, tenantId: session.tenantId, clientId: session.clientId, agentId: session.canonicalAgentId,
          sourceAgentId: session.canonicalAgentId, installationId: session.installationId, hostId: session.hostId,
          runtimeInstanceId: session.runtimeInstanceId, sessionGeneration: session.sessionGeneration };
        socket.send(JSON.stringify(current)); return true;
      };
      const register = () => {
        if (!client.currentSession || socket?.readyState !== 1) return false;
        const healthy = durable(); declaredHealthy = healthy; requestTypes = healthy ? executor.readyCommandTypes() : [];
        const envelope = module.buildProtocolEnvelope('agent.register', { ...executor.registrationPayload(),
          messageId: randomUUID(), durableStateHealthy: healthy, readyCommandTypes: requestTypes }, executor.state().profile, instanceId);
        observer.begin(envelope.messageId); channelConfirmed = false;
        if (!send(envelope)) observer.sendFailed(envelope.messageId);
        return true;
      };
      const transport = {
        ready, reportReady: () => admitted && channelConfirmed && !!client.currentSession && socket?.readyState === 1, send, readyCommandTypes: () => ready() ? executor.readyCommandTypes().filter(type => requestTypes.includes(type)) : [], headers: () => client.sessionHeaders(),
        acknowledge: (command, status, version) => client.acknowledge(command, status, version, { signal: abort?.signal }), nativeFetch: (url, opts) => client.nativeFetch(url, opts),
        refreshCapabilities: register
      };
      const disconnect = () => { channelConfirmed = false; observer?.disconnect(); executor.disconnected(); client.invalidateSession(); };
      const connectOnce = async signal => {
        const session = await client.session({ signal });
        if (signal.aborted) return;
        observer = new RegistrationAckObserver({ agentId: session.canonicalAgentId, runtimeInstanceId: instanceId,
          sessionProof: session, logger: { log() {}, warn() {} } });
        const current = new Socket(client.websocketUrl(), client.websocketOptions()); socket = current;
        executor.attachSocket(current); executor.state().registration = observer; executor.bindTransport(transport);
        return new Promise((resolveConnection, rejectConnection) => {
          const stopped = () => current.close(); signal.addEventListener('abort', stopped, { once: true });
          let ended = false;
          const end = error => { if (ended) return; ended = true; signal.removeEventListener('abort', stopped); if (socket === current) disconnect(); error ? rejectConnection(error) : resolveConnection(); };
          current.on('open', () => { if (socket === current && !signal.aborted) register(); });
          current.on('error', error => { if (socket === current && !signal.aborted) logger('runtime-channel-error', { category: classifyRuntimeError(error).kind }); });
          current.on('close', (code) => end(code === 1008 ? Object.assign(adapterError('RUNTIME_CHANNEL_REVOKED'), { status: 403 }) : null));
          current.on('unexpected-response', (_request, response) => { current.terminate(); end(Object.assign(adapterError('RUNTIME_HANDSHAKE_REJECTED'), { status: response.statusCode })); });
          current.on('message', bytes => {
            if (socket !== current || signal.aborted) return;
            let frame;
            try { frame = JSON.parse(bytes.toString()); } catch { logger('runtime-frame-rejected', { code: 'INVALID_JSON' }); return; }
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
            const payload = frame.data && typeof frame.data === 'object' && !Array.isArray(frame.data) ? frame.data : frame;
            if (['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'hostId', 'runtimeInstanceId', 'sessionGeneration'].some(key => Object.hasOwn(frame, key) && frame[key] !== session[key])) return;
            if (['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'hostId', 'runtimeInstanceId', 'sessionGeneration'].some(key => Object.hasOwn(payload, key) && payload[key] !== session[key])) { logger('runtime-frame-rejected', { code: 'RUNTIME_FRAME_GENERATION_MISMATCH' }); return; }
            const observed = observer.observe(frame);
            if (observed === 'registered') {
              if (payload.readyCommandTypes.length !== requestTypes.length || payload.readyCommandTypes.some(type => !requestTypes.includes(type)) || !payload.durableStateHealthy && requestTypes.length) {
                channelConfirmed = false; rejectActivated?.(adapterError('RUNTIME_REGISTRATION_READINESS_MISMATCH')); current.close(); return;
              }
              channelConfirmed = true; resolveActivated?.(); void executor.resume().catch(error => logger('runtime-replay-failed', { code: error.code || 'REPLAY_FAILED' })); return;
            }
            if (observed === 'rejected') { rejectActivated?.(Object.assign(adapterError('RUNTIME_REGISTRATION_REJECTED'), { status: 403 })); current.close(1008); return; }
            if (frame.type === 'connected' || frame.type === 'agent_registered') return;
            if (frame.type === 'ping') { send({ schemaVersion: 1, messageType: 'pong', type: 'pong', messageId: randomUUID() }); return; }
            if (!channelConfirmed) return;
            // Results/CHAT persistence receipts remain WS business confirmations.
            // Commands go through the existing durable processor, never a new queue.
            if (frame.messageType === 'command.ack') return;
            ingress = ingress.catch(() => {}).then(() => { if (socket === current && client.currentSession === session && channelConfirmed && !signal.aborted) return executor.acceptFrame(frame); }).catch(error => logger('runtime-frame-rejected', { code: error.code || 'INVALID_FRAME' }));
          });
          if (signal.aborted) current.close();
        });
      };
      const startChannel = () => {
        if (loop) return activation;
        abort = new AbortController(); activation = new Promise((resolve, reject) => { resolveActivated = resolve; rejectActivated = reject; });
        loop = (async () => {
          let attempt = 0;
          while (!abort.signal.aborted) {
            try { await connectOnce(abort.signal); attempt = 0; }
            catch (error) {
              if (abort.signal.aborted) break;
              const category = classifyRuntimeError(error).kind;
              if (!['transient-network', 'transient-http'].includes(category)) { rejectActivated(error); admitted = false; logger('runtime-agent-isolated', { subjectKey: options.subjectKey, category }); return; }
              logger('runtime-channel-retry', { subjectKey: options.subjectKey, category });
            }
            if (!abort.signal.aborted) await wait(Math.min(1000 * 2 ** Math.min(attempt++, 6), 60000), abort.signal);
          }
        })();
        return activation;
      };
      const api = {
        initialize: () => executor.initialize(), activate: async () => { await startChannel(); }, ready,
        pause: async () => { admitted = false; executor.state()?.processor.pause(); },
        heartbeat: async () => {
          if (!client.currentSession || socket?.readyState !== 1) return;
          const healthy = durable();
          send(module.buildProtocolEnvelope('agent.presence', { messageId: randomUUID(), status: ready() ? 'online' : 'offline', durableStateHealthy: healthy }, executor.state().profile, instanceId));
          // Health revocation never removes authorization to report known outcomes.
          if (!healthy) { declaredHealthy = false; executor.suspendAdmission(); }
          else if (!declaredHealthy) register();
          if (channelConfirmed) await executor.resume();
        },
        close: () => {
          if (!closed) closed = (async () => {
            admitted = false; abort?.abort(); socket?.close(); rejectActivated?.(adapterError('RUNTIME_CHANNEL_STOPPED'));
            await loop; await executor.close(); await ingress; client.invalidateSession();
          })();
          return closed;
        },
        state: () => executor.state()
      };
      attached.set(options.subjectKey, api); return api;
    },
    heartbeat: () => Promise.allSettled([...attached.values()].map(executor => executor.heartbeat())),
    close: async () => { await Promise.all([...attached.values()].map(executor => executor.close())); await engine.close(); }
  };
}

// Explicit mature-engine payload catalog; no .env, private state or wildcard copy.
export const EXECUTION_PAYLOAD_FILES = Object.freeze([
  ".gitignore",
  "README.md",
  "agent-client.mjs",
  "app-server-adapter.mjs",
  "chat-runtime.mjs",
  "codex-home.example.toml",
  "codex-profiles.conf",
  "contracts/api-hosted-wire-v1.json",
  "contracts/api-hosted-wire-v1.provenance.json",
  "contracts/probes/api-long-history-wire.mjs",
  "controlled-image-bounty-capability.mjs",
  "controlled-image-bounty-v3-capability.mjs",
  "controlled-image-delivery-retention-v3.mjs",
  "controlled-image-gpt-cli-config.mjs",
  "controlled-image-gpt-cli-egress-gate.mjs",
  "controlled-image-gpt-cli-executor-v3.mjs",
  "controlled-image-http-config.mjs",
  "controlled-image-http-executor-v3.mjs",
  "controlled-image-http-executor.mjs",
  "controlled-image-http-ledger.mjs",
  "controlled-image-http-provider-binding.mjs",
  "controlled-image-v3-files.mjs",
  "conversation-controlled-image-v3.mjs",
  "conversation-controlled-image.mjs",
  "conversation-native.mjs",
  "conversation-reference-inputs-v3.mjs",
  "conversation-reference-inputs.mjs",
  "env.example",
  "evidence/typed-inspection-local-image-gpt-5.6-terra-1f95df2.json",
  "install-candidate/INSTALL-CANDIDATE.md",
  "install-candidate/controlled-image-api-policy.redacted.json",
  "install-candidate/install-candidate-check.mjs",
  "install-candidate/wuyong-dual-mode.env.redacted",
  "install-candidate/wuyong-dual-mode-profile.redacted.json",
  "install-policy-check.mjs",
  "juyiting-action-outcome.mjs",
  "juyiting-typed-outcome-stream.mjs",
  "juyiting-typed-outcome.mjs",
  "managed-host.mjs",
  "migrate-ack-high-water.mjs",
  "managed-chat-scope-config.mjs",
  "managed-image-scope-config.mjs",
  "managed-image-scopes.example.json",
  "native-bounty-capability.mjs",
  "package-lock.json",
  "package.json",
  "registration-ack.mjs",
  "report-outbox.mjs",
  "skill-install-manager.mjs",
  "toolchain/delivery_tool.py",
  "toolchain/requirements.txt",
  "typed-inspection-input-carriers.mjs",
  "typed-inspection-network.mjs",
  "typed-inspection-profile.mjs",
  "typed-inspection-runtime.mjs",
  "workspace-file-bridge.mjs",
  "workspace-manager.mjs",
  "workspace-policies.example.json"
]);

const payloadError = code => Object.assign(new Error(code), { code });

// Offline collation only. Does not install packages, initialize an engine or
// adopt an existing release. Layout: artifact/runtime + artifact/codex-ws-agent.
export async function collateExecutionPayload(sourceRoot, targetRoot) {
  const { constants, lstat, mkdir, open, realpath } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const source = await realpath(sourceRoot);
  if (source !== resolve(sourceRoot)) throw payloadError('RUNTIME_PAYLOAD_SOURCE_UNSAFE');
  if (resolve(targetRoot) !== targetRoot || await realpath(dirname(targetRoot)) !== dirname(targetRoot)) throw payloadError('RUNTIME_PAYLOAD_TARGET_UNSAFE');
  await mkdir(targetRoot, { mode: 0o755 }); // no recursive adoption of an existing target
  for (const relativePath of EXECUTION_PAYLOAD_FILES) {
    const path = resolve(source, relativePath);
    if (await realpath(path) !== path) throw payloadError('RUNTIME_PAYLOAD_SOURCE_UNSAFE');
    const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await input.stat({ bigint: true });
      if (!stat.isFile()) throw payloadError('RUNTIME_PAYLOAD_SOURCE_UNSAFE');
      const bytes = await input.readFile();
      const after = await input.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      if (stat.dev !== current.dev || stat.ino !== current.ino || stat.mtimeNs !== after.mtimeNs
          || stat.ctimeNs !== after.ctimeNs || stat.size !== after.size) throw payloadError('RUNTIME_PAYLOAD_SOURCE_CHANGED');
      const outputPath = resolve(targetRoot, relativePath);
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o755 });
      const output = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        relativePath === 'toolchain/delivery_tool.py' ? 0o755 : 0o644);
      try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
    } finally { await input.close(); }
  }
  return validateExecutionPayload(targetRoot, { dependencies: false, toolchain: false });
}

export async function validateExecutionPayload(root, { dependencies = true, toolchain = true } = {}) {
  const { lstat, readFile, realpath } = await import('node:fs/promises');
  const { dirname, relative, resolve } = await import('node:path');
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw payloadError('RUNTIME_PAYLOAD_ROOT_UNSAFE');
  const known = new Set(EXECUTION_PAYLOAD_FILES);
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const requirements = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  for (const relativePath of EXECUTION_PAYLOAD_FILES) {
    const path = resolve(root, relativePath);
    if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw payloadError('RUNTIME_PAYLOAD_FILE_UNSAFE');
    if (!relativePath.endsWith('.mjs')) continue;
    const source = await readFile(path, 'utf8');
    // All existing engine imports are literal. Refuse a dangling relative import
    // or undeclared package; Node's own resolver is additionally tested at import.
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        if (!known.has(relative(root, resolve(dirname(path), specifier)))) throw payloadError('RUNTIME_PAYLOAD_IMPORT_MISSING');
      } else if (!Object.hasOwn(packageJson.dependencies || {}, specifier)) throw payloadError('RUNTIME_PAYLOAD_DEPENDENCY_UNDECLARED');
    }
  }
  for (const privatePath of ['.env', 'runtime.env', 'data', 'codex-session-map.json']) {
    try { await lstat(resolve(root, privatePath)); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    throw payloadError('RUNTIME_PAYLOAD_PRIVATE_STATE_FORBIDDEN');
  }
  if (dependencies) {
    // Includes transitive lock entries, not only the two direct dependencies.
    for (const [path, expected] of Object.entries(requirements.packages || {})) {
      if (!path) continue;
      if (!path.startsWith('node_modules/') || expected.link || !expected.integrity) throw payloadError('RUNTIME_DEPENDENCY_LOCK_INVALID');
      const packagePath = resolve(root, path, 'package.json');
      if (await realpath(packagePath) !== packagePath || !(await lstat(packagePath)).isFile()) throw payloadError('RUNTIME_DEPENDENCY_PATH_UNSAFE');
      const installed = JSON.parse(await readFile(packagePath, 'utf8')); 
      if (installed.version !== expected.version) throw payloadError('RUNTIME_DEPENDENCY_VERSION_MISMATCH');
    }
  }
  if (toolchain) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const environmentRoot = resolve(root, '.toolchain');
    const python = resolve(environmentRoot, 'bin/python');
    const resolvedPython = await realpath(python);
    if (await realpath(environmentRoot) !== environmentRoot || !resolvedPython.startsWith(`${environmentRoot}/`)
        || !(await lstat(resolvedPython)).isFile()) throw payloadError('RUNTIME_TOOLCHAIN_PATH_UNSAFE');
    const environment = { PATH: process.env.PATH || '', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
    // The existing helper checks real format imports; also prove the six pinned
    // distribution versions, not merely that similarly named imports exist.
    await promisify(execFile)(python, ['-c',
      'import pkg_resources, sys\nfor line in open(sys.argv[1]):\n line = line.strip()\n if line and not line.startswith("#"):\n  name, version = line.split("==")\n  assert pkg_resources.get_distribution(name).version == version, "PINNED_TOOLCHAIN_VERSION_MISMATCH"',
      resolve(root, 'toolchain/requirements.txt')], { env: environment });
    await promisify(execFile)(python, [resolve(root, 'toolchain/delivery_tool.py'), 'health'], { env: environment });
  }
  return Object.freeze({ payloadCount: known.size, dependenciesValidated: dependencies, toolchainValidated: toolchain });
}
