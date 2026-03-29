#!/bin/sh

case "$1" in
    start)
         cd /home/isp/apps/rabbitmq/sbin
         ./rabbitmq-server -detached 
         ;;
    stop)
         cd /home/isp/apps/rabbitmq/sbin
         ./rabbitmqctl stop
         ;;
    restart)
         cd /home/isp/apps/rabbitmq/sbin
         ./rabbitmqctl stop
         sleep 1
         ./rabbitmq-server -detached
         ;;
    status)
         ps -fe|grep rabbitmq |grep -v grep
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
