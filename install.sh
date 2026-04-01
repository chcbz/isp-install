#!/bin/bash
#===============================================================
# ISP Install - 一键部署脚本
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/shell/common.sh"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 检查 root 权限
check_root

#===============================================================
# 安装配置文件
#===============================================================

# 定义安装配置文件路径
PROFILES_DIR="$SCRIPT_DIR/profiles"

#===============================================================
# 显示帮助
#===============================================================
show_help() {
    echo -e "${GREEN}ISP Install - 一键部署脚本${NC}"
    echo ""
    echo "使用方法:"
    echo "  $0 [选项] [配置文件]"
    echo ""
    echo "选项:"
    echo "  -l, --list          列出可用配置"
    echo "  -h, --help          显示帮助"
    echo "  -p, --profile       使用预设配置"
    echo "  -s, --select        交互式选择安装"
    echo "  -v, --verbose       显示详细输出"
    echo ""
    echo "预设配置:"
    echo "  web-server          Web 服务器 (Nginx + PHP + MySQL)"
    echo "  dev-env             开发环境 (JDK + Maven + Git + Node)"
    echo "  db-server           数据库服务器 (MySQL + Redis)"
    echo "  full                完整安装 (所有组件)"
    echo ""
    echo "示例:"
    echo "  $0 --profile web-server      # 安装 Web 服务器配置"
    echo "  $0 --select                  # 交互式选择"
    echo "  $0 jdk mysql nginx            # 指定组件安装"
}

#===============================================================
# 列出可用配置
#===============================================================
list_profiles() {
    echo -e "${GREEN}可用的安装配置:${NC}"
    echo ""
    
    echo -e "${BLUE}web-server${NC} - Web 服务器"
    echo "  包含: Nginx, PHP, MySQL, Redis"
    echo ""
    
    echo -e "${BLUE}dev-env${NC} - 开发环境"
    echo "  包含: JDK, Maven, Git, Node.js, Python"
    echo ""
    
    echo -e "${BLUE}db-server${NC} - 数据库服务器"
    echo "  包含: MySQL, Redis, RabbitMQ"
    echo ""
    
    echo -e "${BLUE}ci-cd${NC} - CI/CD 服务器"
    echo "  包含: JDK, Jenkins, Nexus, Git"
    echo ""
    
    echo -e "${BLUE}full${NC} - 完整安装"
    echo "  包含: 所有组件"
    echo ""
    
    echo -e "${BLUE}单独组件:${NC}"
    echo "  jdk, maven, node, python, git"
    echo "  mysql, redis, nginx, php"
    echo "  rabbitmq, openldap, elasticsearch"
    echo "  jenkins, nexus, pureftpd"
}

#===============================================================
# 组件映射
#===============================================================
declare -A COMPONENT_SCRIPTS=(
    ["jdk"]="jdk_install.sh"
    ["java"]="jdk_install.sh"
    ["maven"]="maven_install.sh"
    ["mvn"]="maven_install.sh"
    ["node"]="node_install.sh"
    ["nodejs"]="node_install.sh"
    ["python"]="python_install.sh"
    ["py"]="python_install.sh"
    ["git"]="git_install.sh"
    ["mysql"]="mysql_install.sh"
    ["redis"]="redis_install.sh"
    ["nginx"]="nginx_install.sh"
    ["php"]="php_install.sh"
    ["rabbitmq"]="rabbitmq_install.sh"
    ["openldap"]="openldap_install.sh"
    ["ldap"]="openldap_install.sh"
    ["elasticsearch"]="elasticsearch_install.sh"
    ["es"]="elasticsearch_install.sh"
    ["jenkins"]="jenkins_install.sh"
    ["nexus"]="nexus_install.sh"
    ["pureftpd"]="pureftpd_install.sh"
    ["ftp"]="pureftpd_install.sh"
)

#===============================================================
# 预设配置
#===============================================================
declare -A PROFILES=(
    ["web-server"]="nginx php mysql redis"
    ["dev-env"]="jdk maven git node python"
    ["db-server"]="mysql redis rabbitmq"
    ["ci-cd"]="jdk maven git jenkins nexus"
    ["full"]="jdk maven node python git mysql redis nginx php rabbitmq openldap elasticsearch jenkins nexus pureftpd"
)

#===============================================================
# 安装单个组件
#===============================================================
install_component() {
    local component=$1
    local script=${COMPONENT_SCRIPTS[$component]}
    
    if [ -z "$script" ]; then
        echo -e "${RED}未知组件: $component${NC}"
        return 1
    fi
    
    local script_path="$SCRIPT_DIR/shell/$script"
    
    if [ ! -f "$script_path" ]; then
        echo -e "${RED}脚本不存在: $script_path${NC}"
        return 1
    fi
    
    echo -e "${GREEN}======================================'${NC}"
    echo -e "${GREEN}安装: $component${NC}"
    echo -e "${GREEN}======================================${NC}"
    
    if bash "$script_path"; then
        echo -e "${GREEN}✅ $component 安装成功${NC}"
        return 0
    else
        echo -e "${RED}❌ $component 安装失败${NC}"
        return 1
    fi
}

#===============================================================
# 交互式选择
#===============================================================
interactive_select() {
    echo -e "${GREEN}请选择要安装的组件 (空格分隔，回车确认):${NC}"
    echo ""
    
    local components=()
    local i=1
    
    for comp in "${!COMPONENT_SCRIPTS[@]}"; do
        if [[ ! "$comp" =~ ^(java|mvn|py|es|ldap|ftp)$ ]]; then  # 跳过别名
            echo "  $i) $comp"
            components+=("$comp")
            ((i++))
        fi
    done
    
    echo ""
    read -p "选择: " selection
    
    local selected=()
    for num in $selection; do
        if [[ "$num" =~ ^[0-9]+$ ]] && [ "$num" -ge 1 ] && [ "$num" -le ${#components[@]} ]; then
            selected+=("${components[$((num-1))]}")
        fi
    done
    
    if [ ${#selected[@]} -eq 0 ]; then
        echo -e "${RED}未选择任何组件${NC}"
        exit 1
    fi
    
    echo ""
    echo -e "${YELLOW}将安装以下组件:${NC}"
    for comp in "${selected[@]}"; do
        echo "  - $comp"
    done
    echo ""
    read -p "确认安装? (y/n): " confirm
    
    if [ "$confirm" != "y" ]; then
        echo "已取消"
        exit 0
    fi
    
    # 执行安装
    local failed=()
    for comp in "${selected[@]}"; do
        if ! install_component "$comp"; then
            failed+=("$comp")
        fi
    done
    
    # 显示结果
    echo ""
    echo -e "${GREEN}======================================${NC}"
    echo -e "${GREEN}安装完成${NC}"
    echo -e "${GREEN}======================================${NC}"
    
    if [ ${#failed[@]} -gt 0 ]; then
        echo -e "${RED}失败的组件:${NC}"
        for comp in "${failed[@]}"; do
            echo "  - $comp"
        done
    fi
    
    echo ""
    echo "请执行: source /etc/profile"
}

#===============================================================
# 主函数
#===============================================================
main() {
    local components=()
    local mode="args"
    
    # 解析参数
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                exit 0
                ;;
            -l|--list)
                list_profiles
                exit 0
                ;;
            -p|--profile)
                shift
                local profile=$1
                if [ -n "${PROFILES[$profile]}" ]; then
                    components=(${PROFILES[$profile]})
                else
                    echo -e "${RED}未知配置: $profile${NC}"
                    list_profiles
                    exit 1
                fi
                ;;
            -s|--select)
                mode="interactive"
                ;;
            -v|--verbose)
                VERBOSE=true
                ;;
            *)
                components+=("$1")
                ;;
        esac
        shift
    done
    
    # 显示系统信息
    detect_os
    show_os_info
    
    # 执行安装
    if [ "$mode" = "interactive" ]; then
        interactive_select
    elif [ ${#components[@]} -gt 0 ]; then
        echo -e "${YELLOW}将安装以下组件:${NC}"
        for comp in "${components[@]}"; do
            echo "  - $comp"
        done
        echo ""
        read -p "确认安装? (y/n): " confirm
        
        if [ "$confirm" != "y" ]; then
            echo "已取消"
            exit 0
        fi
        
        # 执行安装
        local failed=()
        for comp in "${components[@]}"; do
            if ! install_component "$comp"; then
                failed+=("$comp")
            fi
        done
        
        # 显示结果
        echo ""
        echo -e "${GREEN}======================================${NC}"
        echo -e "${GREEN}安装完成${NC}"
        echo -e "${GREEN}======================================${NC}"
        
        if [ ${#failed[@]} -gt 0 ]; then
            echo -e "${RED}失败的组件:${NC}"
            for comp in "${failed[@]}"; do
                echo "  - $comp"
            done
        fi
        
        echo ""
        echo "请执行: source /etc/profile"
    else
        show_help
        exit 1
    fi
}

main "$@"
