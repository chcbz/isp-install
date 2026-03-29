#!/bin/sh

case "$1" in
    start)
         cd /home/isp/httpd/bin
         ./apachectl stop
         ./apachectl start
         ;;
    stop)
         cd /home/isp/httpd/bin
         ./apachectl stop
         ;;
    restart)
         cd /home/isp/httpd/bin
         ./apachectl stop
         ./apachectl start
         ;;
    *)
        echo "Usage: $0 {start|stop}"
        RETVAL=1
esac
