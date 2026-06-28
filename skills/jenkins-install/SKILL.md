---
name: jenkins-install
description: Use when installing Jenkins with this repository, including JDK dependency checks, plugin bootstrap, helper script creation, and service verification.
---

# Jenkins Install

## Preconditions

- JDK is installed and Java is version 11 or newer

## Command

- Direct install: `sudo ./shell/jenkins_install.sh`
- Via profile: `sudo ./install.sh jenkins`

## Output

- Installs Jenkins 2.440.1 to `/home/isp/apps/jenkins`
- Prepares logs, workspace, and plugin directories
- Creates `/home/isp/bin/jenkins.sh`

## Verify

- `/home/isp/bin/jenkins.sh status`
- `systemctl status jenkins`
