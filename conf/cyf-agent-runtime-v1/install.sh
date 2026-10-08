#!/bin/bash
# Single artifact: pinned Node, Runtime, mature engine, locked JS deps and Python tools.
# No activation, state adoption, enrollment, service control or legacy .env copy.
set -euo pipefail
usage() {
    echo 'usage: install.sh --target ABSOLUTE_NEW_DIRECTORY [--node NODE20] [--npm NPM_CLI] [--python PYTHON3] [--engine-root ENGINE_SOURCE]' >&2
    exit 2
}
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET=''
NODE_BIN="${CYF_RUNTIME_V1_NODE_BIN:-node}"
NPM_CLI="${CYF_RUNTIME_V1_NPM_CLI:-npm}"
PYTHON_BIN="${CYF_RUNTIME_V1_PYTHON_BIN:-python3}"
ENGINE_ROOT="$(dirname "$SOURCE_DIR")/codex-ws-agent"
while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || usage
    case "$1" in
        --target) TARGET="$2" ;;
        --node) NODE_BIN="$2" ;;
        --npm) NPM_CLI="$2" ;;
        --python) PYTHON_BIN="$2" ;;
        --engine-root) ENGINE_ROOT="$2" ;;
        *) usage ;;
    esac
    shift 2
done
case "$TARGET" in /*) ;; *) usage ;; esac
[ "$(readlink -m "$TARGET")" = "$TARGET" ] || { echo 'Runtime target must be canonical' >&2; exit 1; }
[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo 'Runtime target exists; do not adopt or overwrite it' >&2; exit 1; }
PARENT="$(dirname "$TARGET")"
[ -d "$PARENT" ] && [ "$(readlink -f "$PARENT")" = "$PARENT" ] || { echo 'Runtime target parent must exist and be canonical' >&2; exit 1; }
resolve_bin() { command -v "$1" 2>/dev/null || true; }
NODE_BIN="$(resolve_bin "$NODE_BIN")"
NPM_CLI="$(resolve_bin "$NPM_CLI")"
PYTHON_BIN="$(resolve_bin "$PYTHON_BIN")"
[ -x "$NODE_BIN" ] && [ -f "$NPM_CLI" ] && [ -x "$PYTHON_BIN" ] || { echo 'Node/npm/Python toolchain unavailable' >&2; exit 1; }
[ "$("$NODE_BIN" -p 'process.versions.node')" = '20.20.2' ] || { echo 'Runtime requires pinned Node 20.20.2' >&2; exit 1; }
STAGE="$(mktemp -d "$PARENT/.cyf-agent-runtime.stage.XXXXXX")"
# STAGE is exclusively created above. Never delete a pre-existing target.
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT
install -d -m 0755 "$STAGE/runtime/lib" "$STAGE/runtime/systemd" "$STAGE/node/bin"
install -m 0755 "$(readlink -f "$NODE_BIN")" "$STAGE/node/bin/node"
for file in agent-runtime.mjs install.sh validate.sh; do
    install -m 0755 "$SOURCE_DIR/$file" "$STAGE/runtime/$file"
done
for file in package.json runtime.env.example manifest.example.json lib/manifest.mjs lib/runtime-client.mjs \
    lib/security.mjs lib/runtime-host.mjs lib/execution-adapter.mjs systemd/cyf-agent-runtime-v1@.service; do
    install -m 0644 "$SOURCE_DIR/$file" "$STAGE/runtime/$file"
done
"$STAGE/node/bin/node" --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  const { collateExecutionPayload } = await import(pathToFileURL(process.argv[1]));
  await collateExecutionPayload(process.argv[2], process.argv[3]);
' "$SOURCE_DIR/lib/execution-adapter.mjs" "$ENGINE_ROOT" "$STAGE/codex-ws-agent"
# Fixed lockfile, no install scripts, no host/global npm installation.
(cd "$STAGE/codex-ws-agent" && "$STAGE/node/bin/node" "$(readlink -f "$NPM_CLI")" ci --ignore-scripts --no-audit --no-fund)
"$PYTHON_BIN" -m venv --copies "$STAGE/codex-ws-agent/.toolchain"
"$STAGE/codex-ws-agent/.toolchain/bin/python" -m pip install --disable-pip-version-check --no-input --no-cache-dir --upgrade 'pip<22'
"$STAGE/codex-ws-agent/.toolchain/bin/python" -m pip install --disable-pip-version-check --no-input --no-cache-dir \
    -r "$STAGE/codex-ws-agent/toolchain/requirements.txt"
"$STAGE/runtime/validate.sh" --root "$STAGE"
# Do not let a competing operator install be overwritten between preflight and publication.
[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo 'Runtime target appeared during staging' >&2; exit 1; }
mv -T -n "$STAGE" "$TARGET"
[ ! -d "$STAGE" ] || { echo 'Runtime target publication lost ownership' >&2; exit 1; }
trap - EXIT
"$TARGET/runtime/validate.sh" --root "$TARGET"
printf '%s\n' "Runtime artifact installed without activation: $TARGET"
