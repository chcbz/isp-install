#!/bin/bash
#===============================================================
# 通用工具函数库 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

__red() { echo -e "${RED}$1${NC}"; }
__green() { echo -e "${GREEN}$1${NC}"; }
__yellow() { echo -e "${YELLOW}$1${NC}"; }

#===============================================================
# 系统检测
#===============================================================

# 检测操作系统类型
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        OS_VERSION=$VERSION_ID
        OS_FAMILY=$ID_LIKE
    elif [ -f /etc/redhat-release ]; then
        OS="centos"
    else
        OS="unknown"
    fi
    
    case $OS in
        centos|rocky|almalinux|rhel)
            OS_FAMILY="rhel"
            PKG_MANAGER="yum"
            if command -v dnf &> /dev/null; then
                PKG_MANAGER="dnf"
            fi
            ;;
        ubuntu|debian)
            OS_FAMILY="debian"
            PKG_MANAGER="apt"
            ;;
        *)
            __red "不支持的操作系统: $OS"
            exit 1
            ;;
    esac
    
    export OS OS_VERSION OS_FAMILY PKG_MANAGER
}

# 显示系统信息
show_os_info() {
    detect_os
    echo "=========================================="
    echo "系统信息"
    echo "=========================================="
    __green "操作系统: $OS"
    __green "版本: $OS_VERSION"
    __green "系列: $OS_FAMILY"
    __green "包管理器: $PKG_MANAGER"
    echo "=========================================="
}

#===============================================================
# 包管理器适配
#===============================================================

# 更新软件源
pkg_update() {
    detect_os
    case $PKG_MANAGER in
        yum|dnf)
            $PKG_MANAGER update -y
            ;;
        apt)
            apt update -y
            ;;
    esac
}

# 安装软件包
pkg_install() {
    detect_os
    local packages="$@"
    
    case $PKG_MANAGER in
        yum|dnf)
            $PKG_MANAGER install -y $packages
            ;;
        apt)
            apt install -y $packages
            ;;
    esac
}

# 检查软件包是否已安装
pkg_is_installed() {
    detect_os
    local pkg=$1
    
    case $PKG_MANAGER in
        yum|dnf)
            rpm -q $pkg &> /dev/null
            ;;
        apt)
            dpkg -l $pkg &> /dev/null 2>&1
            ;;
    esac
}

# 获取包名（处理不同系统的包名差异）
pkg_name() {
    local rhel_name=$1
    local debian_name=$2
    
    detect_os
    case $OS_FAMILY in
        rhel)
            echo "$rhel_name"
            ;;
        debian)
            echo "$debian_name"
            ;;
    esac
}

# 常用包名映射
declare -A PKG_NAMES=(
    # RHEL名称 => Debian名称
    ["gcc-c++"]="g++"
    ["openssl-devel"]="libssl-dev"
    ["ncurses-devel"]="libncurses-dev"
    ["expat-devel"]="libexpat1-dev"
    ["bzip2-devel"]="libbz2-dev"
    ["libffi-devel"]="libffi-dev"
    ["sqlite-devel"]="libsqlite3-dev"
    ["readline-devel"]="libreadline-dev"
    ["zlib-devel"]="zlib1g-dev"
    ["libxml2-devel"]="libxml2-dev"
    ["libxslt-devel"]="libxslt1-dev"
    ["curl-devel"]="libcurl4-openssl-dev"
    ["gd-devel"]="libgd-dev"
    ["libjpeg-devel"]="libjpeg-dev"
    ["libpng-devel"]="libpng-dev"
    ["freetype-devel"]="libfreetype6-dev"
    ["gmp-devel"]="libgmp-dev"
    ["libwebp-devel"]="libwebp-dev"
    ["cyrus-sasl-devel"]="libsasl2-dev"
    ["krb5-devel"]="libkrb5-dev"
    ["libtool-ltdl-devel"]="libltdl-dev"
    ["unixODBC-devel"]="unixodbc-dev"
)

# 智能安装（自动处理包名差异）
pkg_install_smart() {
    detect_os
    local packages=()
    
    for pkg in "$@"; do
        if [ "$OS_FAMILY" = "debian" ] && [ -n "${PKG_NAMES[$pkg]}" ]; then
            packages+=("${PKG_NAMES[$pkg]}")
        else
            packages+=("$pkg")
        fi
    done
    
    pkg_install ${packages[*]}
}

#===============================================================
# 用户和组管理
#===============================================================

# 创建用户组
group_create() {
    local group=$1
    if ! grep -q "^$group:" /etc/group; then
        groupadd $group
        __green "用户组 $group 创建成功"
    fi
}

# 创建用户
user_create() {
    local user=$1
    local group=${2:-$user}
    local shell=${3:-"/bin/bash"}
    
    if ! id -u $user &>/dev/null; then
        useradd -g $group -s $shell $user
        __green "用户 $user 创建成功"
    fi
}

#===============================================================
# 服务管理
#===============================================================

# 启动服务
service_start() {
    local service=$1
    systemctl start $service
}

# 停止服务
service_stop() {
    local service=$1
    systemctl stop $service
}

# 重启服务
service_restart() {
    local service=$1
    systemctl restart $service
}

# 启用服务开机自启
service_enable() {
    local service=$1
    systemctl enable $service
}

# 检查服务状态
service_status() {
    local service=$1
    systemctl is-active $service
}

#===============================================================
# 目录管理
#===============================================================

ISP_USER="isp"
ISP_GROUP="isp"
ISP_HOME="/home/isp"
ISP_APPS="$ISP_HOME/apps"
ISP_PKGS="$ISP_HOME/pkgs"
ISP_BIN="$ISP_HOME/bin"
ISP_LOGS="$ISP_HOME/logs"
ISP_HOSTS="$ISP_HOME/hosts"
ISP_CONFIG="$ISP_HOME/.config"

# 创建 ISP 目录结构
create_isp_dirs() {
    mkdir -p $ISP_APPS
    mkdir -p $ISP_PKGS
    mkdir -p $ISP_BIN
    mkdir -p $ISP_LOGS
    mkdir -p $ISP_HOSTS
    mkdir -p $ISP_CONFIG
    
    chown -R $ISP_USER:$ISP_GROUP $ISP_HOME
    chmod -R 775 $ISP_HOME
    chmod -R 777 $ISP_LOGS
    
    __green "ISP 目录结构创建完成"
}

#===============================================================
# 下载工具
#===============================================================

# 下载文件
download_file() {
    local url=$1
    local output=${2:-""}
    
    if command -v wget &> /dev/null; then
        if [ -n "$output" ]; then
            wget --no-check-certificate -O "$output" "$url"
        else
            wget --no-check-certificate "$url"
        fi
    elif command -v curl &> /dev/null; then
        if [ -n "$output" ]; then
            curl -L -o "$output" "$url"
        else
            curl -L -O "$url"
        fi
    else
        __red "未找到 wget 或 curl，请先安装"
        exit 1
    fi
}

#===============================================================
# 编译安装通用函数
#===============================================================

# 通用编译安装
compile_install() {
    local pkg_name=$1
    local pkg_url=$2
    local configure_opts=$3
    local build_dir=$4
    
    cd $ISP_PKGS
    
    # 下载
    if [ ! -f "$(basename $pkg_url)" ]; then
        __yellow "下载 $pkg_name ..."
        download_file "$pkg_url"
    fi
    
    # 解压
    local archive=$(basename $pkg_url)
    if [[ $archive == *.tar.gz ]] || [[ $archive == *.tgz ]]; then
        tar -xzf "$archive"
    elif [[ $archive == *.tar.xz ]]; then
        tar -xJf "$archive"
    elif [[ $archive == *.tar.bz2 ]]; then
        tar -xjf "$archive"
    elif [[ $archive == *.zip ]]; then
        unzip "$archive"
    fi
    
    # 进入目录
    if [ -n "$build_dir" ]; then
        cd "$build_dir"
    else
        cd "${archive%.*.*}" 2>/dev/null || cd "${archive%.*}"
    fi
    
    # 配置编译
    __yellow "配置 $pkg_name ..."
    ./configure $configure_opts
    
    # 编译
    __yellow "编译 $pkg_name ..."
    local nproc=$(nproc)
    make -j$nproc
    
    # 安装
    __yellow "安装 $pkg_name ..."
    make install
    
    __green "$pkg_name 安装完成"
}

#===============================================================
# 验证和检查
#===============================================================

# 检查是否为 root 用户
check_root() {
    if [ "$(id -u)" != "0" ]; then
        __red "此脚本需要 root 权限运行"
        __yellow "请使用: sudo $0"
        exit 1
    fi
}

# 检查命令是否存在
check_command() {
    local cmd=$1
    if ! command -v $cmd &> /dev/null; then
        return 1
    fi
    return 0
}

# 确保命令可用
ensure_command() {
    local cmd=$1
    local pkg=${2:-$1}
    
    if ! check_command $cmd; then
        __yellow "安装 $pkg ..."
        pkg_install $pkg
    fi
}

#===============================================================
# 初始化检测
#===============================================================

# 如果直接运行，显示系统信息
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    show_os_info
fi
