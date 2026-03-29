#!/bin/bash
# chkconfig: 3 21 91
# description: Starts and Stops jia
# Source function library.
. /etc/init.d/functions

# change theses values (default values)
JIA_HOME=/home/isp/hosts/jia
JIA_FILE_NAME=$2
JIA_OPTS=$3
JAVA="java -Xms10m -Xmx200m -jar"
PID_FILE=$JIA_HOME/$JIA_FILE_NAME.pid

JAVA_HOME=/home/isp/apps/jdk8
PATH=$JAVA_HOME/bin:$PATH
export JAVA_HOME PATH

RETVAL=0

init() {
    cd /home/isp/apps/nginx/conf/vhost
    echo "server" > $JIA_FILE_NAME.conf
    echo "{" >> $JIA_FILE_NAME.conf
    echo "  listen 80;" >> $JIA_FILE_NAME.conf
    echo "  server_name $JIA_FILE_NAME;" >> $JIA_FILE_NAME.conf
    echo "  access_log /usr/logs/$JIA_FILE_NAME.log main;" >> $JIA_FILE_NAME.conf
    echo "  location /" >> $JIA_FILE_NAME.conf
    echo "  {" >> $JIA_FILE_NAME.conf
    echo "    proxy_set_header MB-X-Forwarded-Host \$host;" >> $JIA_FILE_NAME.conf
    echo "    proxy_set_header MB-X-Forwarded-Host-Port \$host:\$server_port;" >> $JIA_FILE_NAME.conf
    echo "    proxy_set_header MB-X-Forwarded-For \$remote_addr;" >> $JIA_FILE_NAME.conf
    echo "    proxy_set_header Host \$http_host;" >> $JIA_FILE_NAME.conf
    echo "    proxy_pass http://127.0.0.1:$JIA_OPTS;" >> $JIA_FILE_NAME.conf
    echo "    proxy_redirect default;" >> $JIA_FILE_NAME.conf
    echo "    proxy_buffering on;" >> $JIA_FILE_NAME.conf
    echo "    proxy_buffer_size 64k;" >> $JIA_FILE_NAME.conf
    echo "    proxy_buffers 4 128k;" >> $JIA_FILE_NAME.conf
    echo "    proxy_busy_buffers_size 128k;" >> $JIA_FILE_NAME.conf
    echo "    proxy_store off;" >> $JIA_FILE_NAME.conf
    echo "    proxy_connect_timeout 20;" >> $JIA_FILE_NAME.conf
    echo "    proxy_send_timeout    60;" >> $JIA_FILE_NAME.conf
    echo "    proxy_read_timeout    60;" >> $JIA_FILE_NAME.conf
    echo "  }" >> $JIA_FILE_NAME.conf
    echo "}" >> $JIA_FILE_NAME.conf
    /home/isp/bin/nginx.sh reload
    echo "."
    return $RETVAL
}

start() {
    if [ -f $PID_FILE ];then
      echo "jia already running..."
      exit 1
    fi

    echo $"Starting jia server"
    cd $JIA_HOME
    echo $! > $PID_FILE
    nohup $JAVA $JIA_FILE_NAME $JIA_OPTS > $JIA_HOME/logs/startup.log 2>&1 &
    echo $! > $PID_FILE
#    ps -ef | grep $JIA_FILE_NAME | grep -vE 'grep|bash' | awk '{print $2}' > $PID_FILE
    echo "."
    return $RETVAL
}

stop() {
    if [ -f $PID_FILE ];then
      echo $"Stopping jia server"
      kill `cat $PID_FILE`
      rm -rf $PID_FILE
      echo "."
      return $RETVAL
    fi
}

restart() {
    stop
    sleep 0.5
    start
}

usage() {
    echo $"Usage: /home/isp/bin/jia {start|stop|restart|init}"
}
case $1 in
init)
       init;;
start)
       start;;
stop)
       stop;;
restart)
       restart;;
*)
       usage
       exit 1
       ;;
esac
