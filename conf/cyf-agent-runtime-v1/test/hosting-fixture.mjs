// Local-only synthetic scopes, private roots, native API and executor mocks.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { digestManifest, runtimeSubjectKey } from '../lib/manifest.mjs';
import { RuntimeHost } from '../lib/runtime-host.mjs';
import { HostingControl } from '../lib/hosting-control.mjs';
import { skillInventorySnapshot } from '../../codex-bridge/skill-inventory.mjs';
import { RuntimeV1Client } from '../lib/runtime-client.mjs';

export const tick = () => new Promise(done => setImmediate(done));
export const code = expected => cause => cause?.code === expected;
export async function hostingFixture(t, { loseEnrollment = false, stalled = false, sessionStalled = false, rootParent = tmpdir(), observeInventory, apiOrigin, clock, scopes, staticPeers = false,
  scope = { tenantId: '0', clientId: 'fixture-client', ownerJiacn: 'fixture-owner' } } = {}) {
  const root = await mkdtemp(resolve(rootParent, 'gss-hosting-owned-')); await mkdir(resolve(root, 'host'), { mode: 0o700 });
  await mkdir(resolve(root, 'managed'), { mode: 0o700 }); await mkdir(resolve(root, 'socket'), { mode: 0o750 });
  // Parent test runners may deliberately use umask 077. The real server requires
  // this exact group-searchable socket directory; retain all production checks.
  await chmod(resolve(root, 'socket'), 0o750);
  let now = 1791594000000; let enrollments = 0; let sessions = 0;
  const states = new Map(); const peers = [];
  const template = { profile: { codexBin: '/bin/true', appServerEnabled: false, fastChatEnabled: false },
    codexConfig: 'model_provider = "managed"\n[model_providers.managed]\nname = "Synthetic hosting provider"\nbase_url = "https://no-network.invalid/v1"\nenv_key = "CYF_MANAGED_PROVIDER_API_KEY"\nrequires_openai_auth = false\n',
    providerEnvironment: { CYF_MANAGED_PROVIDER_API_KEY: 'synthetic-provider-never-live' } };
  const controlConfig = { configVersion: 1, socketPath: resolve(root, 'socket/control.sock'), socketGid: process.getgid(),
    managedRoot: resolve(root, 'managed'), scopes: scopes || [scope],
    template: staticPeers ? null : template, enrollmentTtlMs: 3600000 };
  for (let index = 0; index < 3; index++) {
    const base = resolve(root, `peer-${index}`); await mkdir(base, { mode: 0o700 });
    for (const name of ['state', 'home', 'work']) await mkdir(resolve(base, name), { mode: 0o700 });
    const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: staticPeers ? `rti_${String(index + 1).repeat(32)}` : `peer-${index}`, tenantId: '0',
      clientId: 'fixture-client', canonicalAgentId: staticPeers ? `jyt-fixture-peer-${index}` : `agt_peer_${index}` };
    const manifest = { ...unsigned, manifestSha256: digestManifest(unsigned) };
    const manifestPath = resolve(base, 'manifest.json');
    if (staticPeers) await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    peers.push({ manifest, ...(staticPeers ? { manifestPath, publicFiles: { 'config.toml': 'model = "fixture-public"\n' } } : {}), subjectKey: runtimeSubjectKey(manifest), stateRoot: resolve(base, 'state'),
      profile: { profileId: `peer-${index}`, agentId: manifest.canonicalAgentId, codexBin: '/bin/true',
        codexHome: resolve(base, 'home'), codexWorkdir: resolve(base, 'work'), appServerEnabled: false, fastChatEnabled: false } });
  }
  const staticInstallations = new Set(staticPeers ? peers.map(peer => peer.manifest.installationId) : []);
  let pending;
  const hostConfig = { configVersion: 1, hostId: 'fixture-host', stateRoot: resolve(root, 'host'), agents: peers };
  const clientFactory = settings => apiOrigin ? new RuntimeV1Client({ ...settings, apiBaseUrl: apiOrigin }) : new RuntimeV1Client({ ...settings, fetchFn: async (url, options) => {
    const envelope = JSON.parse(options.body); const body = envelope.data;
    if (url.endsWith('/enroll')) {
      enrollments++;
      if (loseEnrollment) throw Object.assign(Error('sensitive-server-error'), { code: 'ECONNRESET' });
      return new Response(JSON.stringify({ protocolVersion: 1, requestId: envelope.requestId, code: 'E0', msg: 'ok', data: {
        installation: { ...Object.fromEntries(['runtimeInstallationId', 'tenantId', 'clientId', 'canonicalAgentId', 'manifestVersion', 'manifestSha256'].map(key => [key, body[key]])),
          enrollmentExpiresAt: now + 3600000, status: 'ACTIVE', lastHeartbeatAt: null }, runtimeAuthorization: 'rta1_' + 'c'.repeat(64) } }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': envelope.requestId } });
    }
    throw Error('fixture only allows enrollment');
  } });
  const createExecutor = ({ agent, subjectKey, instanceId }) => {
    const state = { agent, subjectKey, instanceId, initialized: 0, closed: 0, ready: false, proof: null, release: null, session: 0 };
    const history = states.get(subjectKey) || []; history.push(state); states.set(subjectKey, history);
    return {
      initialize: async () => { state.initialized++; },
      activate: async () => {
        if (agent.manifest.installationId.startsWith('rti_') && !staticInstallations.has(agent.manifest.installationId)) {
          await clientFactory({ manifest: agent.manifest, stateDir: agent.stateRoot, apiBaseUrl: 'https://no-network.invalid' }).loadAuthorization();
          if (apiOrigin) {
            const client = clientFactory({ manifest: agent.manifest, stateDir: agent.stateRoot,
              hostId: hostConfig.hostId, runtimeInstanceId: instanceId });
            const session = await client.session();
            state.session = Number(session.sessionGeneration); sessions++;
            const registered = await fetch(`${apiOrigin}/fixture/register`, { method: 'POST', headers: client.sessionHeaders() });
            if (!registered.ok) throw Error('FIXTURE_REGISTRATION_FAILED');
            state.proof = await registered.json();
          } else state.session = ++sessions;
          if (stalled || sessionStalled) await new Promise(done => { state.release = done; pending = state; });
          if (state.closed) return;
        } else state.session = 1;
        state.ready = true; state.proof ||= { ...Object.fromEntries(['installationId', 'tenantId', 'clientId', 'canonicalAgentId'].map(key => [key, agent.manifest[key]])),
          hostId: hostConfig.hostId, runtimeInstanceId: instanceId, sessionGeneration: String(state.session),
          registeredAt: now, serviceReadyAt: now, executorReady: true, durableReady: true };
      },
      evidence: () => state.ready && !state.closed ? state.proof : null, sessionGeneration: () => String(state.session),
      ready: () => state.ready && !state.closed, pause: async () => { state.ready = false; },
      cancelActivation: () => { state.release?.(); },
      close: async () => { state.closed++; state.ready = false; state.release?.(); }
    };
  };
  let host; let control; let boot = 0;
  const start = async () => {
    if (staticPeers) for (const peer of peers) peer.manifest = JSON.parse(await readFile(peer.manifestPath, 'utf8'));
    host = new RuntimeHost({ config: hostConfig, instanceId: `fixture-instance-${++boot}`, createExecutor });
    await host.start(); for (const peer of peers) if (host.agents.get(peer.subjectKey).phase === 'INITIALIZED') await host.activate(peer.subjectKey);
    control = await new HostingControl({ host, config: controlConfig, apiOrigin: apiOrigin || 'https://no-network.invalid', now: () => clock ? clock() : now, clientFactory, ...(observeInventory ? { observeInventory } : {}) }).initialize();
    return { host, control };
  };
  const stop = async () => { await control?.close(); await host?.stop(); await control?.releaseOwnership(); };
  t.after(async () => { try { await stop(); } finally { await rm(root, { recursive: true, force: true }); } });
  await start();
  const settle = async () => { while (control.jobs.size) { await Promise.all([...control.jobs.values()]); } };
  return { root, controlConfig, hostConfig, peers, states, start, stop, settle, tick, code,
    host: () => host, control: () => control, now: () => now, advance: (ms = 1000) => { now += ms; },
    enrollmentCount: () => enrollments, sessionCount: () => sessions, pending: () => pending };
}
export function candidateRequest(prepare, candidate, method) {
  const { quotedInventory, ...association } = prepare;
  return { ...association, method, installationId: candidate.installationId, manifestSha256: candidate.manifestSha256, provisionGeneration: candidate.provisionGeneration };
}
export function unchangedPeers(f, before) { assert.deepEqual(f.peers.map(peer => f.states.get(peer.subjectKey)[0]), before); }

// Synthetic catalog-only fixtures explicitly declare no native discoveries. Real manager rows
// are still included when a retained installation exists; actual discovery has its own tests.
export const fixtureInventory = async ({ profile, manager } = {}) => skillInventorySnapshot({
  discovery: { data: [{ cwd: profile?.codexWorkdir || '', skills: [], errors: [] }] },
  managed: manager?.listInstalledSkills() || [], cwd: profile?.codexWorkdir || '', codexHome: profile?.codexHome || '' });
export const quotedPreparation = (request, hostId = 'fixture-host', inventorySha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945') => ({
  ...request, quotedInventory: { hostId, inventorySha256 } });
