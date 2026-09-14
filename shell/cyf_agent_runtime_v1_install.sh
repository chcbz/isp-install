#!/bin/bash
#===============================================================
# CYF Agent Runtime v1 parallel package installer
#===============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

APP_NAME="cyf-agent-runtime-v1"
INSTANCE="${CYF_RUNTIME_V1_INSTANCE:-}"
if [ "${CYF_RUNTIME_V1_INSTALL_TEST_MODE:-0}" = "1" ] && [ -n "${CYF_RUNTIME_V1_TEST_APP_ROOT:-}" ]; then
    APP_ROOT="${CYF_RUNTIME_V1_TEST_APP_ROOT}/$APP_NAME"
else
    APP_ROOT="${ISP_APPS:-/home/isp/apps}/$APP_NAME"
fi
APP_HOME=""
CONF_SRC="$ROOT_DIR/conf/$APP_NAME"
SERVICE_SRC="$ROOT_DIR/systemd/$APP_NAME@.service"
SERVICE_DST="/etc/systemd/system/$APP_NAME@.service"

find_node_bin() {
    if [ -x "${ISP_APPS:-/home/isp/apps}/nodejs/bin/node" ]; then
        echo "${ISP_APPS:-/home/isp/apps}/nodejs/bin/node"
    elif [ -x "${ISP_APPS:-/home/isp/apps}/node/bin/node" ]; then
        echo "${ISP_APPS:-/home/isp/apps}/node/bin/node"
    elif command -v node >/dev/null 2>&1; then
        command -v node
    fi
}

validate_instance() {
    if [[ ! "$INSTANCE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
        __red "CYF_RUNTIME_V1_INSTANCE must be a safe non-empty instance name"
        return 1
    fi
}

validate_node() {
    local node_bin="$1"
    local major
    major="$($node_bin -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$major" != "20" ]; then
        __red "CYF Agent Runtime v1 requires Node 20; found $($node_bin -v)"
        return 1
    fi
}

install_package() {
    install -d -m 0755 "$APP_HOME" "$APP_HOME/lib"
    install -d -m 0700 "$APP_HOME/runtime-state"
    install -m 0755 "$CONF_SRC/agent-runtime.mjs" "$CONF_SRC/install.sh" "$CONF_SRC/validate.sh" "$APP_HOME/"
    install -m 0644 "$CONF_SRC/lib/manifest.mjs" "$APP_HOME/lib/manifest.mjs"
    install -m 0644 "$CONF_SRC/lib/runtime-client.mjs" "$APP_HOME/lib/runtime-client.mjs"
    install -m 0644 "$CONF_SRC/lib/security.mjs" "$APP_HOME/lib/security.mjs"
    install -m 0644 "$CONF_SRC/package.json" "$APP_HOME/package.json"
    install -m 0644 "$CONF_SRC/README.md" "$APP_HOME/README.md"
    install -m 0644 "$CONF_SRC/manifest.example.json" "$APP_HOME/manifest.example.json"
    install -m 0644 "$CONF_SRC/runtime.env.example" "$APP_HOME/runtime.env.example"
    install -d -m 0755 "$APP_HOME/systemd"
    install -m 0644 "$CONF_SRC/systemd/$APP_NAME@.service" "$APP_HOME/systemd/$APP_NAME@.service"

    # A real manifest and root-only EnvironmentFile are supplied separately by
    # the controlled deployment channel. This installer never creates or copies
    # a .env, legacy URL API key, authorization, enrollment secret, or old state.
    "$APP_HOME/validate.sh" --root "$APP_HOME" --manifest "$APP_HOME/manifest.example.json" --node "$NODE_BIN"
}

if [ "${CYF_RUNTIME_V1_INSTALL_TEST_MODE:-0}" != "1" ]; then
    check_root
    detect_os
fi

validate_instance
NODE_BIN="${CYF_RUNTIME_V1_TEST_NODE_BIN:-$(find_node_bin || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    __red "Node 20 executable not found"
    exit 1
fi
validate_node "$NODE_BIN"

if [ ! -d "$CONF_SRC" ] || [ ! -f "$SERVICE_SRC" ] || [ ! -f "$CONF_SRC/install.sh" ] || [ ! -f "$CONF_SRC/validate.sh" ] || [ ! -f "$CONF_SRC/systemd/$APP_NAME@.service" ]; then
    __red "Runtime v1 package or service template is missing"
    exit 1
fi

APP_HOME="$APP_ROOT/$INSTANCE"
install_package

if [ "${CYF_RUNTIME_V1_INSTALL_TEST_MODE:-0}" != "1" ]; then
    install -d -m 0700 /etc/cyf-agent-runtime-v1
    install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
    systemctl daemon-reload
fi

echo "Runtime v1 package installed: $APP_HOME"
echo "No service was enabled or started. Supply a real manifest.json and /etc/cyf-agent-runtime-v1/$INSTANCE.conf through the controlled channel, validate, then explicitly enable cyf-agent-runtime-v1@$INSTANCE."
