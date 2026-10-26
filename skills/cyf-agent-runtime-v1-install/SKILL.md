---
name: cyf-agent-runtime-v1-install
description: Prepare and validate the unified CYF multi-Agent Runtime artifact, hand off self-host installation enrollment, and perform explicitly authorized upgrades using existing identity and service ownership.
---

# CYF Unified Runtime Install / Upgrade

核对2026-10-12；Runtime1.0.3基线807b86d。**先完整阅读仓内 `docs/cyf-agent-runtime-v1-self-host.md`**，它是首次接入/已有Runtime升级的操作入口，不再使用旧 API Key 文书。

## Boundaries

- Installer prepares a fresh canonical artifact only. It does not install a systemd unit, enable/start services, enroll, adopt old `.env`, migrate state, or create an API installation.
- Node has no project version allowlist. Record actual Node/npm/Python/platform and verify complete private dependencies; do not substitute globally installed Python packages.
- Determine the exact subject, host, service user, unit/drop-ins and existing installation first. A persona name or old API key is not authority. Existing Runtime upgrades preserve manifest, installation, credentials and state; do not re-enroll.
- First migration from the old client may need installation registration: target generates manifest/one-time secret, owner JWT registers only public digest request, then target enrolls. Do not wait for a nonexistent backend manifest-signing operation.
- Never log/copy enrollment secrets, installation/session credentials, provider credentials, or user JWT into chat/browser/source. Only `handoff.json` (scope + digest request) goes to the user's self-host onboarding page.
- Shared Runtime changes affect all subjects. Require actual service-change authorization and address active/unknown tasks; preserve backups, identity/ACL and single-writer locks. Do not import/replay legacy queues or build compatibility paths.

## Existing executable entrypoints

```bash
# Operator creates and owns the canonical artifact parent first.
# Set explicit tool paths when defaults do not match the target platform.
CYF_RUNTIME_V1_INSTANCE=<new-safe-instance> \
CYF_RUNTIME_V1_NODE_BIN=<node> CYF_RUNTIME_V1_NPM_CLI=<npm> \
CYF_RUNTIME_V1_PYTHON_BIN=<python3.11> \
bash ./shell/cyf_agent_runtime_v1_install.sh

# Offline first-install enrollment preparation, never service activation:
node ./shell/cyf_runtime_enrollment_prepare.mjs \
  --tenant-id <trusted-tenant> --client-id <trusted-client> --agent-id <canonical-agent> \
  --output <new-absolute-private-directory> --expires-at <future-epoch-milliseconds>

# Use artifact-local Node and an actual host.json, not --manifest.
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" validate --config "$HOST_CONFIG"
"$ARTIFACT/runtime/validate.sh" --root "$ARTIFACT" --config "$HOST_CONFIG"
# Only after authorized registration, and only for first enrollment:
CYF_RUNTIME_V1_API_BASE_URL="$API_ORIGIN" \
CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE="$SECRET_FILE" \
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" enroll --config "$HOST_CONFIG" --subject "$SUBJECT_KEY"
```

Preparation creates manifest, private secret, six-field API request, public handoff and subject key. Existing output is rejected. The manifest digest has a `sha256:` prefix; the API request digests do not. Register via existing owner-JWT `POST /agent/runtime/v1/installations`, query the same ID after an ambiguous response; do not retry creation blindly. ACTIVE does not mean online or business-accepted.

Configuration belongs outside artifacts under `/home/isp/conf/cyf-agent-runtime-v1`, persistent state under `/home/isp/state/cyf-agent-runtime-v1`; use real authorized paths on other hosts. Runtime files must belong to the runtime UID. Shipped systemd template uses root and canonical `/home/isp/apps` paths; nonroot/alternate paths require a deliberate unit/drop-in, not blind enable.

Runtime is a real execution host (sessions, transports, per-Agent queues and execution adapter), not a heartbeat-only sidecar. Text/image readiness is separately configured and verified. Managed hosting profiles are not the same as ordinary self-host native-file profiles. After activation verify online identity, conversation and a new item's actual downloadable deliverable/acceptance; image costs require separate permission.

Follow the guide's explicit preparation → owner registration → configuration → validate → enroll → authorized service switch → business acceptance sequence. If the page still instructs API Key/codex-bridge, report that its release is pending; never silently follow the obsolete flow.

## Unified layout / existing HOME relocation

Follow guide §9 for an explicitly authorized existing-Runtime path migration. New HOME is `state/cyf-agent-runtime-v1/<instance>/agents/<subject>/codex-home`; config/policy/model catalog stay in `conf/cyf-agent-runtime-v1`. Preserve each subject's complete HOME and current SQLite path indexes, with stopped-writer backup of DB/WAL/SHM and verified inverse-path recovery. Do not re-enroll, adopt someone else's credentials, rewrite transcripts, import legacy queues, create compatibility links or silently migrate in the artifact installer. Retire old units/scripts/directories only after zero live references and current capability readback. Keep internal `codex-bridge/` library intact. Validate with the service's actual provider/policy environment paths.
