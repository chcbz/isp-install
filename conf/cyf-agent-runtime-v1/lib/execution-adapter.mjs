// Thin injection adapter around codex-ws-agent, not a replacement executor.
// It cannot activate a raw/guessed session DTO. A frozen wire adapter must bind
// current installation identity, generation, transport and command ACK first.
export async function createExecutionAdapterFactory({ config, instanceId, apiOrigin, workspacePolicies, providerEnvironments, bindSession, loadEngine } = {}) {
  const load = loadEngine || (() => import('../../codex-ws-agent/agent-client.mjs'));
  const module = await load();
  const engine = module.createRuntimeExecutionHost({ agents: config.agents, runtimeInstanceId: instanceId, apiOrigin, workspacePolicies, providerEnvironments });
  return {
    createExecutor: options => {
      const executor = engine.createExecutor(options);
      return {
        initialize: () => executor.initialize(),
        activate: async session => {
          if (typeof bindSession !== 'function') throw Object.assign(new Error('RUNTIME_WIRE_ADAPTER_REQUIRED'), { code: 'RUNTIME_WIRE_ADAPTER_REQUIRED' });
          await bindSession({ session, agent: options.agent, instanceId, executor });
          if (!executor.ready()) throw Object.assign(new Error('RUNTIME_SESSION_NOT_READY'), { code: 'RUNTIME_SESSION_NOT_READY' });
        },
        ready: () => executor.ready(),
        pause: () => executor.pause(),
        close: () => executor.close()
      };
    },
    close: () => engine.close()
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
    await promisify(execFile)(resolve(root, '.toolchain/bin/python'), [resolve(root, 'toolchain/delivery_tool.py'), 'health'], {
      env: { PATH: process.env.PATH || '', LANG: 'C.UTF-8' }
    });
  }
  return Object.freeze({ payloadCount: known.size, dependenciesValidated: dependencies, toolchainValidated: toolchain });
}
