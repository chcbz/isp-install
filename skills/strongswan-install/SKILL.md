---
name: strongswan-install
description: Use when installing the repository's StrongSwan-based IKEv2 VPN workflow, including VPN secret handling and interactive certificate/network prompts.
---

# StrongSwan Install

## Command

- Direct install: `sudo ./shell/strongswan_install.sh`
- Via component mapping: `sudo ./install.sh strongswan`

## Required secrets

- `VPN_PSK`
- `VPN_XAUTH_PASS`
- `VPN_EAP_USER`
- `VPN_EAP_PASS`

## Notes

- This script is interactive and asks about public IP, certificates, NAT, and firewall rules.
- Use it only when StrongSwan is the intended VPN stack.

## Verify

- Confirm `ipsec` service health
- Confirm generated client certificate artifacts if that path was selected
