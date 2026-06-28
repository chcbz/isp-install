---
name: git-install
description: Use when installing Git from source with this repository, including default git config prompts, command aliases, and environment setup.
---

# Git Install

## Command

- Direct install: `sudo ./shell/git_install.sh`
- Via profile: `sudo ./install.sh git`

## Inputs

- The script may prompt for `user.name` and `user.email` if not already configured.

## Output

- Installs Git 2.53.0 to `/home/isp/apps/git`
- Creates `/usr/local/bin/git`
- Applies base config and aliases for the current machine

## Verify

- `git --version`
- `git config --global --list`
