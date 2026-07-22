---
name: codex-ws-agent-install
description: Use when installing or configuring codex-ws-agent from this repository, including Node.js dependency, durable command inbox, .env generation, profile configuration, public WSS endpoint setup, helper script installation, and systemd service enablement.
---

# Codex WS Agent Install

## Preconditions

- Node.js 22 or newer is installed from this repo or otherwise available as `node`; verify the selected binary exposes the built-in `WebSocket` global.
- `codex` CLI exists on the target host.
- The service account can create, rename, delete, and `fsync` files below `/home/isp/apps/codex-ws-agent/data/inbox`.

## Command

- Direct install: `sudo ./shell/codex_ws_agent_install.sh`
- Via profile: `sudo ./install.sh --profile agent`
- Helper script after install: `/home/isp/bin/codex_ws_agent.sh start`

The current shell installer accepts Node 20 at its outer version gate, so independently run `node -p "process.version + ' WebSocket=' + typeof WebSocket"` and require `WebSocket=function` before starting the A05 client.

## Config files

- App dir: `/home/isp/apps/codex-ws-agent`
- Main env: `/home/isp/apps/codex-ws-agent/.env`
- Env template: `/home/isp/apps/codex-ws-agent/.env.example`
- Profiles: `/home/isp/apps/codex-ws-agent/codex-profiles.conf`
- Durable inbox: `/home/isp/apps/codex-ws-agent/data/inbox`

## Required settings

- `WS_URL=wss://api.chaoyoufan.cn/ws/agent/channel`
- `OPENCLAW_API_KEY=<key>`
- `DEFAULT_CODEX_PROFILE=codex-default`
- `CODEX_PROFILES_FILE=/home/isp/apps/codex-ws-agent/codex-profiles.conf`
- `COMMAND_INBOX_DIR=/home/isp/apps/codex-ws-agent/data/inbox`
- `COMMAND_INBOX_SUCCESS_POLICY=archive`

Use `archive` for initial rollout. Do not run old and new clients concurrently for the same canonical `agentId`. A rollback to the old client must preserve or drain `pending/` and `processing/`; the old client cannot consume A05 inbox files.

## Verify

- `node -p "process.version + ' WebSocket=' + typeof WebSocket"`
- `cd /home/isp/apps/codex-ws-agent && node agent-client.mjs --validate`
- `systemctl status codex-ws-agent`
- `journalctl -u codex-ws-agent -f`
