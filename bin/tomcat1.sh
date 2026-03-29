#!/bin/sh
ulimit -n 4096
CATALINA_HOME=/home/isp/apps/tomcat1
JAVA_HOME=/home/isp/apps/jdk
PATH=$JAVA_HOME/bin:$PATH
INSTANCE_NAME=oa.admin1
#JAVA_OPTS="-Dtomcat.instance=$INSTANCE_NAME -Xm512m -Xmx1024m"
CATALINA_PID=$CATALINA_HOME/bin/$INSTANCE_NAME.pid
CATALINA_OPTS="$CATALINA_OPTS"

export CATALINA_HOME JAVA_HOME CATALINA_PID PATH
#export JAVA_OPTS

case "$1" in
    start)
                cd $CATALINA_HOME/bin
                ./startup.sh
                ;;
    stop)
                cd $CATALINA_HOME/bin
                ./shutdown.sh -force
                ;;
    restart)
		cd $CATALINA_HOME/bin
                ./shutdown.sh -force
                ./startup.sh
                ;;
    *)
        echo "Usage: $0 {start|stop}"
        RETVAL=1
esac
