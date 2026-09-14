#!/bin/bash
# Install one sealed Runtime v1 package without starting any service or touching codex-ws-agent.
set -euo pipefail

usage() {
    echo "usage: install.sh --target ABSOLUTE_DIRECTORY --manifest ABSOLUTE_MANIFEST [--node NODE]" >&2
    exit 2
}

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=""
MANIFEST=""
NODE_BIN="${CYF_RUNTIME_V1_NODE_BIN:-node}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --target) TARGET="${2:-}"; shift 2 ;;
        --manifest) MANIFEST="${2:-}"; shift 2 ;;
        --node) NODE_BIN="${2:-}"; shift 2 ;;
        *) usage ;;
    esac
done

case "$TARGET" in
    /*) ;;
    *) usage ;;
esac
case "$MANIFEST" in
    /*) ;;
    *) usage ;;
esac
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || { echo "Runtime v1 manifest must be a regular non-symlink file" >&2; exit 1; }
[ ! -e "$TARGET" ] || { echo "Runtime v1 target already exists; use a new installation directory" >&2; exit 1; }
PARENT="$(dirname "$TARGET")"
[ -d "$PARENT" ] && [ ! -L "$PARENT" ] || { echo "Runtime v1 target parent is invalid" >&2; exit 1; }

STAGE="$(mktemp -d "$PARENT/.cyf-agent-runtime-v1.stage.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
install -d -m 0755 "$STAGE" "$STAGE/lib" "$STAGE/systemd"
install -d -m 0700 "$STAGE/runtime-state"
install -m 0755 "$SOURCE_DIR/agent-runtime.mjs" "$SOURCE_DIR/install.sh" "$SOURCE_DIR/validate.sh" "$STAGE/"
install -m 0644 "$SOURCE_DIR/lib/manifest.mjs" "$SOURCE_DIR/lib/runtime-client.mjs" "$SOURCE_DIR/lib/security.mjs" "$STAGE/lib/"
install -m 0644 "$SOURCE_DIR/systemd/cyf-agent-runtime-v1@.service" "$STAGE/systemd/cyf-agent-runtime-v1@.service"
install -m 0644 "$SOURCE_DIR/package.json" "$SOURCE_DIR/README.md" "$SOURCE_DIR/runtime.env.example" \
    "$SOURCE_DIR/manifest.example.json" "$STAGE/"
install -m 0444 "$MANIFEST" "$STAGE/manifest.json"
"$STAGE/validate.sh" --root "$STAGE" --manifest "$STAGE/manifest.json" --node "$NODE_BIN"
mv "$STAGE" "$TARGET"
trap - EXIT
printf '%s\n' "Runtime v1 package installed without activation: $TARGET"
