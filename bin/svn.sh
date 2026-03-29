#!/bin/bash
case "$1" in
start)
        svnserve -d -r /home/isp/svnhome
        ;;
reload)
        killall svnserve && svnserve -d -r /home/isp/svnhome
        ;;
stop)
        killall svnserve
        echo "SVN Server Has Been Stopped"
	;;
*)
        echo "$0: Usage: $0 {start|status|stop|reload}"
        exit 1
esac
