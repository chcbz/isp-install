#!/bin/bash
# Validate the single Runtime/engine/toolchain artifact without execution or network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG=''
while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || { echo 'validate requires key/value arguments' >&2; exit 2; }
    case "$1" in
        --root) PACKAGE_ROOT="$2" ;;
        --config) CONFIG="$2" ;;
        *) echo 'usage: validate.sh [--root ARTIFACT_ROOT] [--config HOST_CONFIG]' >&2; exit 2 ;;
    esac
    shift 2
done
[ -d "$PACKAGE_ROOT" ] && [ "$(readlink -f "$PACKAGE_ROOT")" = "$PACKAGE_ROOT" ] || { echo 'Runtime artifact root must be canonical' >&2; exit 1; }
NODE_BIN="$PACKAGE_ROOT/node/bin/node"
[ -x "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] || { echo 'Artifact-local Node is missing or unsafe' >&2; exit 1; }
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
printf 'Runtime Node version: %s\n' "$NODE_VERSION"
for file in agent-runtime.mjs install.sh validate.sh package.json runtime.env.example manifest.example.json \
    lib/manifest.mjs lib/runtime-client.mjs lib/security.mjs lib/runtime-host.mjs lib/execution-adapter.mjs \
    systemd/cyf-agent-runtime-v1@.service; do
    [ -f "$PACKAGE_ROOT/runtime/$file" ] && [ ! -L "$PACKAGE_ROOT/runtime/$file" ] \
        && [ "$(readlink -f "$PACKAGE_ROOT/runtime/$file")" = "$PACKAGE_ROOT/runtime/$file" ] || {
        echo "Runtime payload is missing or unsafe: $file" >&2; exit 1;
    }
done
for private in .env runtime.env runtime/.env runtime/runtime.env; do
    [ ! -e "$PACKAGE_ROOT/$private" ] && [ ! -L "$PACKAGE_ROOT/$private" ] || { echo 'Runtime artifact contains private environment' >&2; exit 1; }
done
"$NODE_BIN" --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  const { validateExecutionPayload } = await import(pathToFileURL(process.argv[1]));
  await validateExecutionPayload(process.argv[2]);
' "$PACKAGE_ROOT/runtime/lib/execution-adapter.mjs" "$PACKAGE_ROOT/codex-ws-agent"
# A healthy Python import does not validate relocated generated CLI launchers.
# Reject stale staging paths in launchers/activation/config without importing
# host modules, activating the venv or running a retired authentication entry.
"$PACKAGE_ROOT/codex-ws-agent/.toolchain/bin/python" -I -S -B - "$PACKAGE_ROOT" <<'PY_RUNTIME_LAUNCHER_VALIDATE'
import os, sys
venv = os.path.join(sys.argv[1], 'codex-ws-agent', '.toolchain')
paths = [os.path.join(venv, 'pyvenv.cfg')]
paths.extend(os.path.join(venv, 'bin', name) for name in os.listdir(os.path.join(venv, 'bin')))
for path in paths:
    if os.path.islink(path):
        assert '.cyf-agent-runtime.stage.' not in os.readlink(path), 'VENV_STALE_STAGE_SYMLINK'
    elif os.path.isfile(path):
        with open(path, 'rb') as stream: data = stream.read()
        if path.endswith('/pyvenv.cfg') or data.startswith(b'#!') or os.path.basename(path) in ('activate', 'activate.csh', 'activate.fish'):
            assert b'.cyf-agent-runtime.stage.' not in data, 'VENV_STALE_STAGE_LAUNCHER_OR_ACTIVATION'
print('Runtime venv launchers contain no staging references')
PY_RUNTIME_LAUNCHER_VALIDATE
# The import must resolve from this artifact, never a globally installed engine.
# An eval argument is argv[1], not a main module: pass the root so importing the
# engine cannot be mistaken for its retired standalone CLI by the main guard.
"$NODE_BIN" --input-type=module -e '
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const engine = await import(pathToFileURL(resolve(process.argv[1], "codex-ws-agent/agent-client.mjs")));
  if (typeof engine.createRuntimeExecutionHost !== "function") throw new Error("Runtime execution host export is missing");
' "$PACKAGE_ROOT"
if [ -n "$CONFIG" ]; then
    "$NODE_BIN" "$PACKAGE_ROOT/runtime/agent-runtime.mjs" validate --config "$CONFIG" >/dev/null
fi
printf '%s\n' "Runtime artifact closure validation passed: $PACKAGE_ROOT"
