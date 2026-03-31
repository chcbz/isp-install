#!/bin/bash

# Pure-FTPd 安装脚本
# 密码从配置文件读取或交互式输入

set -e

MYSQL_PASS_FILE="/home/isp/.config/mysql.pass"
ISP_PASS_FILE="/home/isp/.config/isp_db.pass"

# 检查并安装 MySQL
if [ ! -d "/home/isp/apps/mysql/" ]; then
    echo "MySQL 未安装，请先运行 mysql_install.sh"
    exit 1
fi

# 加载 MySQL root 密码
if [ -f "$MYSQL_PASS_FILE" ]; then
    source "$MYSQL_PASS_FILE"
fi

# 如果还是没有 MySQL 密码，提示用户输入
if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    echo "=========================================="
    echo "请输入 MySQL root 密码"
    echo "=========================================="
    read -s -p "MySQL root 密码: " MYSQL_ROOT_PASSWORD
    echo
fi

# 获取 ISP 数据库密码
if [ -z "$ISP_DB_PASSWORD" ]; then
    echo "=========================================="
    echo "请设置 ISP 数据库用户密码"
    echo "=========================================="
    while true; do
        read -s -p "请输入 ISP 数据库密码: " ISP_DB_PASSWORD
        echo
        read -s -p "请再次确认密码: " ISP_DB_PASSWORD_CONFIRM
        echo
        if [ "$ISP_DB_PASSWORD" = "$ISP_DB_PASSWORD_CONFIRM" ] && [ -n "$ISP_DB_PASSWORD" ]; then
            break
        else
            echo "错误: 两次密码不一致或密码为空，请重新输入"
        fi
    done
    
    # 保存 ISP 数据库密码
    mkdir -p "$(dirname "$ISP_PASS_FILE")"
    cat > "$ISP_PASS_FILE" << EOF
ISP_DB_PASSWORD=$ISP_DB_PASSWORD
EOF
    chmod 600 "$ISP_PASS_FILE"
    echo "ISP 数据库密码已保存到 $ISP_PASS_FILE"
fi

# 启动 MySQL（如果未运行）
/home/isp/bin/mysql.sh status
if [ $? = "0" ] ;then
    /home/isp/bin/mysql.sh start
    sleep 3s
fi

# 创建数据库和用户
cd /home/isp/apps/mysql
bin/mysql -uroot -p"$MYSQL_ROOT_PASSWORD" << EOF
CREATE DATABASE IF NOT EXISTS isp DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
use isp;

CREATE TABLE IF NOT EXISTS isp_domain (
  no int(11) NOT NULL AUTO_INCREMENT,
  domain_name varchar(250) NOT NULL DEFAULT '',
  admin_passwd varchar(250) NOT NULL DEFAULT '',
  admin_flag int(11) NOT NULL DEFAULT '0',
  mailbox_service tinyint(1) NOT NULL DEFAULT '0',
  mailbox_count int(11) NOT NULL DEFAULT '0',
  mailbox_quota int(11) NOT NULL DEFAULT '0',
  host_service tinyint(1) NOT NULL DEFAULT '0',
  host_type varchar(20) NOT NULL DEFAULT '',
  host_passwd varchar(250) NOT NULL DEFAULT '',
  host_quota int(11) NOT NULL DEFAULT '0',
  sql_service tinyint(1) NOT NULL DEFAULT '0',
  sql_passwd varchar(250) NOT NULL DEFAULT '0',
  sql_quota int(11) NOT NULL DEFAULT '0',
  ftp_dir varchar(250) DEFAULT NULL,
  PRIMARY KEY (no),
  UNIQUE KEY uni_domain_name (domain_name)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS isp_ftp_user (
  no int(11) NOT NULL AUTO_INCREMENT,
  ftp_user_domain_no int(11) NOT NULL DEFAULT '0',
  ftp_user_name varchar(50) NOT NULL DEFAULT '',
  ftp_user_password varchar(50) NOT NULL DEFAULT '',
  ftp_user_path varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (no)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

GRANT ALL PRIVILEGES ON isp.* TO 'isp'@'%' IDENTIFIED BY '$ISP_DB_PASSWORD' WITH GRANT OPTION;
FLUSH PRIVILEGES;

EOF

# 安装 Pure-FTPd
cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/pure-ftpd-1.0.36.tar.gz
tar -zxvf pure-ftpd-1.0.36.tar.gz
yum install -y gcc gcc-c++ make pam-devel openldap-devel mysql-devel
cd pure-ftpd-1.0.36
./configure --prefix=/home/isp/apps/pureftpd/ --with-mysql=/home/isp/apps/mysql --with-language=simplified-chinese --with-everything
make
make install

# 创建配置目录
cd /home/isp/apps/pureftpd
mkdir -p etc

# 生成 MySQL 配置文件（使用用户输入的密码）
cat > etc/pureftpd-mysql.conf << EOF
#MYSQLServer     localhost
#MYSQLPort       3306
MYSQLSocket     /home/isp/apps/mysql/mysql.sock
MYSQLUser       root
MYSQLPassword   $MYSQL_ROOT_PASSWORD
MYSQLDatabase   isp
MYSQLCrypt      cleartext
MYSQLGetPW	SELECT u.ftp_user_password as passwd FROM isp_domain d join isp_ftp_user u on d.no=u.ftp_user_domain_no WHERE u.ftp_user_name="\L" and d.host_service=1
MYSQLGetUID     SELECT 1000
MYSQLGetGID     SELECT 1000
MYSQLGetDir	SELECT concat('/home/isp/hosts/',d.ftp_dir,'/',u.ftp_user_path) from isp_domain d join isp_ftp_user u on d.no=u.ftp_user_domain_no WHERE u.ftp_user_name="\L"
EOF
chmod 600 etc/pureftpd-mysql.conf

cd /home/isp/bin
wget -N https://install.chcbz.net/bin/pureftpd.sh
chmod 777 pureftpd.sh

echo "=========================================="
echo "Pure-FTPd 安装完成!"
echo "MySQL root 密码配置: $MYSQL_PASS_FILE"
echo "ISP 数据库密码配置: $ISP_PASS_FILE"
echo "=========================================="
