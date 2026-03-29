#!/bin/sh

case "$1" in
    start)
         source /home/isp/bin/env.sh
         /home/isp/postfix/usr/sbin/postfix -c /home/isp/postfix/etc/postfix stop
         /home/isp/postfix/usr/sbin/postfix -c /home/isp/postfix/etc/postfix start
         ;;
    stop)
         source /home/isp/bin/env.sh
         /home/isp/postfix/usr/sbin/postfix -c /home/isp/postfix/etc/postfix stop
         ;;
    restart)
         source /home/isp/bin/env.sh
         /home/isp/postfix/usr/sbin/postfix -c /home/isp/postfix/etc/postfix stop
         /home/isp/postfix/usr/sbin/postfix -c /home/isp/postfix/etc/postfix start
         ;;
    *)
        echo "Usage: $0 {start|stop}"
        RETVAL=1
esac

