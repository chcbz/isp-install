#!/bin/bash
#===============================================================
# Codex WebSocket Agent 安装脚本
#===============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

APP_NAME="codex-ws-agent"
APP_HOME="${CODEX_WS_AGENT_TEST_APP_HOME:-${ISP_APPS:-/home/isp/apps}/$APP_NAME}"
CONF_SRC="$ROOT_DIR/conf/$APP_NAME"
SERVICE_SRC="$ROOT_DIR/systemd/$APP_NAME.service"
SERVICE_DST="/etc/systemd/system/$APP_NAME.service"
BIN_SRC="$ROOT_DIR/bin/codex_ws_agent.sh"
BIN_DST="${ISP_BIN:-/home/isp/bin}/codex_ws_agent.sh"
RELEASES_DIR="$APP_HOME/releases"
CURRENT_LINK="$APP_HOME/current"
STAGED_RELEASE=""
ACTIVE_RELEASE=""
PYTHON_BIN=""
SOURCE_COMMIT=""
SOURCE_TREE=""

# Keep this allowlist explicit. A new release-local import or contract must be reviewed here and
# covered by the isolated collation test before it can become an advertised runtime capability.
RELEASE_PAYLOAD=(
    ".gitignore"
    "README.md"
    "agent-client.mjs"
    "app-server-adapter.mjs"
    "chat-runtime.mjs"
    "codex-home.example.toml"
    "codex-profiles.conf"
    "contracts/api-hosted-wire-v1.json"
    "contracts/api-hosted-wire-v1.provenance.json"
    "contracts/probes/api-long-history-wire.mjs"
    "controlled-image-bounty-capability.mjs"
    "controlled-image-bounty-v3-capability.mjs"
    "controlled-image-http-config.mjs"
    "controlled-image-http-executor-v3.mjs"
    "controlled-image-http-executor.mjs"
    "controlled-image-http-ledger.mjs"
    "controlled-image-http-provider-binding.mjs"
    "conversation-controlled-image-v3.mjs"
    "conversation-controlled-image.mjs"
    "conversation-native.mjs"
    "conversation-reference-inputs-v3.mjs"
    "conversation-reference-inputs.mjs"
    "env.example"
    "evidence/typed-inspection-local-image-gpt-5.6-terra-1f95df2.json"
    "install-policy-check.mjs"
    "juyiting-typed-outcome-stream.mjs"
    "juyiting-typed-outcome.mjs"
    "managed-host.mjs"
    "native-bounty-capability.mjs"
    "package-lock.json"
    "package.json"
    "registration-ack.mjs"
    "report-outbox.mjs"
    "skill-install-manager.mjs"
    "toolchain/delivery_tool.py"
    "toolchain/requirements.txt"
    "typed-inspection-input-carriers.mjs"
    "typed-inspection-network.mjs"
    "typed-inspection-profile.mjs"
    "typed-inspection-runtime.mjs"
    "workspace-file-bridge.mjs"
    "workspace-manager.mjs"
    "workspace-policies.example.json"
)

cleanup_staged_release() {
    if [ -n "${STAGED_RELEASE:-}" ] && [ -e "$STAGED_RELEASE" ]; then
        rm -rf -- "$STAGED_RELEASE"
    fi
}
trap cleanup_staged_release EXIT

validate_workspace_policy_schema() {
    local release_dir="${1:-$APP_HOME}"
    local checker="$release_dir/install-policy-check.mjs"
    local policy="$APP_HOME/workspace-policies.json"
    if [ ! -f "$checker" ]; then
        __red "缺少 workspace policy 迁移检查器: $checker"
        return 1
    fi
    "$NODE_BIN" "$checker" "$policy"
}

validate_agent_configuration() {
    local release_dir="${1:-$APP_HOME}"
    (cd "$APP_HOME" && "$NODE_BIN" "$release_dir/agent-client.mjs" --validate)
}

run_validation_gate() {
    local release_dir="${1:-$APP_HOME}"
    if ! validate_workspace_policy_schema "$release_dir"; then
        __red "Workspace policy schema 检查失败；拒绝继续安装或重启。"
        return 1
    fi
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ] && [ "${CODEX_WS_AGENT_TEST_FAIL_PHASE:-}" = "validation" ]; then
        __red "测试注入：候选 release 验证失败。"
        return 1
    fi
    if ! validate_agent_configuration "$release_dir"; then
        __red "配置验证失败；拒绝继续安装或重启。"
        return 1
    fi
    __green "配置验证通过"
}

restart_agent_service() {
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ]; then
        if [ -n "${CODEX_WS_AGENT_TEST_RESTART_MARKER:-}" ]; then
            printf 'restart requested\n' > "$CODEX_WS_AGENT_TEST_RESTART_MARKER"
        fi
        return 0
    fi
    systemctl restart "$APP_NAME.service"
    systemctl --no-pager --full status "$APP_NAME.service"
}

find_node_bin() {
    if [ -x "${ISP_APPS:-/home/isp/apps}/nodejs/bin/node" ]; then
        echo "${ISP_APPS:-/home/isp/apps}/nodejs/bin/node"
    elif [ -x "${ISP_APPS:-/home/isp/apps}/node/bin/node" ]; then
        echo "${ISP_APPS:-/home/isp/apps}/node/bin/node"
    elif command -v node >/dev/null 2>&1; then
        command -v node
    fi
}

find_npm_bin() {
    local node_bin="$1"
    local adjacent
    adjacent="$(dirname "$node_bin")/npm"
    if [ -x "$adjacent" ]; then
        echo "$adjacent"
    elif command -v npm >/dev/null 2>&1; then
        command -v npm
    fi
}

find_python_bin() {
    if [ -n "${CODEX_WS_AGENT_PYTHON_BIN:-}" ] && [ -x "${CODEX_WS_AGENT_PYTHON_BIN}" ]; then
        echo "${CODEX_WS_AGENT_PYTHON_BIN}"
    elif command -v python3 >/dev/null 2>&1; then
        command -v python3
    fi
}

node_major_version() {
    local node_bin="$1"
    "$node_bin" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

copy_if_missing_private() {
    local src="$1"
    local dst="$2"
    if [ -L "$dst" ] || { [ -e "$dst" ] && [ ! -f "$dst" ]; }; then
        __red "持久配置路径不是普通文件，拒绝覆盖或跟随: $dst"
        return 2
    fi
    if [ ! -f "$dst" ]; then
        install -m 0600 "$src" "$dst"
        return 0
    fi
    chmod 0600 "$dst"
    return 1
}

secure_existing_private_file() {
    local path="$1"
    if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then
        __red "持久状态路径不是普通文件，拒绝 chmod 或跟随: $path"
        return 1
    fi
    if [ -f "$path" ]; then
        chmod 0600 "$path"
    fi
}

prepare_managed_layout() {
    local env_status profile_status
    install -d -m 0755 "$APP_HOME" "$RELEASES_DIR"
    install -d -m 0750 "$APP_HOME/logs"
    install -d -m 0700 "$APP_HOME/data" "$APP_HOME/data/inbox"

    if copy_if_missing_private "$CONF_SRC/env.example" "$APP_HOME/.env"; then
        __yellow "已生成默认 .env，请编辑 OPENCLAW_API_KEY 和 WS_URL: $APP_HOME/.env"
    else
        env_status=$?
        if [ "$env_status" -ne 1 ]; then return "$env_status"; fi
        __yellow "保留已有 .env: $APP_HOME/.env"
    fi
    if copy_if_missing_private "$CONF_SRC/codex-profiles.conf" "$APP_HOME/codex-profiles.conf"; then
        __yellow "已生成默认 profile 配置: $APP_HOME/codex-profiles.conf"
    else
        profile_status=$?
        if [ "$profile_status" -ne 1 ]; then return "$profile_status"; fi
        __yellow "保留已有 profile 配置: $APP_HOME/codex-profiles.conf"
    fi
    secure_existing_private_file "$APP_HOME/workspace-policies.json"
    secure_existing_private_file "$APP_HOME/codex-session-map.json"
}

sha256_file() {
    sha256sum -- "$1" | awk '{print $1}'
}

resolve_source_identity() {
    SOURCE_COMMIT="${CODEX_WS_AGENT_SOURCE_COMMIT:-}"
    SOURCE_TREE="${CODEX_WS_AGENT_SOURCE_TREE:-}"
    if { [ -z "$SOURCE_COMMIT" ] || [ -z "$SOURCE_TREE" ]; } && command -v git >/dev/null 2>&1 \
        && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{commit}')"
        SOURCE_TREE="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')"
    fi
    if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$SOURCE_TREE" =~ ^[0-9a-f]{40}$ ]]; then
        __red "无法确定 exact source commit/tree；拒绝生成无来源制品。"
        return 1
    fi
}

payload_mode() {
    case "$1" in
        toolchain/delivery_tool.py) printf '0755\n' ;;
        workspace-policies.example.json) printf '0640\n' ;;
        evidence/*) printf '0444\n' ;;
        *) printf '0644\n' ;;
    esac
}

verify_release_payload() {
    local release_dir="$1"
    local manifest="$release_dir/release-manifest.sha256"
    local provenance="$release_dir/release-provenance.json"
    local integrity="$release_dir/release-integrity.sha256"
    if [ -L "$manifest" ] || [ ! -f "$manifest" ] || [ -L "$provenance" ] || [ ! -f "$provenance" ] \
        || [ -L "$integrity" ] || [ ! -f "$integrity" ]; then
        __red "release 完整性元数据缺失或不安全: $release_dir"
        return 1
    fi
    if [ "$(wc -l < "$manifest")" -ne "${#RELEASE_PAYLOAD[@]}" ]; then
        __red "release payload 清单数量不匹配: $release_dir"
        return 1
    fi
    if ! (cd "$release_dir" && sha256sum --quiet -c release-manifest.sha256 \
        && sha256sum --quiet -c release-integrity.sha256); then
        __red "release payload SHA-256 校验失败: $release_dir"
        return 1
    fi
}

stage_application_files() {
    local stage="$1"
    local relative source destination source_hash destination_hash mode
    local manifest="$stage/release-manifest.sha256"
    local provenance="$stage/release-provenance.json"
    local integrity="$stage/release-integrity.sha256"
    local manifest_hash installer_hash
    install -d -m 0755 "$stage"
    resolve_source_identity
    : > "$manifest"
    chmod 0600 "$manifest"
    for relative in "${RELEASE_PAYLOAD[@]}"; do
        source="$CONF_SRC/$relative"
        destination="$stage/$relative"
        if [ -L "$source" ] || [ ! -f "$source" ]; then
            __red "release payload 源不是普通文件或为符号链接: $source"
            return 1
        fi
        install -d -m 0755 "$(dirname "$destination")"
        mode="$(payload_mode "$relative")"
        install -m "$mode" "$source" "$destination"
        if [ -L "$destination" ] || [ ! -f "$destination" ]; then
            __red "release payload 目标不是普通文件: $destination"
            return 1
        fi
        source_hash="$(sha256_file "$source")"
        destination_hash="$(sha256_file "$destination")"
        if [ "$source_hash" != "$destination_hash" ]; then
            __red "release payload 复制摘要不匹配: $relative"
            return 1
        fi
        printf '%s  %s\n' "$source_hash" "$relative" >> "$manifest"
    done
    chmod 0444 "$manifest"
    ln -s env.example "$stage/.env.example"

    manifest_hash="$(sha256_file "$manifest")"
    installer_hash="$(sha256_file "$SCRIPT_DIR/codex_ws_agent_install.sh")"
    cat > "$provenance" <<EOF
{
  "schemaVersion": 1,
  "artifact": "codex-ws-agent-release",
  "sourceCommit": "$SOURCE_COMMIT",
  "sourceTree": "$SOURCE_TREE",
  "payloadCount": ${#RELEASE_PAYLOAD[@]},
  "payloadManifest": "release-manifest.sha256",
  "payloadManifestSha256": "$manifest_hash",
  "installerSha256": "$installer_hash"
}
EOF
    chmod 0444 "$provenance"
    (cd "$stage" && sha256sum release-manifest.sha256 release-provenance.json > release-integrity.sha256)
    chmod 0444 "$integrity"
    verify_release_payload "$stage"
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ] && [ "${CODEX_WS_AGENT_TEST_FAIL_PHASE:-}" = "copy" ]; then
        __red "测试注入：候选 release 源文件复制失败。"
        return 1
    fi
}

install_runtime_dependencies() {
    local release_dir="$1"
    if [ -z "${NPM_BIN:-}" ] || [ ! -x "$NPM_BIN" ]; then
        __red "未找到 npm，无法按 package-lock.json 安装运行时依赖。"
        return 1
    fi
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ] && [ "${CODEX_WS_AGENT_TEST_FAIL_PHASE:-}" = "npm" ]; then
        __red "测试注入：候选 release npm 安装失败。"
        return 1
    fi
    (cd "$release_dir" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund)
}


install_delivery_toolchain() {
    local release_dir="$1"
    local venv="$release_dir/.toolchain"
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ]; then
        # The installer integration suite verifies staging/atomicity with mocked Node only.
        # Production always builds and health-checks this release-local venv before cutover.
        return 0
    fi
    if [ -z "${PYTHON_BIN:-}" ] || [ ! -x "$PYTHON_BIN" ]; then
        __red "未找到 Python 3，无法安装受控文件交付工具链。"
        return 1
    fi
    "$PYTHON_BIN" -m venv "$venv"
    "$venv/bin/python" -m pip install --disable-pip-version-check --no-input --no-cache-dir --upgrade 'pip<22'
    "$venv/bin/python" -m pip install --disable-pip-version-check --no-input --no-cache-dir -r "$release_dir/toolchain/requirements.txt"
    "$venv/bin/python" "$release_dir/toolchain/delivery_tool.py" health >/dev/null
}


atomic_switch_release() {
    local release_dir="$1"
    local release_name
    local next_link
    release_name="$(basename "$release_dir")"
    next_link="$APP_HOME/.current-${release_name}-$$"
    if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
        __red "current 激活路径不是符号链接，拒绝覆盖: $CURRENT_LINK"
        return 1
    fi
    ln -s "releases/$release_name" "$next_link"
    mv -Tf "$next_link" "$CURRENT_LINK"
}

install_compatibility_entrypoints() {
    local entry
    local next_link
    # Only static entrypoints/templates: never link persistent .env, profiles, auth, or state.
    for entry in workspace-manager.mjs agent-client.mjs README.md .env.example codex-home.example.toml evidence; do
        next_link="$APP_HOME/.${entry}.next-$$"
        ln -s "current/$entry" "$next_link"
        mv -Tf "$next_link" "$APP_HOME/$entry"
    done
}

validate_compatibility_entrypoint_targets() {
    local entry target
    for entry in workspace-manager.mjs agent-client.mjs README.md .env.example codex-home.example.toml evidence; do
        target="$APP_HOME/$entry"
        if [ "$entry" = "evidence" ]; then
            if [ -e "$target" ] && [ ! -L "$target" ]; then
                __red "静态 evidence 入口已被非符号链接占用，拒绝覆盖: $target"
                return 1
            fi
        elif [ -d "$target" ] && [ ! -L "$target" ]; then
            __red "静态兼容入口已被目录占用，拒绝覆盖: $target"
            return 1
        fi
    done
}

collate_release() {
    local release_id
    local final_release
    release_id="${CODEX_WS_AGENT_TEST_RELEASE_ID:-$(date +%Y%m%d%H%M%S)-$$}"
    STAGED_RELEASE="$RELEASES_DIR/.stage-$release_id"
    final_release="$RELEASES_DIR/$release_id"
    if [ -e "$STAGED_RELEASE" ] || [ -e "$final_release" ]; then
        __red "候选 release 路径已存在，拒绝覆盖: $release_id"
        return 1
    fi

    stage_application_files "$STAGED_RELEASE"
    install_runtime_dependencies "$STAGED_RELEASE"
    install_delivery_toolchain "$STAGED_RELEASE"
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ] && [ "${CODEX_WS_AGENT_TEST_FAIL_PHASE:-}" = "payload-drift" ]; then
        printf '\nTEST-ONLY-PAYLOAD-DRIFT\n' >> "$STAGED_RELEASE/agent-client.mjs"
    fi
    verify_release_payload "$STAGED_RELEASE"
    run_validation_gate "$STAGED_RELEASE"
    verify_release_payload "$STAGED_RELEASE"
    validate_compatibility_entrypoint_targets

    mv -T "$STAGED_RELEASE" "$final_release"
    STAGED_RELEASE=""
    atomic_switch_release "$final_release"
    install_compatibility_entrypoints
    ACTIVE_RELEASE="$final_release"
}

if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ]; then
    NODE_BIN="${CODEX_WS_AGENT_TEST_NODE_BIN:-$(command -v node || true)}"
    NPM_BIN="${CODEX_WS_AGENT_TEST_NPM_BIN:-$(find_npm_bin "$NODE_BIN" || true)}"
    PYTHON_BIN="${CODEX_WS_AGENT_TEST_PYTHON_BIN:-$(find_python_bin || true)}"
    if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
        __red "测试模式未提供可执行 Node.js"
        exit 1
    fi
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_COLLATE:-0}" = "1" ]; then
        prepare_managed_layout
        collate_release >/dev/null
    else
        run_validation_gate "$APP_HOME"
    fi
    if [ "${START_CODEX_WS_AGENT:-n}" = "y" ]; then
        restart_agent_service
    fi
    exit 0
fi

check_root
detect_os

echo "=========================================="
echo "Codex WebSocket Agent 安装脚本"
echo "=========================================="
show_os_info

if [ ! -d "$CONF_SRC" ]; then
    __red "配置目录不存在: $CONF_SRC"
    exit 1
fi

NODE_BIN="$(find_node_bin || true)"
if [ -z "$NODE_BIN" ]; then
    __red "未找到 Node.js，请先执行: ./install.sh node"
    exit 1
fi

NODE_MAJOR="$(node_major_version "$NODE_BIN")"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
    __red "Node.js 版本需要 >= 20，当前: $("$NODE_BIN" -v 2>/dev/null || echo unknown)"
    exit 1
fi

NPM_BIN="$(find_npm_bin "$NODE_BIN" || true)"
if [ -z "$NPM_BIN" ]; then
    __red "未找到 npm，无法按 package-lock.json 安装运行时依赖。"
    exit 1
fi

PYTHON_BIN="$(find_python_bin || true)"
if [ -z "$PYTHON_BIN" ]; then
    __red "未找到 Python 3，无法安装受控文件交付工具链。"
    exit 1
fi

echo ""
echo "[1/7] 创建并加固持久目录..."
create_isp_dirs
prepare_managed_layout

echo ""
echo "[2/7] 在隔离 release 中归集源码和配置模板..."
echo "[3/7] 在候选 release 中按锁文件安装生产依赖..."
echo "[4/7] 验证候选 release 后原子切换 current..."
collate_release
__green "已激活 release: $ACTIVE_RELEASE"

echo ""
echo "[5/7] 安装管理脚本..."
install -m 0755 "$BIN_SRC" "$BIN_DST"

echo ""
echo "[6/7] 安装 systemd 服务..."
install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable "$APP_NAME.service"

echo ""
echo "[7/7] 检查 A07 workspace policy..."
if [ -f "$APP_HOME/workspace-policies.json" ]; then
    __green "检测到受控 workspace policy: $APP_HOME/workspace-policies.json"
else
    __yellow "尚未启用 A07 workspace policy。command.dispatch 将 fail closed，不会回退到共享可写代码目录。"
    echo "  cp $CURRENT_LINK/workspace-policies.example.json $APP_HOME/workspace-policies.json"
    echo "  编辑可信 repository/baseRef/trustedRemoteUrl/trustedRemoteRef，并在 .env 设置 CODEX_WORKSPACE_POLICIES_FILE"
fi

if [ "${START_CODEX_WS_AGENT:-n}" = "y" ]; then
    restart_agent_service
else
    __yellow "未自动启动服务。如需启动请执行:"
    echo "  systemctl restart $APP_NAME.service"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "Codex WebSocket Agent 部署完成"
echo "==========================================${NC}"
echo "应用目录: $APP_HOME"
echo "当前 release: $CURRENT_LINK"
echo "配置文件: $APP_HOME/.env"
echo "Profile:  $APP_HOME/codex-profiles.conf"
echo "Workspace policy 示例: $CURRENT_LINK/workspace-policies.example.json"
echo "管理脚本: $BIN_DST"
echo "服务单元: $SERVICE_DST"
