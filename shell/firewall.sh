#!/bin/bash
#===============================================================
# 防火墙配置脚本 - 支持 CentOS/Rocky/Ubuntu/Debian
#===============================================================

set -e

# 获取脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

check_root
detect_os

echo "=========================================="
echo "防火墙配置脚本"
echo "=========================================="
show_os_info

#===============================================================
# 服务端口映射
#===============================================================
declare -A SERVICE_PORTS=(
    ["http"]="80/tcp"
    ["https"]="443/tcp"
    ["mysql"]="3306/tcp"
    ["redis"]="6379/tcp"
    ["nginx"]="80/tcp 443/tcp"
    ["php-fpm"]="9000/tcp"
    ["rabbitmq"]="5672/tcp 15672/tcp"
    ["elasticsearch"]="9200/tcp 9300/tcp"
    ["jenkins"]="8080/tcp"
    ["nexus"]="8081/tcp"
    ["openldap"]="389/tcp 636/tcp"
    ["ftp"]="21/tcp 30000-50000/tcp"
    ["ssh"]="22/tcp"
    ["vpn"]="500/udp 4500/udp 1701/udp"
    ["dns"]="53/tcp 53/udp"
    ["smtp"]="25/tcp 465/tcp 587/tcp"
    ["pop3"]="110/tcp 995/tcp"
    ["imap"]="143/tcp 993/tcp"
)

#===============================================================
# 获取防火墙类型
#===============================================================
get_firewall_type() {
    if command -v firewall-cmd &> /dev/null; then
        echo "firewalld"
    elif command -v ufw &> /dev/null; then
        echo "ufw"
    elif command -v iptables &> /dev/null; then
        echo "iptables"
    else
        echo "none"
    fi
}

#===============================================================
# firewalld 操作
#===============================================================
firewalld_open_port() {
    local port=$1
    local service_name=$2
    
    if firewall-cmd --permanent --add-port="$port" 2>/dev/null; then
        echo -e "${GREEN}✅ 已开放端口: $port ($service_name)${NC}"
    fi
}

firewalld_close_port() {
    local port=$1
    local service_name=$2
    
    if firewall-cmd --permanent --remove-port="$port" 2>/dev/null; then
        echo -e "${GREEN}✅ 已关闭端口: $port ($service_name)${NC}"
    fi
}

firewalld_list() {
    echo -e "${GREEN}已开放的端口:${NC}"
    firewall-cmd --list-ports
}

#===============================================================
# UFW 操作
#===============================================================
ufw_open_port() {
    local port=$1
    local service_name=$2
    
    if ufw allow "$port" comment "$service_name" 2>/dev/null; then
        echo -e "${GREEN}✅ 已开放端口: $port ($service_name)${NC}"
    fi
}

ufw_close_port() {
    local port=$1
    local service_name=$2
    
    if ufw delete allow "$port" 2>/dev/null; then
        echo -e "${GREEN}✅ 已关闭端口: $port ($service_name)${NC}"
    fi
}

ufw_list() {
    echo -e "${GREEN}UFW 状态:${NC}"
    ufw status numbered
}

#===============================================================
# 打开服务端口
#===============================================================
open_service() {
    local service=$1
    local ports=${SERVICE_PORTS[$service]}
    
    if [ -z "$ports" ]; then
        echo -e "${RED}未知服务: $service${NC}"
        return 1
    fi
    
    local fw_type=$(get_firewall_type)
    
    for port in $ports; do
        case $fw_type in
            firewalld)
                firewalld_open_port "$port" "$service"
                ;;
            ufw)
                ufw_open_port "$port" "$service"
                ;;
            *)
                echo -e "${YELLOW}请手动配置防火墙: $port${NC}"
                ;;
        esac
    done
    
    # 重载防火墙
    case $fw_type in
        firewalld)
            firewall-cmd --reload
            ;;
        ufw)
            ufw reload 2>/dev/null || true
            ;;
    esac
}

#===============================================================
# 关闭服务端口
#===============================================================
close_service() {
    local service=$1
    local ports=${SERVICE_PORTS[$service]}
    
    if [ -z "$ports" ]; then
        echo -e "${RED}未知服务: $service${NC}"
        return 1
    fi
    
    local fw_type=$(get_firewall_type)
    
    for port in $ports; do
        case $fw_type in
            firewalld)
                firewalld_close_port "$port" "$service"
                ;;
            ufw)
                ufw_close_port "$port" "$service"
                ;;
        esac
    done
    
    # 重载防火墙
    case $fw_type in
        firewalld)
            firewall-cmd --reload
            ;;
    esac
}

#===============================================================
# 列出服务
#===============================================================
list_services() {
    echo -e "${GREEN}可配置的服务:${NC}"
    echo ""
    
    for service in "${!SERVICE_PORTS[@]}"; do
        echo -e "  ${BLUE}$service${NC}: ${SERVICE_PORTS[$service]}"
    done
}

#===============================================================
# 显示帮助
#===============================================================
show_help() {
    echo "防火墙配置脚本"
    echo ""
    echo "使用方法:"
    echo "  $0 open <服务名>      开放服务端口"
    echo "  $0 close <服务名>     关闭服务端口"
    echo "  $0 list               列出已开放端口"
    echo "  $0 services           列出可用服务"
    echo "  $0 status             显示防火墙状态"
    echo ""
    echo "示例:"
    echo "  $0 open nginx         开放 HTTP/HTTPS 端口"
    echo "  $0 open mysql         开放 MySQL 端口"
    echo "  $0 close redis        关闭 Redis 端口"
}

#===============================================================
# 主函数
#===============================================================
main() {
    local action=$1
    local service=$2
    
    local fw_type=$(get_firewall_type)
    
    echo -e "${GREEN}检测到防火墙: $fw_type${NC}"
    echo ""
    
    case $action in
        open)
            if [ -z "$service" ]; then
                echo -e "${RED}请指定服务名${NC}"
                show_help
                exit 1
            fi
            open_service "$service"
            ;;
        close)
            if [ -z "$service" ]; then
                echo -e "${RED}请指定服务名${NC}"
                show_help
                exit 1
            fi
            close_service "$service"
            ;;
        list)
            case $fw_type in
                firewalld)
                    firewalld_list
                    ;;
                ufw)
                    ufw_list
                    ;;
            esac
            ;;
        services)
            list_services
            ;;
        status)
            case $fw_type in
                firewalld)
                    firewall-cmd --state
                    firewall-cmd --list-all
                    ;;
                ufw)
                    ufw status verbose
                    ;;
            esac
            ;;
        -h|--help|*)
            show_help
            ;;
    esac
}

main "$@"
