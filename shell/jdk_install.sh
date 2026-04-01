#!/bin/bash
#===============================================================
# JDK 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "JDK 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
JDK_VERSION="8u482"
JDK_BUILD="b08"
JDK_URL="https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u482-b08/OpenJDK8U-jdk_x64_linux_hotspot_8u482b08.tar.gz"
JDK_ARCHIVE="OpenJDK8U-jdk_x64_linux_hotspot_8u482b08.tar.gz"
INSTALL_PREFIX="$ISP_APPS/java"

#===============================================================
# 下载 JDK
#===============================================================
echo ""
echo "[1/3] 下载 JDK..."

cd $ISP_PKGS

if [ ! -f "$JDK_ARCHIVE" ]; then
    echo "下载 OpenJDK 8 (Temurin)..."
    download_file "$JDK_URL" "$JDK_ARCHIVE"
fi

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[2/3] 解压安装 JDK..."

mkdir -p $ISP_APPS
tar -xzf $JDK_ARCHIVE -C $ISP_APPS

# 重命名为 java
if [ -d "$ISP_APPS/jdk8u411-b09" ]; then
    mv $ISP_APPS/jdk8u411-b09 $INSTALL_PREFIX
fi

#===============================================================
# 配置环境变量
#===============================================================
echo ""
echo "[3/3] 配置环境变量..."

# 添加到 profile
if ! grep -q "JAVA_HOME=$INSTALL_PREFIX" /etc/profile; then
    cat >> /etc/profile << EOF

# Java Environment
export JAVA_HOME=$INSTALL_PREFIX
export PATH=\$JAVA_HOME/bin:\$PATH
EOF
    echo -e "${GREEN}环境变量配置完成${NC}"
fi

# 立即生效
export JAVA_HOME=$INSTALL_PREFIX
export PATH=$JAVA_HOME/bin:$PATH

# 验证安装
if [ -f "$INSTALL_PREFIX/bin/java" ]; then
    echo -e "${GREEN}JDK 安装成功${NC}"
    $INSTALL_PREFIX/bin/java -version
else
    echo -e "${RED}JDK 安装失败${NC}"
    exit 1
fi

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "JDK 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "Java 版本: $($INSTALL_PREFIX/bin/java -version 2>&1 | head -1)"
echo ""
echo "请执行以下命令使环境变量生效:"
echo "  source /etc/profile"
echo ""
echo "或重新登录终端"
