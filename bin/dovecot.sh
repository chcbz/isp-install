#!/bin/sh

case "$1" in
    start)
         kill `cat /home/isp/dovecot/var/run/dovecot/master.pid`
         /home/isp/dovecot/sbin/dovecot
         ;;
    stop)
         kill `cat /home/isp/dovecot/var/run/dovecot/master.pid`
         ;;
    restart)
         kill `cat /home/isp/dovecot/var/run/dovecot/master.pid`
         /home/isp/dovecot/sbin/dovecot
         ;;
    *)
        echo "Usage: $0 {start|stop}"
        RETVAL=1
esac

