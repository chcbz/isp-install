cd /home/isp/pkgs
wget https://install.chcbz.net/pkgs/jdk-8u121-linux-x64.tar.gz
tar -zxvf jdk-8u121-linux-x64.tar.gz -C /home/isp/apps
cd /home/isp/apps
mv jdk1.8.0_121 jdk8
echo "" >> /etc/profile
echo "#set java environment" >> /etc/profile
echo "JAVA_HOME=/home/isp/apps/jdk8" >> /etc/profile
echo "JRE_HOME=\$JAVA_HOME/jre" >> /etc/profile
echo "CLASS_PATH=.:\$JAVA_HOME/lib/dt.jar:\$JAVA_HOME/lib/tools.jar:\$JRE_HOME/lib" >> /etc/profile
echo "PATH=\$PATH:\$JAVA_HOME/bin:\$JRE_HOME/bin" >> /etc/profile
echo "export JAVA_HOME JRE_HOME CLASS_PATH PATH" >> /etc/profile
source /etc/profile
