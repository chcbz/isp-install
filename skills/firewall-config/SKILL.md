---
name: firewall-config
description: Use when opening, listing, or reviewing firewall ports for components installed by this repository through shell/firewall.sh service aliases.
---

# Firewall Config

Use this skill after installing a network-facing service.

## Commands

- List supported aliases: `sudo ./shell/firewall.sh services`
- Open a service: `sudo ./shell/firewall.sh open nginx`
- Show active rules: `sudo ./shell/firewall.sh list`

## Typical aliases

- `nginx`
- `mysql`
- `redis`
- other services exposed by `shell/firewall.sh services`

## Workflow

1. Install the target service first.
2. Open only the required aliases.
3. Re-check service status after changing rules.

## Verify

- Run `sudo ./shell/firewall.sh list`.
- Test connectivity from another host if the service should be public.
