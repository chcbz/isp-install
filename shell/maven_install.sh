#!/bin/bash
#===============================================================
# Maven 安装脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "Maven 安装脚本"
echo "=========================================="
show_os_info

#===============================================================
# 配置变量
#===============================================================
MAVEN_VERSION="3.9.6"
MAVEN_URL="https://dlcdn.apache.org/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz"
INSTALL_PREFIX="$ISP_APPS/maven"

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
        echo "请先运行 ./jdk_install.sh 安装 JDK"
        exit 1
    fi
fi

echo -e "${GREEN}Java 环境: $JAVA_HOME${NC}"
$JAVA_HOME/bin/java -version

#===============================================================
# 下载 Maven
#===============================================================
echo ""
echo "[2/3] 下载 Maven ${MAVEN_VERSION}..."

cd $ISP_PKGS

if [ ! -f "apache-maven-${MAVEN_VERSION}-bin.tar.gz" ]; then
    download_file "$MAVEN_URL"
fi

#===============================================================
# 解压安装
#===============================================================
echo ""
echo "[3/3] 解压安装 Maven..."

mkdir -p $ISP_APPS
tar -xzf apache-maven-${MAVEN_VERSION}-bin.tar.gz -C $ISP_APPS
mv $ISP_APPS/apache-maven-${MAVEN_VERSION} $INSTALL_PREFIX

# 创建符号链接
ln -sf $INSTALL_PREFIX/bin/mvn /usr/local/bin/mvn

#===============================================================
# 配置环境变量
#===============================================================
if ! grep -q "MAVEN_HOME=$INSTALL_PREFIX" /etc/profile; then
    cat >> /etc/profile << EOF

# Maven Environment
export MAVEN_HOME=$INSTALL_PREFIX
export PATH=\$MAVEN_HOME/bin:\$PATH
EOF
    echo -e "${GREEN}环境变量配置完成${NC}"
fi

export PATH=$INSTALL_PREFIX/bin:$PATH

#===============================================================
# 配置 settings.xml
#===============================================================
mkdir -p $INSTALL_PREFIX/conf

# 检查是否已有配置文件
if [ ! -f "$INSTALL_PREFIX/conf/settings.xml" ]; then
    echo ""
    echo "配置 Maven settings.xml..."
    
    # 创建本地仓库目录
    mkdir -p $ISP_HOME/.m2/repository
    
    # 创建 settings.xml
    cat > $INSTALL_PREFIX/conf/settings.xml << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 
                              http://maven.apache.org/xsd/settings-1.0.0.xsd">
    
    <localRepository>/home/isp/.m2/repository</localRepository>
    
    <mirrors>
        <!-- 阿里云镜像 -->
        <mirror>
            <id>aliyun</id>
            <name>Aliyun Maven Mirror</name>
            <url>https://maven.aliyun.com/repository/public</url>
            <mirrorOf>central</mirrorOf>
        </mirror>
    </mirrors>
    
    <profiles>
        <profile>
            <id>default</id>
            <activation>
                <activeByDefault>true</activeByDefault>
            </activation>
            <repositories>
                <repository>
                    <id>aliyun</id>
                    <url>https://maven.aliyun.com/repository/public</url>
                    <releases><enabled>true</enabled></releases>
                    <snapshots><enabled>true</enabled></snapshots>
                </repository>
            </repositories>
            <pluginRepositories>
                <pluginRepository>
                    <id>aliyun-plugin</id>
                    <url>https://maven.aliyun.com/repository/public</url>
                </pluginRepository>
            </pluginRepositories>
        </profile>
    </profiles>
    
    <!-- 如需配置服务器认证，请设置环境变量 -->
    <!--
    <servers>
        <server>
            <id>nexus</id>
            <username>${env.NEXUS_USERNAME}</username>
            <password>${env.NEXUS_PASSWORD}</password>
        </server>
    </servers>
    -->
</settings>
EOF
    echo -e "${GREEN}settings.xml 配置完成${NC}"
fi

#===============================================================
# 创建管理脚本
#===============================================================
cat > $ISP_BIN/maven.sh << 'SCRIPT'
#!/bin/bash

MAVEN_HOME=/home/isp/apps/maven

case "$1" in
    version|v)
        $MAVEN_HOME/bin/mvn --version
        ;;
    clean)
        echo "清理本地仓库..."
        read -p "确认清理? (y/n): " confirm
        if [ "$confirm" = "y" ]; then
            rm -rf /home/isp/.m2/repository/*
            echo "清理完成"
        fi
        ;;
    *)
        echo "Maven 管理脚本"
        echo ""
        $MAVEN_HOME/bin/mvn --version
        echo ""
        echo "使用方法:"
        echo "  $0 version    显示版本"
        echo "  $0 clean      清理本地仓库"
        echo ""
        echo "直接使用:"
        echo "  mvn clean install"
        echo "  mvn compile"
        echo "  mvn package"
        ;;
esac
SCRIPT

chmod +x $ISP_BIN/maven.sh

#===============================================================
# 完成
#===============================================================
echo ""
echo -e "${GREEN}=========================================="
echo "Maven 安装完成！"
echo "==========================================${NC}"
echo ""
echo "安装位置: $INSTALL_PREFIX"
echo "Maven 版本: $($INSTALL_PREFIX/bin/mvn --version | head -1)"
echo "配置文件: $INSTALL_PREFIX/conf/settings.xml"
echo "本地仓库: $ISP_HOME/.m2/repository"
echo ""
echo "使用方法:"
echo "  mvn --version              # 查看版本"
echo "  mvn clean install          # 清理并安装"
echo "  mvn compile                # 编译"
echo "  mvn package                # 打包"
echo ""
echo "请执行以下命令使环境变量生效:"
echo "  source /etc/profile"
