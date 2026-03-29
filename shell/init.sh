groupadd isp
useradd -g isp isp
mkdir /home/isp/apps
mkdir /home/isp/hosts
mkdir /home/isp/pkgs
mkdir /home/isp/bin
mkdir /home/isp/logs
chmod -R 775 /home/isp
chmod -R 777 /home/isp/logs
yum install -y wget
yum install kde-l10n-Chinese -y
yum reinstall glibc-common -y
localedef -c -f UTF-8 -i zh_CN zh_CN.utf8
echo LANG=zh_CN.UTF8 > /etc/locale.conf
source /etc/locale.conf
export LC_ALL=zh_CN.utf8
ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
yum install net-tools -y
