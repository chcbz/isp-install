cd /home/isp/apps
mkdir jenkins
cd jenkins
mkdir logs
wget https://install.chcbz.net/pkgs/jenkins.war
yum install -y initscripts
cd /home/isp/bin
wget https://install.chcbz.net/bin/jenkins.sh
chmod 777 jenkins.sh
