# CYF Agent Runtime v1

A separate Node 20 Runtime v1 package. It does not reuse `codex-ws-agent`, WebSocket URLs, `.env` files, legacy `api_key` configuration, profiles, or state.

## Offline validation and installation

```bash
./validate.sh --manifest manifest.example.json
npm test
```

The repository release profile also provides `./install.sh runtime-v1` (which invokes
`shell/cyf_agent_runtime_v1_install.sh`) and the `systemd/cyf-agent-runtime-v1@.service`
template. The copied Runtime v1 payload contains its own `install.sh`, `validate.sh`, and
`systemd/` template. Both installers create a **new** directory and never copy, read, stop,
or overwrite `codex-ws-agent` files.

For a standalone sealed package delivery, use the payload installer with a real manifest:

```bash
./install.sh --target /home/isp/apps/cyf-agent-runtime-v1/AGENT_INSTANCE \
  --manifest /secure/channel/manifest.json
```

It copies only Runtime v1 files, validates the installed manifest, creates a private
`runtime-state/` directory, and does not enable or start a service.

A deployment channel must deliver a real read-only `manifest.json` with exact `tenantId`, `clientId`, `canonicalAgentId`, `installationId`, `manifestVersion`, and `manifestSha256`. `manifestSha256` is calculated as `sha256:` plus the lowercase SHA-256 of the recursively key-sorted JSON object with the `manifestSha256` member omitted. This local packaging rule is deliberately isolated because the API design does not yet specify a manifest canonicalization wire format.

## Runtime configuration

Set only `CYF_RUNTIME_V1_API_BASE_URL` plus one enrollment source:

- `CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE`: regular non-symlink file with mode `0600`; or
- `CYF_RUNTIME_V1_ENROLLMENT_SECRET`: protected service-manager environment.

The CLI deliberately has no enrollment-secret option. Runtime authorization is persisted only below `--state-dir` in private (`0700` directory, `0600` file) storage. Do not retain the enrollment secret after a successful enrollment. Do not put any authorization value in a URL, shell history, manifest, browser, or normal log.

## Commands

```bash
node agent-runtime.mjs validate --manifest manifest.json
node agent-runtime.mjs enroll --manifest manifest.json --state-dir runtime-state
node agent-runtime.mjs session --manifest manifest.json --state-dir runtime-state
node agent-runtime.mjs heartbeat --manifest manifest.json --state-dir runtime-state
node agent-runtime.mjs ack --manifest manifest.json --state-dir runtime-state --command command.json --status RECEIVED
node agent-runtime.mjs run --manifest manifest.json --state-dir runtime-state
```

`ack` validates command target identity, expiry, required command fields, and monotonic state before a private durable queue is written. Reconnection resends the same `messageId` ACK; terminal acknowledgement records are retained to avoid execution replay and terminal rewrites.

## API integration assumptions requiring confirmation

The frozen design specifies endpoint paths but not request/response schemas or command-channel transport. This package therefore sends the documented identity fields to all Runtime v1 HTTP endpoints and assumes:

1. enrollment accepts `enrollmentSecret` and returns `data.runtimeAuthorization` in CYF's common JSON envelope;
2. runtime authorization is sent as `Authorization: Bearer <runtimeAuthorization>`;
3. ACK body uses `status` and returns `data.kind: ADVANCED|PRIOR`;
4. session/heartbeat return `data.status`, including `REBINDS_REQUIRED`.

No command-polling or command-channel transport is invented here: `run` establishes a session, heartbeats, and flushes already durable ACKs. An API-owned command channel contract is required before it can consume commands or execute F01/E05 work.
