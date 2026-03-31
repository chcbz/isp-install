#!/bin/bash
#===============================================================
# Git 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Git 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
GIT_VERSION="2.44.0"
GIT_URL="https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.gz"
INSTALL_PREFIX="$ISP_APPS/git"

#===============================================================
# 安装编译依赖
#===============================================================
echo ""
echo "[1/3] 安装编译依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install make gcc gcc-c++ \
            openssl-devel curl-devel expat-devel \
            gettext-devel zlib-devel perl-ExtUtils-MakeMaker \
            docbook2X asciidoc xmlto
        ;;
    debian)
        pkg_install make gcc g++ \
            libssl-dev libcurl4-openssl-dev libexpat1-dev \
            gettext zlib1g-dev liberror-perl \
            docbook2x asciidoc xmlto
        ;;
esac

#===============================================================
# 下载源码
#===============================================================
echo ""
echo "[2/3] 下载 Git ${GIT_VERSION}..."

cd $ISP_PKGS

if [ ! -f "git-${GIT_VERSION}.tar.gz" ]; then
    download_file "$GIT_URL"
fi

#===============================================================
# 编译安装
#===============================================================
echo ""
echo "[3/3] 编译安装 Git..."

tar -xzf git-${GIT_VERSION}.tar.gz
cd git-${GIT_VERSION}

make prefix=$INSTALL_PREFIX all
make prefix=$INSTALL_PREFIX install

# 创建符号链接
ln -sf $INSTALL_PREFIX/bin/git /usr/local/bin/git
ln -sf $INSTALL_PREFIX/bin/gitk /usr/local/bin/gitk 2>/dev/null || true

# 配置环境变量
if ! grep -q "GIT_HOME=$INSTALL_PREFIX" /etc/profile; then
    cat >> /etc/profile << EOF

# Git Environment
export GIT_HOME=$INSTALL_PREFIX
export PATH=\$GIT_HOME/bin:\$PATH
EOF
fi

export PATH=$INSTALL_PREFIX/bin:$PATH

#===============================================================
# 基本配置
#===============================================================
echo ""
echo "配置 Git..."

# 设置默认用户名和邮箱 (如果未设置)
if [ -z "$(git config --global user.name 2>/dev/null)" ]; then
    read -p "请输入 Git 用户名: " git_username
    read -p "请输入 Git 邮箱: " git_email
    
    git config --global user.name "$git_username"
    git config --global user.email "$git_email"
fi

# 默认配置
git config --global init.defaultBranch main
git config --global core.editor vim
git config --global pull.rebase false
git config --global credential.helper store

# 中文文件名支持
git config --global core.quotepath false

# 配置别名
git config --global alias.st status
git config --global alias.co checkout
git config --global alias.br branch
git config --global alias.ci commit
git config --global alias.lg "log --oneline --graph --decorate --all"

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Git 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "Git 版本: $($INSTALL_PREFIX/bin/git --version)"
echo ""
echo "全局配置:"
git config --global --list 2>/dev/null | head -10
echo ""
echo "使用方法:"
echo "  git --version           # 查看版本"
echo "  git config --list       # 查看配置"
echo "  git clone <repo>        # 克隆仓库"
echo ""
echo "请执行以下命令使环境变量生效:"
echo "  source /etc/profile"
