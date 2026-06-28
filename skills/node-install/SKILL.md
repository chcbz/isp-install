---
name: node-install
description: Use when installing Node.js with this repository, including optional NODE_VERSION selection, npm registry choice, and global tool setup for yarn, pnpm, and pm2.
---

# Node Install

## Command

- Direct install: `sudo ./shell/node_install.sh`
- Via profile: `sudo ./install.sh node`

## Inputs

- Optional `NODE_VERSION`, default `lts`
- Optional choice to use `npmmirror` during the interactive prompt

## Output

- Installs Node.js to `/home/isp/apps/nodejs`
- Creates `node`, `npm`, and `npx` symlinks in `/usr/local/bin`
- Installs global tools: `yarn`, `pnpm`, `pm2`

## Verify

- `node -v`
- `npm -v`
- `pm2 -v`
