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
- `agent`: `node codex-ws-agent`
- `full`: installs the full supported stack

## Workflow

1. Run `sudo ./shell/init.sh` on a fresh server.
2. Pick the smallest matching profile or component list.
3. Export any required secrets before install, such as `MYSQL_ROOT_PASSWORD` or `OPENCLAW_API_KEY`.
4. After install, apply the matching `systemd/*.service` units if the component provides one.

## Verify

- Re-run `sudo ./install.sh --list` if mapping is unclear.
- Check component-specific verification commands in the matching skill.
