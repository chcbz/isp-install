# New API Docker 依赖环境

核对日期：2026-11-06。依据 `chcbz/new-api` 的 `docker-compose.yml`，源码
`2de51a19e35a602a0041d380b29be7c9bcd1e0e5`。默认依赖是 PostgreSQL 15 与 Redis；
MySQL 是替代数据库，不需同时安装；ClickHouse 是可选日志库，本方案不启用。
Docker 交付不需要在宿主机安装 Go、Bun、Node 或数据库服务。

## 安装

已实现的主机安装器仅支持 Ubuntu 22.04/24.04/26.04/26.10，使用 Docker 官方签名 APT
仓库并校验签名公钥指纹。其他现有组件的系统支持表不代表本组件已在所有系统验证。
需要 root、可访问选定的签名软件源及镜像仓库；不使用来源不明的镜像代理、不关闭 TLS 校验。
可显式设置 `DOCKER_PACKAGE_SOURCE=ubuntu` 使用 Ubuntu 签名仓库的 `docker.io`/`docker-compose-v2`/`docker-buildx`，
不自动降级/切换渠道。默认仍为 Docker 官方仓库。
存在其他容器运行时包时拒绝自动卸载；已有可用 Docker/Compose 时不更换引擎、不重启。

```bash
sudo ./install.sh --profile new-api-deps
# 交互确认 y；该 profile 不执行 init.sh，不执行原生数据库安装器。
# 也可依次运行：
sudo ./shell/docker_install.sh
sudo ./shell/new_api_deps_install.sh
```

依赖需要 `openssl`（随机数生成）、`flock` 和 Docker Compose v2+；Ubuntu 标准系统提供前两项。
安装将 `postgres:15-bookworm` 与 `redis:7.4-bookworm` 解析为 registry SHA256 digest，并写入目标
私有 `.env`；再次安装沿用 digest 与凭据，不自动切换新版。`up --wait` 必须健康才报告成功。
若 Docker Hub 不可达，允许在**首次安装前**显式指定已审核镜像来源，例如 AWS 公共仓库中的
Docker Official Images；仍解析和锁定该仓库返回的digest，不能宣称跨仓库digest已验证相等：

```bash
sudo env DOCKER_PACKAGE_SOURCE=ubuntu \
  POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:15-bookworm \
  REDIS_IMAGE=public.ecr.aws/docker/library/redis:7.4-bookworm \
  ./install.sh --profile new-api-deps
```

既有 `.env` 优先，不因环境变量改变而替换现用镜像/密码；升级应另做备份与审核。
两个容器均设置 `unless-stopped`，Docker 设置开机启动；未执行整机重启测试。

## 布局与安全

| 目标机绝对路径 | 用途 |
| --- | --- |
| `/home/isp/apps/new-api-deps/compose.yaml` | 依赖编排，root 专用 |
| `/home/isp/conf/new-api-deps/.env` | root:root 0600，随机数据库/Redis/会话密钥及镜像 digest |
| `/home/isp/state/new-api-deps/postgres` | PostgreSQL 持久化数据 |
| `/home/isp/state/new-api-deps/redis` | Redis AOF 持久化数据 |

Docker 管理网络为 `new-api-backend`；服务名 `postgres` 和 `redis`。
没有宿主机端口映射，不开放 5432、6379 或任何业务端口；无公网管理页面。
PostgreSQL 内存上限768MiB，Redis容器512MiB/数据256MiB，Redis使用noeviction避免静默淘汰。
Docker日志每容器10MiB×3轮转，数据库数据不自动清理。

该 `.env` 不是普通配置示例，不能提交、粘贴到工单、回复或日志。
不要运行不带 `--quiet` 的 `docker compose config` 输出展开后的密码。
有状态数据但私有配置丢失时拒绝重建随机密码；Compose 被人工修改时拒绝覆盖。
安装失败保留数据与已有凭据，不自动 down/删库。

## 验证与运维

```bash
sudo docker compose --env-file /home/isp/conf/new-api-deps/.env \
  -f /home/isp/apps/new-api-deps/compose.yaml ps
sudo docker compose --env-file /home/isp/conf/new-api-deps/.env \
  -f /home/isp/apps/new-api-deps/compose.yaml logs --tail 100
sudo docker compose --env-file /home/isp/conf/new-api-deps/.env \
  -f /home/isp/apps/new-api-deps/compose.yaml stop
sudo docker compose --env-file /home/isp/conf/new-api-deps/.env \
  -f /home/isp/apps/new-api-deps/compose.yaml up -d --wait
```

停服影响未来连接该依赖的应用；数据保留。**禁止 `down -v`、删除state或覆盖私有.env**。
上线前还需设计数据库备份并恢复演练；本安装不伪称已建立异地备份/监控。

## 后续接入 New API（未执行）

将经审核的应用镜像/自建 `chcbz/new-api` 镜像加入外部网络 `new-api-backend`：

```yaml
networks:
  backend:
    external: true
    name: new-api-backend
```

应用容器需提供以下值（从目标机私有配置读取，不把占位符原样上线）：

```text
SQL_DSN=postgresql://newapi:<POSTGRES_PASSWORD>@postgres:5432/new-api
REDIS_CONN_STRING=redis://:<REDIS_PASSWORD>@redis:6379/0
SESSION_SECRET=<SESSION_SECRET>
TZ=Asia/Shanghai
```

密码为十六进制，不需额外 URL 编码。仓库示例引用公共 `calciumion/new-api` 镜像，
不能据此认定公共镜像包含 `chcbz/new-api` 的改动；应用构建/部署须另外核对源码来源。
对公网服务还需域名、HTTPS、可信代理配置和管理员初始化；本依赖任务不部署这些内容。

## 隔离测试

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_new_api_deps.py -v
bash -n install.sh shell/docker_install.sh shell/new_api_deps_install.sh
```

测试通过临时目录和模拟 Docker 覆盖首次安装、digest锁定、重复安装密码不变、已有数据缺凭据、
配置冲突、符号链接、镜像拉取失败及异常digest拒绝；不连接生产数据库、不启动本机容器。
