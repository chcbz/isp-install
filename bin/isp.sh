#!/bin/sh

case "$1" in
    start)
         cd /home/isp/bin
         source /home/isp/bin/env.sh
         ./bind.sh start
         ./mysql.sh start
         ./redis.sh start
         ./gitblit.sh start
         ./php.sh start
         ./nginx.sh start
         ./smb.sh start
         ./nexus.sh start
         ./jenkins.sh start
         ./pptpd.sh start
	 ./rabbitmq.sh start
#         ./tomcat.sh start
#         ./dovecot.sh start
#         ./postfix.sh start
#         ./pureftpd.sh start
          service iptables start
         ;;
    stop)
         cd /home/isp/bin
         source /home/isp/bin/env.sh
         ./mysql.sh stop
         ./redis.sh stop
         ./gitblit.sh stop
         ./php.sh stop
         ./nginx.sh stop
         ./smb.sh stop
         ./pptpd.sh stop
         ./bind.sh stop
         ./nexus.sh stop
         ./jenkins.sh stop
#         ./tomcat.sh stop
#         ./dovecot.sh stop
#         ./postfix.sh stop
#         ./pureftpd.sh stop
          service iptables stop
         ;;
    restart)
         cd /home/isp/bin
         source /home/isp/bin/env.sh
         ./mysql.sh stop
         ./redis.sh stop
         ./gitblit.sh stop
         ./php.sh stop
         ./nginx.sh stop
         ./smb.sh stop
         ./pptpd.sh stop
         ./bind.sh stop
         ./nexus.sh stop
         ./jenkins.sh stop
#         ./tomcat.sh stop
#         ./dovecot.sh stop
#         ./postfix.sh stop
#         ./pureftpd.sh stop
         service iptables stop
         ./bind.sh start
         ./mysql.sh start
         ./redis.sh start
         ./gitblit.sh start
         ./php.sh start
         ./nginx.sh start
         ./smb.sh start
         ./pptpd.sh start
         ./nexus.sh start
         ./jenkins.sh start
         ./rabbitmq.sh start
#         ./tomcat.sh start
#         ./dovecot.sh start
#         ./postfix.sh start
#         ./pureftpd.sh start
          service iptables start
         ;;
    *)
        echo "Usage: $0 {start|stop|restart}"
        RETVAL=1
esac
