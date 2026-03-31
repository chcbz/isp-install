#!/bin/bash
#===============================================================
# 服务器初始化脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 加载通用函数库
source "$SCRIPT_DIR/common.sh"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=========================================="
echo "服务器初始化脚本"
echo "==========================================${NC}"

# 检查 root 权限
check_root

# 检测操作系统
detect_os
show_os_info

#===============================================================
# 1. 创建用户和目录
#===============================================================
echo -e "\n${YELLOW}[1/6] 创建用户和目录结构...${NC}"

# 创建用户组
if ! grep -q "^isp:" /etc/group; then
    groupadd isp
    echo -e "${GREEN}用户组 isp 创建成功${NC}"
fi

# 创建用户
if ! id -u isp &>/dev/null; then
    useradd -g isp -s /bin/bash isp
    echo -e "${GREEN}用户 isp 创建成功${NC}"
fi

# 创建目录结构
mkdir -p $ISP_APPS
mkdir -p $ISP_PKGS
mkdir -p $ISP_BIN
mkdir -p $ISP_LOGS
mkdir -p $ISP_HOSTS
mkdir -p $ISP_CONFIG

# 设置权限
chown -R isp:isp /home/isp
chmod -R 775 /home/isp
chmod -R 777 /home/isp/logs

echo -e "${GREEN}目录结构创建完成${NC}"

#===============================================================
# 2. 安装基础工具
#===============================================================
echo -e "\n${YELLOW}[2/6] 安装基础工具...${NC}"

case $OS_FAMILY in
    rhel)
        # RHEL/Rocky/CentOS
        pkg_install wget curl net-tools vim git
        ;;
    debian)
        # Ubuntu/Debian
        pkg_install wget curl net-tools vim git
        ;;
esac

echo -e "${GREEN}基础工具安装完成${NC}"

#===============================================================
# 3. 配置中文语言环境
#===============================================================
echo -e "\n${YELLOW}[3/6] 配置语言环境...${NC}"

case $OS_FAMILY in
    rhel)
        # RHEL/Rocky/CentOS
        if ! locale -a | grep -q "zh_CN.utf8"; then
            pkg_install kde-l10n-Chinese glibc-common 2>/dev/null || true
            localedef -c -f UTF-8 -i zh_CN zh_CN.utf8 2>/dev/null || true
        fi
        
        # 设置系统语言
        echo "LANG=zh_CN.UTF-8" > /etc/locale.conf
        export LANG=zh_CN.UTF-8
        export LC_ALL=zh_CN.utf8
        ;;
    debian)
        # Ubuntu/Debian
        pkg_install locales language-pack-zh-hans 2>/dev/null || true
        
        # 生成 locale
        if [ -f /etc/locale.gen ]; then
            sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen
            locale-gen zh_CN.UTF-8 2>/dev/null || true
        fi
        
        # 设置系统语言
        update-locale LANG=zh_CN.UTF-8 2>/dev/null || true
        export LANG=zh_CN.UTF-8
        export LC_ALL=zh_CN.UTF-8
        ;;
esac

echo -e "${GREEN}语言环境配置完成${NC}"

#===============================================================
# 4. 设置时区
#===============================================================
echo -e "\n${YELLOW}[4/6] 设置时区...${NC}"

# 设置为上海时区
ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# 同步到硬件时钟
hwclock --systohc 2>/dev/null || true

echo -e "${GREEN}时区已设置为 Asia/Shanghai${NC}"

#===============================================================
# 5. 配置系统限制
#===============================================================
echo -e "\n${YELLOW}[5/6] 配置系统限制...${NC}"

# 配置文件打开数限制
if ! grep -q "isp soft nofile" /etc/security/limits.conf 2>/dev/null; then
    cat >> /etc/security/limits.conf << EOF

# ISP 用户限制
isp soft nofile 65535
isp hard nofile 65535
isp soft nproc 65535
isp hard nproc 65535
EOF
    echo -e "${GREEN}用户限制配置完成${NC}"
fi

#===============================================================
# 6. 系统优化
#===============================================================
echo -e "\n${YELLOW}[6/6] 系统优化...${NC}"

case $OS_FAMILY in
    rhel)
        # 关闭 SELinux (可选)
        if command -v setenforce &> /dev/null; then
            setenforce 0 2>/dev/null || true
            if [ -f /etc/selinux/config ]; then
                sed -i 's/SELINUX=enforcing/SELINUX=disabled/' /etc/selinux/config
            fi
        fi
        ;;
    debian)
        # Ubuntu/Debian 系统优化
        # 启用必要的服务
        systemctl enable ssh 2>/dev/null || true
        ;;
esac

# 配置 sysctl
if [ ! -f /etc/sysctl.d/99-isp.conf ]; then
    cat > /etc/sysctl.d/99-isp.conf << 'EOF'
# 网络优化
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30

# 文件系统
fs.file-max = 2097152

# 内存
vm.swappiness = 10
EOF
    sysctl -p /etc/sysctl.d/99-isp.conf 2>/dev/null || true
    echo -e "${GREEN}内核参数优化完成${NC}"
fi

#===============================================================
# 完成
#===============================================================
echo -e "\n${GREEN}=========================================="
echo "初始化完成！"
echo "==========================================${NC}"
echo ""
echo "创建的目录结构："
echo "  /home/isp/apps    - 应用程序安装目录"
echo "  /home/isp/pkgs    - 软件包存放目录"
echo "  /home/isp/bin     - 管理脚本目录"
echo "  /home/isp/logs    - 日志目录"
echo "  /home/isp/hosts   - 项目目录"
echo ""
echo "下一步："
echo "  1. 运行 ./shell/jdk_install.sh 安装 JDK"
echo "  2. 运行 ./shell/mysql_install.sh 安装 MySQL"
echo "  3. 或根据需要运行其他安装脚本"
