---
name: redis-install
description: Use when installing Redis with this repository, including compile-from-source setup, redis.conf generation, helper script creation, and optional password hardening.
---

# Redis Install

## Command

- Direct install: `sudo ./shell/redis_install.sh`
- Via profile: `sudo ./install.sh redis`

## Output

- Installs Redis 7.4.8 to `/home/isp/apps/redis`
- Writes config to `/home/isp/apps/redis/redis.conf`
- Creates helper `/home/isp/bin/redis.sh`

## Optional config

- Set `requirepass` in `/home/isp/apps/redis/redis.conf` if authentication is needed

## Verify

- `/home/isp/bin/redis.sh status`
- `test -f /home/isp/apps/redis/redis.pid`
