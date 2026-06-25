# Repository Guidelines

## Project Structure & Module Organization

This repository is a Linux server deployment toolkit. The main entrypoint is `install.sh`, which maps component names to scripts in `shell/`.

- `shell/`: install scripts, usually named `<component>_install.sh`.
- `shell/common.sh`: shared OS detection, package install, download, directory, and service helpers.
- `bin/`: service management scripts copied to `/home/isp/bin`.
- `conf/`: configuration templates copied into `/home/isp/apps/<component>` or service-specific paths.
- `systemd/`: unit files for services managed by `systemctl`.
- `docs/`: design notes and optimization history.

There is no dedicated test directory; validation is script syntax checks plus targeted install verification.

## Build, Test, and Development Commands

- `bash -n install.sh shell/*.sh bin/*.sh`: check Bash syntax before committing.
- `./install.sh --list`: show available profiles and components.
- `sudo ./install.sh <component>`: install one component, such as `nginx`.
- `sudo ./install.sh --profile agent`: install the Codex WebSocket Agent profile.
- `sudo ./shell/firewall.sh services`: list firewall service aliases.

Run host-changing commands only on a disposable VM or intended target host.

## Coding Style & Naming Conventions

Use Bash for install and management scripts. Follow the existing style: `#!/bin/bash`, section banners, uppercase path constants, lowercase function names, and consistent indentation within each file. Source `shell/common.sh` instead of duplicating OS/package/user helpers.

Name new install scripts as `shell/<component>_install.sh`, service scripts as `bin/<component>.sh`, and systemd units as `systemd/<component>.service`. Keep templates under `conf/<component>/`.

## Testing Guidelines

At minimum, run `bash -n` on every changed shell script. For scripts using templates, verify required files exist and paths match `/home/isp/apps`, `/home/isp/bin`, and `/home/isp/pkgs`. If a component has a validation command, run it directly; for example, use `node agent-client.mjs --validate`.

Document any manual install test in the PR, including OS version and whether the service started successfully.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries, often with prefixes such as `docs:`, `chore:`, or `upgrade:`. Keep messages concise, for example `docs: update nginx install notes` or `upgrade: bump JDK to 21.0.10 LTS`.

Pull requests should include the affected component, tested OS, commands run, and any required environment variables. Link related issues when available. For service changes, include `systemctl status <service>` output or a short verification summary.

## Security & Configuration Tips

Do not commit real passwords, API keys, host-specific `.env` files, or private Codex homes. Use placeholders in `conf/` templates and document required variables in `README.md`.
