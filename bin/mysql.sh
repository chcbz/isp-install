#!/bin/sh

case "$1" in
    start)
         cd /home/isp/apps/mysql
         bin/mysqld_safe &
         ;;
    stop)
         cd /home/isp/apps/mysql
         bin/mysqladmin shutdown --sock=/home/isp/apps/mysql/mysql.sock -uroot -pcomeongogogo
         ;;
    restart)
         cd /home/isp/apps/mysql
         bin/mysqladmin shutdown --sock=/home/isp/apps/mysql/mysql.sock -uroot -pcomeongogogo
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
        echo "Usage: $0 {start|stop}"
        RETVAL=1
esac
