cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/otp_src_19.3.tar.gz
wget https://install.chcbz.net/pkgs/rabbitmq-server-generic-unix-3.6.11.tar.xz
yum -y install make ncurses-devel gcc gcc-c++ unixODBC unixODBC-devel openssl openssl-devel perl
tar -zxvf otp_src_19.3.tar.gz
cd otp_src_19.3
./configure --prefix=/home/isp/apps/erlang --enable-smp-support --enable-threads --enable-sctp --enable-kernel-poll --enable-hipe --with-ss
make
make install
echo "" >> /etc/profile
echo "#set erlang environment" >> /etc/profile
echo "export PATH=/home/isp/apps/erlang/bin:\$PATH" >> /etc/profile
source /etc/profile
cd ..
tar -xvJf rabbitmq-server-generic-unix-3.6.11.tar.xz -C /home/isp/apps
cd /home/isp/apps/
mv rabbitmq_server-3.6.11 rabbitmq
cd rabbitmq
sbin/rabbitmq-server -detached
sbin/rabbitmq-plugins enable rabbitmq_management
sbin/rabbitmqctl add_user admin password
sbin/rabbitmqctl set_user_tags admin administrator
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/rabbitmq.sh
chmod 777 rabbitmq.sh
