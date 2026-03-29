#!/bin/sh

PPTPD_HOME=/home/isp/apps/pptpd

case "$1" in
    start)
         $PPTPD_HOME/sbin/pptpd -c $PPTPD_HOME/etc/pptpd.conf -o $PPTPD_HOME/etc/options.pptpd -p $PPTPD_HOME/var/run/pptpd.pid
         ;;
    stop)
         kill `cat $PPTPD_HOME/var/run/pptpd.pid`
         ;;
    restart)
         kill `cat $PPTPD_HOME/var/run/pptpd.pid`
         $PPTPD_HOME/sbin/pptpd -c $PPTPD_HOME/etc/pptpd.conf -o $PPTPD_HOME/etc/options.pptpd -p $PPTPD_HOME/var/run/pptpd.pid
         ;;
    status)
         if [ -f $PPTPD_HOME/var/run/pptpd.pid ]
         then
                printf "1"
         else
                printf "0"
         fi
         ;;
    *)
        echo "Usage: $0 {start|stop|restart}"
        RETVAL=1
esac
