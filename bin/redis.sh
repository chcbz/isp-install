#!/bin/bash
#
# redis - this script starts and stops the redis-server daemon
#
# chkconfig:  - 80 12
# description: Redis is a persistent key-value database
# processname: redis-server
# config:   /home/isp/apps/redis/etc/redis.conf
# pidfile:   /home/isp/apps/redis/var/redis.pid
 
source /etc/init.d/functions
 
BIN="/home/isp/apps/redis/bin"
CONFIG="/home/isp/apps/redis/etc/redis.conf"
PIDFILE="/home/isp/apps/redis/var/redis.pid"
 
 
### Read configuration
[ -r "$SYSCONFIG" ] && source "$SYSCONFIG"
 
RETVAL=0
prog="redis-server"
desc="Redis Server"
 
start() {
 
    if [ -e $PIDFILE ];then
       echo "$desc already running...."
       exit 1
    fi
 
    echo -n $"Starting $desc: "
    daemon $BIN/$prog $CONFIG
 
    RETVAL=$?
    echo
    [ $RETVAL -eq 0 ] && touch /var/lock/subsys/$prog
    return $RETVAL
}
 
stop() {
    echo -n $"Stop $desc: "
    killproc $prog
    RETVAL=$?
    echo
    [ $RETVAL -eq 0 ] && rm -f /var/lock/subsys/$prog $PIDFILE
    return $RETVAL
}
 
restart() {
  stop
  start
}
 
case "$1" in
 start)
    start
    ;;
 stop)
    stop
    ;;
 restart)
    restart
    ;;
 condrestart)
    [ -e /var/lock/subsys/$prog ] && restart
    RETVAL=$?
    ;;
 status)
#    status $prog
#    RETVAL=$?
         if [ -e $PIDFILE ]
         then
                printf "1"
         else
                printf "0"
         fi
         ;;
  *)
    echo $"Usage: $0 {start|stop|restart|condrestart|status}"
    RETVAL=1
esac
 
exit $RETVAL
