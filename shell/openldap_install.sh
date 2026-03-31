#!/bin/bash
#===============================================================
# OpenLDAP 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "OpenLDAP 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
OPENLDAP_VERSION="2.6.9"
OPENLDAP_URL="https://www.openldap.org/software/download/OpenLDAP/openldap-release/openldap-${OPENLDAP_VERSION}.tgz"
INSTALL_PREFIX="$ISP_APPS/openldap"

#===============================================================
# 安装编译依赖
#===============================================================
echo ""
echo "[1/4] 安装编译依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install gcc gcc-c++ make autoconf automake libtool \
            openssl-devel cyrus-sasl-devel krb5-devel \
            libtool-ltdl-devel unixODBC-devel \
            bzip2 gzip unzip wget
        ;;
    debian)
        pkg_install gcc g++ make autoconf automake libtool \
            libssl-dev libsasl2-dev libkrb5-dev \
            libltdl-dev unixodbc-dev \
            bzip2 gzip unzip wget
        ;;
esac

#===============================================================
# 下载源码
#===============================================================
echo ""
echo "[2/4] 下载 OpenLDAP ${OPENLDAP_VERSION}..."

cd $ISP_PKGS

if [ ! -f "openldap-${OPENLDAP_VERSION}.tgz" ]; then
    download_file "$OPENLDAP_URL"
fi

#===============================================================
# 编译安装
#===============================================================
echo ""
echo "[3/4] 编译安装 OpenLDAP..."

tar -xzf openldap-${OPENLDAP_VERSION}.tgz
cd openldap-${OPENLDAP_VERSION}

# 配置编译选项 (使用 MDB 后端)
./configure \
    --prefix=$INSTALL_PREFIX \
    --enable-slapd \
    --enable-dynacl \
    --enable-aci \
    --enable-cleartext \
    --enable-crypt \
    --enable-spasswd \
    --enable-modules \
    --enable-rlookups \
    --enable-slapi \
    --enable-wrappers=no \
    --enable-backends=no \
    --enable-mdb \
    --enable-memberof=yes \
    --enable-overlays=yes \
    --disable-wt \
    --disable-ipv6 \
    --with-tls=openssl

# 编译
make depend
make -j$(nproc)
make install

echo -e "${GREEN}OpenLDAP 编译安装完成${NC}"

#===============================================================
# 配置
#===============================================================
echo ""
echo "[4/4] 配置 OpenLDAP..."

# 创建必要目录
mkdir -p $INSTALL_PREFIX/var/openldap-data
mkdir -p $INSTALL_PREFIX/var/run
mkdir -p $INSTALL_PREFIX/var/logs

# 创建基础配置文件
cat > $INSTALL_PREFIX/etc/openldap/ldap.conf << 'EOF'
BASE    dc=example,dc=com
URI     ldap://localhost:389
TLS_CACERT    $INSTALL_PREFIX/etc/openldap/certs/ca.crt
EOF

# 创建 slapd.conf
cat > $INSTALL_PREFIX/etc/openldap/slapd.conf << 'EOF'
# Schema 定义
include $INSTALL_PREFIX/etc/openldap/schema/core.schema
include $INSTALL_PREFIX/etc/openldap/schema/cosine.schema
include $INSTALL_PREFIX/etc/openldap/schema/inetorgperson.schema
include $INSTALL_PREFIX/etc/openldap/schema/nis.schema

# PID 和 Args 文件
pidfile $INSTALL_PREFIX/var/run/slapd.pid
argsfile $INSTALL_PREFIX/var/run/slapd.args

# 日志级别
loglevel -1
logfile $INSTALL_PREFIX/var/logs/slapd.log

# 模块路径
modulepath $INSTALL_PREFIX/lib
moduleload memberof

# MDB 数据库配置
database mdb
maxsize 1073741824
directory $INSTALL_PREFIX/var/openldap-data

# 后缀和 Root DN
suffix "dc=example,dc=com"
rootdn "cn=admin,dc=example,dc=com"

# Root 密码 (请使用 slappasswd 生成)
# rootpw {SSHA}YOUR_HASHED_PASSWORD_HERE

# 索引
index objectClass eq
index uid eq
index cn,sn eq,sub
index mail eq,sub

# 访问控制
access to attrs=userPassword
    by self write
    by anonymous auth
    by * none

access to *
    by self write
    by * read
EOF

# 生成密码哈希
echo ""
echo "设置管理员密码..."
read -s -p "请输入 OpenLDAP 管理员密码: " LDAP_ADMIN_PASSWORD
echo

# 使用 slappasswd 生成哈希
LDAP_PASS_HASH=$($INSTALL_PREFIX/sbin/slappasswd -h {SSHA} -s "$LDAP_ADMIN_PASSWORD")

# 更新配置文件
sed -i "s|# rootpw.*|rootpw $LDAP_PASS_HASH|" $INSTALL_PREFIX/etc/openldap/slapd.conf

# 保存密码
mkdir -p $ISP_CONFIG
cat > $ISP_CONFIG/ldap.pass << EOF
LDAP_ADMIN_PASSWORD=$LDAP_ADMIN_PASSWORD
LDAP_ADMIN_DN=cn=admin,dc=example,dc=com
EOF
chmod 600 $ISP_CONFIG/ldap.pass

#===============================================================
# 创建管理脚本
#===============================================================
cat > $ISP_BIN/slapd.sh << SCRIPT
#!/bin/bash

SLAPD_HOME=$INSTALL_PREFIX
SLAPD_CONF=$SLAPD_HOME/etc/openldap/slapd.conf

case "\$1" in
    start)
        \$SLAPD_HOME/libexec/slapd -f \$SLAPD_CONF -h "ldap:// ldapi://"
        echo "OpenLDAP started"
        ;;
    stop)
        if [ -f \$SLAPD_HOME/var/run/slapd.pid ]; then
            kill \$(cat \$SLAPD_HOME/var/run/slapd.pid)
            echo "OpenLDAP stopped"
        else
            echo "OpenLDAP is not running"
        fi
        ;;
    restart)
        \$0 stop
        sleep 2
        \$0 start
        ;;
    status)
        if [ -f \$SLAPD_HOME/var/run/slapd.pid ]; then
            if ps -p \$(cat \$SLAPD_HOME/var/run/slapd.pid) > /dev/null 2>&1; then
                echo "OpenLDAP is running (PID: \$(cat \$SLAPD_HOME/var/run/slapd.pid))"
            else
                echo "OpenLDAP is not running (stale pid file)"
            fi
        else
            echo "OpenLDAP is not running"
        fi
        ;;
    test)
        \$SLAPD_HOME/libexec/slapd -f \$SLAPD_CONF -T test
        ;;
    *)
        echo "OpenLDAP 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  \$0 start     启动"
        echo "  \$0 stop      停止"
        echo "  \$0 restart   重启"
        echo "  \$0 status    状态"
        echo "  \$0 test      测试配置"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/slapd.sh

# 测试配置
echo ""
echo "测试配置..."
$ISP_BIN/slapd.sh test || {
    echo -e "${RED}配置测试失败，请检查配置文件${NC}"
}

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "OpenLDAP 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "配置文件: $INSTALL_PREFIX/etc/openldap/slapd.conf"
echo "管理脚本: $ISP_BIN/slapd.sh"
echo ""
echo "管理员信息:"
echo "  DN: cn=admin,dc=example,dc=com"
echo "  密码: (你设置的密码)"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/slapd.sh start    # 启动"
echo "  $ISP_BIN/slapd.sh stop     # 停止"
echo "  $ISP_BIN/slapd.sh status   # 状态"
echo "  $ISP_BIN/slapd.sh test     # 测试配置"
echo ""
echo "测试连接:"
echo "  ldapsearch -x -H ldap://localhost -b 'dc=example,dc=com'"
echo ""
echo "注意: 请根据需要修改 slapd.conf 中的 suffix 和 rootdn"
