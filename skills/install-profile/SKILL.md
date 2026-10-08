---
name: install-profile
description: Use when the task is to install one or more components from this repository through install.sh profiles or direct component names, including quick mapping from user intent to the right ./install.sh command.
---

# Install Profile

Use this skill when the user wants a grouped install instead of a single tool script.

## Commands

- List available profiles and components: `sudo ./install.sh --list`
- Interactive mode: `sudo ./install.sh --select`
- Install a profile: `sudo ./install.sh --profile web-server`
- Install a component directly: `sudo ./install.sh nginx`

## Built-in profiles

- `web-server`: `nginx php mysql redis`
- `dev-env`: `jdk maven git node python`
- `db-server`: `mysql redis rabbitmq`
- `ci-cd`: `jdk maven git jenkins nexus`
- `agent`: `cyf-agent-runtime-v1` (single unified Runtime artifact; explicit instance and Node 20.20.2, no generic Node upgrade)
- `full`: installs the full supported stack

## Workflow

1. Run `sudo ./shell/init.sh` on a fresh server.
2. Pick the smallest matching profile or component list.
3. Export any required secrets before install, such as `MYSQL_ROOT_PASSWORD`. For Agents, installation enrollment is an explicit separate operation; execution uses only installation-derived AgentRuntime sessions, never an old Agent API key.
4. After install, apply the matching `systemd/*.service` units if the component provides one, only under its separate activation authorization. Agent artifact staging does not enable or restart a service.

## Unified Agent entry

Use `./install.sh cyf-agent-runtime-v1` (alias `runtime-v1`),
`./install.sh --profile agent`, or `./shell/cyf_agent_runtime_v1_install.sh`.
Prepare a new canonical artifact target parent, set `CYF_RUNTIME_V1_INSTANCE`,
and supply pinned Node **20.20.2**, npm and compatible Python via the Runtime
installer variables. No existing target, old env/profile or credential is adopted.

See `conf/cyf-agent-runtime-v1/README.md` and
`skills/codex-ws-agent-install/SKILL.md` for explicit sealed multi-Agent config and
per-subject private roots. Execution is the artifact-local pinned Node plus
`runtime/agent-runtime.mjs run --config HOST_JSON`, not an old launcher alias.
Installation credentials remain private; derived execution sessions stay in memory
and never appear in URL/log/checkpoint. Enrollment, state migration, activation,
versioned release and any online operation need their own exact authorization.

## Verify

- Re-run `sudo ./install.sh --list` if mapping is unclear.
- Check component-specific verification commands in the matching skill.
