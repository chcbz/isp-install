#!/bin/bash
#===============================================================
# RabbitMQ 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "RabbitMQ 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
ERLANG_VERSION="26.2.1"
RABBITMQ_VERSION="3.12.12"
INSTALL_PREFIX="$ISP_APPS/rabbitmq"
ERLANG_PREFIX="$ISP_APPS/erlang"

#===============================================================
# 获取 RabbitMQ 管理员密码
#===============================================================
if [ -z "$RABBITMQ_ADMIN_PASSWORD" ]; then
    echo ""
    echo "=========================================="
    echo "请设置 RabbitMQ 管理员密码"
    echo "=========================================="
    while true; do
        read -s -p "请输入 admin 用户密码: " RABBITMQ_ADMIN_PASSWORD
        echo
        read -s -p "请再次确认密码: " RABBITMQ_ADMIN_PASSWORD_CONFIRM
        echo
        if [ "$RABBITMQ_ADMIN_PASSWORD" = "$RABBITMQ_ADMIN_PASSWORD_CONFIRM" ] && [ -n "$RABBITMQ_ADMIN_PASSWORD" ]; then
            break
        else
            echo -e "${RED}错误: 两次密码不一致或密码为空，请重新输入${NC}"
        fi
    done
fi

# 保存密码
mkdir -p $ISP_CONFIG
cat > $ISP_CONFIG/rabbitmq.pass << EOF
RABBITMQ_ADMIN_PASSWORD=$RABBITMQ_ADMIN_PASSWORD
EOF
chmod 600 $ISP_CONFIG/rabbitmq.pass

#===============================================================
# 安装依赖
#===============================================================
echo ""
echo "[1/4] 安装依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install make gcc gcc-c++ perl \
            ncurses-devel openssl-devel \
            unixODBC unixODBC-devel
        ;;
    debian)
        pkg_install make gcc g++ perl \
            libncurses-dev libssl-dev \
            unixodbc-dev
        ;;
esac

#===============================================================
# 下载 Erlang/OTP
#===============================================================
echo ""
echo "[2/4] 下载并安装 Erlang/OTP..."

cd $ISP_PKGS

# 使用预编译的 Erlang (更快更可靠)
ERLANG_URL="https://github.com/rabbitmq/erlang-rpm/releases/download/v${ERLANG_VERSION}/erlang-${ERLANG_VERSION}-1.el$(rpm -E '%{rhel}' 2>/dev/null || echo "8").x86_64.rpm"

if [ "$OS_FAMILY" = "rhel" ]; then
    # RHEL 系列 - 使用 RPM 包
    if [ ! -f "erlang-${ERLANG_VERSION}.rpm" ]; then
        download_file "$ERLANG_URL" "erlang-${ERLANG_VERSION}.rpm" || {
            # 如果下载失败，尝试从源码编译
            echo -e "${YELLOW}预编译包下载失败，将从源码编译...${NC}"
            ERLANG_SRC_URL="https://github.com/erlang/otp/releases/download/OTP-${ERLANG_VERSION}/otp_src_${ERLANG_VERSION}.tar.gz"
            download_file "$ERLANG_SRC_URL"
            tar -xzf otp_src_${ERLANG_VERSION}.tar.gz
            cd otp_src_${ERLANG_VERSION}
            ./configure --prefix=$ERLANG_PREFIX --without-javac
            make -j$(nproc)
            make install
            
            # 配置环境变量
            if ! grep -q "ERLANG_HOME=$ERLANG_PREFIX" /etc/profile; then
                cat >> /etc/profile << EOF

# Erlang Environment
export ERLANG_HOME=$ERLANG_PREFIX
export PATH=\$ERLANG_HOME/bin:\$PATH
EOF
            fi
            export PATH=$ERLANG_PREFIX/bin:$PATH
        }
    fi
else
    # Debian 系列 - 使用 apt 仓库
    echo "安装 Erlang from Erlang Solutions..."
    pkg_install gnupg apt-transport-https
    
    # 添加 Erlang Solutions 仓库
    wget -O- https://packages.erlang-solutions.com/ubuntu/erlang_solutions.asc | apt-key add - 2>/dev/null || true
    echo "deb https://packages.erlang-solutions.com/ubuntu $(lsb_release -sc 2>/dev/null || echo "focal") contrib" > /etc/apt/sources.list.d/erlang.list
    
    apt update
    pkg_install esl-erlang
fi

#===============================================================
# 下载 RabbitMQ
#===============================================================
echo ""
echo "[3/4] 下载并安装 RabbitMQ..."

cd $ISP_PKGS

RABBITMQ_URL="https://github.com/rabbitmq/rabbitmq-server/releases/download/v${RABBITMQ_VERSION}/rabbitmq-server-generic-unix-${RABBITMQ_VERSION}.tar.xz"

if [ ! -f "rabbitmq-server-generic-unix-${RABBITMQ_VERSION}.tar.xz" ]; then
    download_file "$RABBITMQ_URL"
fi

# 解压
mkdir -p $ISP_APPS
tar -xJf rabbitmq-server-generic-unix-${RABBITMQ_VERSION}.tar.xz -C $ISP_APPS
mv $ISP_APPS/rabbitmq_server-${RABBITMQ_VERSION} $INSTALL_PREFIX

# 创建必要目录
mkdir -p $INSTALL_PREFIX/var/log/rabbitmq
mkdir -p $INSTALL_PREFIX/var/lib/rabbitmq/mnesia

# 设置环境变量
if ! grep -q "RABBITMQ_HOME=$INSTALL_PREFIX" /etc/profile; then
    cat >> /etc/profile << EOF

# RabbitMQ Environment
export RABBITMQ_HOME=$INSTALL_PREFIX
export PATH=\$RABBITMQ_HOME/sbin:\$PATH
EOF
fi
export PATH=$INSTALL_PREFIX/sbin:$PATH

#===============================================================
# 配置并启动
#===============================================================
echo ""
echo "[4/4] 配置并启动 RabbitMQ..."

# 配置文件
mkdir -p $INSTALL_PREFIX/etc/rabbitmq
cat > $INSTALL_PREFIX/etc/rabbitmq/rabbitmq.conf << EOF
# 监听地址
listeners.tcp.default = 5672
management.tcp.port = 15672

# 数据目录
default_user = guest
default_pass = guest

# 内存限制
vm_memory_high_watermark.relative = 0.6

# 日志
log.console.level = info
EOF

# 启动 RabbitMQ
cd $INSTALL_PREFIX
sbin/rabbitmq-server -detached

# 等待启动
echo "等待 RabbitMQ 启动..."
sleep 10

# 启用管理插件
sbin/rabbitmq-plugins enable rabbitmq_management

# 创建管理员用户
sbin/rabbitmqctl add_user admin "$RABBITMQ_ADMIN_PASSWORD"
sbin/rabbitmqctl set_user_tags admin administrator
sbin/rabbitmqctl set_permissions -p / admin ".*" ".*" ".*"

#===============================================================
# 创建管理脚本
#===============================================================
cat > $ISP_BIN/rabbitmq.sh << SCRIPT
#!/bin/bash

RABBITMQ_HOME=$INSTALL_PREFIX

case "\$1" in
    start)
        \$RABBITMQ_HOME/sbin/rabbitmq-server -detached
        echo "RabbitMQ started"
        ;;
    stop)
        \$RABBITMQ_HOME/sbin/rabbitmqctl stop_app
        \$RABBITMQ_HOME/sbin/rabbitmqctl stop
        echo "RabbitMQ stopped"
        ;;
    restart)
        \$RABBITMQ_HOME/sbin/rabbitmqctl stop_app
        sleep 2
        \$RABBITMQ_HOME/sbin/rabbitmqctl start_app
        echo "RabbitMQ restarted"
        ;;
    status)
        \$RABBITMQ_HOME/sbin/rabbitmqctl status
        ;;
    cli)
        \$RABBITMQ_HOME/sbin/rabbitmqctl "\$2" "\$3" "\$4"
        ;;
    plugins)
        \$RABBITMQ_HOME/sbin/rabbitmq-plugins list
        ;;
    enable)
        shift
        \$RABBITMQ_HOME/sbin/rabbitmq-plugins enable "\$@"
        ;;
    *)
        echo "RabbitMQ 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  \$0 start          启动"
        echo "  \$0 stop           停止"
        echo "  \$0 restart        重启"
        echo "  \$0 status         状态"
        echo "  \$0 plugins        列出插件"
        echo "  \$0 enable <插件>  启用插件"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/rabbitmq.sh

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "RabbitMQ 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "版本: $RABBITMQ_VERSION"
echo "管理脚本: $ISP_BIN/rabbitmq.sh"
echo ""
echo "访问地址:"
echo "  AMQP:      localhost:5672"
echo "  管理界面:  http://localhost:15672"
echo ""
echo "用户信息:"
echo "  用户名: admin"
echo "  密码: (你设置的密码)"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/rabbitmq.sh start    # 启动"
echo "  $ISP_BIN/rabbitmq.sh stop     # 停止"
echo "  $ISP_BIN/rabbitmq.sh status   # 状态"
echo ""
echo "请执行以下命令使环境变量生效:"
echo "  source /etc/profile"
