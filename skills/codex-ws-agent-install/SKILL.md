---
name: codex-ws-agent-install
description: Install the latest unified multi-Agent Runtime artifact from this repository, with pinned toolchain and explicit installation/configuration boundaries. The old codex-ws-agent service/API-key provisioning entry is retired.
---

# Unified Agent Runtime installation

The skill name is a repository discovery label, not a legacy execution alias.
The only current installer is `shell/cyf_agent_runtime_v1_install.sh` (dispatcher
component `cyf-agent-runtime-v1`, alias `runtime-v1`, profile `agent`).
See `conf/cyf-agent-runtime-v1/README.md` for the actual configuration and recovery
contract. Do not install or launch the retired engine CLI/service.

## Preconditions and staging

- Fix the authorized source commit and source/artifact evidence. This candidate is
  not release approval; formal verification and versioned release belong to Main.
- Supply Node **20.20.2**, an npm CLI and compatible Python/stdlib/ABI. Do not upgrade
  the host's generic Node as an implicit Agent installation step.
- Prepare a canonical artifact parent and choose a new explicit instance; existing
  targets are rejected, never adopted. Set `CYF_RUNTIME_V1_INSTANCE`,
  `CYF_RUNTIME_V1_NODE_BIN`, `CYF_RUNTIME_V1_NPM_CLI`, `CYF_RUNTIME_V1_PYTHON_BIN`
  and `ISP_APPS` deliberately for the intended offline/disposable target.
- The direct entry stages one artifact: `runtime/`, execution library,
  pinned local Node, locked npm graph and Python delivery tools. It neither enrolls
  identities nor copies old env/profiles, enables units, restarts services or
  migrates state. Dispatcher profile `agent` selects this same artifact entry.

```bash
# Only on an explicitly authorized target with the prerequisites above:
./shell/cyf_agent_runtime_v1_install.sh
# Alternative dispatcher (same entry, no extra legacy component):
./install.sh --profile agent
```

## Configuration and authorization are separate

Use an explicit external host JSON with sealed manifest/profile/state paths for
**each full subject** (tenant/client/canonicalAgentId); persona names do not grant
permission. Reject identity/installation duplication and overlapping/symlink
writable roots. Each Agent gets independent installation enrollment, derived
in-memory session, queue, workspace and model-provider environment. Never use an
old Agent API key or profile as enrollment evidence or copy a template credential
across Agents. Model/provider auth is not Runtime execution auth.

Run the artifact's `runtime/validate.sh --root ARTIFACT --config HOST_JSON` for
local validation. Execution uses only `ARTIFACT/node/bin/node
ARTIFACT/runtime/agent-runtime.mjs run --config HOST_JSON` and the current
`cyf-agent-runtime-v1@.service` template. Neither this skill nor the installer grants
service activation, deployment, enrollment or historical maintenance authorization.

## State and recovery safeguards

Preserve existing workspace policies/trusted repositories and their locks. ACK
confirmation is matching Runtime HTTP D06 status/version, not successful WS send;
CHAT/results keep their own dedicated receipts. Unknown STARTED/native/business
outcomes retain recovery materials and never auto-rerun. No automatic workspace
archive, paid replay or queue clearing. Inventory all dynamic/shared identities
and stop exact writers only under separate maintenance authorization. Migration
and rollback must cover code, state format, identity mappings and unknown outcomes;
old/new writers cannot run together and binary-only rollback is unsafe. Source-only
removal of old unit templates does not remove any installed service.
