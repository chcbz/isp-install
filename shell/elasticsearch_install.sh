#!/bin/bash
#===============================================================
# Elasticsearch 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Elasticsearch 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
ES_VERSION="8.12.2"
ES_URL="https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-${ES_VERSION}-linux-x86_64.tar.gz"
# IK 分词插件已迁移到新地址
IK_VERSION=$ES_VERSION
IK_URL="https://get.infini.cloud/elasticsearch/analysis-ik/${ES_VERSION}"
INSTALL_PREFIX="$ISP_APPS/elasticsearch"

#===============================================================
# 检查 Java 环境
#===============================================================
echo ""
echo "[1/5] 检查 Java 环境..."

if [ -z "$JAVA_HOME" ]; then
    if [ -d "$ISP_APPS/java" ]; then
        export JAVA_HOME=$ISP_APPS/java
        export PATH=$JAVA_HOME/bin:$PATH
    else
        echo -e "${RED}错误: 未找到 Java 环境${NC}"
        echo "请先运行 ./jdk_install.sh 安装 JDK 11+"
        exit 1
    fi
fi

echo -e "${GREEN}Java 环境: $JAVA_HOME${NC}"

#===============================================================
# 创建用户
#===============================================================
echo ""
echo "[2/5] 创建 Elasticsearch 用户..."

# Elasticsearch 不能用 root 运行
if ! id -u elasticsearch &>/dev/null; then
    useradd -g isp -s /bin/bash elasticsearch
    echo -e "${GREEN}用户 elasticsearch 创建成功${NC}"
fi

#===============================================================
# 下载 Elasticsearch
#===============================================================
echo ""
echo "[3/5] 下载 Elasticsearch ${ES_VERSION}..."

cd $ISP_PKGS

if [ ! -f "elasticsearch-${ES_VERSION}-linux-x86_64.tar.gz" ]; then
    download_file "$ES_URL"
fi

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[4/5] 解压安装 Elasticsearch..."

mkdir -p $ISP_APPS
tar -xzf elasticsearch-${ES_VERSION}-linux-x86_64.tar.gz -C $ISP_APPS
mv $ISP_APPS/elasticsearch-${ES_VERSION} $INSTALL_PREFIX

# 下载 IK 分词插件
echo "下载 IK 分词插件..."
if [ ! -f "elasticsearch-analysis-ik-${IK_VERSION}.zip" ]; then
    download_file "$IK_URL"
fi

# 安装 IK 插件
echo "安装 IK 分词插件..."
# 使用 ES 插件管理器安装 IK
cd $INSTALL_PREFIX
bin/elasticsearch-plugin install "$IK_URL" --batch || {
    echo -e "${YELLOW}IK 插件安装失败，可稍后手动安装:${NC}"
    echo "  bin/elasticsearch-plugin install $IK_URL"
}

#===============================================================
# 配置
#===============================================================
echo ""
echo "[5/5] 配置 Elasticsearch..."

# 创建必要目录
mkdir -p $INSTALL_PREFIX/data
mkdir -p $INSTALL_PREFIX/logs

# 配置文件
cat > $INSTALL_PREFIX/config/elasticsearch.yml << EOF
# 集群名称
cluster.name: isp-cluster

# 节点名称
node.name: node-1

# 数据和日志目录
path.data: $INSTALL_PREFIX/data
path.logs: $INSTALL_PREFIX/logs

# 网络配置
network.host: 0.0.0.0
http.port: 9200
transport.port: 9300

# 发现配置 (单节点)
discovery.type: single-node

# 内存锁定
bootstrap.memory_lock: true

# 安全配置 (开发环境关闭)
xpack.security.enabled: false
xpack.security.enrollment.enabled: false
xpack.security.http.ssl.enabled: false
xpack.security.transport.ssl.enabled: false

# 跨域配置
http.cors.enabled: true
http.cors.allow-origin: "*"
EOF

# JVM 配置
ES_MEMORY=$(free -m | awk '/^Mem:/{print int($2/4)}')
[ $ES_MEMORY -lt 512 ] && ES_MEMORY=512
[ $ES_MEMORY -gt 16384 ] && ES_MEMORY=16384

cat > $INSTALL_PREFIX/config/jvm.options.d/heap.options << EOF
-Xms${ES_MEMORY}m
-Xmx${ES_MEMORY}m
EOF

# 设置权限
chown -R elasticsearch:isp $INSTALL_PREFIX

# 创建管理脚本
cat > $ISP_BIN/elasticsearch.sh << 'SCRIPT'
#!/bin/bash

ES_HOME=/home/isp/apps/elasticsearch
ES_USER=elasticsearch

case "$1" in
    start)
        echo "Starting Elasticsearch..."
        su - $ES_USER -c "$ES_HOME/bin/elasticsearch -d -p $ES_HOME/es.pid"
        echo "Elasticsearch started"
        ;;
    stop)
        if [ -f $ES_HOME/es.pid ]; then
            kill $(cat $ES_HOME/es.pid)
            echo "Elasticsearch stopped"
        else
            echo "Elasticsearch is not running"
        fi
        ;;
    restart)
        $0 stop
        sleep 5
        $0 start
        ;;
    status)
        if curl -s http://localhost:9200 > /dev/null 2>&1; then
            echo "Elasticsearch is running"
            curl -s http://localhost:9200 | head -10
        else
            echo "Elasticsearch is not running"
        fi
        ;;
    plugins)
        $ES_HOME/bin/elasticsearch-plugin list
        ;;
    *)
        echo "Elasticsearch 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  $0 start     启动"
        echo "  $0 stop      停止"
        echo "  $0 restart   重启"
        echo "  $0 status    状态"
        echo "  $0 plugins   查看插件"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/elasticsearch.sh

# 配置系统参数
if ! grep -q "elasticsearch soft memlock" /etc/security/limits.conf; then
    cat >> /etc/security/limits.conf << EOF

# Elasticsearch
elasticsearch soft memlock unlimited
elasticsearch hard memlock unlimited
elasticsearch soft nofile 65536
elasticsearch hard nofile 65536
EOF
fi

# 配置 vm.max_map_count
if [ $(cat /proc/sys/vm/max_map_count) -lt 262144 ]; then
    sysctl -w vm.max_map_count=262144
    echo "vm.max_map_count=262144" >> /etc/sysctl.conf
fi

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Elasticsearch 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "版本: $ES_VERSION"
echo "JVM 堆内存: ${ES_MEMORY}MB"
echo ""
echo "访问地址:"
echo "  REST API: http://localhost:9200"
echo ""
echo "管理脚本: $ISP_BIN/elasticsearch.sh"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/elasticsearch.sh start    # 启动"
echo "  $ISP_BIN/elasticsearch.sh stop     # 停止"
echo "  $ISP_BIN/elasticsearch.sh status   # 状态"
echo ""
echo "测试:"
echo "  curl http://localhost:9200"
