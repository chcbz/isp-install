#!/bin/bash
#===============================================================
# Nginx 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Nginx 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
NGINX_VERSION="1.24.0"
NGINX_URL="https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz"
INSTALL_PREFIX="$ISP_APPS/nginx"
PCRE_VERSION="8.45"
ZLIB_VERSION="1.3.1"
OPENSSL_VERSION="1.1.1w"

#===============================================================
# 安装编译依赖
#===============================================================
echo ""
echo "[1/5] 安装编译依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install gcc gcc-c++ make perl expat-devel
        ;;
    debian)
        pkg_install gcc g++ make perl libexpat1-dev
        ;;
esac

#===============================================================
# 下载源码
#===============================================================
echo ""
echo "[2/5] 下载源码..."

cd $ISP_PKGS

# 下载 Nginx
if [ ! -f "nginx-${NGINX_VERSION}.tar.gz" ]; then
    download_file "$NGINX_URL"
fi

# 下载 PCRE
if [ ! -f "pcre-${PCRE_VERSION}.tar.gz" ]; then
    download_file "https://sourceforge.net/projects/pcre/files/pcre/${PCRE_VERSION}/pcre-${PCRE_VERSION}.tar.gz/download" "pcre-${PCRE_VERSION}.tar.gz"
fi

# 下载 zlib
if [ ! -f "zlib-${ZLIB_VERSION}.tar.gz" ]; then
    download_file "https://zlib.net/zlib-${ZLIB_VERSION}.tar.gz"
fi

# 下载 OpenSSL
if [ ! -f "openssl-${OPENSSL_VERSION}.tar.gz" ]; then
    download_file "https://www.openssl.org/source/openssl-${OPENSSL_VERSION}.tar.gz"
fi

#===============================================================
# 解压源码
#===============================================================
echo ""
echo "[3/5] 解压源码..."

tar -xzf nginx-${NGINX_VERSION}.tar.gz 2>/dev/null || true
tar -xzf pcre-${PCRE_VERSION}.tar.gz 2>/dev/null || true
tar -xzf zlib-${ZLIB_VERSION}.tar.gz 2>/dev/null || true
tar -xzf openssl-${OPENSSL_VERSION}.tar.gz 2>/dev/null || true

#===============================================================
# 编译安装
#===============================================================
echo ""
echo "[4/5] 编译安装 Nginx..."

cd nginx-${NGINX_VERSION}

./configure \
    --prefix=$INSTALL_PREFIX \
    --with-pcre=../pcre-${PCRE_VERSION} \
    --with-zlib=../zlib-${ZLIB_VERSION} \
    --with-openssl=../openssl-${OPENSSL_VERSION} \
    --with-http_ssl_module \
    --with-http_v2_module \
    --with-http_realip_module \
    --with-http_gzip_static_module \
    --with-http_stub_status_module \
    --with-stream

make -j$(nproc)
make install

echo -e "${GREEN}Nginx 编译安装完成${NC}"

#===============================================================
# 配置
#===============================================================
echo ""
echo "[5/5] 配置 Nginx..."

# 创建日志目录
mkdir -p $INSTALL_PREFIX/logs

# 创建 vhost 目录
mkdir -p $INSTALL_PREFIX/conf/vhost

# 下载配置文件（可选）
if [ -f "$SCRIPT_DIR/../conf/nginx/nginx.conf" ]; then
    cp "$SCRIPT_DIR/../conf/nginx/nginx.conf" $INSTALL_PREFIX/conf/nginx.conf
fi

# 创建管理脚本
cat > $ISP_BIN/nginx.sh << 'SCRIPT'
#!/bin/bash

NGINX_HOME=/home/isp/apps/nginx

case "$1" in
    start)
        $NGINX_HOME/sbin/nginx
        echo "Nginx started"
        ;;
    stop)
        $NGINX_HOME/sbin/nginx -s stop
        echo "Nginx stopped"
        ;;
    reload)
        $NGINX_HOME/sbin/nginx -s reload
        echo "Nginx reloaded"
        ;;
    restart)
        $NGINX_HOME/sbin/nginx -s stop
        sleep 1
        $NGINX_HOME/sbin/nginx
        echo "Nginx restarted"
        ;;
    status)
        if [ -f $NGINX_HOME/logs/nginx.pid ]; then
            echo "Nginx is running (PID: $(cat $NGINX_HOME/logs/nginx.pid))"
        else
            echo "Nginx is not running"
        fi
        ;;
    test)
        $NGINX_HOME/sbin/nginx -t
        ;;
    *)
        echo "Usage: $0 {start|stop|reload|restart|status|test}"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/nginx.sh

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Nginx 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "配置文件: $INSTALL_PREFIX/conf/nginx.conf"
echo "管理脚本: $ISP_BIN/nginx.sh"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/nginx.sh start    # 启动"
echo "  $ISP_BIN/nginx.sh stop     # 停止"
echo "  $ISP_BIN/nginx.sh restart  # 重启"
echo "  $ISP_BIN/nginx.sh status   # 状态"
echo "  $ISP_BIN/nginx.sh test     # 测试配置"
