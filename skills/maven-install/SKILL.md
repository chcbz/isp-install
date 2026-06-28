---
name: maven-install
description: Use when installing Apache Maven with this repository, including dependency on JDK, default settings.xml generation, and optional Nexus or FTP credential wiring through environment variables.
---

# Maven Install

## Preconditions

- JDK is installed and working.

## Command

- Direct install: `sudo ./shell/maven_install.sh`
- Via profile: `sudo ./install.sh maven`

## Config

- Install path: `/home/isp/apps/maven`
- Main config: `/home/isp/apps/maven/conf/settings.xml`
- Optional secrets: `NEXUS_PASSWORD`, `FTP_USERNAME`, `FTP_PASSWORD`

## Workflow

1. Install JDK first.
2. Export repository credentials if Maven should publish to Nexus or FTP.
3. Run the install command.

## Verify

- `mvn --version`
- Review `/home/isp/apps/maven/conf/settings.xml`
