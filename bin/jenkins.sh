#!/bin/bash
# chkconfig: 3 21 91
# description: Starts and Stops jenkins
# Source function library.
. /etc/init.d/functions

# change theses values (default values)
JENKINS_HOME=/home/isp/apps/jenkins
JENKINS_FILE_NAME=jenkins.war
JENKINS_LOG_FILE=$JENKINS_HOME/logs/jenkins.log
JENKINS_HTTP_PORT=49001
JAVA="java -Xms10m -Xmx200m -jar"
PID_FILE=$JENKINS_HOME/jenkins.pid

JAVA_HOME=/home/isp/apps/jdk8
PATH=$JAVA_HOME/bin:$PATH
export JAVA_HOME JENKINS_HOME PATH

RETVAL=0

case "$1" in
  start)
    if [ -f $PID_FILE ];then
      echo "jenkins already running..."
      exit 1
    fi

    echo $"Starting jenkins server"
    cd $JENKINS_HOME
    $JAVA $JENKINS_FILE_NAME --httpPort=$JENKINS_HTTP_PORT --daemon --logfile=$JENKINS_LOG_FILE
    ps -ef | grep $JENKINS_FILE_NAME | grep -v grep | awk '{print $2}' > $PID_FILE
    echo "."
    exit $RETVAL
  ;;

  stop)
    if [ -f $PID_FILE ];then
      echo $"Stopping jenkins server"
      kill `cat $PID_FILE`
      rm -rf $PID_FILE
      echo "."
      exit $RETVAL
    fi
  ;;
  status)
    if [ -f $PID_FILE ]
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
    echo $"Usage: /home/isp/bin/jenkins {start|stop|restart|force-reload}"
    exit 1
  ;;
esac

exit $RETVAL
