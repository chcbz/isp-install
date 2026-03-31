#!/bin/bash
#===============================================================
# Nexus (Sonatype Nexus Repository) 安装脚本
# 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Nexus Repository 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
NEXUS_VERSION="3.66.0-02"
NEXUS_URL="https://download.sonatype.com/nexus/3/nexus-${NEXUS_VERSION}-unix.tar.gz"
INSTALL_PREFIX="$ISP_APPS/nexus"
NEXUS_PORT="${NEXUS_PORT:-8081}"

#===============================================================
# 检查 Java 环境
#===============================================================
echo ""
echo "[1/4] 检查 Java 环境..."

if [ -z "$JAVA_HOME" ]; then
    if [ -d "$ISP_APPS/java" ]; then
        export JAVA_HOME=$ISP_APPS/java
        export PATH=$JAVA_HOME/bin:$PATH
    else
        echo -e "${RED}错误: 未找到 Java 环境${NC}"
        echo "请先运行 ./jdk_install.sh 安装 JDK 8 或 11"
        exit 1
    fi
fi

echo -e "${GREEN}Java 环境: $JAVA_HOME${NC}"

#===============================================================
# 创建用户
#===============================================================
echo ""
echo "[2/4] 创建 Nexus 用户..."

if ! id -u nexus &>/dev/null; then
    useradd -g isp -s /bin/bash nexus
    echo -e "${GREEN}用户 nexus 创建成功${NC}"
fi

#===============================================================
# 下载 Nexus
#===============================================================
echo ""
echo "[3/4] 下载 Nexus ${NEXUS_VERSION}..."

cd $ISP_PKGS

if [ ! -f "nexus-${NEXUS_VERSION}-unix.tar.gz" ]; then
    download_file "$NEXUS_URL"
fi

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[4/4] 解压安装 Nexus..."

mkdir -p $ISP_APPS
tar -xzf nexus-${NEXUS_VERSION}-unix.tar.gz -C $ISP_APPS
mv $ISP_APPS/nexus-${NEXUS_VERSION} $INSTALL_PREFIX

# 设置数据目录
mkdir -p $INSTALL_PREFIX/sonatype-work

# 配置 nexus.vmoptions
cat > $INSTALL_PREFIX/bin/nexus.vmoptions << EOF
-Xms512m
-Xmx1024m
-XX:MaxDirectMemorySize=1024m
-XX:+UnlockDiagnosticVMOptions
-XX:+LogVMOutput
-XX:LogFile=$INSTALL_PREFIX/sonatype-work/nexus3/log/jvm.log
-XX:-OmitStackTraceInFastThrow
-Djava.net.preferIPv4Stack=true
-Dkaraf.home=$INSTALL_PREFIX
-Dkaraf.base=$INSTALL_PREFIX
-Dkaraf.etc=$INSTALL_PREFIX/etc/karaf
-Djava.util.logging.config.file=$INSTALL_PREFIX/etc/karaf/java.util.logging.properties
-Dkaraf.data=$INSTALL_PREFIX/sonatype-work/nexus3
-Dkaraf.log=$INSTALL_PREFIX/sonatype-work/nexus3/log
-Djava.io.tmpdir=$INSTALL_PREFIX/sonatype-work/nexus3/tmp
-Dkaraf.startLocalConsole=false
-Djdk.java.launcher=SOSA
EOF

# 配置 nexus-default.properties
cat > $INSTALL_PREFIX/etc/nexus-default.properties << EOF
# Jetty section
application-port=${NEXUS_PORT}
application-host=0.0.0.0
nexus-args=\${jetty.etc}/jetty.xml,\${jetty.etc}/jetty-http.xml,\${jetty.etc}/jetty-requestlog.xml
nexus-context-path=/

# Nexus section
nexus-edition=nexus-pro-feature
nexus.features=\\
 nexus-pro-feature
nexus.hazelcast.discovery.isEnabled=true
EOF

# 设置权限
chown -R nexus:isp $INSTALL_PREFIX

# 创建管理脚本
cat > $ISP_BIN/nexus.sh << SCRIPT
#!/bin/bash

NEXUS_HOME=$INSTALL_PREFIX
NEXUS_USER=nexus

case "\$1" in
    start)
        echo "Starting Nexus..."
        su - \$NEXUS_USER -c "\$NEXUS_HOME/bin/nexus start"
        echo "Nexus started"
        echo ""
        echo "访问: http://localhost:${NEXUS_PORT}"
        ;;
    stop)
        echo "Stopping Nexus..."
        su - \$NEXUS_USER -c "\$NEXUS_HOME/bin/nexus stop"
        echo "Nexus stopped"
        ;;
    restart)
        \$0 stop
        sleep 5
        \$0 start
        ;;
    status)
        su - \$NEXUS_USER -c "\$NEXUS_HOME/bin/nexus status"
        ;;
    run)
        su - \$NEXUS_USER -c "\$NEXUS_HOME/bin/nexus run"
        ;;
    init-pass)
        if [ -f \$NEXUS_HOME/sonatype-work/nexus3/admin.password ]; then
            echo "初始管理员密码:"
            cat \$NEXUS_HOME/sonatype-work/nexus3/admin.password
        else
            echo "密码文件不存在，请先启动 Nexus"
        fi
        ;;
    log)
        tail -f \$NEXUS_HOME/sonatype-work/nexus3/log/nexus.log
        ;;
    *)
        echo "Nexus Repository 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  \$0 start       启动 Nexus"
        echo "  \$0 stop        停止 Nexus"
        echo "  \$0 restart     重启 Nexus"
        echo "  \$0 status      查看状态"
        echo "  \$0 run         前台运行"
        echo "  \$0 log         查看日志"
        echo "  \$0 init-pass   显示初始密码"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/nexus.sh

# 配置 ulimit
if ! grep -q "nexus soft nofile" /etc/security/limits.conf; then
    cat >> /etc/security/limits.conf << EOF

# Nexus
nexus soft nofile 65536
nexus hard nofile 65536
nexus soft nproc 4096
nexus hard nproc 4096
EOF
fi

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Nexus Repository 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "版本: $NEXUS_VERSION"
echo "端口: $NEXUS_PORT"
echo ""
echo "管理脚本: $ISP_BIN/nexus.sh"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/nexus.sh start       # 启动"
echo "  $ISP_BIN/nexus.sh stop        # 停止"
echo "  $ISP_BIN/nexus.sh status      # 状态"
echo "  $ISP_BIN/nexus.sh init-pass   # 显示初始密码"
echo ""
echo "首次访问:"
echo "  1. 访问 http://localhost:$NEXUS_PORT"
echo "  2. 用户名: admin"
echo "  3. 密码: 初始密码见 $ISP_BIN/nexus.sh init-pass"
echo ""
echo "注意: 首次启动可能需要几分钟初始化"
