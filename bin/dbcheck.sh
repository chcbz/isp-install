#!/bin/sh
DBCHECK_HOME=/home/isp/dbcheck
JAVA_HOME=/home/isp/jdk
DBCHECK_PID=dbcheck.pid

case "$1" in
    start)
                cd $DBCHECK_HOME
                kill -9 `cat $DBCHECK_PID`
		rm -f $DBCHECK_PID
                $JAVA_HOME/bin/java -cp app-checkdbconn.jar com.s60sign.CheckDbConn > log.txt &
		echo $! > $DBCHECK_PID
                ;;
    stop)
                cd $DBCHECK_HOME
		kill -9 `cat $DBCHECK_PID`
		rm -f $DBCHECK_PID
                ;;
    *)
        echo "Usage: $0 {start|stop}"
        RETVAL=1
esac
