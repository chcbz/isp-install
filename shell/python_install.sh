#!/bin/bash
#===============================================================
# Python 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Python 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
PYTHON_VERSION="3.12.2"
PYTHON_URL="https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tgz"
INSTALL_PREFIX="$ISP_APPS/python3"

#===============================================================
# 安装编译依赖
#===============================================================
echo ""
echo "[1/4] 安装编译依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install gcc gcc-c++ make \
            openssl-devel bzip2-devel libffi-devel \
            zlib-devel xz-devel sqlite-devel \
            readline-devel ncurses-devel gdbm-devel \
            tk-devel
        ;;
    debian)
        pkg_install gcc g++ make \
            libssl-dev libbz2-dev libffi-dev \
            zlib1g-dev liblzma-dev libsqlite3-dev \
            libreadline-dev libncurses-dev libgdbm-dev \
            tk-dev
        ;;
esac

#===============================================================
# 下载源码
#===============================================================
echo ""
echo "[2/4] 下载 Python ${PYTHON_VERSION}..."

cd $ISP_PKGS

if [ ! -f "Python-${PYTHON_VERSION}.tgz" ]; then
    download_file "$PYTHON_URL"
fi

#===============================================================
# 编译安装
#===============================================================
echo ""
echo "[3/4] 编译安装 Python..."

tar -xzf Python-${PYTHON_VERSION}.tgz
cd Python-${PYTHON_VERSION}

# 配置
./configure \
    --prefix=$INSTALL_PREFIX \
    --enable-optimizations \
    --with-lto \
    --enable-shared \
    LDFLAGS="-Wl,-rpath,$INSTALL_PREFIX/lib"

# 编译 (使用所有 CPU 核心)
make -j$(nproc)

# 安装
make install

# 创建符号链接
ln -sf $INSTALL_PREFIX/bin/python3 $INSTALL_PREFIX/bin/python
ln -sf $INSTALL_PREFIX/bin/pip3 $INSTALL_PREFIX/bin/pip

echo -e "${GREEN}Python 编译安装完成${NC}"

#===============================================================
# 配置环境变量
#===============================================================
echo ""
echo "[4/4] 配置环境变量..."

# 添加到 profile
if ! grep -q "PYTHON_HOME=$INSTALL_PREFIX" /etc/profile; then
    cat >> /etc/profile << EOF

# Python Environment
export PYTHON_HOME=$INSTALL_PREFIX
export PATH=\$PYTHON_HOME/bin:\$PATH
export LD_LIBRARY_PATH=\$PYTHON_HOME/lib:\$LD_LIBRARY_PATH
EOF
    echo -e "${GREEN}环境变量配置完成${NC}"
fi

# 立即生效
export PATH=$INSTALL_PREFIX/bin:$PATH
export LD_LIBRARY_PATH=$INSTALL_PREFIX/lib:$LD_LIBRARY_PATH

# 升级 pip
echo "升级 pip..."
$INSTALL_PREFIX/bin/pip install --upgrade pip

# 安装常用包
echo "安装常用 Python 包..."
$INSTALL_PREFIX/bin/pip install virtualenv requests

#===============================================================
# 创建管理脚本
#===============================================================
cat > $ISP_BIN/python.sh << 'SCRIPT'
#!/bin/bash

PYTHON_HOME=/home/isp/apps/python3

case "$1" in
    venv)
        shift
        $PYTHON_HOME/bin/python -m venv "$@"
        echo "虚拟环境已创建: $1"
        ;;
    pip)
        shift
        $PYTHON_HOME/bin/pip "$@"
        ;;
    version)
        $PYTHON_HOME/bin/python --version
        ;;
    *)
        echo "Python 3.12 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  $0 venv <目录>   创建虚拟环境"
        echo "  $0 pip <命令>    执行 pip 命令"
        echo "  $0 version       显示版本"
        echo ""
        echo "直接使用:"
        echo "  python --version"
        echo "  pip install <包名>"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/python.sh

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Python 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "Python 版本: $($INSTALL_PREFIX/bin/python --version)"
echo "Pip 版本: $($INSTALL_PREFIX/bin/pip --version)"
echo ""
echo "使用方法:"
echo "  python --version           # 查看版本"
echo "  pip install <包名>         # 安装包"
echo "  python -m venv myenv       # 创建虚拟环境"
echo ""
echo "请执行以下命令使环境变量生效:"
echo "  source /etc/profile"
