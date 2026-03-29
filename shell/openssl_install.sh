cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/openssl-1.1.0g.tar.gz
tar -zxvf openssl-1.1.0g.tar.gz
yum install -y gcc gcc-c++ make expat-devel perl
cd openssl-1.1.0g
./config --prefix=/home/isp/apps/openssl
make & make install
mv /usr/bin/openssl /usr/bin/openssl.bak
mv /usr/include/openssl /usr/include/openssl.bak
ln -s /home/isp/apps/openssl/bin/openssl /usr/bin/openssl
ln -s /home/isp/apps/openssl/include/openssl /usr/include/openssl
echo “/home/isp/apps/openssl/lib” >> /etc/ld.so.conf
ln -s /home/isp/apps/openssl/lib/libssl.so.1.1 /usr/lib64/libssl.so.1.1
ln -s /home/isp/apps/openssl/lib/libcrypto.so.1.1 /usr/lib64/libcrypto.so.1.1
