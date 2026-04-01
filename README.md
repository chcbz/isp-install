# ISP Install - 服务器自动化部署工具集

一套用于 Linux 系统的服务器环境快速部署脚本集合，支持从源码编译安装各类常用服务软件。

## 支持的操作系统

| 系统 | 版本 | 状态 |
|------|------|------|
| CentOS | 7, 8 | ✅ 完全支持 |
| Rocky Linux | 8, 9 | ✅ 完全支持 |
| AlmaLinux | 8, 9 | ✅ 完全支持 |
| RHEL | 7, 8, 9 | ✅ 完全支持 |
| Ubuntu | 18.04, 20.04, 22.04, 24.04 | ✅ 完全支持 |
| Debian | 10, 11, 12 | ✅ 完全支持 |

脚本会自动检测操作系统类型，并使用对应的包管理器（yum/dnf 或 apt）。

## 目录结构

```
.
├── bin/          # 服务管理脚本 (start/stop/restart/status)
├── shell/        # 安装脚本 (从源码编译安装)
├── pkgs/         # 软件包存放目录
└── conf/         # 配置文件模板
```

## 快速开始

### 方式一：一键部署（推荐）

```bash
# 初始化服务器
sudo ./shell/init.sh

# 使用预设配置安装
sudo ./install.sh --profile web-server    # Web 服务器
sudo ./install.sh --profile dev-env       # 开发环境
sudo ./install.sh --profile db-server     # 数据库服务器
sudo ./install.sh --profile ci-cd         # CI/CD 服务器

# 交互式选择安装
sudo ./install.sh --select

# 指定组件安装
sudo ./install.sh nginx mysql redis
```

### 方式二：单独安装

```bash
# 1. 初始化服务器
sudo ./shell/init.sh

# 2. 安装软件（按需选择）
sudo ./shell/jdk_install.sh
sudo ./shell/mysql_install.sh
sudo ./shell/nginx_install.sh
sudo ./shell/redis_install.sh

# 3. 使环境变量生效
source /etc/profile
```

### 防火墙配置

```bash
# 开放服务端口
sudo ./shell/firewall.sh open nginx
sudo ./shell/firewall.sh open mysql
sudo ./shell/firewall.sh open redis

# 查看已开放端口
sudo ./shell/firewall.sh list

# 查看可用服务
sudo ./shell/firewall.sh services
```

### Systemd 服务

```bash
# 复制服务文件
sudo cp systemd/mysql.service /etc/systemd/system/
sudo cp systemd/nginx.service /etc/systemd/system/

# 启用并启动服务
sudo systemctl daemon-reload
sudo systemctl enable mysql nginx
sudo systemctl start mysql nginx
```

## 支持的软件

| 类别 | 软件 | 说明 |
|------|------|------|
| **Web 服务器** | Nginx 1.28.2, Apache httpd | 反向代理、Web 服务 |
| **数据库** | MySQL 8.0.45 | 关系型数据库 |
| **缓存/消息** | Redis 7.4.8, RabbitMQ 3.12.13 | 缓存、消息队列 |
| **开发环境** | JDK 21.0.10, Maven 3.9.6, Node.js LTS, Python 3.12.13, PHP 8.2.26 | 编程语言和构建工具 |
| **版本控制** | Git 2.53.0, Gitblit, SVN | 代码仓库管理 |
| **CI/CD** | Jenkins 2.440.1, Nexus 3.66.0-02 | 持续集成、制品库 |
| **文件服务** | Pure-FTPd 1.0.53 | FTP 服务器 |
| **目录服务** | OpenLDAP 2.6.13 | LDAP 目录服务 |
| **VPN** | Libreswan, StrongSwan, PPTP | IPsec/L2TP VPN |
| **邮件服务** | Postfix, Dovecot | 邮件服务器 |
| **DNS** | BIND | DNS 服务器 |
| **搜索引擎** | Elasticsearch 8.12.2 + IK分词, Logstash, Kibana | ELK 日志分析栈 |
| **其他** | OpenSSL (系统自带), Tomcat | SSL 库、应用服务器 |

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

- **操作系统**: CentOS 7/8, Rocky Linux 8/9, Ubuntu 18.04+, Debian 10+
- **架构**: x86_64 (AMD64)
- **权限**: 需要 root 权限执行安装脚本
- **网络**: 需要访问外网下载源码包和配置文件

## 核心组件

### shell/common.sh - 通用工具库

提供跨系统兼容的核心功能：

```bash
# 加载工具库
source ./shell/common.sh

# 检测系统
detect_os
show_os_info

# 智能安装（自动处理包名差异）
pkg_install_smart gcc-c++ openssl-devel

# 通用函数
check_root          # 检查 root 权限
download_file URL   # 下载文件
compile_install ... # 编译安装
```

### 包名映射

不同系统的包名差异会自动处理：

| RHEL/CentOS | Ubuntu/Debian |
|-------------|---------------|
| openssl-devel | libssl-dev |
| gcc-c++ | g++ |
| ncurses-devel | libncurses-dev |
| zlib-devel | zlib1g-dev |

## 注意事项

1. **安全更新**: 所有组件已更新到最新稳定版本（截至2026年4月1日），包含重要的安全修复
2. **安全性**: 所有密码均需通过环境变量或交互式输入，不再硬编码
3. **防火墙**: 安装后需根据服务开放相应端口
4. **备份**: 建议在安装前备份重要数据
5. **已废弃脚本**: 以下脚本已标记为废弃，不推荐使用：
   - `openssl_install.sh` (系统自带 OpenSSL 即可)
   - `fonts_install.sh` (硬编码域名，不安全)
   - `https_install.sh` (硬编码域名，不安全)
   - `console_install.sh` (外部下载源，不可靠)

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
