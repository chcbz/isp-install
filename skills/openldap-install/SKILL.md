---
name: openldap-install
description: Use when installing OpenLDAP with this repository, including schema deployment, config file paths, and service startup validation.
---

# OpenLDAP Install

## Command

- Direct install: `sudo ./shell/openldap_install.sh`
- Via profile: `sudo ./install.sh openldap`

## Config templates

- `conf/openldap/etc/openldap/slapd.conf`
- `conf/openldap/etc/openldap/ldap.conf`
- `conf/openldap/etc/openldap/schema/`

## Verify

- `systemctl status openldap`
- Confirm `slapd` is listening after startup
