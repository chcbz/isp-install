#!/bin/bash
#===============================================================
# Codex WebSocket Agent 安装脚本
#===============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

APP_NAME="codex-ws-agent"
APP_HOME="$ISP_APPS/$APP_NAME"
CONF_SRC="$ROOT_DIR/conf/$APP_NAME"
SERVICE_SRC="$ROOT_DIR/systemd/$APP_NAME.service"
SERVICE_DST="/etc/systemd/system/$APP_NAME.service"
BIN_SRC="$ROOT_DIR/bin/codex_ws_agent.sh"
BIN_DST="$ISP_BIN/codex_ws_agent.sh"

echo "=========================================="
echo "Codex WebSocket Agent 安装脚本"
echo "=========================================="
show_os_info

find_node_bin() {
    if [ -x "$ISP_APPS/nodejs/bin/node" ]; then
        echo "$ISP_APPS/nodejs/bin/node"
    elif [ -x "$ISP_APPS/node/bin/node" ]; then
        echo "$ISP_APPS/node/bin/node"
    elif command -v node >/dev/null 2>&1; then
        command -v node
    fi
}

node_major_version() {
    local node_bin="$1"
    "$node_bin" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

copy_if_missing() {
    local src="$1"
    local dst="$2"

    if [ ! -f "$dst" ]; then
        cp "$src" "$dst"
        return 0
    fi

    return 1
}

if [ ! -d "$CONF_SRC" ]; then
    __red "配置目录不存在: $CONF_SRC"
    exit 1
fi

NODE_BIN="$(find_node_bin || true)"
if [ -z "$NODE_BIN" ]; then
    __red "未找到 Node.js，请先执行: ./install.sh node"
    exit 1
fi

NODE_MAJOR="$(node_major_version "$NODE_BIN")"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
    __red "Node.js 版本需要 >= 20，当前: $("$NODE_BIN" -v 2>/dev/null || echo unknown)"
    exit 1
fi

echo ""
echo "[1/6] 创建目录..."
create_isp_dirs
install -d -m 0755 "$APP_HOME" "$APP_HOME/logs"
install -d -m 0700 "$APP_HOME/data" "$APP_HOME/data/inbox"

echo ""
echo "[2/6] 部署应用文件..."
install -m 0644 "$CONF_SRC/agent-client.mjs" "$APP_HOME/agent-client.mjs"
install -m 0644 "$CONF_SRC/workspace-manager.mjs" "$APP_HOME/workspace-manager.mjs"
install -m 0644 "$CONF_SRC/package.json" "$APP_HOME/package.json"
install -m 0644 "$CONF_SRC/README.md" "$APP_HOME/README.md"
install -m 0644 "$CONF_SRC/env.example" "$APP_HOME/.env.example"
install -m 0640 "$CONF_SRC/workspace-policies.example.json" "$APP_HOME/workspace-policies.example.json"
if [ -f "$APP_HOME/workspace-policies.json" ]; then
    chmod 0600 "$APP_HOME/workspace-policies.json"
fi

if copy_if_missing "$CONF_SRC/env.example" "$APP_HOME/.env"; then
    __yellow "已生成默认 .env，请编辑 OPENCLAW_API_KEY 和 WS_URL: $APP_HOME/.env"
else
    __yellow "保留已有 .env: $APP_HOME/.env"
fi

if copy_if_missing "$CONF_SRC/codex-profiles.conf" "$APP_HOME/codex-profiles.conf"; then
    __yellow "已生成默认 profile 配置: $APP_HOME/codex-profiles.conf"
else
    __yellow "保留已有 profile 配置: $APP_HOME/codex-profiles.conf"
fi

echo ""
echo "[3/6] 安装管理脚本..."
install -m 0755 "$BIN_SRC" "$BIN_DST"

echo ""
echo "[4/6] 安装 systemd 服务..."
install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable "$APP_NAME.service"

echo ""
echo "[5/6] 验证配置..."
if (cd "$APP_HOME" && "$NODE_BIN" agent-client.mjs --validate); then
    __green "配置验证通过"
else
    __yellow "配置验证未通过。请确认 codex CLI、codexWorkdir、API key/profile 配置后再启动服务。"
fi

echo ""
echo "[6/6] 检查 A07 workspace policy..."
if [ -f "$APP_HOME/workspace-policies.json" ]; then
    __green "检测到受控 workspace policy: $APP_HOME/workspace-policies.json"
else
    __yellow "尚未启用 A07 workspace policy。command.dispatch 将 fail closed，不会回退到共享可写代码目录。"
    echo "  cp $APP_HOME/workspace-policies.example.json $APP_HOME/workspace-policies.json"
    echo "  编辑可信 repository/baseRef，并在 .env 设置 CODEX_WORKSPACE_POLICIES_FILE"
fi

if [ "${START_CODEX_WS_AGENT:-n}" = "y" ]; then
    systemctl restart "$APP_NAME.service"
    systemctl --no-pager --full status "$APP_NAME.service"
else
    __yellow "未自动启动服务。如需启动请执行:"
    echo "  systemctl restart $APP_NAME.service"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "Codex WebSocket Agent 部署完成"
echo "==========================================${NC}"
echo "应用目录: $APP_HOME"
echo "配置文件: $APP_HOME/.env"
echo "配置模板: $APP_HOME/.env.example"
echo "Profile:  $APP_HOME/codex-profiles.conf"
echo "Workspace policy 示例: $APP_HOME/workspace-policies.example.json"
echo "管理脚本: $BIN_DST"
echo "服务单元: $SERVICE_DST"
