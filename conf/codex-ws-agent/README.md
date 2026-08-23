# codex-ws-agent

Connects a local Codex runner to the OpenClaw agent WebSocket channel.

## Start

```bash
cd /home/isp/apps/codex-ws-agent
npm ci --omit=dev
cp -n .env.example .env
vi .env
/home/isp/bin/codex_ws_agent.sh start
```

Recommended production mode is `systemd`:

```bash
systemctl status codex-ws-agent
systemctl restart codex-ws-agent
journalctl -u codex-ws-agent -f
```

The helper script `/home/isp/bin/codex_ws_agent.sh` now delegates to `systemd` automatically when the service is installed, and falls back to the legacy direct-start mode otherwise.

Required:

- Node.js 20 or newer. Node 20 loads the declared `ws` dependency; newer runtimes may use their built-in WebSocket implementation.
- `OPENCLAW_API_KEY`: API key accepted by `/ws/agent/channel`.
- `WS_URL`: WebSocket endpoint. Default public endpoint is `wss://api.chaoyoufan.cn/ws/agent/channel`.

## Multiple Codex CLI Profiles

The recommended deployment mode is multi-profile:

- `CODEX_PROFILES_FILE` pointing to a JSON file or section-style profile file
- or `CODEX_PROFILES` as an inline JSON array
- plus optional `DEFAULT_CODEX_PROFILE`

Legacy single-profile `AGENT_*` and `CODEX_*` variables are still accepted as a fallback, but are no longer recommended.

Each profile can define:

- `profileId`
- `agentId`
- `agentName`
- `personaName`
- `codexBin`
- `codexHome`
- `codexWorkdir`
- `codexSandbox`
- `codexApproval`
- `codexSessionMode`
- `codexTimeoutMs`
- `abilities` (optional comma-separated runtime labels)
- `skills` (optional comma-separated skill names)
- `workspacePolicyId`
- `workspaceRole`
- `workspaceNoTaskPolicy`
- `workspaceNonCodingCommandTypes`
- `workspaceFallbackWorkdir`
- `isDefault`

Recommended `.env`:

```bash
DEFAULT_CODEX_PROFILE=codex-default
CODEX_PROFILES_FILE=/home/isp/apps/codex-ws-agent/codex-profiles.conf
```

Example `codex-profiles.conf`:

```ini
[default]
codexBin=/usr/local/bin/codex
codexWorkdir=/home/isp
codexSandbox=danger-full-access
codexApproval=never
codexSessionMode=resume
codexTimeoutMs=900000
# Select a trusted entry from workspace-policies.json before accepting coding commands.
# workspacePolicyId=cyf
workspaceRole=coder
workspaceNoTaskPolicy=reject

[agent.default]
profileId=codex-default
agentId=codex-default
agentName=Codex
personaName=Default
codexHome=/home/isp/apps/codex-ws-agent/.codex-default
isDefault=true

[agent.wuyong]
agentId=jyt-client-wuyong
agentName=吴用
personaName=智多星
codexHome=/home/isp/apps/codex-ws-agent/.codex-wuyong
codexWorkdir=/home/isp/wsps/cyf
abilities=planning,review
skills=cyf-quick-iterate
enabled=true
apiKey=cdx_optional_profile_specific_key
```

Every `[agent.*]` section inherits fields from `[default]` and can override any of them.

At registration and every presence heartbeat, the client rebuilds the reported ability snapshot from the built-in Codex capabilities, profile `abilities`/`skills`, and installed `SKILL.md` manifests under the profile `CODEX_HOME`, plugin cache, and workspace skill directories. This lets the server refresh `agent_runtime.abilities` without changing the bound persona. Ability labels are scheduling hints, not authorization.

Set `enabled=false` on an `[agent.*]` section to take that profile out of service without deleting it. Hot reload closes the profile connection and skips registration; changing it back to `enabled=true` reconnects it. `active=false` and `status=disabled|inactive|unavailable` are also treated as disabled.

If a profile is bound to a different user than the global `OPENCLAW_API_KEY`, set `apiKey` on that profile. Profile-level keys override the global key for that WebSocket connection.

Startup validation now checks that:

- every configured `codexBin` exists and is executable
- every configured `codexWorkdir` exists
- profile ids and agent ids are unique
- the default profile exists

You can run the validation manually:

```bash
cd /home/isp/apps/codex-ws-agent
node agent-client.mjs --validate
```

JSON is still supported:

```json
[
  {
    "profileId": "songjiang",
    "agentId": "songjiang",
    "agentName": "宋江",
    "personaName": "及时雨",
    "codexBin": "codex",
    "codexHome": "/home/isp/apps/codex-ws-agent/.codex-songjiang",
    "codexWorkdir": "/home/isp/hosts/cyf/workspace/cyf",
    "codexSandbox": "workspace-write",
    "codexApproval": "never",
    "codexSessionMode": "new",
    "codexTimeoutMs": 900000,
    "isDefault": true
  },
  {
    "profileId": "wuyong",
    "agentId": "wuyong",
    "agentName": "吴用",
    "personaName": "智多星",
    "codexBin": "/usr/local/bin/codex",
    "codexHome": "/home/isp/apps/codex-ws-agent/.codex-wuyong",
    "codexWorkdir": "/home/isp/hosts/cyf/workspace/cyf",
    "codexSandbox": "workspace-write",
    "codexApproval": "never",
    "codexSessionMode": "resume",
    "codexTimeoutMs": 900000
  }
]
```

When multi-profile mode is enabled:

- The process opens one WebSocket connection per configured agent profile.
- Each profile maintains its own `CODEX_HOME`, workdir, sandbox, and timeout.
- Each WebSocket connection is bound to one configured Agent profile. The client does not reroute a message received on one profile's connection to another local profile.
- `command.dispatch` requires `targetAgentId` and rejects a target that differs from the connection's profile. Chat and event messages with an explicit target apply the same check.

Reconnect behavior:

- The agent reconnects automatically after WebSocket disconnects.
- Backoff starts at 1 second and caps at 30 seconds.
- Retry window is `RECONNECT_MAX_MS`, default `1800000` (30 minutes).
- A successful connection resets the retry window.
- If the reconnect window is exhausted, the process exits and should be restarted by `systemd`.
- Reconnect scheduling is de-duplicated per profile to avoid repeated `error` + `close` races.

## A07 Isolated Task Worktrees

`command.dispatch` no longer runs in a profile's shared writable `codexWorkdir`. Production command execution sets `requireWorkspace=true` and fails closed unless the profile selects a trusted workspace policy. Chat remains on the profile workdir and never receives workspace-management privileges.

Create an active policy file from the installed example:

```bash
cp /home/isp/apps/codex-ws-agent/workspace-policies.example.json \
  /home/isp/apps/codex-ws-agent/workspace-policies.json
chmod 600 /home/isp/apps/codex-ws-agent/workspace-policies.json
```

Example trusted policy:

```json
{
  "cyf": {
    "root": "/home/isp/hosts/cyf/agent-workspaces",
    "repository": "/home/isp/hosts/cyf/repository.git",
    "baseRef": "refs/heads/master",
    "trustedRemoteUrl": "https://git.example.com/chaoyoufan/cyf.git",
    "trustedRemoteRef": "refs/heads/master"
  }
}
```

Then configure:

```bash
CODEX_WORKSPACE_POLICIES_FILE=/home/isp/apps/codex-ws-agent/workspace-policies.json
```

and select the policy in each coding profile:

```ini
workspacePolicyId=cyf
workspaceRole=coder
workspaceNoTaskPolicy=reject
```

Security and lifecycle rules:

- `root`, `repository`, `baseRef`, `trustedRemoteUrl`, and `trustedRemoteRef` come only from the local policy file/inline environment policy. Dispatch payload fields cannot replace them. Publication URLs must be credential-free HTTPS; SSH, local paths, and `file://` are rejected in this version. The ref must be one fixed `refs/heads/*` ref.
- Policy loading canonicalizes resources and rejects duplicate or overlapping repositories/workspace roots across policy IDs. Workspace lock identity is derived from canonical repository/root plus task/agent, not from a policy alias.
- `taskId`, canonical `agentId`, and role must be safe 1-64 character ASCII slugs. Traversal, symlink components, repository/root overlap, and arbitrary paths/refs fail closed.
- The default layout is `/home/isp/hosts/cyf/agent-workspaces/<taskId>/agent-<agentId>` with deterministic branch `codex/<taskId>/agent-<agentId>-<role>`.
- A cross-process durable lock serializes creation. Durable `creating` metadata is written before `git worktree add`, so a later process can validate and finish a partial creation without adopting an unknown directory or branch.
- Reuse requires the Git worktree registration, branch, trusted repository, fixed baseline commit, path, task, agent, role, and durable metadata to match exactly.
- Managed command runs force a fresh Codex exec with both process `cwd` and `--cd` set to the task worktree; a resume session from another worktree is not used.
- A command without `taskId` is rejected by default. Compatibility is available only when `workspaceNoTaskPolicy=dedicated-workdir`, the command type is explicitly listed in `workspaceNonCodingCommandTypes`, and `workspaceFallbackWorkdir` is a trusted non-Git directory with no overlap in either direction with the repository or workspace root.
- Workspaces are never automatically deleted. Archive is an explicit operator action and refuses modified, ignored/untracked, unmerged, index-hidden (`skip-worktree`, `assume-unchanged`, or any non-normal tracked flag), or unpushed work.
- Archive is logical and non-destructive: it moves the metadata-owned worktree into the private `.archive-quarantine` directory, keeps the Git worktree registration and all files indefinitely, and persists `state=archived`, `quarantinePath`, branch, and `archivedHead`. It never invokes `git worktree remove` or `git worktree prune`.
- Before the logical archive transition, archive enumerates every stage-0 index entry and independently verifies the actual regular-file/symlink type, executable mode, and raw blob hash. This does not trust Git's stat cache, `core.trustctime`, `core.filemode`, file length, or restored mtimes.
- For a workspace beyond its baseline, archive creates a new temporary bare verification repository, disables system/global configuration, supplies a fresh HOME/XDG config, clears inherited proxy/askpass/SSH/Git configuration environment, forces TLS verification, and fetches only `trustedRemoteRef` from the exact `trustedRemoteUrl`. The managed repository is never used as the fetch destination. Local upstreams, `insteadOf`, proxy/credential helpers, stale refs, and substituted remotes are not publication proof.
- Every archived record is bound to exactly one retained Git worktree. On restart, inspection/reuse validates the exact registered path, Git top-level, symbolic branch, worktree HEAD, and repository branch ref against `quarantinePath`, `branch`, and `archivedHead`. Any registration, path, branch, HEAD, or ref drift fails with `WORKSPACE_ARCHIVE_RECOVERY_REQUIRED` before returning a generic inactive-state result.
- This version has no Agent-side GC, delete, prune, recover, or reconcile command. Archived quarantine usage therefore grows with every logical archive; operators must monitor filesystem capacity and inode usage below the policy workspace root. Physical deletion is outside the Agent trust boundary and is not enabled by this package.

Operator commands use the installed helper and never accept paths, repositories, refs, or cleanup instructions from an Agent message:

```bash
/home/isp/bin/codex_ws_agent.sh workspace inspect --policy cyf --task task-123 --agent agent-a --role coder
/home/isp/bin/codex_ws_agent.sh workspace ensure  --policy cyf --task task-123 --agent agent-a --role coder
# Stop the service first; archive is refused while the Agent process is running.
/home/isp/bin/codex_ws_agent.sh workspace archive --policy cyf --task task-123 --agent agent-a --role coder
```

`workspace inspect` is diagnostic-only. For a valid archived workspace it returns the retained metadata, including `quarantinePath`; it does not reactivate, move, repair, or delete anything. If it reports `WORKSPACE_ARCHIVE_RECOVERY_REQUIRED`, stop the Agent service and preserve the metadata file, quarantine directory, repository refs, and Git worktree administrative records as evidence. Do not run `git worktree remove`, `git worktree prune`, or manually edit/move/delete those paths through the Agent account. Manual recovery starts only after an operator has made a separate backup and reconciled the exact path/registration/branch/HEAD/ref mismatch under an independently authorized administrative procedure.

The service account needs `0700` create/fsync permissions below the workspace root, Git ref/worktree administrative permissions in the trusted repository, and credentials/network access to fetch the policy-pinned remote during archive. Prefer a dedicated bare repository or mirror so no Agent ever writes a shared main checkout. Capacity monitoring is mandatory because archived quarantine directories are retained permanently by this version.

## Protocol v1 Message Handling

The client is fail-closed and uses the canonical `messageType` as the semantic discriminator:

- `command.dispatch`: the only message type that enters the executable queue. It must use `schemaVersion: 1` and include `messageId`, `commandId`, `commandType`, and `targetAgentId`.
- `chat.message`: may invoke Codex for a conversational reply. That path emits only `chat.message.delta` and final `chat.message`; it never emits `task.report`, `work.result`, or `codex.result`.
- `task.event`: updates the profile's local observed-task state and never invokes Codex.
- Other recognized Protocol v1 messages are non-executable. Unknown, malformed, missing-version, missing-`messageType`, conflicting outer/nested Envelope, and legacy execution messages fail closed.
- Known legacy server control notifications are handled without command execution. The existing `connected` and `ping` controls retain their protocol responses, while `agent_status` is ignored for compatibility with existing CYF API presence broadcasts; unknown and execution-like legacy frames still fail closed.

The compatibility outer type `agent_direct_message` is accepted only when its canonical `messageType` is explicitly `chat.message` or `command.dispatch`. Legacy `codex.exec`, `task.assign`, and `task_assigned` messages do not execute.

Payload prompt fields are resolved from `prompt`, `content`, `instruction`, `description`, `title`, or `currentTaskTitle`.

## Process Runtime Identity

A new UUID `runtimeInstanceId` is generated once when the Node process starts. All profiles in that process share it. Every WebSocket reconnect reuses the same value, while a process restart generates a new value.

The ID is sent in both WebSocket query aliases (`runtime_instance_id` and `runtimeInstanceId`) and in Protocol v1 registration, presence, chat, and protocol-error messages. It is process identity only and is never used as a task, work-item, command, or ownership key.

## Durable Command Inbox

Configure:

```bash
COMMAND_INBOX_DIR=/home/isp/apps/codex-ws-agent/data/inbox
COMMAND_INBOX_SUCCESS_POLICY=archive
```

The service account must have create, rename, delete, and `fsync` permissions below `COMMAND_INBOX_DIR` before upgrading.

Each canonical Agent receives an isolated directory keyed by the hex encoding of `agentId`:

```text
COMMAND_INBOX_DIR/
  <agent-id-as-utf8-hex>/
    pending/
    processing/
    recovery-required/
    archive/
    quarantine/
    ledger/
    ledger-conflicts/
    ledger-quarantine/
    ledger-blocked/
    acks/
    acks-quarantine/
```

Each command is one JSON file with `formatVersion: 1` and these durable fields:

```json
{
  "formatVersion": 1,
  "queueId": "uuid",
  "queueSequence": 1,
  "profileId": "local-profile-key",
  "agentId": "canonical-agent-id",
  "state": "pending",
  "receivedAt": 0,
  "enqueuedAt": 0,
  "messageId": "message-id",
  "commandId": "command-id",
  "commandType": "TASK_EXECUTE",
  "taskId": "task-id",
  "workItemId": "work-item-id",
  "attempt": 0,
  "issuedAt": 0,
  "expiresAt": 0,
  "correlationId": "correlation-id",
  "causationId": "causation-id",
  "rawPayload": {}
}
```

Queue behavior:

- A profile-local `sequence.json` counter is atomically persisted before each record; FIFO ordering uses this cross-restart monotonic sequence and never wall-clock time.
- The complete record is written to a temporary file, file-synced, and atomically renamed into `pending/` before execution can start.
- A profile executes one command at a time in durable enqueue order. Commands arriving while Codex is busy remain in `pending/`.
- Claiming is an atomic `pending/ -> processing/` rename.
- On process startup, an unfinished `processing/` record moves to durable `recovery-required/`, emits a persistent `REJECTED` ACK, and pauses the profile. It is never automatically re-executed because its external side effects are unknown. Reconciliation or a server dispatch with a new `commandId` is required.
- A `processing/` record already durably marked completed is settled without re-execution and its terminal ledger state is reconciled/replayed.
- Recovery and the final pre-execution gate fully revalidate Protocol v1 semantics, `command.dispatch`, target, and message/command fields. Invalid records move to `quarantine/` with a `.reason.txt` sidecar and never execute.
- Inbox, recovery, ledger, conflict, ACK outbox, blocked, and quarantine directories are forced to `0700`; durable records and reason files are forced to `0600`.
- Critical file/directory `fsync`, rename, unlink, and cross-directory move failures propagate and pause execution rather than claiming durability.
- With the default `archive` policy, successful and failed executions move to `archive/`. With `delete`, successful executions are removed and failures remain archived.

A06 closes the A05 crash window with two durable guards:

- `commandId` is deduped in a persistent ledger by a canonical fingerprint containing only command semantics plus the complete nested business payload. Object-key order is normalized, array values/order remain significant, and transport redelivery metadata such as message/runtime/session/correlation ids and timestamps is excluded.
- A fingerprint conflict creates a separate durable conflict record and `REJECTED` ACK; it never overwrites the original command fingerprint, terminal status, outcome, or completion timestamp.
- `RECEIVED`, `STARTED`, `SUCCEEDED`, `FAILED`, and `REJECTED` ACKs are written to a persistent outbox before send. `ack*Emitted` is persisted only after `send` explicitly succeeds; marker/dequeue failures retain the outbox record for documented at-least-once replay.
- Corrupt ledger or ACK records are durably quarantined and the profile pauses fail-closed for manual reconciliation.
- Every ACK has a new `messageId`; `correlationId` alone points to the dispatch `messageId`. Duplicate delivery replays the ledger's current ACK state, including terminal `SUCCEEDED` or `FAILED`.

Completed failures are archived rather than retried in a hot loop.

## Codex Invocation

For a managed command, the client calls Codex with the resolved task/Agent worktree as both process cwd and `--cd`:

```bash
codex exec --cd "/home/isp/hosts/cyf/agent-workspaces/$TASK_ID/agent-$AGENT_ID" \
  --ask-for-approval "$CODEX_APPROVAL" --sandbox "$CODEX_SANDBOX" "$PROMPT"
```

`codexWorkdir` remains the chat workdir and is not a coding-command fallback unless the explicit non-coding compatibility policy above is configured.

Command compatibility results remain `task.report` plus `codex.result` until the later ACK/result migration. Chat and task-event paths never use those result types.

## Test

From the versioned `isp-install` checkout:

```bash
cd conf/codex-ws-agent
npm test
OPENCLAW_API_KEY=test CODEX_BIN=/bin/true CODEX_WORKDIR=/tmp node agent-client.mjs --validate
```

The test suite uses only Node built-ins (`node:test`). A07 tests create temporary local Git repositories/worktrees and do not touch production paths. The production installer copies the runtime files, not the repository-only test directory.

## Upgrade and Rollback

Before upgrade:

1. Create `COMMAND_INBOX_DIR` and grant the service account ownership/write access.
2. Stop the old process cleanly before starting the A06 client; do not run old and new clients concurrently for the same canonical `agentId`.
3. Keep the default `archive` policy through initial rollout so command outcomes are inspectable.

Rollback to the pre-A05 client does not understand the durable inbox, ledger, ACK outbox, or `recovery-required/` files. Preserve all profile-local state and coordinate reconciliation/server redispatch before rollback. Never delete `processing/` or `recovery-required/` blindly; either may represent a command whose external side effect already occurred.

## Runtime Notes

- Each configured profile keeps its own `CODEX_HOME`.
- On shutdown, the agent sends `offline` and terminates active Codex children. Any unsettled `processing/` record becomes fail-closed `recovery-required/` on the next process and is not automatically retried.
- Pending commands wait until the profile WebSocket reconnects before executing; recovery-required commands remain paused until explicit reconciliation.
- Runtime logs are available from `journalctl -u codex-ws-agent`.
