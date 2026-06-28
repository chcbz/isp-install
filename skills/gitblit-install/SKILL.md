---
name: gitblit-install
description: Use when working with the repository's legacy Gitblit installer. This skill is for maintenance or migration tasks only because the script is marked for further optimization.
---

# Gitblit Install

Use this skill only when Gitblit is explicitly required.

## Command

- Direct install: `sudo ./shell/gitblit_install.sh`
- Via component mapping if present: `sudo ./install.sh gitblit`

## Notes

- The script is legacy and less standardized than the mainline installers.
- Prefer `git-install` for plain Git tooling unless the user specifically needs Gitblit.

## Verify

- Check the extracted app under `/home/isp/apps`
- Validate the runtime process and port manually on the target host
