#!/bin/bash
#===============================================================
# MySQL 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "MySQL 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
MYSQL_VERSION="8.0.45"
MYSQL_URL="https://dev.mysql.com/get/Downloads/MySQL-8.0/mysql-${MYSQL_VERSION}-linux-glibc2.28-x86_64.tar.xz"
INSTALL_PREFIX="$ISP_APPS/mysql"
MYSQL_USER="mysql"
MYSQL_GROUP="mysql"

#===============================================================
# 获取 MySQL root 密码
#===============================================================
if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    echo ""
    echo "=========================================="
    echo "请设置 MySQL root 用户密码"
    echo "=========================================="
    while true; do
        read -s -p "请输入密码: " MYSQL_ROOT_PASSWORD
        echo
        read -s -p "请再次确认密码: " MYSQL_ROOT_PASSWORD_CONFIRM
        echo
        if [ "$MYSQL_ROOT_PASSWORD" = "$MYSQL_ROOT_PASSWORD_CONFIRM" ] && [ -n "$MYSQL_ROOT_PASSWORD" ]; then
            break
        else
            echo -e "${RED}错误: 两次密码不一致或密码为空，请重新输入${NC}"
        fi
    done
else
    echo -e "${GREEN}使用环境变量 MYSQL_ROOT_PASSWORD 作为密码${NC}"
fi

# 保存密码到配置文件
mkdir -p $ISP_CONFIG
cat > $ISP_CONFIG/mysql.pass << EOF
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
EOF
chmod 600 $ISP_CONFIG/mysql.pass
echo -e "${GREEN}密码已保存到 $ISP_CONFIG/mysql.pass${NC}"

#===============================================================
# 安装依赖
#===============================================================
echo ""
echo "[1/5] 安装依赖..."

case $OS_FAMILY in
    rhel)
        pkg_install libaio numactl-libs
        ;;
    debian)
        pkg_install libaio1 libnuma1
        ;;
esac

#===============================================================
# 创建用户和目录
#===============================================================
echo ""
echo "[2/5] 创建用户和目录..."

# 创建用户组
if ! grep -q "^$MYSQL_GROUP:" /etc/group; then
    groupadd $MYSQL_GROUP
fi

# 创建用户
if ! id -u $MYSQL_USER &>/dev/null; then
    useradd -g $MYSQL_GROUP -M -s /sbin/nologin $MYSQL_USER
fi

# 创建目录
mkdir -p $INSTALL_PREFIX
mkdir -p $INSTALL_PREFIX/data
mkdir -p $INSTALL_PREFIX/logs

#===============================================================
# 下载 MySQL
#===============================================================
echo ""
echo "[3/5] 下载 MySQL..."

cd $ISP_PKGS

if [ ! -f "mysql-${MYSQL_VERSION}-linux-glibc2.28-x86_64.tar.xz" ]; then
    echo "下载 MySQL ${MYSQL_VERSION}..."
    download_file "$MYSQL_URL"
fi

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[4/5] 解压安装 MySQL..."

tar -xJf mysql-${MYSQL_VERSION}-linux-glibc2.28-x86_64.tar.xz -C $ISP_APPS
mv $ISP_APPS/mysql-${MYSQL_VERSION}-linux-glibc2.28-x86_64/* $INSTALL_PREFIX/
rm -rf $ISP_APPS/mysql-${MYSQL_VERSION}-linux-glibc2.28-x86_64

# 设置权限
chown -R $MYSQL_USER:$MYSQL_GROUP $INSTALL_PREFIX

#===============================================================
# 初始化和配置
#===============================================================
echo ""
echo "[5/5] 初始化 MySQL..."

# 创建配置文件
cat > $INSTALL_PREFIX/my.cnf << EOF
[mysqld]
# 基本配置
basedir=$INSTALL_PREFIX
datadir=$INSTALL_PREFIX/data
socket=$INSTALL_PREFIX/mysql.sock
port=3306
user=$MYSQL_USER

# 字符集
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci

# 日志
log-error=$INSTALL_PREFIX/logs/mysql.log
pid-file=$INSTALL_PREFIX/mysql.pid

# 性能优化
max_connections=500
innodb_buffer_pool_size=256M
innodb_log_file_size=64M
innodb_flush_log_at_trx_commit=2
innodb_flush_method=O_DIRECT

# 其他
explicit_defaults_for_timestamp=ON
lower_case_table_names=1
EOF

# 初始化数据库
echo "初始化数据库..."
cd $INSTALL_PREFIX
bin/mysqld --initialize --user=$MYSQL_USER --basedir=$INSTALL_PREFIX --datadir=$INSTALL_PREFIX/data

# 获取临时密码
TEMP_PASSWORD=$(grep 'temporary password' $INSTALL_PREFIX/logs/mysql.log | tail -1 | awk '{print $NF}')
if [ -n "$TEMP_PASSWORD" ]; then
    echo -e "${YELLOW}临时密码: $TEMP_PASSWORD${NC}"
fi

# 创建管理脚本
cat > $ISP_BIN/mysql.sh << SCRIPT
#!/bin/bash

MYSQL_HOME=$INSTALL_PREFIX
MYSQL_PASS_FILE="$ISP_CONFIG/mysql.pass"

# 加载密码配置
if [ -f "\$MYSQL_PASS_FILE" ]; then
    source "\$MYSQL_PASS_FILE"
fi

# 如果还是没有密码，提示用户输入
if [ -z "\$MYSQL_ROOT_PASSWORD" ]; then
    read -s -p "请输入 MySQL root 密码: " MYSQL_ROOT_PASSWORD
    echo
fi

case "\$1" in
    start)
        cd \$MYSQL_HOME
        bin/mysqld_safe --defaults-file=\$MYSQL_HOME/my.cnf &
        echo "MySQL started"
        ;;
    stop)
        cd \$MYSQL_HOME
        bin/mysqladmin shutdown --socket=\$MYSQL_HOME/mysql.sock -uroot -p"\$MYSQL_ROOT_PASSWORD"
        echo "MySQL stopped"
        ;;
    restart)
        cd \$MYSQL_HOME
        bin/mysqladmin shutdown --socket=\$MYSQL_HOME/mysql.sock -uroot -p"\$MYSQL_ROOT_PASSWORD" 2>/dev/null || true
        sleep 2
        bin/mysqld_safe --defaults-file=\$MYSQL_HOME/my.cnf &
        echo "MySQL restarted"
        ;;
    status)
        if [ -e \$MYSQL_HOME/mysql.sock ]; then
            echo "MySQL is running"
        else
            echo "MySQL is not running"
        fi
        ;;
    cli)
        \$MYSQL_HOME/bin/mysql --socket=\$MYSQL_HOME/mysql.sock -uroot -p"\$MYSQL_ROOT_PASSWORD"
        ;;
    *)
        echo "Usage: \$0 {start|stop|restart|status|cli}"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/mysql.sh

# 启动 MySQL
echo "启动 MySQL..."
$ISP_BIN/mysql.sh start
sleep 5

# 设置 root 密码
if [ -n "$TEMP_PASSWORD" ]; then
    # MySQL 8.0 需要先用临时密码登录，再修改密码
    cd $INSTALL_PREFIX
    bin/mysql --socket=$INSTALL_PREFIX/mysql.sock -uroot -p"$TEMP_PASSWORD" --connect-expired-password << SQLSQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '$MYSQL_ROOT_PASSWORD';
FLUSH PRIVILEGES;
SQLSQL
else
    # 没有临时密码，直接设置
    cd $INSTALL_PREFIX
    bin/mysql --socket=$INSTALL_PREFIX/mysql.sock -uroot << SQLSQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '$MYSQL_ROOT_PASSWORD';
FLUSH PRIVILEGES;
SQLSQL
fi

# 停止 MySQL
$ISP_BIN/mysql.sh stop

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "MySQL 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "配置文件: $INSTALL_PREFIX/my.cnf"
echo "管理脚本: $ISP_BIN/mysql.sh"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/mysql.sh start    # 启动"
echo "  $ISP_BIN/mysql.sh stop     # 停止"
echo "  $ISP_BIN/mysql.sh restart  # 重启"
echo "  $ISP_BIN/mysql.sh status   # 状态"
echo "  $ISP_BIN/mysql.sh cli      # 命令行客户端"
echo ""
echo "root 密码已保存在 $ISP_CONFIG/mysql.pass"
