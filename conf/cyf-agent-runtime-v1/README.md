# Unified Agent Runtime (UR-01, 2026-10-08)

One Runtime host reuses `codex-ws-agent`; it is not a heartbeat sidecar or a new
model executor. The current source is an **offline M3 canonical-r2 candidate**, not an accepted
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

Current shared wire r2 is pinned by API commit
**8911817e07cd938ecc77f14c4bb373a7f0246934**, fixture SHA256
**7a1b0b41d3d57634557401b1a6e9fdf1ccd6f2ef09e14eea1ce42acef6616312**.
Session/proof/version semantics remain as frozen in r1; the UR03 v1 fixture
is retained only as its unchanged historical test input, not a second protocol.
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
  correlation, command, task, nullable workItem, nullable payloadReference and ISO expiresAt.
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
- Native v1, controlled-image v2/v3 and typed inspection receive the six exact
  current session headers from the trusted transport at every HTTP send. They
  reject old 32hex credentials, missing proof, wrong Agent/boot and non-canonical
  generation. They neither synthesize installation identity nor mint credentials.
  Session rotation aborts only its owned native network and rejects late responses;
  no new request deadline or forced business replay is added.
- Workspace material cleanup requires its known native terminal plus matching
  durable HTTP D06 terminal. The existing completed inbox/ledger stores only local
  command fingerprint/directory/device/inode, never session proof. After restart,
  cleanup uses that exact directory identity without input download or re-execution;
  absent paths are idempotent, replacement/symlink/foreign paths fail closed. Cleanup
  IO failure retains retry authority in the same ledger, not a new queue. Native
  v1/v2/v3 unknown START/upload/commit/failure also retains its private run.
- Stopping polls does not release an in-flight guard; shutdown awaits owned native
  operations (including an in-flight lease renewal) and engine closure before releasing writer locks. Exact CHAT stop
  remains request/turn/dispatch/Agent-correlated and current-channel/generation
  checked; unverified WORK_ITEM_CANCEL is not advertised.
- Each Agent has its own session, socket, reconnect and queues. Revocation isolates
  only that subject. SIGTERM aborts owned transport work and waits for confirmed
  engine shutdown before releasing writer locks. No permanent legacy auth path.

## Owner test coverage and remaining gates

Targeted tests: `test/runtime-v1.test.mjs` (r1 request/proof/result/expiry/security),
`test/runtime-host.test.mjs` (config/locks/isolated lifecycle/generation/health/close),
engine `test/agent-client.test.mjs` (mature queue + D06 FIFO/STARTED/unknown result/
restart/conflicting payload; CHAT/result dedicated confirmation),
`test/registration-ack.test.mjs` and `test/skill-install-manager.test.mjs`.
Native lane/runtime, workspace-file-bridge and inspection tests cover the proof
migration, prior function/Provider-start/lease/input/output boundaries and recovery
retention. Integrated UR03 `unified-runtime-acceptance.test.mjs` keeps its cross-end
HTTP test explicitly NOT_RUN (skip), not a synthetic PASS.
They use private synthetic roots/mock HTTP/socket and a local WS handshake;
**they are not cross-end API, clean-target install, Flow or online evidence**.

Canonical dispatch projection **r2** uses the exact API codec fixture (commit
`a2dbe65062ff4c1c511094c19233b1b25c076f3e`, SHA256
`057a4626387846f4bf420cab046d7d0bb4d12cdae6569e90839af00161cbd5a3`).
Raw tenant/client/targetAgentId must first match the trusted manifest, without
nested identity aliases. ACK canonicalAgentId and Runtime installation then come
only from that manifest; session/host/boot/generation are added by the current
transport at send. Skill's root installationId is PRODUCT data, not Runtime proof;
using Runtime installation as product installation is rejected. An absent actual
payloadReference projects to null, never a fabricated source/ACL proof. Nullable
workItem follows the codec. A safe epoch integer within the JS date range projects
to ISO, without changing admission expiry or the original message. The existing
source/context/reference/reassignment/lease checks are not replaced by projection.

The Runtime fingerprint binds the original canonical raw wire, including original
epoch, product installation and actual business source/context, not ACK-normalized
fields. Before any HTTP ACK send, ledger projection and original inbox wire
fingerprint/projection must independently match; response commit still rechecks
FIFO/status/version under the original short lock. No second durable queue exists.
`test/canonical-dispatch-r2.test.mjs` covers the byte-pinned E05 fixture at a frozen
fake Date (the shared fixture clock `1001000`) through a **local real HTTP server**
and mature checkpoint, exact shared first-ACK projection, pre-checkpoint negatives,
expiry, lost terminal response and restart/current-session replay. This is an
Owner client boundary test, **not the actual Java API/D06/DB integration**. The
UR03 cross-end NOT_RUN skip is not removed or reclassified. Remaining M3 gates are
actual client/server HTTP/native/skill acceptance and exact WORK_ITEM_CANCEL
adapter/codec verification if that existing adapter can prove binding. Uncertain
recovery material is retained, never manually cleared or automatically reexecuted.
Dynamic online identity/maintenance ownership, stopped-writer state migration,
Flow version/commit/artifact proof and three-Agent real business acceptance remain
release gates. Current task is incomplete: **do not publish or switch production**.
