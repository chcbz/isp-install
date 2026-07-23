---
name: codex-ws-agent-install
description: Use when installing or configuring codex-ws-agent from this repository, including Node.js dependency, durable command inbox, .env generation, profile configuration, public WSS endpoint setup, helper script installation, and systemd service enablement.
---

# Codex WS Agent Install

## Preconditions

- Node.js 20 or newer is installed from this repo or otherwise available as `node`.
- `codex` CLI exists on the target host.
- The service account can create, rename, delete, and `fsync` files below `/home/isp/apps/codex-ws-agent/data/inbox`.
- For A07 coding commands, prepare a trusted Git repository and a `0700` workspace root (default `/home/isp/hosts/cyf/agent-workspaces`). Prefer a dedicated bare repository/mirror rather than a shared main checkout.

## Command

- Direct install: `sudo ./shell/codex_ws_agent_install.sh`
- Via profile: `sudo ./install.sh --profile agent`
- Helper script after install: `/home/isp/bin/codex_ws_agent.sh start`

After files are installed, run `cd /home/isp/apps/codex-ws-agent && npm ci --omit=dev` so Node 20 can load the declared `ws` dependency. Node runtimes with a built-in WebSocket remain supported.

A06 runtime notes:
- keep one canonical `agentId` on one client at a time; the durable inbox, dedupe ledger, and ACK outbox are profile-local
- `commandId` dedupe uses canonical business-payload fingerprints; transport redelivery metadata is ignored, deep payload/array changes are significant, and conflicts are stored separately without changing the original terminal entry
- never auto-rerun a recovered `processing/` record; A06 moves it to `recovery-required/`, persists a `REJECTED` ACK, and pauses for reconciliation or a new server-issued `commandId`
- reconnects must call the built-in ACK replay path; do not clear the outbox on send failure, marker failure, corrupt-record quarantine, or uncertain recovery
- each ACK has an independent `messageId`; only `correlationId` references the dispatch `messageId`

## A07 workspace policy

1. Copy `/home/isp/apps/codex-ws-agent/workspace-policies.example.json` to `workspace-policies.json` and set mode `0600`.
2. Set only trusted local values for `root`, `repository`, `baseRef`, `trustedRemoteUrl`, and `trustedRemoteRef`; never derive them from a dispatch payload. This version accepts only credential-free HTTPS publication URLs and one fixed `refs/heads/*` ref; SSH, local paths, and `file://` are rejected.
3. Set `CODEX_WORKSPACE_POLICIES_FILE=/home/isp/apps/codex-ws-agent/workspace-policies.json`.
4. Add `workspacePolicyId=<policy>` and `workspaceRole=coder` to every coding Agent profile.
5. Keep `workspaceNoTaskPolicy=reject` unless a specific non-coding command type needs compatibility. If needed, use `dedicated-workdir`, list exact command types, and provide a non-Git `workspaceFallbackWorkdir` with no overlap in either direction with repository or workspace root.

Each `taskId + canonical agentId` receives one deterministic worktree. Creation is cross-process locked and durable metadata must match the repository, fixed baseline commit, trusted remote, branch, role, and path before reuse. Policy loading rejects duplicate/overlapping canonical repositories or roots across policy IDs. Missing policy/task id, path traversal, symlink escape, branch collision, unknown partial state, or Git failure is fail-closed.

There is no automatic cleanup. Operators may inspect or explicitly archive with `/home/isp/bin/codex_ws_agent.sh workspace ...`; archive requires the Agent service to be stopped and refuses dirty, ignored/untracked, unmerged, index-hidden (`skip-worktree`, `assume-unchanged`, or other non-normal index flags), stat-cache-hidden content/mode differences, or unpushed work. Every tracked regular file/symlink is hashed and mode-checked against the index. Publication is proven only in a fresh temporary bare repository with system/global/local config and inherited Git/proxy/askpass/SSH environment excluded, TLS verification forced, and the exact trusted HTTPS URL/ref fetched. Never expose archive arguments to Agent-generated commands.

## Config files

- App dir: `/home/isp/apps/codex-ws-agent`
- Main env: `/home/isp/apps/codex-ws-agent/.env`
- Env template: `/home/isp/apps/codex-ws-agent/.env.example`
- Profiles: `/home/isp/apps/codex-ws-agent/codex-profiles.conf`
- Durable inbox: `/home/isp/apps/codex-ws-agent/data/inbox`
- Workspace manager: `/home/isp/apps/codex-ws-agent/workspace-manager.mjs`
- Workspace policies: `/home/isp/apps/codex-ws-agent/workspace-policies.json`
- Default workspace root: `/home/isp/hosts/cyf/agent-workspaces`

## Required settings

- `WS_URL=wss://api.chaoyoufan.cn/ws/agent/channel`
- `OPENCLAW_API_KEY=<key>`
- `DEFAULT_CODEX_PROFILE=codex-default`
- `CODEX_PROFILES_FILE=/home/isp/apps/codex-ws-agent/codex-profiles.conf`
- `COMMAND_INBOX_DIR=/home/isp/apps/codex-ws-agent/data/inbox`
- `COMMAND_INBOX_SUCCESS_POLICY=archive`
- `CODEX_WORKSPACE_POLICIES_FILE=/home/isp/apps/codex-ws-agent/workspace-policies.json`
- profile: `workspacePolicyId=<trusted-policy>` and `workspaceRole=coder`

Use `archive` for initial rollout. Do not run old and new clients concurrently for the same canonical `agentId`. A rollback must preserve `pending/`, `processing/`, `recovery-required/`, ledger, conflict, blocked/quarantine, and ACK outbox state; the old client cannot consume these records safely.

## Verify

- `cd /home/isp/apps/codex-ws-agent && npm ci --omit=dev`
- `node -v` (must be Node 20+)
- `cd /home/isp/apps/codex-ws-agent && node agent-client.mjs --validate`
- `/home/isp/bin/codex_ws_agent.sh workspace inspect --policy <id> --task <taskId> --agent <agentId> --role coder`
- `systemctl status codex-ws-agent`
- `journalctl -u codex-ws-agent -f`
