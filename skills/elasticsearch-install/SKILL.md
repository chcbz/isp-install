---
name: elasticsearch-install
description: Use when installing Elasticsearch with this repository, including JDK dependency handling, IK plugin installation, data and log directory setup, and service validation.
---

# Elasticsearch Install

## Preconditions

- JDK is installed

## Command

- Direct install: `sudo ./shell/elasticsearch_install.sh`
- Via profile: `sudo ./install.sh elasticsearch`

## Output

- Installs Elasticsearch 8.12.2 to `/home/isp/apps/elasticsearch`
- Installs the IK plugin matching the Elasticsearch version
- Creates data and log directories under the app home

## Verify

- `/home/isp/bin/elasticsearch.sh status`
- `systemctl status elasticsearch`
