#!/bin/sh

ES_HOME=/home/isp/apps/elasticsearch

case "$1" in
    start)
         su isp -c "sh ${ES_HOME}/bin/elasticsearch -d -p ${ES_HOME}/pid"
         ;;
    stop)
         kill `cat ${ES_HOME}/pid`
         ;;
    restart)
         kill `cat ${ES_HOME}/pid`
         su isp -c "sh ${ES_HOME}/bin/elasticsearch -d -p ${ES_HOME}/pid"
         ;;
    status)
         if [ -f ${ES_HOME}/pid ]
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

