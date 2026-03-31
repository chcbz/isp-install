#!/bin/bash
# OpenLDAP 安装脚本 (Rocky 8, 使用 MDB 后端)
# 用法: 以 root 用户执行

set -e  # 遇到错误即退出

# 配置变量
OPENLDAP_VERSION="2.6.9"
OPENLDAP_TGZ="openldap-${OPENLDAP_VERSION}.tgz"
DOWNLOAD_URL="https://install.chcbz.net/pkgs/${OPENLDAP_TGZ}"
INSTALL_PREFIX="/home/isp/apps/openldap"
WORKDIR="/home/isp/pkgs"
CONF_URL_BASE="https://install.chcbz.net/conf/openldap/etc/openldap"
BIN_URL_BASE="https://install.chcbz.net/bin"

# 检查并创建工作目录
mkdir -p "${WORKDIR}"
cd "${WORKDIR}"

# 安装基础工具和编译依赖（移除 libdb-devel）
echo "安装依赖包..."
yum install -y wget gcc gcc-c++ make autoconf automake libtool \
    openssl-devel cyrus-sasl-devel krb5-devel \
    libtool-ltdl-devel openslp-devel unixODBC-devel \
    bzip2 gzip unzip

# 下载 OpenLDAP 源码
if [ ! -f "${OPENLDAP_TGZ}" ]; then
    echo "下载 OpenLDAP ${OPENLDAP_VERSION} 源码..."
    wget --no-check-certificate -O "${OPENLDAP_TGZ}" "${DOWNLOAD_URL}"
fi

# 解压并进入源码目录
tar -xzf "${OPENLDAP_TGZ}"
cd "openldap-${OPENLDAP_VERSION}"

# 配置编译选项（显式启用 MDB，禁用 BDB/HDB 等）
echo "配置编译选项（使用 MDB 后端）..."
./configure \
    --prefix="${INSTALL_PREFIX}" \
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
    --enable-overlays=yes
    --disable-wt \
    --disable-ipv6 \
    --with-tls=openssl

# 编译并安装
echo "编译中（使用 4 线程）..."
make depend
make -j4
make -j4 install

# 配置目录
cd "${INSTALL_PREFIX}/etc/openldap"

# 下载配置文件（如果存在则覆盖）
echo "下载配置文件..."
wget -N "${CONF_URL_BASE}/slapd.conf"      || echo "slapd.conf 下载失败，请手动配置"
wget -N "${CONF_URL_BASE}/ldap.conf"       || echo "ldap.conf 下载失败，请手动配置"

# 下载扩展 schema
cd schema
wget -N "${CONF_URL_BASE}/schema/freeradius.schema" || echo "freeradius.schema 下载失败"
wget -N "${CONF_URL_BASE}/schema/jiaorg.schema"  || echo "jiaorg.schema 下载失败"
wget -N "${CONF_URL_BASE}/schema/jiaperson.schema"  || echo "jiaperson.schema 下载失败"
wget -N "${CONF_URL_BASE}/schema/samba.schema"      || echo "samba.schema 下载失败"
cd ..

# 下载启动脚本
mkdir -p /home/isp/bin
cd /home/isp/bin
wget -N "${BIN_URL_BASE}/slapd.sh"
chmod 755 slapd.sh

echo "安装完成！"
echo "请确认配置文件 ${INSTALL_PREFIX}/etc/openldap/slapd.conf 中使用了 MDB 后端，例如："
echo "  database mdb"
echo "  suffix \"dc=example,dc=com\""
echo "  rootdn \"cn=Manager,dc=example,dc=com\""
echo "  rootpw {SSHA}YOUR_HASHED_PASSWORD"
echo "  # 使用 slappasswd -h {SSHA} 生成密码哈希"
echo "  directory /home/isp/apps/openldap/var/openldap-data"
echo ""
echo "如需启动服务，请执行：/home/isp/bin/slapd.sh start"
