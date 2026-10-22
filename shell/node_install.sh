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
# Explicit release input; never resolve a moving "latest" during installation.
# CYF host, Runtime artifact and Flow use this same LTS baseline (2026-10-22).
NODE_VERSION="${NODE_VERSION:-v24.22.1}"
INSTALL_PREFIX="$ISP_APPS/node"
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo 'NODE_VERSION must be an explicit vMAJOR.MINOR.PATCH' >&2; exit 1;
}
# Updating an existing host requires its release backup and process coordination;
# do not silently nest an extracted distribution in the existing installation.
[ ! -e "$INSTALL_PREFIX" ] && [ ! -L "$INSTALL_PREFIX" ] || {
    echo 'Existing Node installation: use the coordinated host upgrade procedure' >&2; exit 1;
}
NODE_ARCHIVE="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"

#===============================================================
# 下载 Node.js
#===============================================================
echo ""
echo "[1/3] 下载 Node.js ($NODE_VERSION)..."

cd $ISP_PKGS

if [ ! -f "$NODE_ARCHIVE" ]; then
    download_file "$NODE_URL"
fi

# Authenticate cached and freshly downloaded bytes against the release manifest.
SUMS_FILE="$(mktemp "$ISP_PKGS/.node-shasums.XXXXXX")"
trap 'rm -f -- "$SUMS_FILE"' EXIT
curl --fail --silent --show-error --location "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$SUMS_FILE"
NODE_SHA="$(awk -v name="$NODE_ARCHIVE" '$2 == name { print $1 }' "$SUMS_FILE")"
[ "${#NODE_SHA}" -eq 64 ] || { echo 'Missing release SHA256' >&2; exit 1; }
# The default release also has an independently fixed digest, shared with Flow.
if [ "$NODE_VERSION" = v24.22.1 ]; then
    [ "$NODE_SHA" = 6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 ] || exit 1
fi
printf '%s  %s\n' "$NODE_SHA" "$NODE_ARCHIVE" | sha256sum -c -

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[2/3] 解压安装 Node.js..."

mkdir -p $ISP_APPS
tar --no-same-owner -xJf "$NODE_ARCHIVE" -C "$ISP_APPS"

# Canonical host Node entry
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

NODE_HOME=/home/isp/apps/node

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
