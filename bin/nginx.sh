#!/bin/sh

case "$1" in
    start)
         cd /home/isp/apps/nginx/sbin
         ./nginx
         ;;
    stop)
         cd /home/isp/apps/nginx/sbin
         kill `cat /home/isp/apps/nginx/nginx.pid`
         ;;
    restart)
         cd /home/isp/apps/nginx/sbin
         kill `cat /home/isp/apps/nginx/nginx.pid`
         ./nginx
         ;;
    reload)
         cd /home/isp/apps/nginx/sbin
         a1=$(./nginx -t 2>&1)
         a2=$a1|sed -n '2p'|sed 's/^.*successful.*$/successful/'
         if [ $a2='successful' ]
         then
		/home/isp/apps/nginx/sbin/nginx -s reload	
         else
		echo $a1
         fi
         ;;
    status)
         if [ -f /home/isp/apps/nginx/nginx.pid ]
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
