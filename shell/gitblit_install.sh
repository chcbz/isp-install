cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/gitblit-1.8.0.tar.gz
tar -zxvf gitblit-1.8.0.tar.gz -C /home/isp/apps/
cd /home/isp/apps
mv gitblit-1.8.0 gitblit
cd /home/isp/bin
wget https://install.chcbz.net/bin/gitblit.sh
chmod 777 gitblit.sh
