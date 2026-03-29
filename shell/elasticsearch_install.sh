cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/elasticsearch-8.11.4-linux-x86_64.tar.gz
tar -zxvf elasticsearch-8.11.4-linux-x86_64.tar.gz
wget https://install.chcbz.net/pkgs/elasticsearch-analysis-ik-8.11.4.zip
unzip elasticsearch-analysis-ik-8.11.4.zip -d elasticsearch-8.11.4/analysis-ik
mv elasticsearch-8.11.4 /home/isp/apps/
cd /home/isp/apps
mv elasticsearch-8.11.4 elasticsearch
cd elasticsearch/conf
wget -N https://install.chcbz.net/conf/elasticsearch/conf/elasticsearch.conf
cd /home/isp/apps/
chown -R isp:isp elasticsearch
cd /home/isp/bin
wget -N https://install.chcbz.net/bin/elasticsearch.sh
chmod 777 elasticsearch.sh
