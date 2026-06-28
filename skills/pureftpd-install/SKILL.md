---
name: pureftpd-install
description: Use when installing Pure-FTPd with this repository, including TLS certificate generation, config file creation, helper script setup, and FTP runtime verification.
---

# Pure-FTPd Install

## Command

- Direct install: `sudo ./shell/pureftpd_install.sh`
- Via profile: `sudo ./install.sh pureftpd`

## Output

- Installs Pure-FTPd 1.0.53 to `/home/isp/apps/pureftpd`
- Writes config to `/home/isp/apps/pureftpd/etc/pure-ftpd.conf`
- Generates a self-signed cert at `/home/isp/apps/pureftpd/etc/ssl/pure-ftpd.pem` if missing

## Verify

- `/home/isp/bin/pureftpd.sh status`
- Check FTP and passive port reachability if exposed externally
