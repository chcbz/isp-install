cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/node-v8.12.0-linux-x64.tar.xz
tar -Jxvf node-v8.12.0-linux-x64.tar.xz -C /home/isp/apps
cd /home/isp/apps/
mv node-v8.12.0-linux-x64 node
echo "" >> /etc/profile
echo "#set node environment" >> /etc/profile
echo "NODE_HOME=/home/isp/apps/node" >> /etc/profile
echo "PATH=\$PATH:\$NODE_HOME/bin" >> /etc/profile
echo "export NODE_HOME PATH" >> /etc/profile
source /etc/profile
