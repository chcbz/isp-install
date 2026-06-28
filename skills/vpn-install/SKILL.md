---
name: vpn-install
description: Use when installing the repository's legacy IPsec/L2TP VPN stack based on the bundled hwdsl2 script, mainly for RHEL-style hosts that explicitly need this workflow.
---

# VPN Install

## Command

- Direct install: `sudo ./shell/vpn_install.sh`
- Via component mapping: `sudo ./install.sh vpn`

## Notes

- This is a legacy script derived from hwdsl2 and is mainly for explicit compatibility cases.
- Review the script before use on modern hosts because it changes firewall, services, and kernel settings.

## Verify

- Confirm `ipsec` and `xl2tpd` are running
- Validate the generated VPN credentials on the target host
