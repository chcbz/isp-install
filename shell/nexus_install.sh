cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/nexus-3.14.0-04-unix.tar.gz
tar -zxvf nexus-3.14.0-04-unix.tar.gz -C /home/isp/apps/
cd /home/isp/apps
mv nexus-3.14.0-04 nexus
cd /home/isp/bin
wget https://install.chcbz.net/bin/nexus.sh
chmod 777 nexus.sh

