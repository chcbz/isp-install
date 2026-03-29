yum install -y epel-release certbot
certbot -d chcbz.net -d *.chcbz.net --manual --preferred-challenges dns-01 --server https://acme-v02.api.letsencrypt.org/directory certonly
echo '0 */12 * * * certbot renew --quiet --renew-hook "/home/isp/bin/nginx.sh reload"' >> /etc/crontab

