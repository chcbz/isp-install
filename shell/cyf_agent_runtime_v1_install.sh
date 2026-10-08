#!/bin/bash
# Single Runtime artifact installer. No activation or service-manager mutation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
INSTANCE="${CYF_RUNTIME_V1_INSTANCE:-}"
[[ "$INSTANCE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo 'CYF_RUNTIME_V1_INSTANCE must be a safe non-empty instance name' >&2; exit 1; }
APP_ROOT="${ISP_APPS:-/home/isp/apps}/cyf-agent-runtime-v1"
if [ "${CYF_RUNTIME_V1_INSTALL_TEST_MODE:-0}" = '1' ]; then
    [ -n "${CYF_RUNTIME_V1_TEST_APP_ROOT:-}" ] || { echo 'Explicit fixture app root required' >&2; exit 1; }
    APP_ROOT="$CYF_RUNTIME_V1_TEST_APP_ROOT/cyf-agent-runtime-v1"
fi
[ -d "$APP_ROOT" ] && [ "$(readlink -f "$APP_ROOT")" = "$APP_ROOT" ] || { echo 'Operator must create canonical artifact parent first' >&2; exit 1; }
exec "$ROOT_DIR/conf/cyf-agent-runtime-v1/install.sh" --target "$APP_ROOT/$INSTANCE" \
    --node "${CYF_RUNTIME_V1_NODE_BIN:-node}" --npm "${CYF_RUNTIME_V1_NPM_CLI:-npm}" --python "${CYF_RUNTIME_V1_PYTHON_BIN:-python3}"
