cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/mysql-5.6.22.tar.gz
tar -zxvf mysql-5.6.22.tar.gz
yum install -y gcc gcc-c++ ncurses-devel perl cmake make autoconf
cd mysql-5.6.22
cmake \
-DCMAKE_INSTALL_PREFIX=/home/isp/apps/mysql \
-DMYSQL_UNIX_ADDR=/home/isp/apps/mysql/mysql.sock \
-DDEFAULT_CHARSET=utf8 \
-DDEFAULT_COLLATION=utf8_general_ci \
-DWITH_INNOBASE_STORAGE_ENGINE=1 \
-DWITH_ARCHIVE_STORAGE_ENGINE=1 \
-DWITH_BLACKHOLE_STORAGE_ENGINE=1 \
-DMYSQL_DATADIR=/home/isp/apps/mysql/data \
-DMYSQL_TCP_PORT=3306 \
-DENABLE_DOWNLOADS=1
make
make install
groupadd mysql
useradd -g mysql mysql -M -s /sbin/nologin
chown -R mysql:mysql /home/isp/apps/mysql
cd /home/isp/apps/mysql
wget -N https://install.chcbz.net/conf/mysql/my.cnf
chmod 644 my.cnf
scripts/mysql_install_db --basedir=/home/isp/apps/mysql --datadir=/home/isp/apps/mysql/data --user=mysql
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/mysql.sh
chmod 777 mysql.sh
/home/isp/bin/mysql.sh start
sleep 3s
cd /home/isp/apps/mysql
bin/mysqladmin -uroot password comeongogogo
/home/isp/bin/mysql.sh stop
