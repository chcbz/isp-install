#!/bin/bash

# MySQL 管理脚本
# 密码从配置文件读取或使用环境变量

MYSQL_PASS_FILE="/home/isp/.config/mysql.pass"

# 加载密码配置
if [ -f "$MYSQL_PASS_FILE" ]; then
    source "$MYSQL_PASS_FILE"
fi

# 如果还是没有密码，提示用户输入
if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    read -s -p "请输入 MySQL root 密码: " MYSQL_ROOT_PASSWORD
    echo
fi

case "$1" in
    start)
         cd /home/isp/apps/mysql
         bin/mysqld_safe &
         ;;
    stop)
         cd /home/isp/apps/mysql
         bin/mysqladmin shutdown --sock=/home/isp/apps/mysql/mysql.sock -uroot -p"$MYSQL_ROOT_PASSWORD"
         ;;
    restart)
         cd /home/isp/apps/mysql
         bin/mysqladmin shutdown --sock=/home/isp/apps/mysql/mysql.sock -uroot -p"$MYSQL_ROOT_PASSWORD"
         bin/mysqld_safe &
         ;;
    status)
         if [ -e /home/isp/apps/mysql/mysql.sock ]
         then
                printf "1"
         else
                printf "0"
         fi
         ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        RETVAL=1
esac
