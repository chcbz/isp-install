# ISP Install - 服务器自动化部署工具集

一套用于 CentOS/RHEL 系统的服务器环境快速部署脚本集合，支持从源码编译安装各类常用服务软件。

## 目录结构

```
.
├── bin/          # 服务管理脚本 (start/stop/restart/status)
├── shell/        # 安装脚本 (从源码编译安装)
├── pkgs/         # 软件包存放目录
└── conf/         # 配置文件模板
```

## 快速开始

### 1. 初始化服务器

```bash
# 以 root 用户执行
./shell/init.sh
```

这将创建：
- 用户和用户组：`isp`
- 目录结构：`/home/isp/{apps,hosts,pkgs,bin,logs}`
- 中文语言环境
- 时区设置：`Asia/Shanghai`

### 2. 安装软件

```bash
# 安装 MySQL (交互式输入密码)
./shell/mysql_install.sh

# 安装 Nginx
./shell/nginx_install.sh

# 安装 Redis
./shell/redis_install.sh

# 安装 OpenLDAP
./shell/openldap_install.sh

# 安装 VPN (IPsec/L2TP)
./shell/vpn_install.sh
```

### 3. 管理服务

```bash
# 启动服务
/home/isp/bin/mysql.sh start

# 停止服务
/home/isp/bin/mysql.sh stop

# 重启服务
/home/isp/bin/mysql.sh restart

# 查看状态
/home/isp/bin/mysql.sh status
```

## 支持的软件

| 类别 | 软件 | 说明 |
|------|------|------|
| **Web 服务器** | Nginx, Apache httpd | 反向代理、Web 服务 |
| **数据库** | MySQL 5.6 | 关系型数据库 |
| **缓存/消息** | Redis, RabbitMQ | 缓存、消息队列 |
| **开发环境** | JDK 8, Maven, Node.js, Python 3.7, PHP 7.1 | 编程语言和构建工具 |
| **版本控制** | Git, Gitblit, SVN | 代码仓库管理 |
| **CI/CD** | Jenkins, Nexus | 持续集成、制品库 |
| **文件服务** | Pure-FTPd | FTP 服务器 |
| **目录服务** | OpenLDAP | LDAP 目录服务 |
| **VPN** | Libreswan, StrongSwan, PPTP | IPsec/L2TP VPN |
| **邮件服务** | Postfix, Dovecot | 邮件服务器 |
| **DNS** | BIND | DNS 服务器 |
| **搜索引擎** | Elasticsearch, Logstash, Kibana | ELK 日志分析栈 |
| **其他** | OpenSSL, Tomcat | SSL 库、应用服务器 |

## 环境变量

部分安装脚本需要设置环境变量或交互式输入密码：

```bash
# MySQL
export MYSQL_ROOT_PASSWORD="your_secure_password"

# RabbitMQ
export RABBITMQ_ADMIN_PASSWORD="your_rabbitmq_password"

# VPN (StrongSwan)
export VPN_PSK="your_psk_key"
export VPN_XAUTH_PASS="your_xauth_password"
export VPN_EAP_USER="username"
export VPN_EAP_PASS="your_eap_password"

# Maven (Nexus)
export NEXUS_PASSWORD="your_nexus_password"
export FTP_USERNAME="ftp_username"
export FTP_PASSWORD="ftp_password"
```

## 安装位置

所有软件默认安装到 `/home/isp/apps/` 目录：

```
/home/isp/apps/
├── mysql/
├── nginx/
├── redis/
├── openldap/
├── java/
├── maven/
└── ...
```

## 配置文件

配置文件模板位于 `conf/` 目录，按软件分类：

```
conf/
├── mysql/
│   └── my.cnf
├── nginx/
│   └── nginx.conf
├── openldap/
│   └── etc/openldap/slapd.conf
├── maven/
│   └── settings.xml
└── ...
```

## 系统要求

- **操作系统**: CentOS 7/8, RHEL 7/8, Rocky Linux 8/9
- **架构**: x86_64
- **权限**: 需要 root 权限执行安装脚本
- **网络**: 需要访问 `install.chcbz.net` 下载配置文件（可选）

## 注意事项

1. **生产环境**: 部分脚本版本较旧，建议根据实际需求更新软件版本
2. **安全性**: 所有密码均需通过环境变量或交互式输入，不再硬编码
3. **防火墙**: 安装后需根据服务开放相应端口
4. **备份**: 建议在安装前备份重要数据

## 可用的安装脚本

查看 `shell/sh_list.txt` 获取支持的软件列表：

```
openssl
nginx
mysql
rabbitmq
jdk
maven
redis
git
jenkins
pureftpd
gitblit
php
openldap
node
python
nexus
vpn
```

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。

## 许可证

本项目仅供学习和参考使用。
