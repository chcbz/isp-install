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

The current clean-target acceptance candidate targets **Python 3.11.13**.
`Pillow==10.4.0` and `reportlab==3.6.13` have published cp311/Linux x86_64
wheels matching the inspected tool tags; the previous Pillow 8.4.0 source build
actually failed because JPEG headers/libraries were absent. Wheel metadata is
not installation, ABI/API or six-format acceptance evidence: the new candidate
still requires the full isolated install/import, relocation and PNG/JPEG/PDF/
DOCX/XLSX/PPTX create/validate/reopen checks. Other four direct pins remain
unchanged; these six pins are not a full transitive dependency lock.
`python-docx==0.8.11` remains a permitted pure-Python source distribution; do
not add blanket binary-only installation, borrow host packages or install host
JPEG/compiler dependencies to bypass the private artifact checks. The existing
private `pip<22` bootstrap, Node pin and installer are unchanged. No compatibility
PASS, interpreter upgrade or production activation is implied by this source fix.

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

## Legacy provisioning source retirement (UR-01, 2026-10-08)

The unified artifact does **not** generate an API-key Agent execution entry.
`codex-ws-agent` is an execution library, not a second service/provisioner:

| Exact source path | Minimal convergence |
| --- | --- |
| `shell/codex_ws_agent_install.sh`, `bin/codex_ws_agent.sh` | Deleted on 2026-10-09; no diagnostic wrapper or old launcher remains. The main dispatcher still rejects removed component names. |
| `conf/codex-ws-agent/managed-host.mjs` | Deleted: no API-key broker, ensure/observe admission, credential restore/copy, generation creation or Unix provisioning socket remains. Historical association/journal/credential files are not touched. |
| `conf/codex-ws-agent/agent-client.mjs` | Remove dead broker references; standalone CLI remains retired. Only the injected Runtime execution host is used. |
| `conf/codex-ws-agent/package.json` | No `start` script; not an alternate executable package. Model/provider credentials remain distinct from Agent authentication. |
| `conf/cyf-agent-runtime-v1/lib/execution-adapter.mjs` | Authoritative explicit execution-library catalog and import closure. Excludes/rejects the old broker, API-key env/profile templates, old engine execution README, old install-candidate/policy tools, offline ACK migration and diagnostic probes; also rejects reintroduced package start/prestart/poststart/bin entries and retired-path symlinks. |
| `shell/cyf_agent_runtime_v1_install.sh`, `conf/cyf-agent-runtime-v1/install.sh` | Existing sole artifact staging path retained: fresh canonical target only, no old `.env` or profile adoption, no enrollment, service activation or state migration. |

Existing scoped provider, CHAT, native/skill and checkpoint implementations are
not replaced. Long historical profile identifiers remain explicit provider-scope
regression inputs; they neither provision an identity nor authorize a Runtime.
The retired candidate/provenance checker, its templates and its dedicated tests
were deleted on 2026-10-09. Current configuration validation, manifest/session
contracts and execution tests remain; no old installer fixture is shipped.

### Registry, launcher and unit source convergence

`install.sh` advertises only `cyf-agent-runtime-v1`/`runtime-v1` for Agent artifacts;
profile `agent` selects the canonical Runtime component without a generic Node
upgrade. Other component mappings and full-profile order are preserved, with only
the retired Agent component replaced. `codex-ws-agent`/`codex` are rejected before
any component installation, even in a mixed argument list. `shell/sh_list.txt`
lists only the current Runtime installer. Explicit instance, prepared canonical
parent and Node 20.20.2 prerequisites still apply; no identity is inferred.

The old launcher/installer stubs and API-key env/INI templates are deleted,
along with the dual-mode candidate checker, workspace migration pre-check and
historical API probe. The execution library no longer exports `loadRuntimeConfig`
or `observeTypedRuntimeAuthentication`; explicit JSON profiles are normalized
under the existing Runtime host. Current tests verify removed paths remain absent.

The old unit templates remain absent. Only the existing unified Runtime unit is
shipped. These are source changes, not removal or restart of installed services.
The separate active ACK workstream still references its offline migration tool;
that tool remains repository-only and excluded from the execution artifact.


## Old/new state migration requirements — no migration performed

1. Inventory **all** shared/dynamic profiles, exact tenant/client/canonical Agent,
   verified Runtime installation mapping, work roots and maintenance Owners. The
   three persona names are not exhaustive identities or authorization evidence.
   Preserve private historical association, journal and credential evidence for
   audit; never authorize a new installation using an old API key/hash or role.
2. Require an explicit, independently verifiable, unique full-subject mapping into
   each sealed manifest and protected installation enrollment. Ambiguous histories
   remain blocked and untouched; do not silently restore the old broker or infer
   ownership from directory/profile names. New session tokens and generations are
   transport-only authority, not migration inputs or persistent queue contents.
3. After an authorized stop of **all exact old writers**, back up code plus state
   formats, identity maps and owned directory/inode evidence. Account for inbox,
   original-wire fingerprints, ledger, ACK FIFO/head/last-confirmed-version and
   receipts; CHAT inbox/outbox/request/turn/thread/session; skill result evidence
   and outbox; execution reports; provider ledgers/fences and unknown outcomes;
   worktrees, materials and cleanup authority. No queue clearing, paid/business
   replay, re-delivery or inferred success from a historical WS send.
4. Pre-r2 fingerprints and ACK formats are not silently convertible to r2. A
   proved, explicit offline migration plan must preserve original work evidence
   and unknown/recovery-required outcomes. The offline ACK tool is deliberately
   **not** packaged as a Runtime startup step. Model-provider Codex home/auth is
   separate from retired Agent credential files; no cross-Agent template copying.
5. Cut over with one writer per full subject, never old/new simultaneous writers.
   Recovery covers code **and** format/state/identity mapping; binary-only rollback
   into new ACK state is unsafe. No production history migration, DDL, revocation,
   credential rewrite, chmod, deletion or service operation is authorized here.

Owned client source retirement and offline self-check can complete separately
from these **remaining gates**: main/runner's real Java/D06/isolated-MySQL and
native/skill cross-end acceptance (UR03 HTTP remains NOT_RUN), clean-target locked
toolchain/Flow verification and exact source/artifact binding, full online identity
and maintenance inventory, explicit stopped-writer migration/recovery plan,
versioned release/cutover/old-authorization revocation, and three-Agent real business
acceptance. Unverified WORK_ITEM_CANCEL stays unadvertised; exact CHAT cancellation
remains supported. These are not replaced by local mocks or by a task-branch push.
