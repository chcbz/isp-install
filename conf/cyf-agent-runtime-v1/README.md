# Unified Agent Runtime (UR-01, 2026-10-08)

One Runtime host reuses `codex-ws-agent`; it is not a heartbeat sidecar or a new
model executor. The current source is an **offline M3 candidate**, not an accepted
migration or authorized release. The old engine CLI/API-key execution entry is
retired; do not run the old service with the new ACK format.

## Artifact and configuration

`install.sh --target ABSOLUTE_NEW_DIRECTORY` prepares a new artifact containing
`runtime/`, `codex-ws-agent/` and pinned `node/bin/node` (20.20.2), npm lock graph
and release-local Python delivery tools. It neither enables services nor adopts,
rewrites, enrolls or deletes existing Agent state. Python still needs a compatible
target ABI/stdlib; mocked installer tests do not prove clean-target installation.

Configuration lives **outside** the artifact. A host config has exactly:

```json
{
  "configVersion": 1,
  "hostId": "operator-provisioned-persistent-host",
  "stateRoot": "/private/host-state",
  "agents": [
    {
      "manifestPath": "/private/agent-a/manifest.json",
      "profilePath": "/private/agent-a/profile.json",
      "stateRoot": "/private/agent-a/state"
    }
  ]
}
```

Each sealed manifest contains exact `installationId`, `tenantId`, `clientId`,
`canonicalAgentId`, `manifestVersion`, `runtimeProtocolVersion: "v1"`, and
`manifestSha256` (`sha256:` + SHA256 of recursively key-sorted unsigned JSON).
Each profile explicitly selects the same `agentId`, a `profileId`, `codexBin`,
`codexHome`, `codexWorkdir`, and existing per-operation executor policies. For
example, `appServerEnabled`, `fastChatEnabled`, and `skillInstallEnabled` are
explicit booleans; none imply readiness without the real adapter. No profile may
supply API keys, installation/session credentials or reserved Runtime identity.

Pre-create private state roots (0700, current UID). Config/manifest/profile files
must be current-UID regular files, not group/other writable; credential files are
0600. Duplicate full subjects/installations and equal/nested/symlink-alias writable
roots across Agents are rejected. Host state cannot overlap Agent writable roots.
Same-UID malicious code is **not** a strong isolation boundary. Provision workspace
policies separately; do not share writable workspaces between subjects. Existing
cross-process locks retain ownership until confirmed shutdown; crashed writer locks
require stopped-writer reconciliation, never automatic theft or state clearing.

## Entry and authorization

Use the artifact-local Node; installation/enrollment and service activation are
separate operations, requiring their own authorization:

```bash
ARTIFACT=/path/to/prepared-artifact
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" validate --config /private/host.json
"$ARTIFACT/runtime/validate.sh" --root "$ARTIFACT" --config /private/host.json
# Explicit enrollment for exactly one SHA256 full-subject storage key:
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" enroll --config /private/host.json --subject SUBJECT_KEY
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" run --config /private/host.json
```

`CYF_RUNTIME_V1_API_BASE_URL` must be an HTTP(S) origin without routing data or
credentials. Enrollment alone consumes one protected environment secret or
`CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE` (non-symlink 0600 regular file). Do not retain
that secret in the running service environment. Each Agent persists only its own
installation authorization in `stateRoot/runtime-authorization.json`.

Wire r1 is frozen by API commit **87c894dc297145ee2da338107727087ac74e81b1**;
fixture SHA256 **56d7c3d31a33191eb23b0209158dd0395c184f661aa694eb7cc29f0942322adb**.
Session POST `/agent/runtime/v1/session` uses installation Bearer plus sealed
identity/host/boot. Only exact `JsonResult.data` identity, host, boot and increasing
server generation is accepted. WS `/ws/agent/channel`, native `/internal/agent/`
and command HTTP ACK use memory-only `AgentRuntime rts1_<64-lowercase-hex>` and
five X-Agent proof headers (Id, Installation-Id, Host-Id, Runtime-Id,
Session-Generation). No URL credentials, API-key fallback, registration-minted
replacement token or session secrets in logs/checkpoints.

## Frozen persistence and lifecycle boundaries

- Event catalog stays the mature Protocol v1 catalog, including command.dispatch,
  CHAT, exact chat.stop, work.result and their own business receipts. No new command.
- Unique command authority is the existing per-Agent ledger + inbox + ACK outbox
  checkpoint. No `pending-acks.json`, sidecar ACK CLI or duplicate durable queue.
- Lock order: lifetime host/Agent ownership → per-Agent lifecycle gate → existing
  short checkpoint locks. HTTP waits occur **outside** the short filesystem lock;
  response commits reacquire it, revalidate FIFO head/original-context digest,
  persist exact D06 receipt + emitted marker, then durably dequeue. A crash between
  these steps retains idempotent replay evidence.
- Immutable ACK context contains installation/full subject, original message,
  correlation, command, task, nullable workItem, payloadReference and expiresAt.
  Session proof is appended only when sending. First deliveryVersion is null;
  later it is the last confirmed value, not a predicted CAS version. Only matching
  status + valid monotonic version + ADVANCED/PRIOR confirms commit. Injected
  clients cannot bypass the checkpoint's independent result validation.
- RECEIVED follows durable fingerprint/inbox; STARTED is durable and HTTP-confirmed
  before business side effects. Unknown STARTED or business write outcomes are
  recovery-required, never automatic rerun. Expiry denies new admission, not known
  terminal reporting. Unknown native start/upload/commit retains recovery materials.
- Registration is token-free and request/identity/boot/session-correlated;
  readyCommandTypes comes from measured actual adapters, empty admits no commands.
  durableStateHealthy is computed from actual stores, not a heartbeat assertion.
  Health loss pauses admission but allows lawful terminal/result replay. Recovery
  refreshes registration before readmission. Chat `profiles.EXECUTE` stays disabled.
- Each Agent has its own session, socket, reconnect and queues. Revocation isolates
  only that subject. SIGTERM aborts owned transport work and waits for confirmed
  engine shutdown before releasing writer locks. No permanent legacy auth path.

## Owner test coverage and remaining gates

Targeted tests: `test/runtime-v1.test.mjs` (r1 request/proof/result/expiry/security),
`test/runtime-host.test.mjs` (config/locks/isolated lifecycle/generation/health/close),
engine `test/agent-client.test.mjs` (mature queue + D06 FIFO/STARTED/unknown result/
restart/conflicting payload; CHAT/result dedicated confirmation),
`test/registration-ack.test.mjs` and `test/skill-install-manager.test.mjs`.
They use private synthetic roots/mock HTTP/socket and a local WS handshake;
**they are not cross-end API, clean-target install, Flow or online evidence**.

Remaining M3 work is tracked in Owner handoff: full exact command.dispatch
payloadReference/canonical identity fixture integration; authorized native lane
32hex validator replacement; bounded terminal-confirmed workspace cleanup; full
per-operation capability/cancellation/reconnect verification. Retaining recovery
material is intentional until confirmation, not permission to clear it manually.
Dynamic online identity/maintenance ownership, stopped-writer state migration,
Flow version/commit/artifact proof and three-Agent real business acceptance remain
release gates. Current task is incomplete: **do not publish or switch production**.
