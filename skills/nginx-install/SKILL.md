---
name: nginx-install
description: Use when installing Nginx with this repository, including service helper usage, systemd integration, and optional vhost template deployment from conf/nginx.
---

# Nginx Install

## Command

- Direct install: `sudo ./shell/nginx_install.sh`
- Via profile: `sudo ./install.sh nginx`

## Config locations

- Main templates: `conf/nginx/conf/nginx.conf`
- Example vhosts: `conf/nginx/conf/vhost/`
- Helper script: `/home/isp/bin/nginx.sh`

## Workflow

1. Install Nginx.
2. Copy or adapt templates from `conf/nginx`.
3. Enable `systemd/nginx.service` for managed startup.

## Verify

- `/home/isp/bin/nginx.sh status`
- `systemctl status nginx`
