#!/bin/bash
#===============================================================
# Xray 安装脚本 - 二进制安装，支持 Rocky/CentOS/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Xray 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
APP_NAME="xray"
APP_HOME="$ISP_APPS/$APP_NAME"

# 当前维护版本，升级时同步更新 XRAY_SHA256
XRAY_VERSION="${XRAY_VERSION:-v26.3.27}"
XRAY_ARCHIVE="Xray-linux-64-${XRAY_VERSION}.zip"
XRAY_SHA256="${XRAY_SHA256:-23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae}"
XRAY_URL="https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip"

CONF_SRC="$ROOT_DIR/conf/$APP_NAME"
SERVICE_SRC="$ROOT_DIR/systemd/$APP_NAME.service"
SERVICE_DST="/etc/systemd/system/$APP_NAME.service"
BIN_SRC="$ROOT_DIR/bin/$APP_NAME.sh"
BIN_DST="$ISP_BIN/$APP_NAME.sh"

NGINX_CONF_SRC="$ROOT_DIR/conf/nginx/conf/vhost/vpn.chcbz.net.conf"
NGINX_VHOST="$ISP_APPS/nginx/conf/vhost/vpn.chcbz.net.conf"
NGINX_BIN="$ISP_APPS/nginx/sbin/nginx"

#===============================================================
# 预检
#===============================================================
if [ "$(uname -m)" != "x86_64" ]; then
    __red "当前脚本仅维护 x86_64 二进制，检测到: $(uname -m)"
    exit 1
fi

if [ ! -f "$CONF_SRC/config.json.template" ]; then
    __red "配置模板不存在: $CONF_SRC/config.json.template"
    exit 1
fi

echo ""
echo "[1/7] 准备目录与依赖..."
ensure_command unzip
mkdir -p "$ISP_PKGS"
mkdir -p "$APP_HOME/bin"
mkdir -p "$APP_HOME/etc"
mkdir -p "$APP_HOME/logs"
mkdir -p "$ISP_BIN"
chown -R "$ISP_USER:$ISP_GROUP" "$APP_HOME"

#===============================================================
# 下载 Xray
#===============================================================
echo ""
echo "[2/7] 下载 Xray $XRAY_VERSION..."

ARCHIVE_PATH="$ISP_PKGS/$XRAY_ARCHIVE"
if [ ! -f "$ARCHIVE_PATH" ]; then
    download_file "$XRAY_URL" "$ARCHIVE_PATH"
fi

ACTUAL_SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$XRAY_SHA256" ]; then
    __red "Xray 下载文件校验失败"
    echo "期望: $XRAY_SHA256"
    echo "实际: $ACTUAL_SHA256"
    exit 1
fi
__green "下载文件校验通过"

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[3/7] 解压并安装二进制文件..."

EXTRACT_DIR="$(mktemp -d)"
trap 'rm -rf "$EXTRACT_DIR"' EXIT
unzip -q -o "$ARCHIVE_PATH" -d "$EXTRACT_DIR"

install -m 0755 "$EXTRACT_DIR/xray" "$APP_HOME/bin/xray"
install -m 0644 "$EXTRACT_DIR/geoip.dat" "$APP_HOME/etc/geoip.dat"
install -m 0644 "$EXTRACT_DIR/geosite.dat" "$APP_HOME/etc/geosite.dat"

#===============================================================
# 生成配置
#===============================================================
echo ""
echo "[4/7] 生成 Xray 配置..."

XRAY_UUID="${XRAY_UUID:-$("$APP_HOME/bin/xray" uuid)}"

copy_if_missing() {
    local src="$1"
    local dst="$2"

    if [ ! -f "$dst" ]; then
        install -m 0640 "$src" "$dst"
        chown "$ISP_USER:$ISP_GROUP" "$dst"
        return 0
    fi

    return 1
}

if copy_if_missing "$CONF_SRC/config.json.template" "$APP_HOME/etc/config.json"; then
    sed -i "s/__XRAY_UUID__/${XRAY_UUID}/g" "$APP_HOME/etc/config.json"
    __green "已生成配置: $APP_HOME/etc/config.json"
else
    __yellow "保留已有配置: $APP_HOME/etc/config.json"
fi

#===============================================================
# 安装管理脚本和服务
#===============================================================
echo ""
echo "[5/7] 安装管理脚本..."

install -m 0755 "$BIN_SRC" "$BIN_DST"

echo ""
echo "[6/7] 安装 systemd 服务..."

install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable "$APP_NAME.service"

#===============================================================
# 安装 nginx vhost
#===============================================================
echo ""
echo "[7/7] 安装 nginx vhost..."

mkdir -p "$ISP_APPS/nginx/conf/vhost"
if copy_if_missing "$NGINX_CONF_SRC" "$NGINX_VHOST"; then
    __green "已安装 nginx vhost: $NGINX_VHOST"
else
    __yellow "保留已有 nginx vhost: $NGINX_VHOST"
fi

if [ -x "$NGINX_BIN" ]; then
    "$NGINX_BIN" -t
    "$NGINX_BIN" -s reload
    __green "nginx 配置校验通过并已重载"
else
    __yellow "未找到 nginx 二进制，请手动验证并重载: $NGINX_BIN"
fi

#===============================================================
# 启动服务
#===============================================================
if [ "${START_XRAY:-n}" = "y" ]; then
    systemctl restart "$APP_NAME.service"
    systemctl --no-pager --full status "$APP_NAME.service"
else
    __yellow "未自动启动服务。如需启动请执行:"
    echo "  systemctl restart $APP_NAME.service"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "Xray 部署完成"
echo "==========================================${NC}"
echo "安装目录: $APP_HOME"
echo "配置文件: $APP_HOME/etc/config.json"
echo "管理脚本: $BIN_DST"
echo "服务单元: $SERVICE_DST"
echo "nginx vhost: $NGINX_VHOST"
echo ""
echo "客户端 UUID: $XRAY_UUID"
echo "客户端地址: vpn.chcbz.net:443"
echo "传输协议: VLESS + WebSocket + TLS"
echo "路径: /"
