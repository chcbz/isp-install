# codex-ws-agent

Connects a local Codex runner to the OpenClaw agent WebSocket channel.

## Start

```bash
cd /home/isp/apps/codex-ws-agent
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
- Inbound messages are routed by `cliProfile`, `codexProfile`, `profileId`, `assignedAgentId`, `targetAgentId`, `receiverAgentId`, or `agentId`.
- If no target is specified, the default profile is used.

Reconnect behavior:

- The agent reconnects automatically after WebSocket disconnects.
- Backoff starts at 1 second and caps at 30 seconds.
- Retry window is `RECONNECT_MAX_MS`, default `1800000` (30 minutes).
- A successful connection resets the retry window.
- If the reconnect window is exhausted, the process exits and should be restarted by `systemd`.
- Reconnect scheduling is de-duplicated per profile to avoid repeated `error` + `close` races.

## Supported Inbound Events

The client runs Codex only for explicit execution-style events:

- `codex.exec`
- `task.assign`
- `task_assigned`
- `task_event` with `assignedAgentId` matching the selected profile `agentId` and status `running`

Payload prompt fields are resolved from `prompt`, `content`, `description`, `title`, or `currentTaskTitle`.

## Codex Invocation

The client calls, per selected profile:

```bash
codex exec --cd "$CODEX_WORKDIR" --ask-for-approval "$CODEX_APPROVAL" --sandbox "$CODEX_SANDBOX" "$PROMPT"
```

Results are sent back over the WebSocket as `task.report` and `codex.result` events.

## Runtime Notes

- Each configured profile keeps its own `CODEX_HOME`.
- On shutdown, the agent first sends `offline`, then terminates active Codex child processes with `SIGTERM`, and escalates to `SIGKILL` after a short grace period.
- Runtime logs are available from `journalctl -u codex-ws-agent`.
