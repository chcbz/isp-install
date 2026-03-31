#!/bin/bash
#===============================================================
# Node.js 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Node.js 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
# 可选版本: lts (长期支持) 或 current (最新版)
NODE_VERSION="${NODE_VERSION:-lts}"
INSTALL_PREFIX="$ISP_APPS/nodejs"

# 获取下载 URL
get_node_url() {
    local version=$1
    local arch="x64"
    
    if [ "$version" = "lts" ]; then
        # 获取最新 LTS 版本
        local lts_version=$(curl -sL https://nodejs.org/dist/index.json | grep -m1 '"lts"' | grep -oP '"version":\s*"\K[^"]+')
        echo "https://nodejs.org/dist/${lts_version}/node-${lts_version}-linux-${arch}.tar.xz"
    else
        echo "https://nodejs.org/dist/${version}/node-${version}-linux-${arch}.tar.xz"
    fi
}

NODE_URL=$(get_node_url $NODE_VERSION)
NODE_ARCHIVE=$(basename $NODE_URL)

#===============================================================
# 下载 Node.js
#===============================================================
echo ""
echo "[1/3] 下载 Node.js ($NODE_VERSION)..."

cd $ISP_PKGS

if [ ! -f "$NODE_ARCHIVE" ]; then
    download_file "$NODE_URL"
fi

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[2/3] 解压安装 Node.js..."

mkdir -p $ISP_APPS
tar -xJf $NODE_ARCHIVE -C $ISP_APPS

# 重命名为 nodejs
NODE_DIR=$(tar -tf $NODE_ARCHIVE | head -1 | cut -d'/' -f1)
mv $ISP_APPS/$NODE_DIR $INSTALL_PREFIX

# 创建符号链接
ln -sf $INSTALL_PREFIX/bin/node /usr/local/bin/node
ln -sf $INSTALL_PREFIX/bin/npm /usr/local/bin/npm
ln -sf $INSTALL_PREFIX/bin/npx /usr/local/bin/npx

#===============================================================
# 配置环境变量
#===============================================================
echo ""
echo "[3/3] 配置环境变量..."

# 添加到 profile
if ! grep -q "NODE_HOME=$INSTALL_PREFIX" /etc/profile; then
    cat >> /etc/profile << EOF

# Node.js Environment
export NODE_HOME=$INSTALL_PREFIX
export PATH=\$NODE_HOME/bin:\$PATH
EOF
    echo -e "${GREEN}环境变量配置完成${NC}"
fi

# 立即生效
export PATH=$INSTALL_PREFIX/bin:$PATH

# 配置 npm 全局目录
mkdir -p $INSTALL_PREFIX/global
mkdir -p $INSTALL_PREFIX/cache
$INSTALL_PREFIX/bin/npm config set prefix $INSTALL_PREFIX/global
$INSTALL_PREFIX/bin/npm config set cache $INSTALL_PREFIX/cache

# 设置淘宝镜像 (可选)
read -p "是否配置淘宝 npm 镜像? (y/n, 默认 n): " use_taobao
if [ "$use_taobao" = "y" ]; then
    $INSTALL_PREFIX/bin/npm config set registry https://registry.npmmirror.com
    echo -e "${GREEN}已配置淘宝 npm 镜像${NC}"
fi

# 安装常用全局包
echo "安装常用全局包..."
$INSTALL_PREFIX/bin/npm install -g yarn pnpm pm2

#===============================================================
# 创建管理脚本
#===============================================================
cat > $ISP_BIN/node.sh << 'SCRIPT'
#!/bin/bash

NODE_HOME=/home/isp/apps/nodejs

case "$1" in
    version|v)
        $NODE_HOME/bin/node --version
        $NODE_HOME/bin/npm --version
        ;;
    npm)
        shift
        $NODE_HOME/bin/npm "$@"
        ;;
    yarn)
        shift
        $NODE_HOME/bin/yarn "$@"
        ;;
    pm2)
        shift
        $NODE_HOME/bin/pm2 "$@"
        ;;
    update)
        echo "更新 npm..."
        $NODE_HOME/bin/npm install -g npm@latest
        ;;
    *)
        echo "Node.js 管理脚本"
        echo ""
        echo "Node 版本: $($NODE_HOME/bin/node --version)"
        echo "NPM 版本:  $($NODE_HOME/bin/npm --version)"
        echo ""
        echo "使用方法:"
        echo "  $0 version       显示版本"
        echo "  $0 npm <命令>    执行 npm 命令"
        echo "  $0 yarn <命令>   执行 yarn 命令"
        echo "  $0 pm2 <命令>    执行 pm2 命令"
        echo "  $0 update        更新 npm"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/node.sh

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Node.js 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "Node 版本: $($INSTALL_PREFIX/bin/node --version)"
echo "NPM 版本:  $($INSTALL_PREFIX/bin/npm --version)"
echo "Yarn 版本: $($INSTALL_PREFIX/bin/yarn --version)"
echo "PM2 版本:  $($INSTALL_PREFIX/bin/pm2 --version)"
echo ""
echo "使用方法:"
echo "  node --version      # 查看版本"
echo "  npm install <包>    # 安装包"
echo "  yarn add <包>       # 使用 yarn 安装"
echo "  pm2 start app.js    # 使用 PM2 管理进程"
echo ""
echo "请执行以下命令使环境变量生效:"
echo "  source /etc/profile"
