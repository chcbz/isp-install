#!/bin/bash
#===============================================================
# Xray 管理脚本
#===============================================================

XRAY_HOME=/home/isp/apps/xray
XRAY_BIN="$XRAY_HOME/bin/xray"
XRAY_CONFIG="$XRAY_HOME/etc/config.json"
SERVICE_NAME=xray

case "$1" in
    start)
        sudo systemctl start "$SERVICE_NAME"
        ;;
    stop)
        sudo systemctl stop "$SERVICE_NAME"
        ;;
    restart)
        sudo systemctl restart "$SERVICE_NAME"
        ;;
    status)
        sudo systemctl status "$SERVICE_NAME" --no-pager
        ;;
    enable)
        sudo systemctl enable "$SERVICE_NAME"
        ;;
    disable)
        sudo systemctl disable "$SERVICE_NAME"
        ;;
    version|v)
        "$XRAY_BIN" version
        ;;
    uuid)
        "$XRAY_BIN" uuid
        ;;
    test)
        "$XRAY_BIN" run -test -config "$XRAY_CONFIG"
        ;;
    *)
        echo "Xray 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  $0 start      启动服务"
        echo "  $0 stop       停止服务"
        echo "  $0 restart    重启服务"
        echo "  $0 status     查看服务状态"
        echo "  $0 enable     设置开机自启"
        echo "  $0 disable    关闭开机自启"
        echo "  $0 version    查看 Xray 版本"
        echo "  $0 uuid       生成一个 UUID"
        echo "  $0 test       测试配置文件"
        ;;
esac
