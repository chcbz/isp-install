#!/bin/bash
#===============================================================
# Pure-FTPd 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Pure-FTPd 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
PUREFTPD_VERSION="1.0.51"
PUREFTPD_URL="https://download.pureftpd.org/pub/pure-ftpd/releases/pure-ftpd-${PUREFTPD_VERSION}.tar.gz"
INSTALL_PREFIX="$ISP_APPS/pureftpd"

#===============================================================
# 安装编译依赖
#===============================================================
echo ""
echo "[1/4] 安装编译依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install gcc gcc-c++ make \
            openssl-devel mysql-devel postgresql-devel
        ;;
    debian)
        pkg_install gcc g++ make \
            libssl-dev libmysqlclient-dev libpq-dev
        ;;
esac

#===============================================================
# 下载源码
#===============================================================
echo ""
echo "[2/4] 下载 Pure-FTPd ${PUREFTPD_VERSION}..."

cd $ISP_PKGS

if [ ! -f "pure-ftpd-${PUREFTPD_VERSION}.tar.gz" ]; then
    download_file "$PUREFTPD_URL"
fi

#===============================================================
# 编译安装
#===============================================================
echo ""
echo "[3/4] 编译安装 Pure-FTPd..."

tar -xzf pure-ftpd-${PUREFTPD_VERSION}.tar.gz
cd pure-ftpd-${PUREFTPD_VERSION}

./configure \
    --prefix=$INSTALL_PREFIX \
    --with-ftpwho \
    --with-altlog \
    --with-puredb \
    --with-throttling \
    --with-ratios \
    --with-quotas \
    --with-uploadscript \
    --with-virtualchroot \
    --with-tls \
    --with-largefile \
    --with-peruserlimits

make -j$(nproc)
make install

echo -e "${GREEN}Pure-FTPd 编译安装完成${NC}"

#===============================================================
# 配置
#===============================================================
echo ""
echo "[4/4] 配置 Pure-FTPd..."

# 创建目录
mkdir -p $INSTALL_PREFIX/etc
mkdir -p $INSTALL_PREFIX/var/run
mkdir -p $INSTALL_PREFIX/var/log
mkdir -p $INSTALL_PREFIX/etc/ssl

# 创建配置文件
cat > $INSTALL_PREFIX/etc/pure-ftpd.conf << 'EOF'
# 基本配置
ChrootEveryone              yes
BrokenClientsCompatibility  yes
MaxClientsNumber            50
Daemonize                   yes
MaxClientsPerIP             10
VerboseLog                  yes
DisplayDotFiles             yes
AnonymousOnly               no
NoAnonymous                 yes
SyslogFacility              ftp
DontResolve                 yes
MaxIdleTime                 15

# 认证配置
PureDB                      /home/isp/apps/pureftpd/etc/pureftpd.pdb
ExtAuth                     /home/isp/apps/pureftpd/sbin/pure-authd -s /var/run/pure-authd.sock -r /home/isp/apps/pureftpd/bin/auth.sh &

# 性能配置
LimitRecursion              10000 8
AnonymousCanCreateDirs      no
MaxLoad                     4

# 被动模式端口范围
PassivePortRange            30000 50000

# 强制 TLS (可选)
# TLS                        2

# TLS 证书
TLSCipherSuite              HIGH:MEDIUM:+TLSv1:!SSLv2:!SSLv3
CertFile                    /home/isp/apps/pureftpd/etc/ssl/pure-ftpd.pem

# 日志
AltLog                      clf:/home/isp/apps/pureftpd/var/log/pure-ftpd.log

# 文件权限
Umask                       133:022
MinUID                      100

# 禁止 .forward 等文件
ProhibitDotFilesRead        no
ProhibitDotFilesWrite       yes
EOF

# 创建 FTP 用户目录
mkdir -p $ISP_HOME/ftp
chown -R isp:isp $ISP_HOME/ftp

# 创建管理脚本
cat > $ISP_BIN/pureftpd.sh << 'SCRIPT'
#!/bin/bash

PUREFTPD_HOME=/home/isp/apps/pureftpd
PUREFTPD_CONF=$PUREFTPD_HOME/etc/pure-ftpd.conf

case "$1" in
    start)
        $PUREFTPD_HOME/sbin/pure-ftpd $PUREFTPD_CONF
        echo "Pure-FTPd started"
        ;;
    stop)
        killall pure-ftpd 2>/dev/null || true
        echo "Pure-FTPd stopped"
        ;;
    restart)
        $0 stop
        sleep 1
        $0 start
        ;;
    status)
        if pgrep -x pure-ftpd > /dev/null; then
            echo "Pure-FTPd is running"
            $PUREFTPD_HOME/sbin/pure-ftpwho
        else
            echo "Pure-FTPd is not running"
        fi
        ;;
    user-add)
        if [ -z "$2" ]; then
            echo "用法: $0 user-add <用户名>"
            exit 1
        fi
        $PUREFTPD_HOME/bin/pure-pw useradd $2 -u isp -d /home/isp/ftp/$2
        $PUREFTPD_HOME/bin/pure-pw mkdb
        echo "用户 $2 创建成功"
        ;;
    user-del)
        if [ -z "$2" ]; then
            echo "用法: $0 user-del <用户名>"
            exit 1
        fi
        $PUREFTPD_HOME/bin/pure-pw userdel $2
        $PUREFTPD_HOME/bin/pure-pw mkdb
        echo "用户 $2 删除成功"
        ;;
    user-list)
        $PUREFTPD_HOME/bin/pure-pw list
        ;;
    mkdb)
        $PUREFTPD_HOME/bin/pure-pw mkdb
        echo "数据库已更新"
        ;;
    *)
        echo "Pure-FTPd 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  $0 start           启动"
        echo "  $0 stop            停止"
        echo "  $0 restart         重启"
        echo "  $0 status          状态"
        echo "  $0 user-add <用户> 添加用户"
        echo "  $0 user-del <用户> 删除用户"
        echo "  $0 user-list       用户列表"
        echo "  $0 mkdb            更新用户数据库"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/pureftpd.sh

# 生成自签名 TLS 证书
if [ ! -f "$INSTALL_PREFIX/etc/ssl/pure-ftpd.pem" ]; then
    openssl req -x509 -nodes -days 3650 \
        -newkey rsa:2048 \
        -keyout $INSTALL_PREFIX/etc/ssl/pure-ftpd.pem \
        -out $INSTALL_PREFIX/etc/ssl/pure-ftpd.pem \
        -subj "/C=CN/ST=Shanghai/L=Shanghai/O=ISP/CN=localhost" 2>/dev/null
    chmod 600 $INSTALL_PREFIX/etc/ssl/pure-ftpd.pem
fi

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Pure-FTPd 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "版本: $PUREFTPD_VERSION"
echo "配置文件: $INSTALL_PREFIX/etc/pure-ftpd.conf"
echo "管理脚本: $ISP_BIN/pureftpd.sh"
echo ""
echo "FTP 目录: $ISP_HOME/ftp"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/pureftpd.sh start           # 启动"
echo "  $ISP_BIN/pureftpd.sh stop            # 停止"
echo "  $ISP_BIN/pureftpd.sh user-add <用户> # 添加用户"
echo "  $ISP_BIN/pureftpd.sh user-list       # 用户列表"
echo ""
echo "被动模式端口: 30000-50000 (请在防火墙开放)"
