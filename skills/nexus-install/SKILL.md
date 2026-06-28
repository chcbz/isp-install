---
name: nexus-install
description: Use when installing Sonatype Nexus with this repository, including JDK dependency handling, service user setup, and post-install status checks.
---

# Nexus Install

## Preconditions

- JDK is installed

## Command

- Direct install: `sudo ./shell/nexus_install.sh`
- Via profile: `sudo ./install.sh nexus`

## Output

- Installs Nexus 3.66.0-02 to `/home/isp/apps/nexus`
- Prepares runtime user and directories expected by the service
- Works with `systemd/nexus` patterns used by the repo

## Verify

- Check the Nexus process after install
- Enable and inspect the service if you add a unit on the target host
