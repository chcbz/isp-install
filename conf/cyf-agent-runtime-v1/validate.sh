#!/bin/bash
# Offline integrity validation for one CYF Agent Runtime v1 package directory.
set -euo pipefail

usage() {
    echo "usage: validate.sh [--root PACKAGE_ROOT] [--manifest MANIFEST] [--node NODE]" >&2
    exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$SCRIPT_DIR"
MANIFEST=""
NODE_BIN="${CYF_RUNTIME_V1_NODE_BIN:-node}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --root) PACKAGE_ROOT="${2:-}"; shift 2 ;;
        --manifest) MANIFEST="${2:-}"; shift 2 ;;
        --node) NODE_BIN="${2:-}"; shift 2 ;;
        *) usage ;;
    esac
done

[ -n "$PACKAGE_ROOT" ] && [ -d "$PACKAGE_ROOT" ] || { echo "Runtime v1 package root is invalid" >&2; exit 1; }
PACKAGE_ROOT="$(cd "$PACKAGE_ROOT" && pwd -P)"
if [ -z "$MANIFEST" ]; then
    if [ -f "$PACKAGE_ROOT/manifest.json" ]; then
        MANIFEST="$PACKAGE_ROOT/manifest.json"
    else
        MANIFEST="$PACKAGE_ROOT/manifest.example.json"
    fi
fi
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || { echo "Runtime v1 manifest must be a regular non-symlink file" >&2; exit 1; }

for file in agent-runtime.mjs install.sh validate.sh package.json README.md runtime.env.example manifest.example.json \
    lib/manifest.mjs lib/runtime-client.mjs lib/security.mjs \
    systemd/cyf-agent-runtime-v1@.service; do
    [ -f "$PACKAGE_ROOT/$file" ] && [ ! -L "$PACKAGE_ROOT/$file" ] || {
        echo "Runtime v1 package file is missing or unsafe: $file" >&2
        exit 1
    }
done
[ ! -e "$PACKAGE_ROOT/.env" ] || { echo "Runtime v1 package must not contain .env" >&2; exit 1; }
[ ! -e "$PACKAGE_ROOT/runtime.env" ] || { echo "Runtime v1 package must not contain runtime.env" >&2; exit 1; }

mode="$(stat -c '%a' "$MANIFEST")"
case "$mode" in
    ???) ;;
    *) echo "Runtime v1 manifest permissions are unreadable" >&2; exit 1 ;;
esac
# Group/world write access makes the scope-bound manifest mutable after delivery.
if [ $((8#${mode:1:1} & 2)) -ne 0 ] || [ $((8#${mode:2:1} & 2)) -ne 0 ]; then
    echo "Runtime v1 manifest must not be group/world writable" >&2
    exit 1
fi

[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v "$NODE_BIN" 2>/dev/null || true)"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "Node 20 executable not found" >&2; exit 1; }
major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$major" = "20" ] || { echo "Runtime v1 requires Node 20" >&2; exit 1; }
"$NODE_BIN" "$PACKAGE_ROOT/agent-runtime.mjs" validate --manifest "$MANIFEST" >/dev/null
printf '%s\n' "Runtime v1 package validation passed: $PACKAGE_ROOT"
