---
name: rabbitmq-install
description: Use when installing RabbitMQ with this repository, including Erlang bootstrap, admin password handling, management plugin enablement, and service startup checks.
---

# RabbitMQ Install

## Command

- Direct install: `sudo ./shell/rabbitmq_install.sh`
- Via profile: `sudo ./install.sh rabbitmq`

## Required input

- Export `RABBITMQ_ADMIN_PASSWORD` first, or provide it interactively

## Output

- Installs Erlang 26.2.1 and RabbitMQ under `/home/isp/apps`
- Creates `/home/isp/bin/rabbitmq.sh`
- Enables the management plugin and creates the `admin` user

## Verify

- `/home/isp/bin/rabbitmq.sh status`
- `systemctl status rabbitmq`
- Access the management UI if the port is exposed
