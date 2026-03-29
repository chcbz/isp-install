#!/bin/bash
# named a network name service.
# chkconfig: 345 35 75
# description: a name server
pidfile=/home/isp/apps/bind/var/run/named.pid
lockfile=/var/lock/subsys/named
conffile=/home/isp/apps/bind/etc/named.conf
named=/home/isp/apps/bind/sbin/named
prog=named
#source /etc/init.d/functions  
[ -r /etc/rc.d/init.d/functions ] && . /etc/rc.d/init.d/functions 
  
start() {
       if [ -e $lockfile ] ; then
               echo -n -e "$prog is already running.\n"
               warning
               echo -n -e \n
               exit 0
       fi
  
       echo -n "Starting $prog:"
       daemon --pidfile $pidfile $named -u named -c $conffile
       tetval=$?
       echo
       if [[ $retval -eq  0  ]] ; then
               touch $lockfile 
               return $retval
       else
               rm -f $lockfile $pidfile
                return 1
       fi
}
  
stop() {
       if [ ! -e $lockfile ] ; then
               echo -n "$prog is stopped."
               warning
               echo
               exit 0
       fi
  
       echo -n "Stopping $prog:"
       killproc $prog
       retval=$?
       echo
  
       if [[ $retval -eq 0 ]] ; then
               rm -f $lockfile $pidfile
               return 0
       else
               echo "Can't stop $prog"
               return 1
       fi
}
  
restart() {
       stop
       start
}
  
reload() {
       echo -n "Reload the $prog:"
       killproc -HUP $prog
       retval=$?
       echo
       return $retval
}
  
status() {
       if pidof $prog &>/dev/null; then
#               echo -n "$prog is running."
#               success
#               echo
	printf "1"
       else
#               echo -n "$prog is stopped."
#               success
#               echo
	printf "0"
       fi
}
  
usage() {
       echo "Usage:named {start|stop|status|reload|restart}"
}
  
case $1 in
start)
       start;;
stop)
       stop;;
restart)
       restart;;
status)
       status;;
reload)
       reload;;
*)
       usage
       exit 1
       ;;
esac
