#!/bin/bash
#===============================================================
# PHP 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "PHP 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
PHP_VERSION="8.2.26"
PHP_URL="https://www.php.net/distributions/php-${PHP_VERSION}.tar.gz"
INSTALL_PREFIX="$ISP_APPS/php"

#===============================================================
# 安装编译依赖
#===============================================================
echo ""
echo "[1/4] 安装编译依赖..."

case $OS_FAMILY in
    rhel)
        # EPEL 仓库
        if ! rpm -q epel-release &>/dev/null; then
            pkg_install epel-release || true
        fi
        
        pkg_install gcc gcc-c++ make autoconf \
            libxml2-devel openssl-devel bzip2-devel \
            curl-devel libjpeg-devel libpng-devel \
            freetype-devel gmp-devel readline-devel \
            libxslt-devel openldap-devel \
            sqlite-devel libzip-devel oniguruma-devel \
            libargon2-devel libsodium-devel
        ;;
    debian)
        pkg_install gcc g++ make autoconf \
            libxml2-dev libssl-dev libbz2-dev \
            libcurl4-openssl-dev libjpeg-dev libpng-dev \
            libfreetype6-dev libgmp-dev libreadline-dev \
            libxslt1-dev libldap2-dev \
            libsqlite3-dev libzip-dev libonig-dev \
            libsodium-dev
        ;;
esac

#===============================================================
# 下载源码
#===============================================================
echo ""
echo "[2/4] 下载 PHP ${PHP_VERSION}..."

cd $ISP_PKGS

if [ ! -f "php-${PHP_VERSION}.tar.gz" ]; then
    download_file "$PHP_URL"
fi

#===============================================================
# 编译安装
#===============================================================
echo ""
echo "[3/4] 编译安装 PHP..."

tar -xzf php-${PHP_VERSION}.tar.gz
cd php-${PHP_VERSION}

# 配置编译选项
./configure \
    --prefix=$INSTALL_PREFIX \
    --with-config-file-path=$INSTALL_PREFIX/etc \
    --with-config-file-scan-dir=$INSTALL_PREFIX/etc/php.d \
    --enable-fpm \
    --with-fpm-user=isp \
    --with-fpm-group=isp \
    --enable-opcache \
    --enable-opcache-jit \
    --with-openssl \
    --with-zlib \
    --with-bz2 \
    --with-curl \
    --with-libxml \
    --enable-bcmath \
    --with-gmp \
    --enable-gd \
    --with-jpeg \
    --with-freetype \
    --with-gettext \
    --enable-mbstring \
    --with-onig \
    --with-mysqli \
    --with-pdo-mysql \
    --with-pdo-sqlite \
    --with-sqlite3 \
    --with-readline \
    --enable-soap \
    --with-xsl \
    --with-ldap \
    --enable-sockets \
    --enable-sysvmsg \
    --enable-sysvsem \
    --enable-sysvshm \
    --with-zip \
    --enable-intl \
    --with-sodium \
    --with-password-argon2 \
    --enable-ftp \
    --enable-calendar \
    --enable-exif \
    --enable-shmop

# 编译
make -j$(nproc)
make install

echo -e "${GREEN}PHP 编译安装完成${NC}"

#===============================================================
# 配置
#===============================================================
echo ""
echo "[4/4] 配置 PHP..."

# 创建配置目录
mkdir -p $INSTALL_PREFIX/etc/php.d
mkdir -p $INSTALL_PREFIX/var/run
mkdir -p $INSTALL_PREFIX/var/log

# 复制默认配置
cp php.ini-production $INSTALL_PREFIX/etc/php.ini
cp $INSTALL_PREFIX/etc/php-fpm.conf.default $INSTALL_PREFIX/etc/php-fpm.conf
cp $INSTALL_PREFIX/etc/php-fpm.d/www.conf.default $INSTALL_PREFIX/etc/php-fpm.d/www.conf

# 创建 php.ini
cat > $INSTALL_PREFIX/etc/php.ini << 'EOF'
[PHP]
; 基本设置
memory_limit = 256M
upload_max_filesize = 50M
post_max_size = 50M
max_execution_time = 300
max_input_time = 300

; 错误处理
display_errors = Off
log_errors = On
error_log = /home/isp/apps/php/var/log/php-error.log
error_reporting = E_ALL & ~E_DEPRECATED & ~E_STRICT

; 时区
date.timezone = Asia/Shanghai

; 字符集
default_charset = "UTF-8"

; Session
session.save_path = "/home/isp/apps/php/var/session"
session.gc_maxlifetime = 7200

; OPcache (性能优化)
[opcache]
opcache.enable=1
opcache.memory_consumption=128
opcache.interned_strings_buffer=8
opcache.max_accelerated_files=10000
opcache.revalidate_freq=60
opcache.fast_shutdown=1
opcache.jit_buffer_size=100M
opcache.jit=1255

[CLI Server]
cli_server.color = On
EOF

# 创建 session 目录
mkdir -p $INSTALL_PREFIX/var/session
chmod 1777 $INSTALL_PREFIX/var/session

# 配置 php-fpm
sed -i 's|;daemonize = yes|daemonize = yes|' $INSTALL_PREFIX/etc/php-fpm.conf
sed -i "s|user = nobody|user = isp|" $INSTALL_PREFIX/etc/php-fpm.d/www.conf
sed -i "s|group = nobody|group = isp|" $INSTALL_PREFIX/etc/php-fpm.d/www.conf
sed -i "s|listen = 127.0.0.1:9000|listen = /home/isp/apps/php/var/run/php-fpm.sock|" $INSTALL_PREFIX/etc/php-fpm.d/www.conf

# 创建管理脚本
cat > $ISP_BIN/php.sh << 'SCRIPT'
#!/bin/bash

PHP_HOME=/home/isp/apps/php

case "$1" in
    start)
        $PHP_HOME/sbin/php-fpm
        echo "PHP-FPM started"
        ;;
    stop)
        if [ -f $PHP_HOME/var/run/php-fpm.pid ]; then
            kill -QUIT $(cat $PHP_HOME/var/run/php-fpm.pid)
            echo "PHP-FPM stopped"
        else
            echo "PHP-FPM is not running"
        fi
        ;;
    restart)
        $0 stop
        sleep 2
        $0 start
        ;;
    status)
        if [ -f $PHP_HOME/var/run/php-fpm.pid ]; then
            if ps -p $(cat $PHP_HOME/var/run/php-fpm.pid) > /dev/null 2>&1; then
                echo "PHP-FPM is running (PID: $(cat $PHP_HOME/var/run/php-fpm.pid))"
            else
                echo "PHP-FPM is not running"
            fi
        else
            echo "PHP-FPM is not running"
        fi
        ;;
    version|v)
        $PHP_HOME/bin/php -v
        ;;
    *)
        echo "PHP 管理脚本"
        echo ""
        $PHP_HOME/bin/php -v | head -1
        echo ""
        echo "使用方法:"
        echo "  $0 start     启动 PHP-FPM"
        echo "  $0 stop      停止 PHP-FPM"
        echo "  $0 restart   重启 PHP-FPM"
        echo "  $0 status    状态"
        echo "  $0 version   版本"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/php.sh

# 创建命令行链接
ln -sf $INSTALL_PREFIX/bin/php /usr/local/bin/php
ln -sf $INSTALL_PREFIX/bin/phpize /usr/local/bin/phpize
ln -sf $INSTALL_PREFIX/bin/php-config /usr/local/bin/php-config

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "PHP 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "PHP 版本: $($INSTALL_PREFIX/bin/php -v | head -1)"
echo "配置文件: $INSTALL_PREFIX/etc/php.ini"
echo "管理脚本: $ISP_BIN/php.sh"
echo ""
echo "PHP-FPM 套接字: $INSTALL_PREFIX/var/run/php-fpm.sock"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/php.sh start    # 启动"
echo "  $ISP_BIN/php.sh stop     # 停止"
echo "  $ISP_BIN/php.sh restart  # 重启"
echo "  $ISP_BIN/php.sh status   # 状态"
echo ""
echo "Nginx 配置示例:"
echo "  location ~ \.php$ {"
echo "      fastcgi_pass unix:$INSTALL_PREFIX/var/run/php-fpm.sock;"
echo "      fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;"
echo "      include fastcgi_params;"
echo "  }"
