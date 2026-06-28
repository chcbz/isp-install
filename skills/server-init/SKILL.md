---
name: server-init
description: Use when preparing a fresh Linux server for this repository before component installation, especially for package tools, base directories, users, and environment readiness via shell/init.sh.
---

# Server Init

Use this skill before the first component install on a new host.

## Command

- Initialize the server: `sudo ./shell/init.sh`

## What it prepares

- Base directories under `/home/isp`
- Shared runtime assumptions used by `shell/common.sh`
- Package manager prerequisites for later install scripts

## Workflow

1. Confirm the host is a supported distro from `README.md`.
2. Run `sudo ./shell/init.sh`.
3. Continue with either `sudo ./install.sh --profile <name>` or an individual install script.

## Verify

- Confirm `/home/isp/apps`, `/home/isp/bin`, and `/home/isp/pkgs` exist.
- Continue with one component install to validate the environment.
