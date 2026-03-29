#!/bin/bash

if [ ! -d "/home/isp/apps/mysql/" ]; then
    curl -s -S -L https://install.chcbz.net/shell/mysql_install.sh | /bin/sh
fi

/home/isp/bin/mysql.sh status
if [ $? = "0" ] ;then
    /home/isp/bin/mysql.sh start
    sleep 3s
fi

cd /home/isp/apps/mysql
bin/mysql -uroot -pcomeongogogo << EOF
CREATE DATABASE isp DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
use isp;

CREATE TABLE isp_domain (
  no int(11) NOT NULL AUTO_INCREMENT,
  domain_name varchar(250) NOT NULL DEFAULT '',
  admin_passwd varchar(250) NOT NULL DEFAULT '',
  admin_flag int(11) NOT NULL DEFAULT '0',
  mailbox_service tinyint(1) NOT NULL DEFAULT '0',
  mailbox_count int(11) NOT NULL DEFAULT '0',
  mailbox_quota int(11) NOT NULL DEFAULT '0',
  host_service tinyint(1) NOT NULL DEFAULT '0',
  host_type varchar(20) NOT NULL DEFAULT '',
  host_passwd varchar(250) NOT NULL DEFAULT '',
  host_quota int(11) NOT NULL DEFAULT '0',
  sql_service tinyint(1) NOT NULL DEFAULT '0',
  sql_passwd varchar(250) NOT NULL DEFAULT '0',
  sql_quota int(11) NOT NULL DEFAULT '0',
  ftp_dir varchar(250) DEFAULT NULL,
  PRIMARY KEY (no),
  UNIQUE KEY uni_domain_name (domain_name)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE isp_ftp_user (
  no int(11) NOT NULL AUTO_INCREMENT,
  ftp_user_domain_no int(11) NOT NULL DEFAULT '0',
  ftp_user_name varchar(50) NOT NULL DEFAULT '',
  ftp_user_password varchar(50) NOT NULL DEFAULT '',
  ftp_user_path varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (no)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

GRANT ALL PRIVILEGES ON isp.* TO 'isp'@'%' IDENTIFIED BY 'mymail321' WITH GRANT OPTION;
FLUSH PRIVILEGES;

EOF

cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/pure-ftpd-1.0.36.tar.gz
tar -zxvf pure-ftpd-1.0.36.tar.gz
yum install -y gcc gcc-c++ make pam-devel openldap-devel mysql-devel
cd pure-ftpd-1.0.36
./configure --prefix=/home/isp/apps/pureftpd/ --with-mysql=/home/isp/apps/mysql --with-language=simplified-chinese --with-everything
make
make install
cd /home/isp/apps/pureftpd
mkdir etc
cd etc
wget -N https://install.chcbz.net/conf/pureftpd/etc/pureftpd-mysql.conf
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/pureftpd.sh
chmod 777 pureftpd.sh
