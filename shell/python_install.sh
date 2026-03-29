cd /home/isp/pkgs
wget -c https://install.chcbz.net/pkgs/Python-3.7.1.tgz
tar -zxvf Python-3.7.1.tgz
yum install -y gcc gcc-c++ make zlib zlib-devel ncurses ncurses-devel libffi-devel openssl openssl-devel
cd Python-3.7.1
./configure --prefix=/home/isp/apps/python
make
make install
echo "" >> /etc/profile
echo "#set python environment" >> /etc/profile
echo "PATH=\$PATH:/home/isp/apps/python/bin" >> /etc/profile
echo "export PATH" >> /etc/profile
source /etc/profile
