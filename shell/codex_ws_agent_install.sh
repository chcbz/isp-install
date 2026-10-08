#!/bin/bash
# Retired entrypoint: fail before reading configuration or changing any host state.
# Do not source common.sh, adopt profiles, enroll identities or control old services.
printf '%s\n' 'UNIFIED_RUNTIME_ENTRY_REQUIRED: codex-ws-agent installation/provisioning is retired. Use shell/cyf_agent_runtime_v1_install.sh for a new artifact and explicit sealed multi-Agent configuration; historical credentials/state are not adopted.' >&2
exit 2
