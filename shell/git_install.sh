cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/git-2.9.2.tar.gz
yum -y install make gcc gcc-c++ openssl-devel curl-devel expat-devel gettext-devel zlib-devel perl-ExtUtils-MakeMaker
tar -zxvf git-2.9.2.tar.gz
cd git-2.9.2
make prefix=/home/isp/apps/git all
make prefix=/home/isp/apps/git install
echo "" >> /etc/profile
echo "#set git environment" >> /etc/profile
echo "export PATH=\$PATH:/home/isp/apps/git/bin" >> /etc/profile
source /etc/profile

