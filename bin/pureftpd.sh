#!/bin/sh

case "$1" in
    start)
         cd /home/isp/apps/pureftpd/sbin
         ./pure-ftpd -l mysql:/home/isp/apps/pureftpd/etc/pureftpd-mysql.conf -A --pidfile=/home/isp/apps/pureftpd/pureftpd.pid --passiveportrange=30000:30999 &
         ;;
    stop)
         cd /home/isp/apps/pureftpd
         kill `cat /home/isp/apps/pureftpd/pureftpd.pid`
         ;;
    restart)
         cd /home/isp/apps/pureftpd/sbin
         kill `cat /home/isp/apps/pureftpd/pureftpd.pid`
         ./pure-ftpd -l mysql:/home/isp/apps/pureftpd/etc/pureftpd-mysql.conf -A --pidfile=/home/isp/apps/pureftpd/pureftpd.pid --passiveportrange=30000:30999 &
         ;;
    status)
         if [ -f /home/isp/apps/pureftpd/pureftpd.pid ]
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
