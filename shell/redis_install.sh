#!/bin/bash
#===============================================================
# Redis 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Redis 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
REDIS_VERSION="7.4.8"
REDIS_URL="https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz"
INSTALL_PREFIX="$ISP_APPS/redis"

#===============================================================
# 安装编译依赖
#===============================================================
echo ""
echo "[1/4] 安装编译依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install gcc gcc-c++ make
        ;;
    debian)
        pkg_install gcc g++ make pkg-config
        ;;
esac

#===============================================================
# 下载源码
#===============================================================
echo ""
echo "[2/4] 下载 Redis..."

cd $ISP_PKGS

if [ ! -f "redis-${REDIS_VERSION}.tar.gz" ]; then
    download_file "$REDIS_URL"
fi

#===============================================================
# 编译安装
#===============================================================
echo ""
echo "[3/4] 编译安装 Redis..."

tar -xzf redis-${REDIS_VERSION}.tar.gz
cd redis-${REDIS_VERSION}

make -j$(nproc)
make PREFIX=$INSTALL_PREFIX install

echo -e "${GREEN}Redis 编译安装完成${NC}"

#===============================================================
# 配置
#===============================================================
echo ""
echo "[4/4] 配置 Redis..."

# 创建目录
mkdir -p $INSTALL_PREFIX/data
mkdir -p $INSTALL_PREFIX/logs

# 创建配置文件
cat > $INSTALL_PREFIX/redis.conf << 'EOF'
# 基本配置
bind 127.0.0.1
port 6379
daemonize yes
pidfile /home/isp/apps/redis/redis.pid
logfile /home/isp/apps/redis/logs/redis.log
dir /home/isp/apps/redis/data

# 内存配置
maxmemory 256mb
maxmemory-policy allkeys-lru

# 持久化配置
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfilename "appendonly.aof"

# 性能优化
tcp-backlog 511
timeout 0
tcp-keepalive 300

# 安全 (如需密码，取消注释并设置)
# requirepass your_password_here
EOF

# 创建管理脚本
cat > $ISP_BIN/redis.sh << 'SCRIPT'
#!/bin/bash

REDIS_HOME=/home/isp/apps/redis

case "$1" in
    start)
        $REDIS_HOME/bin/redis-server $REDIS_HOME/redis.conf
        echo "Redis started"
        ;;
    stop)
        $REDIS_HOME/bin/redis-cli shutdown
        echo "Redis stopped"
        ;;
    restart)
        $REDIS_HOME/bin/redis-cli shutdown 2>/dev/null || true
        sleep 1
        $REDIS_HOME/bin/redis-server $REDIS_HOME/redis.conf
        echo "Redis restarted"
        ;;
    status)
        if $REDIS_HOME/bin/redis-cli ping 2>/dev/null | grep -q "PONG"; then
            echo "Redis is running"
        else
            echo "Redis is not running"
        fi
        ;;
    cli)
        $REDIS_HOME/bin/redis-cli
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|cli}"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/redis.sh

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Redis 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "配置文件: $INSTALL_PREFIX/redis.conf"
echo "管理脚本: $ISP_BIN/redis.sh"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/redis.sh start    # 启动"
echo "  $ISP_BIN/redis.sh stop     # 停止"
echo "  $ISP_BIN/redis.sh restart  # 重启"
echo "  $ISP_BIN/redis.sh status   # 状态"
echo "  $ISP_BIN/redis.sh cli      # 命令行客户端"
echo ""
echo "如需设置密码，请编辑 $INSTALL_PREFIX/redis.conf"
