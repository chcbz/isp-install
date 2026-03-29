cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/php-7.1.4.tar.gz
tar -zxvf php-7.1.4.tar.gz
yum install -y epel-release
yum install -y gcc libxml2 libxml2-devel openssl openssl-devel bzip2 bzip2-devel libcurl libcurl-devel libjpeg libjpeg-devel libpng libpng-devel freetype freetype-devel gmp gmp-devel libmcrypt libmcrypt-devel readline readline-devel libxslt libxslt-devel openldap openldap-devel
ln -s /usr/lib64/liblber* /usr/lib/
cd php-7.1.4
./configure \
--prefix=/home/isp/apps/php \
--with-config-file-path=/home/isp/apps/php/etc \
--enable-fpm \
--with-fpm-user=isp \
--with-fpm-group=isp \
--enable-inline-optimization \
--disable-debug \
--disable-rpath \
--enable-shared \
--enable-soap \
--with-libxml-dir \
--with-xmlrpc \
--with-openssl \
--with-mcrypt \
--with-mhash \
--with-pcre-regex \
--with-sqlite3 \
--with-zlib \
--enable-bcmath \
--with-iconv \
--with-bz2 \
--enable-calendar \
--with-curl \
--with-cdb \
--enable-dom \
--enable-exif \
--enable-fileinfo \
--enable-filter \
--with-pcre-dir \
--enable-ftp \
--with-gd \
--with-openssl-dir \
--with-jpeg-dir \
--with-png-dir \
--with-zlib-dir \
--with-freetype-dir \
--enable-gd-native-ttf \
--enable-gd-jis-conv \
--with-gettext \
--with-gmp \
--with-mhash \
--enable-json \
--enable-mbstring \
--enable-mbregex \
--enable-mbregex-backtrack \
--with-libmbfl \
--with-onig \
--enable-pdo \
--with-mysqli=mysqlnd \
--with-pdo-mysql=mysqlnd \
--with-zlib-dir \
--with-pdo-sqlite \
--with-readline \
--enable-session \
--enable-shmop \
--enable-simplexml \
--enable-sockets \
--enable-sysvmsg \
--enable-sysvsem \
--enable-sysvshm \
--enable-wddx \
--with-libxml-dir \
--with-xsl \
--enable-zip \
--enable-mysqlnd-compression-support \
--with-pear \
--with-ldap -shared\
--enable-opcache
make
make install
cd /home/isp/apps/php/etc
wget -N https://install.chcbz.net/conf/php/etc/php.ini
cp php-fpm.conf.default php-fpm.conf
cd php-fpm.d
cp www.conf.default www.conf
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/php.sh
chmod 777 php.sh

