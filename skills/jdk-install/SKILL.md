---
name: jdk-install
description: Use when installing the repository's JDK runtime with shell/jdk_install.sh, including JAVA_HOME setup for tools such as Maven, Jenkins, Nexus, and Elasticsearch.
---

# JDK Install

## Command

- Direct install: `sudo ./shell/jdk_install.sh`
- Via profile: `sudo ./install.sh jdk`

## Output

- Installs JDK 21.0.10 to `/home/isp/apps/java`
- Appends `JAVA_HOME` and `PATH` entries to `/etc/profile`

## Workflow

1. Run `sudo ./shell/init.sh` on fresh hosts.
2. Install JDK before `maven`, `jenkins`, `nexus`, or `elasticsearch`.
3. Reload the shell with `source /etc/profile` if the current session needs `java`.

## Verify

- `java -version`
- `test -x /home/isp/apps/java/bin/java`
