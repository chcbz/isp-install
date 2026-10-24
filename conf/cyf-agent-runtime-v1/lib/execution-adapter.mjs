// Wire r1 boundary, API fixture87c894dc. One transport/client per full subject.
// Session credentials live only here; outbound work checkpoints hold no proof.
import { isManagementMessage } from '../../codex-ws-agent/skill-management-wire.mjs';
import { randomUUID } from 'node:crypto';
import { toAgentWire, fromAgentWire } from '../../codex-ws-agent/agent-message-wire.mjs';
import { RuntimeV1Client, classifyRuntimeError, runtimeErrorFacts, runtimeAckWireContext } from './runtime-client.mjs';
const adapterError = code => Object.assign(new Error(code), { code });
const wait = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});

// Called only after the exact correlated authenticated registration ACK. The session
// response intentionally has no owner; take it from the server's installation-derived
// runtimeAuth receipt, never profile/model/presence. Return no credentials.
export function skillSessionBinding(receipt, session) {
  const auth = receipt?.runtimeAuth;
  if (!session || !auth || typeof auth !== 'object' || Array.isArray(auth) || auth.scheme !== 'native-runtime-v1'
      || typeof auth.ownerJiacn !== 'string' || !auth.ownerJiacn || auth.ownerJiacn !== auth.ownerJiacn.trim()
      || [...auth.ownerJiacn].length > 50 || /[\x00-\x1f\x7f]/u.test(auth.ownerJiacn)
      || auth.agentId !== session.canonicalAgentId
      || ['tenantId', 'clientId', 'installationId', 'hostId', 'runtimeInstanceId', 'sessionGeneration']
        .some(key => auth[key] !== session[key])) return null;
  return Object.freeze({ scope: Object.freeze({ tenantId: session.tenantId, clientId: session.clientId,
    ownerJiacn: auth.ownerJiacn, agentId: session.canonicalAgentId }), fence: Object.freeze({
    installationId: session.installationId, hostId: session.hostId,
    runtimeInstanceId: session.runtimeInstanceId, sessionGeneration: session.sessionGeneration }) });
}

export async function createExecutionAdapterFactory({ config, instanceId, apiOrigin, workspacePolicies,
  providerEnvironments, loadEngine, socketFactory, clientFactory, logger = () => {} } = {}) {
  const module = await (loadEngine || (() => import('../../codex-ws-agent/agent-client.mjs')))();
  const Socket = socketFactory || await module.loadWebSocketClient();
  const { RegistrationAckObserver } = await import('../../codex-ws-agent/registration-ack.mjs');
  const engine = module.createRuntimeExecutionHost({ agents: config.agents, runtimeInstanceId: instanceId,
    apiOrigin, workspacePolicies, providerEnvironments, webSocketClient: Socket });
  const attached = new Map();
  const known = new Set(config.agents.map(agent => agent.subjectKey));
  let closing = false;
  return {
    createExecutor: options => {
      if (closing || attached.has(options.subjectKey)) throw adapterError('RUNTIME_EXECUTOR_SUBJECT_INVALID');
      if (!known.has(options.subjectKey)) { engine.addAgent(options.agent); known.add(options.subjectKey); }
      const executor = engine.createExecutor(options);
      const client = (clientFactory || (settings => new RuntimeV1Client(settings)))({ manifest: options.agent.manifest,
        apiBaseUrl: apiOrigin, stateDir: options.agent.stateRoot, hostId: config.hostId, runtimeInstanceId: instanceId });
      let socket = null; let observer = null; let abort = null; let loop = null; let channelConfirmed = false;
      let admitted = true; let activation = null; let resolveActivated; let rejectActivated; let closed = null;
      let lastPresenceSentAt = null; let lastPresenceAckAt = null; let channelState = 'initializing'; let lastFailure = null;
      let ingress = Promise.resolve(); let requestTypes = []; let declaredHealthy = false; let registeredAt = null; let serviceReadyAt = null; let replay = null;
      const durable = () => executor.durableStateHealthy() === true;
      const usable = () => executor.readyCommandTypes().length > 0 || executor.chatReady() || executor.skillManagementReady?.() === true;
      const readyWithHealth = healthy => admitted && channelConfirmed && declaredHealthy && healthy && usable() && socket?.readyState === 1;
      const ready = () => admitted && channelConfirmed && declaredHealthy && readyWithHealth(durable());
      const send = envelope => {
        if (!client.currentSession || socket?.readyState !== 1) return false;
        if (isManagementMessage(envelope)) {
          if (envelope.messageType === 'command.ack' && executor.matchesSkillManagementAck?.(envelope) !== true) return false;
          if (envelope.messageType === 'work.result' && executor.matchesSkillInstallResult?.(envelope) !== true) return false;
          if (!['command.ack', 'work.result'].includes(envelope.messageType)) return false;
          // Credentials are transport-only; never rewrite immutable management facts.
          socket.send(JSON.stringify(toAgentWire(envelope))); return true;
        }
        if (envelope.messageType === 'command.ack') return false;
        const session = client.currentSession;
        const current = { ...envelope, tenantId: session.tenantId, clientId: session.clientId,
          agentId: session.canonicalAgentId, sourceAgentId: session.canonicalAgentId,
          hostId: session.hostId, sessionGeneration: session.sessionGeneration,
          installationId: session.installationId, runtimeInstanceId: session.runtimeInstanceId };
        socket.send(JSON.stringify(toAgentWire(current, session))); return true;
      };
      const register = () => {
        if (!client.currentSession || socket?.readyState !== 1) return false;
        const healthy = durable(); declaredHealthy = healthy; requestTypes = healthy ? executor.readyCommandTypes() : [];
        const envelope = module.buildProtocolEnvelope('agent.register', { ...executor.registrationPayload(),
          messageId: randomUUID(), durableStateHealthy: healthy, readyCommandTypes: requestTypes }, executor.state().profile, instanceId);
        observer.begin(envelope.messageId); channelConfirmed = false; registeredAt = null; serviceReadyAt = null;
        if (!send(envelope)) observer.sendFailed(envelope.messageId);
        return true;
      };
      const transport = {
        ready, reportReady: () => admitted && channelConfirmed && !!client.currentSession && socket?.readyState === 1, send, readyCommandTypes: () => ready() ? executor.readyCommandTypes().filter(type => requestTypes.includes(type)) : [], headers: () => client.sessionHeaders(),
        acknowledge: (command, status, version) => client.acknowledge(runtimeAckWireContext(command), status, version, { signal: abort?.signal }), nativeFetch: (url, opts) => client.nativeFetch(url, opts),
        refreshCapabilities: register
      };
      // Resume can await this subject's durable/native reconciliation. Never let
      // that network work hold the shared presence loop or stack duplicate work.
      const resume = () => {
        if (replay || !admitted || !channelConfirmed) return;
        replay = Promise.resolve().then(() => executor.resume()).catch(error => logger('runtime-replay-failed', { code: error.code || 'REPLAY_FAILED' }));
        void replay.finally(() => { replay = null; });
      };
      const disconnect = () => { channelState = 'disconnected'; lastPresenceAckAt = null; registeredAt = null; serviceReadyAt = null; channelConfirmed = false; observer?.disconnect(); executor.disconnected(); client.invalidateSession(); };
      const connectOnce = async signal => {
        channelState = 'connecting';
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
          current.on('error', error => { if (socket === current && !signal.aborted) logger('runtime-channel-error', runtimeErrorFacts(error)); });
          current.on('close', (code) => end(code === 1008 ? Object.assign(adapterError('RUNTIME_CHANNEL_REVOKED'), { status: 403 }) : null));
          current.on('unexpected-response', (_request, response) => { current.terminate(); end(Object.assign(adapterError('RUNTIME_HANDSHAKE_REJECTED'), { status: response.statusCode })); });
          current.on('message', bytes => {
            if (socket !== current || signal.aborted) return;
            let frame;
            try { frame = fromAgentWire(bytes.toString()); } catch { logger('runtime-frame-rejected', { code: 'INVALID_JSON' }); return; }
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
            const payload = frame;
            const proofMismatch = layer => {
              if (isManagementMessage(layer)) {
                if (layer.messageType === 'work.result.receipt') return executor.matchesSkillInstallReceipt?.(layer) === true ? null : 'correlationId';
                const data = layer.data;
                return Object.entries({ tenantId: session.tenantId, clientId: session.clientId, agentId: session.canonicalAgentId,
                  runtimeInstallationId: session.installationId }).find(([key, value]) => data[key] !== value)?.[0] || null;
              }
              if (Object.hasOwn(layer, 'runtimeInstallationId') && layer.runtimeInstallationId !== session.installationId) return 'runtimeInstallationId';
              if (layer.messageType === 'command.dispatch') {
                if (layer.tenantId !== session.tenantId) return 'tenantId';
                if (layer.clientId !== session.clientId) return 'clientId';
                if (layer.targetAgentId !== session.canonicalAgentId) return 'targetAgentId';
              }
              return ['installationId', 'tenantId', 'clientId', 'canonicalAgentId', 'hostId', 'runtimeInstanceId', 'sessionGeneration']
                .find(key => Object.hasOwn(layer, key) && layer[key] !== session[key]);
            };
            const mismatchField = proofMismatch(frame) || proofMismatch(payload);
            if (mismatchField) { logger('runtime-frame-rejected', { code: 'RUNTIME_FRAME_GENERATION_MISMATCH', field: mismatchField }); return; }
            // A type-only control event is not a business envelope. Check both
            // supported wrapper shapes: even null/invalid explicit messageType
            // must reach the original strict business validator, never be eaten
            // by a cosmetic control type (including registration/error replies).
            const layers = [frame, payload, frame.payload, payload.payload].filter(layer => layer && typeof layer === 'object' && !Array.isArray(layer));
            const declared = layers.filter(layer => Object.hasOwn(layer, 'messageType'));
            const typeOnlyControl = declared.length === 0;
            const registrationError = (frame.type === 'error' || frame.type === 'protocol_error'
              || !Object.hasOwn(frame, 'type') && frame.messageType === 'protocol.error')
              && declared.every(layer => layer.messageType === 'protocol.error');
            const observed = typeOnlyControl || registrationError ? observer.observe(frame) : null;
            if (observed === 'registered') {
              if (payload.readyCommandTypes.length !== requestTypes.length || payload.readyCommandTypes.some(type => !requestTypes.includes(type)) || payload.durableStateHealthy !== declaredHealthy) {
                channelConfirmed = false; rejectActivated?.(adapterError('RUNTIME_REGISTRATION_READINESS_MISMATCH')); current.close(); return;
              }
              channelConfirmed = true; registeredAt = Date.now(); serviceReadyAt = ready() ? registeredAt : null;
              // The first ACK supplies owner scope. If it starts a catalog measurement,
              // activation waits for the follow-up catalog registration ACK; otherwise the
              // shared host could freeze INITIALIZED while re-registration is in flight.
              const measuring = executor.bindSkillSession?.(skillSessionBinding(payload, session)) === true;
              if (!measuring) { resolveActivated?.(); resume(); }
              return;
            }
            if (observed === 'rejected') { rejectActivated?.(Object.assign(adapterError('RUNTIME_REGISTRATION_REJECTED'), { status: 403 })); current.close(1008); return; }
            if (typeOnlyControl && (frame.type === 'connected' || frame.type === 'agent_registered')) return;
            if (typeOnlyControl && frame.type === 'ping') { send({ schemaVersion: 1, messageType: 'pong', messageId: randomUUID(), correlationId: frame.messageId, requestId: frame.requestId }); return; }
            if (!channelConfirmed) return;
            // AgentWebSocketHandler.updateAgentStatus sends copyTrace(presence)
            // plus agentId/status as agent_status_updated, without messageType.
            // Consume ONLY this receipt, after session gates, without granting
            // readiness, changing lifecycle state or re-registering. Unknown and
            // error frames still take the existing registration/business paths.
            if (typeOnlyControl && frame.type === 'agent_status_updated') {
              if (layers.some(proofMismatch) || payload.schemaVersion !== 1
                  || payload.agentId !== session.canonicalAgentId || payload.runtimeInstanceId !== session.runtimeInstanceId
                  || typeof payload.messageId !== 'string' || !payload.messageId.trim() || payload.messageId.trim() !== payload.messageId
                  || Buffer.byteLength(payload.messageId) > 128 || /[\x00-\x1f\x7f]/u.test(payload.messageId)
                  || !['online', 'busy', 'offline', 'error'].includes(payload.status)) {
                logger('runtime-frame-rejected', { code: 'RUNTIME_CONTROL_RECEIPT_INVALID' }); return;
              }
              // Do not log the frame, arbitrary trace fields, error text or tokens.
              lastPresenceAckAt = Date.now();
              logger('runtime-control-receipt', { type: 'agent_status_updated' }); return;
            }
            // Validated informational control events never enter the durable business processor.
            // Session proof checks above still apply. These events grant no readiness or ACK state.
            // chat.message.receipt MUST continue below to its persistence receipt handler.
            if (typeOnlyControl && ['agent_status', 'agent_capability_index', 'pong',
                'task_reported', 'chat_dispatch_acknowledged', 'protocol_error', 'error'].includes(frame.type)) {
              logger('runtime-control-receipt', { type: frame.type }); return;
            }
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
              lastFailure = runtimeErrorFacts(error);
              const category = lastFailure.category;
              if (!['transient-network', 'transient-http'].includes(category)) { channelState = 'isolated'; rejectActivated(error); admitted = false; logger('runtime-agent-isolated', { subjectKey: options.subjectKey, ...lastFailure }); return; }
              channelState = 'retrying';
              logger('runtime-channel-retry', { subjectKey: options.subjectKey, ...lastFailure });
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
          if (send(module.buildProtocolEnvelope('agent.presence', { messageId: randomUUID(), status: readyWithHealth(healthy) ? 'online' : 'offline', durableStateHealthy: healthy }, executor.state().profile, instanceId))) lastPresenceSentAt = Date.now();
          // Health revocation never removes authorization to report known outcomes.
          if (!healthy) { declaredHealthy = false; executor.suspendAdmission(); }
          else if (!declaredHealthy) register();
          if (channelConfirmed) resume();
        },
        close: () => {
          if (!closed) closed = (async () => {
            admitted = false; abort?.abort(); socket?.close(); rejectActivated?.(adapterError('RUNTIME_CHANNEL_STOPPED'));
            await loop; await ingress; await replay; await executor.close(); client.invalidateSession();
            if (attached.get(options.subjectKey) === api) { attached.delete(options.subjectKey); known.delete(options.subjectKey); }
          })();
          return closed;
        },
        cancelActivation: () => { admitted = false; abort?.abort(); socket?.close(); rejectActivated?.(adapterError('RUNTIME_CHANNEL_STOPPED')); },
        health: () => { const isReady = ready(); return ({ subjectKey: options.subjectKey, agentId: options.agent.manifest.canonicalAgentId,
          connected: !!client.currentSession && socket?.readyState === 1, registered: channelConfirmed,
          ready: isReady, channelState: isReady ? 'ready' : channelState,
          lastPresenceSentAt, lastPresenceAckAt, lastFailure }); },
        sessionGeneration: () => client.lastGeneration,
        evidence: () => {
          if (!ready() || !registeredAt || !serviceReadyAt || !client.currentSession) return null;
          const { installationId, tenantId, clientId, canonicalAgentId, hostId, runtimeInstanceId, sessionGeneration } = client.currentSession;
          return { installationId, tenantId, clientId, canonicalAgentId, hostId, runtimeInstanceId, sessionGeneration,
            registeredAt, serviceReadyAt, executorReady: true, durableReady: true };
        },
        state: () => executor.state()
      };
      attached.set(options.subjectKey, api); return api;
    },
    health: () => [...attached.values()].map(executor => executor.health()),
    heartbeat: () => Promise.allSettled([...attached.values()].map(executor => executor.heartbeat())),
    close: async () => { closing = true; await Promise.all([...attached.values()].map(executor => executor.close())); await engine.close(); }
  };
}

// Authoritative unified execution-library catalog, not the retired installer list.
// No legacy auth templates/broker/install tools, private state or wildcard copy.
// Model/provider configuration is distinct from Agent transport credentials.
export const EXECUTION_PAYLOAD_FILES = Object.freeze([
  ".gitignore",
  "agent-client.mjs",
  "agent-message-wire.mjs",
  "api-envelope.mjs",
  "message-envelope.mjs",
  "native-json.mjs",
  "native-poll-diagnostic.mjs",
  "app-server-adapter.mjs",
  "app-server-integrity-worker.mjs",
  "executable-integrity.mjs",
  "chat-runtime.mjs",
  "codex-home.example.toml",
  "contracts/api-hosted-wire-v1.json",
  "contracts/api-hosted-wire-v1.provenance.json",
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
  "conversation-text-file.mjs",
  "conversation-reference-inputs-v3.mjs",
  "conversation-reference-inputs.mjs",
  "evidence/typed-inspection-local-image-gpt-5.6-terra-1f95df2.json",
  "juyiting-action-outcome.mjs",
  "juyiting-review-basis.mjs",
  "juyiting-typed-outcome-stream.mjs",
  "juyiting-typed-outcome.mjs",
  "managed-chat-scope-config.mjs",
  "managed-image-scope-config.mjs",
  "managed-image-scopes.example.json",
  "native-bounty-capability.mjs",
  "package-lock.json",
  "package.json",
  "registration-ack.mjs",
  "report-outbox.mjs",
  "skill-install-manager.mjs",
  "materials-input.mjs",
  "image-input.mjs",
  "image-input-file.mjs",
  "materials-chat.mjs",
  "skill-bindings.mjs",
  "skill-runners/native-model.mjs",
  "skill-runners/local-script.mjs",
  "skill-runners/image-http-codec.mjs",
  "skill-runners/image-provider.mjs",
  "skill-config-candidate.mjs",
  "skill-conversation.mjs",
  "skill-executor.mjs",
  "skill-execution-store.mjs",
  "skill-manifest.mjs",
  "skill-registry.mjs",
  "skill-management-wire.mjs",
  "schemas/management-contract-v1.schema.json",
  "schemas/skill-manifest-v1.schema.json",
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

// Reject accidentally collated historical entrypoints/tools even when their files
// are not imported. lstat also detects symlinks/dangling links without following.
export const RETIRED_EXECUTION_PAYLOAD_PATHS = Object.freeze([
  'README.md', 'codex-profiles.conf', 'env.example', '.env.example',
  'managed-host.mjs', 'install-candidate', 'install-policy-check.mjs',
  'migrate-ack-high-water.mjs', 'contracts/probes'
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
  if (['start', 'prestart', 'poststart'].some(key => Object.hasOwn(packageJson.scripts || {}, key))
      || Object.hasOwn(packageJson, 'bin')) throw payloadError('RUNTIME_PAYLOAD_LEGACY_ENTRY_FORBIDDEN');
  for (const retiredPath of RETIRED_EXECUTION_PAYLOAD_PATHS) {
    try { await lstat(resolve(root, retiredPath)); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    throw payloadError('RUNTIME_PAYLOAD_LEGACY_ENTRY_FORBIDDEN');
  }
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
      } else {
        // Node package subpaths (including scoped packages) use the declared
        // package's dependency; actual export resolution remains Node's job.
        const parts = specifier.split('/');
        const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!Object.hasOwn(packageJson.dependencies || {}, packageName)) throw payloadError('RUNTIME_PAYLOAD_DEPENDENCY_UNDECLARED');
      }
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
