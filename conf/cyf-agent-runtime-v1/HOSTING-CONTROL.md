# GSS-HOSTING-RUNTIME-20261010 implementation boundary

Frozen before source edits, 2026-10-10; base 2ce6fedf34832048e248fde3e07222f5ed867b7a.
Owner gss_runtime_sol_20261010. Development only; no installation, provider call or production readiness evidence.

- Wire catalog: runtime-hosting-v1, capabilities/prepare/ensure/observe; exact flat association from Main's frozen GSS-HOSTING-CONTROL-CONTRACT-20261010.md. Reject duplicate and unknown keys. No request-selected paths, commands, URLs or secrets.
- Lock order: existing lifetime host ownership -> control per-subject journal gate -> RuntimeHost per-subject lifecycle gate -> existing executor short durable-store locks. Journal commits finish before enrollment/session/activation. Observe reads live executor proof, never awaits activation or treats persisted READY as current readiness.
- Transaction boundary: prepare durably allocates a candidate only; API transaction authorizes exact installation before ensure. Runtime has no DB transaction. Ensure durably admits before enrollment/network; enrollment uncertainty marker remains authoritative and prohibits retry. Reprovision preserves installation/manifest/auth; only the subject executor/session changes.
- Sensitive allowlist: only enrollmentSecretSha256 and manifest digest leave private journal; runtime authorization and enrollment secret never leave private Runtime state except native authenticated API enrollment/session calls. Socket admission is filesystem identity/permissions plus exact configured tenant/client/owner scope. Operator explicitly grants access to the API OS identity; hostile same-UID processes are not an isolation boundary.
- Coverage: dynamic add/recreate and peers unchanged -> hosting lifecycle tests; registration-pending heartbeat -> existing runtime-host tests; exact association/replay/scope/duplicate fields/generation -> hosting control tests; journal restart and stale readiness -> hosting control tests; lost enrollment response -> runtime-v1 tests plus hosting control tests; installer/schema/template boundary -> config/installer source checks. All network tests use local mocks, not actual readiness.

Managed template and source installer support are specified below with exact fields. Retired broker remains retired. Final module-wide, isolated DB and production validation belong to Main/test runner, not this Owner.

## Operator setup (source contract, NOT performed on this host)

The artifact-staging installer includes `hosting-control.example.json`, this guide,
`lib/hosting-*.mjs` and `systemd/cyf-agent-runtime-v1-hosting.tmpfiles.conf.example`.
It does not install a service, create production roots, apply tmpfiles, enroll,
connect a provider, or change the API. Existing static config remains valid.

1. Explicitly authorize the release and fix its source/artifact. Copy the example
   to an operator-owned **0600**, non-symlink external configuration, e.g.
   `/etc/cyf-agent-runtime-v1/unified.hosting.json`. Replace all placeholders with
   the authorized tenant/client/owner and independent managed provider/model/binary.
   The example is not proof the production host is already configured. Select an
   app-server schema contract supported by the configured binary (no Node gate).
2. Add **only** `"hostingControlPath": "/etc/cyf-agent-runtime-v1/unified.hosting.json"`
   to the existing `unified.host.json`; retain `agents/configVersion/hostId/stateRoot`.
   Static Agents stay outside the managed journal and remain installation-authorized.
3. Install the reviewed tmpfiles example as
   `/etc/tmpfiles.d/cyf-agent-runtime-v1-hosting.conf`. The example uses `root:isp`;
   verify the actual trusted group before applying it. Normal boot tmpfiles setup
   recreates `/run/cyf-agent-runtime-v1/unified` as **root:isp 0750**. Persistent
   `/var/lib/cyf-agent-runtime-v1-managed/unified` is **root:root 0700**. Applying
   tmpfiles for initial installation requires separate explicit release authority;
   the installer never invokes `systemd-tmpfiles` or changes those directories.
   Service sources order after `systemd-tmpfiles-setup.service`. Existing unknown
   files/listeners/writer locks are never removed or adopted.
4. Configure the exact API/Runtime pair together:
   - Runtime `socketPath`: `/run/cyf-agent-runtime-v1/unified/control.sock`.
   - API `agent.hosting-rent.managed.socket-path`: same path, fixed by the selected API configuration.
   - Runtime `socketGid: 1000` ↔ API
     **`agent.hosting-rent.managed.socket-group-gid=1000`** for trusted `isp`.
   - API runner UID **0** for the root Runtime. Socket is **root:isp 0660**;
     parent accepts only **0710/0750**, same configured group, never group write or
     world access. Runtime uses filesystem group admission + exact scope; any group
     member is a trusted control caller. Do not grant that group to untrusted users.
5. Validate with the artifact-local Node `agent-runtime.mjs validate --config ...`
   and `runtime/validate.sh` before authorized service activation. Validation is
   read-only; it does not make enrollment/registration/provider readiness claims.
   Subsequent subject add/reprovision uses this SAME process, not a service restart.

### Exact local schema

Hosting config requires exactly `configVersion:1`, `socketPath` (canonical UDS
path), `socketGid` (nonnegative integer trusted group), `managedRoot` (canonical,
operator-created owned 0700 root disjoint from host/static Agent roots), `scopes`
(nonempty exact triples `tenantId/clientId/ownerJiacn`), `enrollmentTtlMs` (positive
safe integer, native enrollment expiry only), and `template`.

`template` has exactly `profile`, `codexConfig` (explicit TOML string), and
`providerEnvironment`. Managed profile fields are the exported
`MANAGED_PROFILE_FIELDS` catalog in `lib/hosting-config.mjs`; `codexBin` is explicit.
No profileId/agentId/HOME/workdir/state paths, Runtime credentials, legacy key,
or request-selected command/URL can enter the template. Runtime derives
`managedRoot/SHA256(tenantId,clientId,canonicalAgentId)/{home,work,state}` and a
subject-specific profileId. It creates a new HOME `config.toml` from this exact
private template, never copies another user's HOME/auth/tasks. Secrets are
operator-owned template material, not submitted by API control requests.

`providerEnvironment` permits only **CYF_MANAGED_PROVIDER_[A-Z][A-Z0-9_]*** string
keys. `codexConfig` explicitly selects a custom provider and its matching managed
`env_key` (example `CYF_MANAGED_PROVIDER_API_KEY`), explicit HTTPS `base_url` and
`requires_openai_auth=false`
avoids borrowing personal OpenAI HOME authorization. The supported TOML subset is
one `[model_providers.NAME]` table, single-line double-quoted scalars/booleans,
and comments on their own lines. Top-level allowed keys: `model`,
`model_provider`, `model_reasoning_effort`, `disable_response_storage`.
Provider keys: `name`, `base_url`, `wire_api` (only `responses`), `env_key`,
`requires_openai_auth` (must be false). Duplicates, other tables, headers,
includes, inline/multiline credential material and alternate auth are rejected.
The example enables WS app-server CHAT but leaves native HTTP poll disabled;
ordinary task commands additionally require a trusted `workspacePolicyId` and
matching `CYF_RUNTIME_WORKSPACE_POLICIES_FILE` (existing policy loader), not a
request-selected directory or policy. No task/provider capability is claimed
from the placeholder example. The mature engine's actual
child environment builder passes these explicit values, not `process.env` secrets;
HOME/CODEX_HOME remain the new subject HOME. PATH/LANG/LC_ALL/TZ keep the existing
narrow inherited environment. Environment credentials cannot override HOME,
NODE_OPTIONS, shell state, existing user's auth, or Runtime session proof.

The initial template snapshot is private and durable per subject. Existing
subject profile/config must match the journal; edits/credential rotation require
an explicitly scoped operator workflow, not another request-supplied profile.
No rotation/automatic auth repair API is supplied in this task.

### API installation handoff and recovery

Prepare persists association + installation/manifest + one-time secret **before**
returning PREPARED. Only manifest and bare SHA256 metadata go to API. API ensures
and links that exact installation in its own transaction, then sends ensure.
Prepare/observe never enroll or activate. Ensure records admission before native
enroll/session/WS registration. Replayed operation association must be identical.
Free reprovision keeps installation/manifest/authorization and enrollment expiry;
its new monotonically allocated provision generation gets a fresh native session.
No reenrollment or full service restart occurs in the normal free-reprovision path.

The private enrollment-attempt marker remains authoritative after a lost enroll
reply or failed authorization write: **RECOVERY_REQUIRED**, never automatic secret
retry, generic FAILED_NO_EFFECT, refund proof or automatic repair delivered.
An operator must reconcile the precise installation under a separate authorized
workflow. Journal loss/unsafe state/unknown writer locks fail closed. Admitted
subjects reload after a clean restart and request a fresh session; prepared-only
candidates stay dormant. Persisted readiness is never trusted: observe requires
this process/operation, current generation, fresh exact registered ACK, current
executor readiness and actual durable health. Revocation/reconnect removes proof.

## Selfcheck evidence boundary

Frozen synthetic fixture source:
`/home/isp/wsps/cyf/docs/implementation/fixtures/gss-hosting-control-v1.json`,
SHA256 `5c4b833e6db5bab3122c6dee17ef49198462aee3c3edf58f628ed8571e241403`.
Copied unchanged under `test/fixtures/`. Selectors `hosting-control.test.mjs` and
`hosting-lifecycle.test.mjs` are local synthetic/native/socket mocks, plus actual
mature-engine state/child environment and local Unix cross-identity permission
checks. They are **not** actual provider, server installation, production GSS
registration/rent settlement, free-reprovision business acceptance or release proof.
`test/hosting-java-bridge-fixture.mjs` starts the actual controller/UDS with
synthetic native/executor mocks and prints one metadata JSON line; keep stdin
open and send `stop` or EOF to clean up. Clock is fixed at 2026-10-10 09:00 CST;
free reprovision `requestedAt=reservedAt` yields expected mock sessions 1/2.
Use this as the Java peer's local integration boundary, not production proof.

Crash recovery is not automatic: stopped-writer repair of a retained ownership
lock or unknown/stale socket requires separate explicit operator reconciliation.
Neither startup nor tmpfiles deletes an existing unknown file/listener/lock.
Clean shutdown releases owned locks and its socket; reboot recreates the `/run`
parent, while persistent private state remains.

Node measured during development: **v20.20.2**. No version gate added.
