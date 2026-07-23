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
enabled=true
apiKey=cdx_optional_profile_specific_key
```

Every `[agent.*]` section inherits fields from `[default]` and can override any of them.

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

## Protocol v1 Message Handling

The client is fail-closed and uses the canonical `messageType` as the semantic discriminator:

- `command.dispatch`: the only message type that enters the executable queue. It must use `schemaVersion: 1` and include `messageId`, `commandId`, `commandType`, and `targetAgentId`.
- `chat.message`: may invoke Codex for a conversational reply. That path emits only `chat.message.delta` and final `chat.message`; it never emits `task.report`, `work.result`, or `codex.result`.
- `task.event`: updates the profile's local observed-task state and never invokes Codex.
- Other recognized Protocol v1 messages are non-executable. Unknown, malformed, missing-version, missing-`messageType`, conflicting outer/nested Envelope, and legacy execution messages fail closed.

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
    archive/
    quarantine/
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
- On process startup, unfinished `processing/` records return to `pending/`; records already marked completed are settled without re-execution.
- Recovery and the final pre-execution gate fully revalidate Protocol v1 semantics, `command.dispatch`, target, and message/command fields. Invalid records move to `quarantine/` with a `.reason.txt` sidecar and never execute.
- Queue directories are forced to `0700`; sequence, queue, archive, quarantine, and reason files are forced to `0600`.
- Critical file/directory `fsync`, rename, unlink, and cross-directory move failures propagate and pause execution rather than claiming durability.
- With the default `archive` policy, successful and failed executions move to `archive/`. With `delete`, successful executions are removed and failures remain archived.

A05 deliberately does **not** implement durable ACK or `commandId` idempotency. A crash after the external command side effect but before the local completion marker can execute the command again after restart. A06 must close that window. Completed failures are archived rather than retried in a hot loop.

## Codex Invocation

The client calls, per selected profile:

```bash
codex exec --cd "$CODEX_WORKDIR" --ask-for-approval "$CODEX_APPROVAL" --sandbox "$CODEX_SANDBOX" "$PROMPT"
```

Command compatibility results remain `task.report` plus `codex.result` until the later ACK/result migration. Chat and task-event paths never use those result types.

## Test

From the versioned `isp-install` checkout:

```bash
cd conf/codex-ws-agent
npm test
OPENCLAW_API_KEY=test CODEX_BIN=/bin/true CODEX_WORKDIR=/tmp node agent-client.mjs --validate
```

The test suite uses only Node built-ins (`node:test`). The production installer copies the runtime files, not the repository-only test directory.

## Upgrade and Rollback

Before upgrade:

1. Create `COMMAND_INBOX_DIR` and grant the service account ownership/write access.
2. Stop the old process cleanly before starting the A05 client; do not run old and new clients concurrently for the same canonical `agentId`.
3. Keep the default `archive` policy through initial rollout so command outcomes are inspectable.

Rollback to the pre-A05 client does not understand `pending/` or `processing/` files and can therefore strand queued commands. Drain or preserve the inbox and coordinate server redispatch before rollback. Never delete `processing/` blindly; it may represent a command whose external side effect already occurred.

## Runtime Notes

- Each configured profile keeps its own `CODEX_HOME`.
- On shutdown, the agent sends `offline`, terminates active Codex children, and leaves any unsettled `processing/` record recoverable by the next process.
- Pending recovery waits until the profile WebSocket reconnects before executing, reducing the chance that a result is produced with no live transport.
- Runtime logs are available from `journalctl -u codex-ws-agent`.
