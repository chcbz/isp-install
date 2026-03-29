#!/bin/sh
ulimit -n 65536

case "$1" in
    start)
         cd /home/isp/apps/nexus/bin
         ./nexus start
         ;;
    stop)
         cd /home/isp/apps/nexus/bin
         ./nexus stop
         ;;
    restart)
         cd /home/isp/apps/nexus/bin
         ./nexus restart
         ;;
    status)
         ps -fe|grep nexus |grep -v grep
         if [ $? -eq 0 ]
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
