#!/bin/bash
#===============================================================
# Jenkins 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Jenkins 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
JENKINS_VERSION="2.440.1"
JENKINS_URL="https://get.jenkins.io/war-stable/${JENKINS_VERSION}/jenkins.war"
INSTALL_PREFIX="$ISP_APPS/jenkins"
JENKINS_PORT="${JENKINS_PORT:-8080}"

#===============================================================
# 检查 Java 环境
#===============================================================
echo ""
echo "[1/3] 检查 Java 环境..."

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

# 检查 Java 版本
JAVA_VERSION=$($JAVA_HOME/bin/java -version 2>&1 | head -1 | cut -d'"' -f2 | cut -d'.' -f1)
if [ "$JAVA_VERSION" -lt 11 ]; then
    echo -e "${RED}错误: Jenkins 需要 JDK 11 或更高版本${NC}"
    exit 1
fi

echo -e "${GREEN}Java 环境: $JAVA_HOME (版本: $JAVA_VERSION)${NC}"

#===============================================================
# 下载 Jenkins
#===============================================================
echo ""
echo "[2/3] 下载 Jenkins ${JENKINS_VERSION}..."

mkdir -p $INSTALL_PREFIX
mkdir -p $INSTALL_PREFIX/logs
mkdir -p $INSTALL_PREFIX/workspace
mkdir -p $INSTALL_PREFIX/plugins

cd $INSTALL_PREFIX

if [ ! -f "jenkins.war" ]; then
    download_file "$JENKINS_URL" "jenkins.war"
fi

# 预安装常用插件
echo ""
echo "预安装常用插件..."

# 插件列表
PLUGINS=(
    "workflow-aggregator"
    "git"
    "github"
    "pipeline-stage-view"
    "credentials-binding"
    "ssh-slaves"
    "matrix-auth"
    "config-file-provider"
    "docker"
    "kubernetes"
)

# Jenkins 插件下载基础URL
PLUGIN_URL="https://updates.jenkins.io/latest"

mkdir -p $INSTALL_PREFIX/plugins

# 下载 plugin-installation-manager
if [ ! -f "$INSTALL_PREFIX/jenkins-plugin-manager.jar" ]; then
    download_file "https://github.com/jenkinsci/plugin-installation-manager-tool/releases/download/2.14.0/jenkins-plugin-manager-2.14.0.jar" \
        "$INSTALL_PREFIX/jenkins-plugin-manager.jar"
fi

#===============================================================
# 创建管理脚本
#===============================================================
echo ""
echo "[3/3] 配置 Jenkins..."

# 创建管理脚本
cat > $ISP_BIN/jenkins.sh << SCRIPT
#!/bin/bash

JENKINS_HOME=$INSTALL_PREFIX
JENKINS_WAR=\$JENKINS_HOME/jenkins.war
JENKINS_LOG=\$JENKINS_HOME/logs/jenkins.log
JENKINS_PID=\$JENKINS_HOME/jenkins.pid
JENKINS_PORT=${JENKINS_PORT}

# JVM 参数
JENKINS_JAVA_OPTS="-Xms512m -Xmx1024m -Djenkins.install.runSetupWizard=false"

case "\$1" in
    start)
        if [ -f \$JENKINS_PID ] && kill -0 \$(cat \$JENKINS_PID) 2>/dev/null; then
            echo "Jenkins is already running"
            exit 0
        fi
        
        echo "Starting Jenkins on port \$JENKINS_PORT..."
        nohup \$JAVA_HOME/bin/java \$JENKINS_JAVA_OPTS \\
            -DJENKINS_HOME=\$JENKINS_HOME \\
            -jar \$JENKINS_WAR \\
            --httpPort=\$JENKINS_PORT \\
            > \$JENKINS_LOG 2>&1 &
        
        echo \$! > \$JENKINS_PID
        echo "Jenkins started (PID: \$(cat \$JENKINS_PID))"
        echo "Log file: \$JENKINS_LOG"
        echo ""
        echo "访问: http://localhost:\$JENKINS_PORT"
        ;;
    stop)
        if [ -f \$JENKINS_PID ]; then
            echo "Stopping Jenkins..."
            kill \$(cat \$JENKINS_PID)
            rm -f \$JENKINS_PID
            echo "Jenkins stopped"
        else
            echo "Jenkins is not running"
        fi
        ;;
    restart)
        \$0 stop
        sleep 5
        \$0 start
        ;;
    status)
        if [ -f \$JENKINS_PID ] && kill -0 \$(cat \$JENKINS_PID) 2>/dev/null; then
            echo "Jenkins is running (PID: \$(cat \$JENKINS_PID))"
            echo "URL: http://localhost:\$JENKINS_PORT"
        else
            echo "Jenkins is not running"
        fi
        ;;
    log)
        tail -f \$JENKINS_LOG
        ;;
    plugins)
        java -jar \$JENKINS_HOME/jenkins-plugin-manager.jar \\
            --war \$JENKINS_WAR \\
            --plugin-download-directory \$JENKINS_HOME/plugins \\
            --plugin-file \$JENKINS_HOME/plugins.txt 2>/dev/null || \\
            echo "请创建 plugins.txt 文件指定要安装的插件"
        ;;
    init-pass)
        if [ -f \$JENKINS_HOME/secrets/initialAdminPassword ]; then
            cat \$JENKINS_HOME/secrets/initialAdminPassword
        else
            echo "初始密码文件不存在，请先启动 Jenkins"
        fi
        ;;
    *)
        echo "Jenkins 管理脚本"
        echo ""
        echo "使用方法:"
        echo "  \$0 start       启动 Jenkins"
        echo "  \$0 stop        停止 Jenkins"
        echo "  \$0 restart     重启 Jenkins"
        echo "  \$0 status      查看状态"
        echo "  \$0 log         查看日志"
        echo "  \$0 init-pass   显示初始管理员密码"
        echo "  \$0 plugins     安装插件"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/jenkins.sh

# 创建默认插件配置
cat > $INSTALL_PREFIX/plugins.txt << 'EOF'
workflow-aggregator
git
github
pipeline-stage-view
credentials-binding
ssh-slaves
timestamper
build-timeout
rebuild
EOF

# 设置权限
chown -R isp:isp $INSTALL_PREFIX

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Jenkins 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "版本: $JENKINS_VERSION"
echo "端口: $JENKINS_PORT"
echo ""
echo "管理脚本: $ISP_BIN/jenkins.sh"
echo ""
echo "使用方法:"
echo "  $ISP_BIN/jenkins.sh start       # 启动"
echo "  $ISP_BIN/jenkins.sh stop        # 停止"
echo "  $ISP_BIN/jenkins.sh status      # 状态"
echo "  $ISP_BIN/jenkins.sh log         # 查看日志"
echo "  $ISP_BIN/jenkins.sh init-pass   # 显示初始密码"
echo ""
echo "首次访问:"
echo "  1. 访问 http://localhost:$JENKINS_PORT"
echo "  2. 获取初始密码: $ISP_BIN/jenkins.sh init-pass"
echo "  3. 安装推荐插件或选择自定义插件"
echo ""
echo "注意: 首次启动可能需要几分钟初始化"
