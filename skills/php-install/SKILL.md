---
name: php-install
description: Use when installing PHP and PHP-FPM with this repository, including source compilation, php.ini and php-fpm.conf generation, socket-based Nginx integration, and service verification.
---

# PHP Install

## Command

- Direct install: `sudo ./shell/php_install.sh`
- Via profile: `sudo ./install.sh php`

## Output

- Installs PHP 8.2.26 to `/home/isp/apps/php`
- Writes config to `/home/isp/apps/php/etc/php.ini`
- Uses FPM socket `/home/isp/apps/php/var/run/php-fpm.sock`
- Creates `/home/isp/bin/php.sh`

## Verify

- `php -v`
- `systemctl status php-fpm`

## Notes

- Pair this skill with `nginx-install` for web deployments
