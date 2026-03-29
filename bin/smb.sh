#!/bin/sh

# Source function library.
if [ -f /etc/init.d/functions ] ; then
  . /etc/init.d/functions
elif [ -f /etc/rc.d/init.d/functions ] ; then
  . /etc/rc.d/init.d/functions
else
  exit 1
fi

# Avoid using root's TMPDIR
unset TMPDIR

# Source networking configuration.
. /etc/sysconfig/network

# Options to smbd
SMBDOPTIONS="-D"
# Options to nmbd
NMBDOPTIONS="-D"
# Options for winbindd
WINBINDOPTIONS=""

SMB_HOME=/home/isp/apps/samba

# Check that networking is up.
[ ${NETWORKING} = "no" ] && exit 1

# Check that smb.conf exists.
[ -f $SMB_HOME/etc/smb.conf ] || exit 6

RETVAL=0


start() {
	sss_cache -E
        KIND="SMB"
	echo -n $"Starting $KIND services: "
	daemon $SMB_HOME/sbin/smbd $SMBDOPTIONS
        daemon $SMB_HOME/sbin/nmbd $NMBDOPTIONS
	RETVAL=$?
	echo
	[ $RETVAL -eq 0 ] && touch /var/lock/subsys/smb || \
	   RETVAL=1
	return $RETVAL
}	

stop() {
        KIND="SMB"
	echo -n $"Shutting down $KIND services: "
	killproc smbd
        killproc nmbd
	RETVAL=$?
	echo
	[ $RETVAL -eq 0 ] && rm -f /var/lock/subsys/smb
	return $RETVAL
}	

restart() {
	stop
	start
}	

reload() {
        echo -n $"Reloading smb.conf file: "
	killproc smbd -HUP
        killproc nmbd -HUP
	RETVAL=$?
	echo
	return $RETVAL
}	

rhstatus() {
	status -l smb smbd
	return $?
}	

configtest() {
	# First run testparm and check the exit status.
	# If it ain't 0, there was a problem, show them the testparm output.
	# Most of the time, though, testparm gives 0 - obvious problems
	# (like a missing config file) that testparm normally tells us about
	# have been checked for earlier in this script.
	/usr/bin/testparm -s &> /dev/null	
	RETVAL=$?
	if [ $RETVAL -ne 0 ]; then
		/usr/bin/testparm -s
		exit $RETVAL
	fi
	
	
	# Note: testparm returns 0 even if it has unknown parameters.
	# Check for the word 'unknown', and print the relevant section
	# if it appears. Return '3' because testparm doesn't usually
	# use that. 
	/usr/bin/testparm -s 2>&1 | grep -i unknown &> /dev/null 
	if [ $? -eq 0 ]; then
		RETVAL=3
		/usr/bin/testparm -s 2>&1 | grep -i unknown 
		exit $RETVAL
	fi

	# If testparm didn't fail and there weren't any unknowns, exit.
	echo Syntax OK
	return $RETVAL
}


# Allow status as non-root.
if [ "$1" = status ]; then
       rhstatus
       exit $?
fi

# Check that we are root ... so non-root users stop here
[  `id -u` -eq  "0" ] ||  exit 4



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
  reload)
  	reload
	;;
  status)
  	rhstatus
	;;
  configtest)
  	configtest
	;;
  condrestart)
  	[ -f /var/lock/subsys/smb ] && restart || :
	;;
  *)
	echo $"Usage: $0 {start|stop|restart|reload|configtest|status|condrestart}"
	exit 2
esac

exit $?
