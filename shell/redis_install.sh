cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/redis-4.0.6.tar.gz
yum -y install make gcc gcc-c++ initscripts
tar -zxvf redis-4.0.6.tar.gz
cd redis-4.0.6
make MALLOC=libc
make PREFIX=/home/isp/apps/redis install
cd /home/isp/apps/redis
mkdir etc
mkdir var
cd etc
wget -N https://install.chcbz.net/conf/redis/etc/redis.conf
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/redis.sh
chmod 777 redis.sh
