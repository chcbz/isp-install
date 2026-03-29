cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/pcre-8.36.tar.gz
wget https://install.chcbz.net/pkgs/openssl-1.1.0g.tar.gz
wget https://install.chcbz.net/pkgs/zlib-1.2.8.tar.gz
wget https://install.chcbz.net/pkgs/nginx-dav-ext-module.tar.gz
wget https://install.chcbz.net/pkgs/nginx-1.12.2.tar.gz
tar -zxvf pcre-8.36.tar.gz
tar -zxvf openssl-1.1.0g.tar.gz
tar -zxvf zlib-1.2.8.tar.gz
tar -zxvf nginx-dav-ext-module.tar.gz
tar -zxvf nginx-1.12.2.tar.gz
yum install -y gcc gcc-c++ make expat-devel perl
cd nginx-1.12.2
./configure --prefix=/home/isp/apps/nginx --with-pcre=/home/isp/pkgs/pcre-8.36 --with-openssl=/home/isp/pkgs/openssl-1.1.0g --with-zlib=/home/isp/pkgs/zlib-1.2.8 --with-http_ssl_module --with-http_v2_module --with-http_dav_module --add-module=/home/isp/pkgs/nginx-dav-ext-module
make
make install
cd /home/isp/apps/nginx/conf
wget -N https://install.chcbz.net/conf/nginx/conf/nginx.conf
mkdir vhost
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/nginx.sh
chmod 777 nginx.sh

