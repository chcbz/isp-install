#!/bin/sh

case "$1" in
    start)
         systemctl start xl2tpd
         ;;
    stop)
         systemctl stop xl2tpd
         ;;
    restart)
         systemctl restart xl2tpd
         ;;
    *)
        echo "Usage: $0 {start|stop}"
        RETVAL=1
esac
