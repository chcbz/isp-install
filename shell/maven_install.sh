cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/apache-maven-3.5.2-bin.tar.gz
tar -zxvf apache-maven-3.5.2-bin.tar.gz -C /home/isp/apps
cd /home/isp/apps
mv apache-maven-3.5.2 maven
cd maven/conf
wget -N https://install.chcbz.net/conf/maven/conf/settings.xml
echo "" >> /etc/profile
echo "#set maven environment" >> /etc/profile
echo "MAVEN_HOME=/home/isp/apps/maven" >> /etc/profile
echo "export PATH=\$PATH:\$MAVEN_HOME/bin" >> /etc/profile
source /etc/profile
