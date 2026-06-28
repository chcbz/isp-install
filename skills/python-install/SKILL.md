---
name: python-install
description: Use when installing Python 3 from source with this repository, including pip bootstrap, virtualenv setup, and PATH/LD_LIBRARY_PATH configuration.
---

# Python Install

## Command

- Direct install: `sudo ./shell/python_install.sh`
- Via profile: `sudo ./install.sh python`

## Output

- Installs Python 3.12.13 to `/home/isp/apps/python3`
- Adds `python`, `pip`, and shared library paths to `/etc/profile`
- Upgrades `pip` and installs `virtualenv` and `requests`

## Verify

- `python --version`
- `pip --version`
- `test -x /home/isp/apps/python3/bin/python`
