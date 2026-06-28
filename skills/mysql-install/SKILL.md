---
name: mysql-install
description: Use when installing MySQL with this repository, including root password handling, config generation, local management script setup, and optional systemd registration.
---

# MySQL Install

## Command

- Direct install: `sudo ./shell/mysql_install.sh`
- Via profile: `sudo ./install.sh mysql`

## Required input

- Export `MYSQL_ROOT_PASSWORD` first, or provide it interactively when prompted

## Output

- Installs MySQL 8.0.45 to `/home/isp/apps/mysql`
- Writes config to `/home/isp/apps/mysql/my.cnf`
- Creates the local helper `/home/isp/bin/mysql.sh`

## Verify

- `/home/isp/bin/mysql.sh status`
- `test -S /home/isp/apps/mysql/mysql.sock`

## Notes

- Password is stored in `/home/isp/.config/mysql.pass`
- Enable `systemd/mysql.service` if the service should start on boot
