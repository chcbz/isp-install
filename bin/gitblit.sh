#!/bin/bash
# chkconfig: 3 21 91
# description: Starts and Stops gitblit
# Source function library.
. /etc/init.d/functions

# change theses values (default values)
GITBLIT_PATH=/home/isp/apps/gitblit
GITBLIT_BASE_FOLDER=/home/isp/apps/gitblit/data
GITBLIT_HTTP_PORT=7070
GITBLIT_HTTPS_PORT=7071
GITBLIT_LOG=/var/log/gitblit.log
source ${GITBLIT_PATH}/java-proxy-config.sh
JAVA="java -server -Xmx1024M ${JAVA_PROXY_CONFIG} -Djava.awt.headless=true -jar"

JAVA_HOME=/home/isp/apps/jdk8
PATH=$JAVA_HOME/bin:$PATH
export JAVA_HOME PATH

RETVAL=0

case "$1" in
  start)
    if [ -f $GITBLIT_PATH/gitblit.jar ];
      then
      echo $"Starting gitblit server"
      cd $GITBLIT_PATH
      $JAVA $GITBLIT_PATH/gitblit.jar --httpsPort $GITBLIT_HTTPS_PORT --httpPort $GITBLIT_HTTP_PORT --baseFolder $GITBLIT_BASE_FOLDER --dailyLogFile &
      echo "."
      exit $RETVAL
    fi
  ;;

  stop)
    if [ -f $GITBLIT_PATH/gitblit.jar ];
      then
      echo $"Stopping gitblit server"
      cd $GITBLIT_PATH
      $JAVA $GITBLIT_PATH/gitblit.jar --baseFolder $GITBLIT_BASE_FOLDER --stop > /dev/null &
      echo "."
      exit $RETVAL
    fi
  ;;

  status)
    ps -fe|grep gitblit |grep -v grep
    if [ $? -eq 0 ]
      then
        printf "1"
      else
        printf "0"
    fi
  ;;
  
  force-reload|restart)
      $0 stop
      sleep 5
      $0 start
  ;;

  *)
    echo $"Usage: /etc/init.d/gitblit {start|stop|restart|force-reload}"
    exit 1
  ;;
esac

exit $RETVAL
