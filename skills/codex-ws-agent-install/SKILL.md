---
name: codex-ws-agent-install
description: Use when installing or configuring codex-ws-agent from this repository, including Node.js dependency, .env generation, profile configuration, public WSS endpoint setup, helper script installation, and systemd service enablement.
---

# Codex WS Agent Install

## Preconditions

- Node.js is installed from this repo or otherwise available as `node >= 20`
- `codex` CLI exists on the target host

## Command

- Direct install: `sudo ./shell/codex_ws_agent_install.sh`
- Via profile: `sudo ./install.sh --profile agent`
- Helper script after install: `/home/isp/bin/codex_ws_agent.sh start`

## Config files

- App dir: `/home/isp/apps/codex-ws-agent`
- Main env: `/home/isp/apps/codex-ws-agent/.env`
- Env template: `/home/isp/apps/codex-ws-agent/.env.example`
- Profiles: `/home/isp/apps/codex-ws-agent/codex-profiles.conf`

## Required settings

- `WS_URL=wss://api.chaoyoufan.cn/ws/agent/channel`
- `OPENCLAW_API_KEY=<key>`
- `DEFAULT_CODEX_PROFILE=codex-default`
- `CODEX_PROFILES_FILE=/home/isp/apps/codex-ws-agent/codex-profiles.conf`

## Verify

- `cd /home/isp/apps/codex-ws-agent && node agent-client.mjs --validate`
- `systemctl status codex-ws-agent`
- `journalctl -u codex-ws-agent -f`
