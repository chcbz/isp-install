#!/bin/bash

#while getopts ":a:" opt
#do
#    case $opt in
#        a)
#        APPCN=$OPTARG
#        ;;
#        ?)
#        echo "未知参数$OPTARG"
#        exit 1;;
#    esac
#done

if [ ! -n "$1" ]; then
    echo "appcn不能为空"
    exit 2
fi

if [ ! -n "$2" ]; then
    echo "端口不能为空"
    exit 2
fi

if [ ! -d "/home/isp/" ]; then
    curl -s -S -L https://install.chcbz.net/shell/init.sh | /bin/sh
fi

#if [ ! -d "/home/isp/apps/openssl/" ]; then
#    curl -s -S -L https://install.chcbz.net/shell/openssl_install.sh | /bin/sh
#fi

if [ ! -d "/home/isp/apps/python/" ]; then
    curl -s -S -L https://install.chcbz.net/shell/python_install.sh | /bin/sh
fi

if [ -d "/home/isp/hosts/console/" ]; then
    rm -rf /home/isp/hosts/console
fi

cd /home/isp/hosts
wget -N https://install.chcbz.net/pkgs/console.tar.gz
tar zxvf console.tar.gz
cd console
source /etc/profile
python3 -m venv env
source env/bin/activate
pip3 install -r requirements.txt
#CFLAGS="-I/home/isp/apps/openssl/include" LDFLAGS="-L/home/isp/apps/openssl/lib" UWSGI_PROFILE_OVERRIDE=ssl=true pip3 install uwsgi -I --no-cache-dir
bin/dealIni.sh -w config.ini app appcn $1
bin/dealIni.sh -w config.ini uwsgi http 0.0.0.0:$2
#mkdir -p /home/isp/ssl/;cd /home/isp/ssl
#openssl genrsa -out foobar.key 2048
#openssl req -new -key foobar.key -out foobar.csr
#openssl x509 -req -days 365 -in foobar.csr -signkey foobar.key -out foobar.crt
#bin/dealIni.sh -w config.ini uwsgi https 0.0.0.0:$2,/home/isp/ssl/foobar.crt,/home/isp/ssl/foobar.key
uwsgi config.ini
