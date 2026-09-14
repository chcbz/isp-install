---
name: cyf-agent-runtime-v1-install
description: Use when preparing or validating the separate CYF Agent Runtime v1 Node 20 package. It is parallel to, and intentionally incompatible with, codex-ws-agent.
---

# CYF Agent Runtime v1 Install

## Boundaries

- Install only the new `cyf-agent-runtime-v1` package. Do not alter, stop, copy state from, or copy `.env`/API keys from `codex-ws-agent`.
- Do not put enrollment secrets, runtime authorization, Provider credentials, or URL `api_key` values in a manifest, shell command, chat, browser, or ordinary log.
- The package does not support legacy WebSocket registration, legacy IDs, or URL API-key configuration.

## Prepare

The controlled deployment channel supplies a real read-only `manifest.json` and a single-use enrollment secret. The manifest has exact `tenantId`, `clientId`, `canonicalAgentId`, `installationId`, `manifestVersion`, and `manifestSha256`; validate it before a service is enabled.

```bash
export CYF_RUNTIME_V1_INSTANCE=<safe-installation-name>
sudo ./shell/cyf_agent_runtime_v1_install.sh
```

This only copies a parallel package below `/home/isp/apps/cyf-agent-runtime-v1/<instance>` and installs the `cyf-agent-runtime-v1@.service` template. It does **not** enable or start the service.

Create `/etc/cyf-agent-runtime-v1/<instance>.conf` with mode `0600`; it contains `CYF_RUNTIME_V1_API_BASE_URL` and only a path to a separately supplied `0600` enrollment-secret file. Do not store the secret value in the environment file. Remove the enrollment secret after successful enrollment.

## Validate and start

```bash
cd /home/isp/apps/cyf-agent-runtime-v1/<instance>
node agent-runtime.mjs validate --manifest manifest.json
sudo systemctl enable --now cyf-agent-runtime-v1@<instance>
systemctl status cyf-agent-runtime-v1@<instance>
```

The service receives `SIGTERM` and exits its heartbeat loop cleanly. Do not use `kill -9` as a normal stop operation.

## API contract gap

The client has only the frozen endpoint paths and identity/ACK invariants. Before connecting to any API, confirm API-owned request/response field names for enrollment authorization, ACK status/result, `REBINDS_REQUIRED`, and the command-channel transport. `run` does not invent polling or execute received command payloads; it only establishes a session, heartbeats, and replays durable ACKs.
