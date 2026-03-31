#!/bin/bash

# MySQL 安装脚本
# 密码通过交互式输入或环境变量 MYSQL_ROOT_PASSWORD 提供

set -e

# 获取 MySQL root 密码
if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
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
            echo "错误: 两次密码不一致或密码为空，请重新输入"
        fi
    done
else
    echo "使用环境变量 MYSQL_ROOT_PASSWORD 作为密码"
fi

# 保存密码到配置文件（仅 root 可读）
CONFIG_DIR="/home/isp/.config"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/mysql.pass" << EOF
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
EOF
chmod 600 "$CONFIG_DIR/mysql.pass"
echo "密码已保存到 $CONFIG_DIR/mysql.pass"

cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/mysql-5.6.22.tar.gz
tar -zxvf mysql-5.6.22.tar.gz
yum install -y gcc gcc-c++ ncurses-devel perl cmake make autoconf
cd mysql-5.6.22
cmake \
-DCMAKE_INSTALL_PREFIX=/home/isp/apps/mysql \
-DMYSQL_UNIX_ADDR=/home/isp/apps/mysql/mysql.sock \
-DDEFAULT_CHARSET=utf8 \
-DDEFAULT_COLLATION=utf8_general_ci \
-DWITH_INNOBASE_STORAGE_ENGINE=1 \
-DWITH_ARCHIVE_STORAGE_ENGINE=1 \
-DWITH_BLACKHOLE_STORAGE_ENGINE=1 \
-DMYSQL_DATADIR=/home/isp/apps/mysql/data \
-DMYSQL_TCP_PORT=3306 \
-DENABLE_DOWNLOADS=1
make
make install
groupadd mysql
useradd -g mysql mysql -M -s /sbin/nologin
chown -R mysql:mysql /home/isp/apps/mysql
cd /home/isp/apps/mysql
wget -N https://install.chcbz.net/conf/mysql/my.cnf
chmod 644 my.cnf
scripts/mysql_install_db --basedir=/home/isp/apps/mysql --datadir=/home/isp/apps/mysql/data --user=mysql
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/mysql.sh
chmod 777 mysql.sh
/home/isp/bin/mysql.sh start
sleep 3s
cd /home/isp/apps/mysql
bin/mysqladmin -uroot password "$MYSQL_ROOT_PASSWORD"
/home/isp/bin/mysql.sh stop

echo "=========================================="
echo "MySQL 安装完成!"
echo "root 密码已保存在 $CONFIG_DIR/mysql.pass"
echo "=========================================="
