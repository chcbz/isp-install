#!/bin/bash
#===============================================================
# Codex WebSocket Agent 安装脚本
#===============================================================

set -euo pipefail

TEST_MODE="${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}"
TEST_ISOLATION_CHECK=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

APP_NAME="codex-ws-agent"
TEST_FULL="${CODEX_WS_AGENT_INSTALL_TEST_FULL:-0}"
INSTANCE=""
INSTANCE_SELECTED=0
INSTALL_MODE="shared"
TEST_FIXTURE_ROOT=""

usage() {
    echo "Usage: $0 [--instance SAFE_SLUG]" >&2
}

validate_instance_slug() {
    local value="$1"
    [ "${#value}" -le 63 ] || return 1
    [[ "$value" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
}

test_isolation_error() {
    __red "TEST_ISOLATION_REQUIRED: $1"
    return 1
}

validate_test_fixture_root() {
    local raw="${CODEX_WS_AGENT_TEST_FIXTURE_ROOT:-}" canonical mode protected
    [ -n "$raw" ] || { test_isolation_error 'CODEX_WS_AGENT_TEST_FIXTURE_ROOT is required'; return 1; }
    [[ "$raw" = /* ]] || { test_isolation_error 'fixture root must be absolute'; return 1; }
    [ -d "$raw" ] && [ ! -L "$raw" ] || { test_isolation_error 'fixture root must be an existing real directory'; return 1; }
    canonical="$(realpath -e -- "$raw")" || { test_isolation_error 'fixture root cannot be resolved'; return 1; }
    [ "$canonical" = "$raw" ] || { test_isolation_error 'fixture root must be canonical and cannot contain symlink components'; return 1; }
    [ "$(stat -c '%u' -- "$canonical")" = "$(id -u)" ] || { test_isolation_error 'fixture root must be owned by the invoking uid'; return 1; }
    mode="$(stat -c '%a' -- "$canonical")"
    (( (8#$mode & 077) == 0 )) || { test_isolation_error 'fixture root must not grant group/other permissions'; return 1; }
    for protected in /home/isp/apps /home/isp/bin /etc/systemd/system /proc; do
        protected="$(realpath -m -- "$protected")"
        case "$canonical/" in "$protected/"|"$protected/"*) test_isolation_error "fixture root overlaps protected path $protected"; return 1;; esac
        case "$protected/" in "$canonical/"*) test_isolation_error "fixture root contains protected path $protected"; return 1;; esac
    done
    TEST_FIXTURE_ROOT="$canonical"
}

validate_test_path() {
    local label="$1" value="$2" canonical
    [ -n "$value" ] || { test_isolation_error "$label is required"; return 1; }
    [[ "$value" = /* ]] || { test_isolation_error "$label must be absolute"; return 1; }
    canonical="$(realpath -m -- "$value")" || { test_isolation_error "$label cannot be resolved"; return 1; }
    [ "$canonical" = "$value" ] || { test_isolation_error "$label must be canonical and cannot traverse or contain symlink components"; return 1; }
    case "$canonical/" in
        "$TEST_FIXTURE_ROOT/"*) ;;
        *) test_isolation_error "$label must be below CODEX_WS_AGENT_TEST_FIXTURE_ROOT"; return 1 ;;
    esac
    [ "$canonical" != "$TEST_FIXTURE_ROOT" ] || { test_isolation_error "$label cannot equal the fixture root"; return 1; }
}

validate_test_existing_directory() {
    local label="$1" value="$2"
    validate_test_path "$label" "$value" || return 1
    [ -d "$value" ] && [ ! -L "$value" ] \
        || { test_isolation_error "$label must be an existing non-symlink directory"; return 1; }
}

validate_test_executable() {
    local label="$1" value="$2"
    validate_test_path "$label" "$value" || return 1
    [ -f "$value" ] && [ ! -L "$value" ] && [ -x "$value" ] \
        || { test_isolation_error "$label must be an existing non-symlink executable"; return 1; }
}

validate_test_release_id() {
    local value="${CODEX_WS_AGENT_TEST_RELEASE_ID:-}"
    [ -z "$value" ] && return 0
    [ "${#value}" -le 128 ] && [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]] \
        || { test_isolation_error 'CODEX_WS_AGENT_TEST_RELEASE_ID must be one safe path component'; return 1; }
}

validate_test_isolation_contract() {
    [ "$TEST_MODE" = "1" ] || return 0
    validate_test_fixture_root || return 1
    validate_test_path CODEX_WS_AGENT_TEST_APP_HOME "${CODEX_WS_AGENT_TEST_APP_HOME:-}" || return 1
    validate_test_path CODEX_WS_AGENT_TEST_INSTANCE_ROOT "${CODEX_WS_AGENT_TEST_INSTANCE_ROOT:-}" || return 1
    validate_test_path CODEX_WS_AGENT_TEST_SYSTEMD_DIR "${CODEX_WS_AGENT_TEST_SYSTEMD_DIR:-}" || return 1
    validate_test_path CODEX_WS_AGENT_TEST_BIN_DIR "${CODEX_WS_AGENT_TEST_BIN_DIR:-}" || return 1
    validate_test_existing_directory HOME "${HOME:-}" || return 1
    validate_test_existing_directory TMPDIR "${TMPDIR:-}" || return 1
    validate_test_existing_directory XDG_CACHE_HOME "${XDG_CACHE_HOME:-}" || return 1
    validate_test_existing_directory XDG_CONFIG_HOME "${XDG_CONFIG_HOME:-}" || return 1
    validate_test_existing_directory XDG_STATE_HOME "${XDG_STATE_HOME:-}" || return 1
    validate_test_existing_directory NPM_CONFIG_CACHE "${NPM_CONFIG_CACHE:-}" || return 1
    validate_test_executable CODEX_WS_AGENT_TEST_SYSTEMCTL "${CODEX_WS_AGENT_TEST_SYSTEMCTL:-}" || return 1
    validate_test_executable CODEX_WS_AGENT_TEST_NODE_BIN "${CODEX_WS_AGENT_TEST_NODE_BIN:-}" || return 1
    validate_test_executable CODEX_WS_AGENT_TEST_NPM_BIN "${CODEX_WS_AGENT_TEST_NPM_BIN:-}" || return 1
    validate_test_executable CODEX_WS_AGENT_TEST_PYTHON_BIN "${CODEX_WS_AGENT_TEST_PYTHON_BIN:-}" || return 1
    validate_test_release_id || return 1
    if [ -n "${CODEX_WS_AGENT_TEST_RESTART_MARKER:-}" ]; then
        validate_test_path CODEX_WS_AGENT_TEST_RESTART_MARKER "$CODEX_WS_AGENT_TEST_RESTART_MARKER" || return 1
    fi
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --instance)
            [ "$#" -ge 2 ] || { usage; exit 2; }
            INSTANCE_SELECTED=1
            INSTANCE="$2"
            shift 2
            ;;
        --test-isolation-check)
            [ "$TEST_MODE" = "1" ] || { usage; exit 2; }
            TEST_ISOLATION_CHECK=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage
            exit 2
            ;;
    esac
done

if [ "$INSTANCE_SELECTED" = "1" ]; then
    validate_instance_slug "$INSTANCE" || {
        __red "invalid instance slug: use 1-63 lowercase letters, digits, or interior hyphens"
        exit 2
    }
    INSTALL_MODE="instance"
fi

validate_test_isolation_contract
if [ "$TEST_ISOLATION_CHECK" = "1" ]; then
    exit 0
fi

if [ "$TEST_MODE" = "1" ]; then
    DEFAULT_APP_HOME="$CODEX_WS_AGENT_TEST_APP_HOME"
    INSTANCE_ROOT="$CODEX_WS_AGENT_TEST_INSTANCE_ROOT"
    SYSTEMD_DIR="$CODEX_WS_AGENT_TEST_SYSTEMD_DIR"
    SYSTEMCTL_BIN="$CODEX_WS_AGENT_TEST_SYSTEMCTL"
    TEST_BIN_DIR="$CODEX_WS_AGENT_TEST_BIN_DIR"
else
    DEFAULT_APP_HOME="${ISP_APPS:-/home/isp/apps}/$APP_NAME"
    INSTANCE_ROOT="${ISP_APPS:-/home/isp/apps}/${APP_NAME}-instances"
    SYSTEMD_DIR="/etc/systemd/system"
    SYSTEMCTL_BIN="systemctl"
    TEST_BIN_DIR=""
fi
CONF_SRC="$ROOT_DIR/conf/$APP_NAME"
BIN_SRC="$ROOT_DIR/bin/codex_ws_agent.sh"
if [ "$INSTALL_MODE" = "instance" ]; then
    APP_HOME="$INSTANCE_ROOT/$INSTANCE"
    SERVICE_NAME="$APP_NAME@$INSTANCE.service"
    SERVICE_SRC="$ROOT_DIR/systemd/$APP_NAME@.service"
    SERVICE_DST="$SYSTEMD_DIR/$APP_NAME@.service"
    BIN_DST="$APP_HOME/bin/codex_ws_agent.sh"
else
    APP_HOME="$DEFAULT_APP_HOME"
    SERVICE_NAME="$APP_NAME.service"
    SERVICE_SRC="$ROOT_DIR/systemd/$APP_NAME.service"
    SERVICE_DST="$SYSTEMD_DIR/$APP_NAME.service"
    if [ "$TEST_MODE" = "1" ]; then
        BIN_DST="$TEST_BIN_DIR/codex_ws_agent.sh"
    else
        BIN_DST="${ISP_BIN:-/home/isp/bin}/codex_ws_agent.sh"
    fi
fi
RELEASES_DIR="$APP_HOME/releases"
CURRENT_LINK="$APP_HOME/current"
INSTANCE_MARKER="$APP_HOME/.codex-ws-agent-instance"
STAGED_RELEASE=""
ACTIVE_RELEASE=""
PYTHON_BIN=""
SOURCE_COMMIT=""
SOURCE_TREE=""
INSTALL_LOCK_FD=""

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
    "controlled-image-delivery-retention-v3.mjs"
    "controlled-image-gpt-cli-config.mjs"
    "controlled-image-gpt-cli-egress-gate.mjs"
    "controlled-image-gpt-cli-executor-v3.mjs"
    "controlled-image-http-config.mjs"
    "controlled-image-http-executor-v3.mjs"
    "controlled-image-http-executor.mjs"
    "controlled-image-http-ledger.mjs"
    "controlled-image-http-provider-binding.mjs"
    "controlled-image-v3-files.mjs"
    "conversation-controlled-image-v3.mjs"
    "conversation-controlled-image.mjs"
    "conversation-native.mjs"
    "conversation-reference-inputs-v3.mjs"
    "conversation-reference-inputs.mjs"
    "env.example"
    "evidence/typed-inspection-local-image-gpt-5.6-terra-1f95df2.json"
    "install-candidate/INSTALL-CANDIDATE.md"
    "install-candidate/controlled-image-api-policy.redacted.json"
    "install-candidate/install-candidate-check.mjs"
    "install-candidate/wuyong-dual-mode.env.redacted"
    "install-candidate/wuyong-dual-mode-profile.redacted.json"
    "install-policy-check.mjs"
    "juyiting-action-outcome.mjs"
    "juyiting-typed-outcome-stream.mjs"
    "juyiting-typed-outcome.mjs"
    "managed-host.mjs"
    "migrate-ack-high-water.mjs"
    "managed-chat-scope-config.mjs"
    "managed-image-scope-config.mjs"
    "managed-image-scopes.example.json"
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

safe_absolute_path() {
    local value="$1"
    [[ "$value" =~ ^/[A-Za-z0-9_./-]+$ ]] || return 1
    [ "$(realpath -m -- "$value")" = "${value%/}" ]
}

assert_real_directory() {
    local path="$1"
    if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
        __red "目录路径不是实际目录，拒绝跟随或覆盖: $path"
        return 1
    fi
}

ensure_directory() {
    local mode="$1" path="$2"
    assert_real_directory "$path"
    install -d -m "$mode" "$path"
    if [ -L "$path" ] || [ ! -d "$path" ]; then
        __red "无法建立安全目录: $path"
        return 1
    fi
    chmod "$mode" "$path"
}

validate_instance_paths() {
    local canonical_root canonical_home canonical_default
    [ "$INSTALL_MODE" = "instance" ] || return 0
    safe_absolute_path "$INSTANCE_ROOT" || {
        __red "instance root 必须是无遍历、无控制字符的规范绝对路径: $INSTANCE_ROOT"
        return 1
    }
    assert_real_directory "$INSTANCE_ROOT"
    canonical_root="$(realpath -m -- "$INSTANCE_ROOT")"
    canonical_home="$(realpath -m -- "$APP_HOME")"
    canonical_default="$(realpath -m -- "$DEFAULT_APP_HOME")"
    [ "$canonical_home" = "$canonical_root/$INSTANCE" ] || {
        __red "instance APP_HOME 逃逸根目录，拒绝安装: $APP_HOME"
        return 1
    }
    case "$canonical_home/" in
        "$canonical_default/"|"$canonical_default/"*)
            __red "instance APP_HOME 与默认共享根重叠，拒绝安装: $APP_HOME"
            return 1
            ;;
    esac
    case "$canonical_default/" in
        "$canonical_home/"*)
            __red "默认共享根位于 instance APP_HOME 内，拒绝安装: $APP_HOME"
            return 1
            ;;
    esac
}

acquire_instance_lock() {
    local lock_root lock_file
    [ "$INSTALL_MODE" = "instance" ] || return 0
    command -v flock >/dev/null 2>&1 || {
        __red "缺少 flock，无法串行化 instance 安装"
        return 1
    }
    ensure_directory 0700 "$INSTANCE_ROOT"
    lock_root="$INSTANCE_ROOT/.locks"
    ensure_directory 0700 "$lock_root"
    lock_file="$lock_root/$INSTANCE.lock"
    if [ -L "$lock_file" ] || { [ -e "$lock_file" ] && [ ! -f "$lock_file" ]; }; then
        __red "instance 安装锁不是普通文件: $lock_file"
        return 1
    fi
    exec {INSTALL_LOCK_FD}>"$lock_file"
    chmod 0600 "$lock_file"
    # Availability-first: wait for this exact instance lock; never preempt another installer.
    flock "$INSTALL_LOCK_FD"
}

prepare_instance_root() {
    local marker_value existing
    [ "$INSTALL_MODE" = "instance" ] || return 0
    if [ -e "$APP_HOME" ]; then
        assert_real_directory "$APP_HOME"
        if [ ! -f "$INSTANCE_MARKER" ] || [ -L "$INSTANCE_MARKER" ]; then
            existing="$(find "$APP_HOME" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
            if [ -n "$existing" ]; then
                __red "已有非空目录未声明为该 instance，拒绝接管: $APP_HOME"
                return 1
            fi
        fi
    fi
    ensure_directory 0755 "$APP_HOME"
    if [ -e "$INSTANCE_MARKER" ]; then
        if [ -L "$INSTANCE_MARKER" ] || [ ! -f "$INSTANCE_MARKER" ]; then
            __red "instance marker 不安全: $INSTANCE_MARKER"
            return 1
        fi
        marker_value="$(cat "$INSTANCE_MARKER")"
        [ "$marker_value" = "instance=$INSTANCE" ] || {
            __red "instance marker 与选择器不匹配: $APP_HOME"
            return 1
        }
    else
        (umask 077; printf 'instance=%s\n' "$INSTANCE" > "$INSTANCE_MARKER.next-$$")
        mv -T "$INSTANCE_MARKER.next-$$" "$INSTANCE_MARKER"
    fi
}

render_instance_private_file() {
    local kind="$1" src="$2" dst="$3" tmp
    tmp="$dst.next-$$"
    if [ -L "$dst" ] || { [ -e "$dst" ] && [ ! -f "$dst" ]; }; then
        __red "持久配置路径不是普通文件，拒绝覆盖或跟随: $dst"
        return 2
    fi
    if [ -f "$dst" ]; then
        chmod 0600 "$dst"
        return 1
    fi
    case "$kind" in
        env)
            {
                printf '# Generated unconfigured instance candidate. No live identity, secret, session, or task state was copied.\n'
                sed \
                    -e "s|/home/isp/apps/codex-ws-agent|$APP_HOME|g" \
                    -e "s|^DEFAULT_CODEX_PROFILE=codex-default$|DEFAULT_CODEX_PROFILE=instance-$INSTANCE|" \
                    -e "s|\"profileId\":\"default\"|\"profileId\":\"instance-$INSTANCE\"|g" \
                    -e "s|\"agentId\":\"codex-default\"|\"agentId\":\"unconfigured-$INSTANCE\"|g" \
                    -e "s|\"agentName\":\"Codex\"|\"agentName\":\"Unconfigured $INSTANCE\"|g" \
                    -e "s|\"personaName\":\"Default\"|\"personaName\":\"Unconfigured\"|g" \
                    -e "s|\"codexWorkdir\":\"/home/isp\"|\"codexWorkdir\":\"$APP_HOME/workspace\"|g" \
                    "$src"
                printf '\nCODEX_SESSION_MAP_FILE=%s/state/codex-session-map.json\n' "$APP_HOME"
            } > "$tmp"
            ;;
        profile)
            {
                printf '# Generated unconfigured instance candidate. Replace identity/custody explicitly before start.\n'
                sed \
                    -e "s|/home/isp/apps/codex-ws-agent|$APP_HOME|g" \
                    -e "s|^codexWorkdir=/home/isp$|codexWorkdir=$APP_HOME/workspace|" \
                    -e "s|^profileId=codex-default$|profileId=instance-$INSTANCE|" \
                    -e "s|^agentId=codex-default$|agentId=unconfigured-$INSTANCE|" \
                    -e "s|^agentName=Codex$|agentName=Unconfigured $INSTANCE|" \
                    -e "s|^personaName=Default$|personaName=Unconfigured|" \
                    "$src"
                printf '\n# Reserved isolated provider ledger root; provider execution remains disabled.\n'
                printf 'controlledImageHttpEnabled=false\n'
                printf 'controlledImageHttpLedgerRoot=%s/data/provider-ledgers/unconfigured-%s\n' "$APP_HOME" "$INSTANCE"
            } > "$tmp"
            ;;
        *)
            __red "unknown instance config kind: $kind"
            return 2
            ;;
    esac
    chmod 0600 "$tmp"
    mv -T "$tmp" "$dst"
    return 0
}

preflight_service_target() {
    if [ -L "$SERVICE_DST" ] || { [ -e "$SERVICE_DST" ] && [ ! -f "$SERVICE_DST" ]; }; then
        __red "systemd unit 目标不是普通文件: $SERVICE_DST"
        return 1
    fi
    if [ "$INSTALL_MODE" = "instance" ] && [ -f "$SERVICE_DST" ] && ! cmp -s "$SERVICE_SRC" "$SERVICE_DST"; then
        __red "现有共享 instance unit template 内容不同；拒绝由单实例安装覆盖: $SERVICE_DST"
        return 1
    fi
}

systemctl_cmd() {
    "$SYSTEMCTL_BIN" "$@"
}

install_service_unit() {
    install -d -m 0755 "$(dirname "$SERVICE_DST")"
    if [ "$INSTALL_MODE" = "instance" ]; then
        if [ ! -e "$SERVICE_DST" ]; then
            install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
        fi
        systemctl_cmd daemon-reload
        __yellow "instance unit 已安装但未 enable/start；身份、凭据和空闲移交由运行 Owner 另行确认。"
    else
        install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
        systemctl_cmd daemon-reload
        systemctl_cmd enable "$SERVICE_NAME"
    fi
}

install_management_launcher() {
    local control wrapper
    if [ "$INSTALL_MODE" = "shared" ]; then
        install -d -m 0755 "$(dirname "$BIN_DST")"
        install -m 0755 "$BIN_SRC" "$BIN_DST"
        return
    fi
    ensure_directory 0755 "$APP_HOME/bin"
    control="$APP_HOME/bin/codex_ws_agent-control.sh"
    wrapper="$APP_HOME/bin/codex_ws_agent.sh"
    if [ -L "$control" ] || { [ -e "$control" ] && [ ! -f "$control" ]; } \
        || [ -L "$wrapper" ] || { [ -e "$wrapper" ] && [ ! -f "$wrapper" ]; }; then
        __red "instance launcher 目标不安全: $APP_HOME/bin"
        return 1
    fi
    install -m 0755 "$BIN_SRC" "$control.next-$$"
    [ "$(sha256_file "$BIN_SRC")" = "$(sha256_file "$control.next-$$")" ] || {
        __red "instance launcher 复制摘要不匹配"
        return 1
    }
    mv -Tf "$control.next-$$" "$control"
    cat > "$wrapper.next-$$" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export CODEX_WS_AGENT_INSTANCE_ROOT='$INSTANCE_ROOT'
export CODEX_WS_AGENT_SYSTEMD_DIR='$SYSTEMD_DIR'
exec '$control' --instance '$INSTANCE' "\$@"
EOF
    chmod 0755 "$wrapper.next-$$"
    mv -Tf "$wrapper.next-$$" "$wrapper"
}

instance_configuration_is_unconfigured() {
    [ "$INSTALL_MODE" = "instance" ] || return 1
    grep -Eq '^OPENCLAW_API_KEY=(replace-with-api-key)?$' "$APP_HOME/.env" \
        || grep -Eq '^agentId=unconfigured-' "$APP_HOME/codex-profiles.conf"
}

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
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ] && [ "${CODEX_WS_AGENT_INSTALL_TEST_FULL:-0}" != "1" ]; then
        if [ -n "${CODEX_WS_AGENT_TEST_RESTART_MARKER:-}" ]; then
            printf 'restart requested\n' > "$CODEX_WS_AGENT_TEST_RESTART_MARKER"
        fi
        return 0
    fi
    if instance_configuration_is_unconfigured; then
        __red "instance 配置仍是未配置候选；拒绝启动或注册。"
        return 1
    fi
    systemctl_cmd restart "$SERVICE_NAME"
    systemctl_cmd --no-pager --full status "$SERVICE_NAME"
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
    ensure_directory 0755 "$APP_HOME"
    ensure_directory 0755 "$RELEASES_DIR"
    ensure_directory 0750 "$APP_HOME/logs"
    ensure_directory 0700 "$APP_HOME/data"
    ensure_directory 0700 "$APP_HOME/data/inbox"

    if [ "$INSTALL_MODE" = "instance" ]; then
        ensure_directory 0700 "$APP_HOME/data/outbox"
        ensure_directory 0700 "$APP_HOME/data/provider-ledgers"
        ensure_directory 0700 "$APP_HOME/data/private-runs"
        ensure_directory 0700 "$APP_HOME/state"
        ensure_directory 0700 "$APP_HOME/run"
        ensure_directory 0700 "$APP_HOME/homes"
        ensure_directory 0700 "$APP_HOME/workspace"
        ensure_directory 0700 "$APP_HOME/workspaces"
        if render_instance_private_file env "$CONF_SRC/env.example" "$APP_HOME/.env"; then
            __yellow "已生成 instance 未配置 .env 候选；未复制任何线上凭据: $APP_HOME/.env"
        else
            env_status=$?
            if [ "$env_status" -ne 1 ]; then return "$env_status"; fi
            __yellow "保留已有 instance .env: $APP_HOME/.env"
        fi
        if render_instance_private_file profile "$CONF_SRC/codex-profiles.conf" "$APP_HOME/codex-profiles.conf"; then
            __yellow "已生成 instance 未配置 profile 候选: $APP_HOME/codex-profiles.conf"
        else
            profile_status=$?
            if [ "$profile_status" -ne 1 ]; then return "$profile_status"; fi
            __yellow "保留已有 instance profile: $APP_HOME/codex-profiles.conf"
        fi
        secure_existing_private_file "$APP_HOME/workspace-policies.json"
        secure_existing_private_file "$APP_HOME/state/codex-session-map.json"
    else
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
    fi
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

restore_current_release() {
    local previous_target="$1" next_link="$APP_HOME/.current-recovery-$$"
    if [ -n "$previous_target" ]; then
        ln -s "$previous_target" "$next_link"
        mv -Tf "$next_link" "$CURRENT_LINK"
    elif [ -L "$CURRENT_LINK" ]; then
        rm -f -- "$CURRENT_LINK"
    fi
}

collate_release() {
    local release_id final_release previous_target=""
    release_id="${CODEX_WS_AGENT_TEST_RELEASE_ID:-$(date +%Y%m%d%H%M%S)-$$}"
    STAGED_RELEASE="$RELEASES_DIR/.stage-$release_id"
    final_release="$RELEASES_DIR/$release_id"
    if [ -e "$STAGED_RELEASE" ] || [ -e "$final_release" ]; then
        __red "候选 release 路径已存在，拒绝覆盖: $release_id"
        return 1
    fi
    if [ -L "$CURRENT_LINK" ]; then
        previous_target="$(readlink "$CURRENT_LINK")"
        [[ "$previous_target" =~ ^releases/[A-Za-z0-9._-]+$ ]] || {
            __red "current 链接目标不在受管 releases 内，拒绝安装: $previous_target"
            return 1
        }
    elif [ -e "$CURRENT_LINK" ]; then
        __red "current 激活路径不是符号链接，拒绝覆盖: $CURRENT_LINK"
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
    if ! atomic_switch_release "$final_release"; then
        return 1
    fi
    if [ "${CODEX_WS_AGENT_INSTALL_TEST_MODE:-0}" = "1" ] && [ "${CODEX_WS_AGENT_TEST_FAIL_PHASE:-}" = "activation" ]; then
        __red "测试注入：current 切换后失败，执行恢复。"
        restore_current_release "$previous_target"
        return 1
    fi
    if ! install_compatibility_entrypoints; then
        restore_current_release "$previous_target"
        return 1
    fi
    ACTIVE_RELEASE="$final_release"
}

if [ "$TEST_MODE" = "1" ]; then
    NODE_BIN="$CODEX_WS_AGENT_TEST_NODE_BIN"
    NPM_BIN="$CODEX_WS_AGENT_TEST_NPM_BIN"
    PYTHON_BIN="$CODEX_WS_AGENT_TEST_PYTHON_BIN"
    if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
        __red "测试模式未提供可执行 Node.js"
        exit 1
    fi
    if [ "$TEST_FULL" != "1" ]; then
        if [ "$INSTALL_MODE" = "instance" ]; then
            __red "instance installer fixture requires CODEX_WS_AGENT_INSTALL_TEST_FULL=1"
            exit 2
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
else
    check_root
    detect_os
fi

echo "=========================================="
echo "Codex WebSocket Agent 安装脚本"
echo "=========================================="
if [ "$TEST_MODE" != "1" ]; then show_os_info; fi

if [ ! -d "$CONF_SRC" ] || [ ! -f "$SERVICE_SRC" ] || [ ! -f "$BIN_SRC" ]; then
    __red "Agent 配置、launcher 或 service template 不完整"
    exit 1
fi

validate_instance_paths
acquire_instance_lock
prepare_instance_root
preflight_service_target

if [ "$TEST_MODE" != "1" ]; then
    NODE_BIN="$(find_node_bin || true)"
fi
if [ -z "$NODE_BIN" ]; then
    __red "未找到 Node.js，请先执行: ./install.sh node"
    exit 1
fi

NODE_MAJOR="$(node_major_version "$NODE_BIN")"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
    __red "Node.js 版本需要 >= 20，当前: $("$NODE_BIN" -v 2>/dev/null || echo unknown)"
    exit 1
fi

if [ "$TEST_MODE" != "1" ]; then
    NPM_BIN="$(find_npm_bin "$NODE_BIN" || true)"
    PYTHON_BIN="$(find_python_bin || true)"
fi
if [ -z "$NPM_BIN" ]; then
    __red "未找到 npm，无法按 package-lock.json 安装运行时依赖。"
    exit 1
fi
if [ -z "$PYTHON_BIN" ]; then
    __red "未找到 Python 3，无法安装受控文件交付工具链。"
    exit 1
fi

echo ""
echo "[1/7] 创建并加固持久目录..."
if [ "$INSTALL_MODE" = "shared" ] && [ "$TEST_MODE" != "1" ]; then create_isp_dirs; fi
prepare_managed_layout

echo ""
echo "[2/7] 在隔离 release 中归集源码和配置模板..."
echo "[3/7] 在候选 release 中按锁文件安装生产依赖..."
echo "[4/7] 验证候选 release 后原子切换 current..."
collate_release
__green "已激活 release: $ACTIVE_RELEASE"

echo ""
echo "[5/7] 安装管理脚本..."
install_management_launcher

echo ""
echo "[6/7] 安装 systemd 服务..."
install_service_unit

echo ""
echo "[7/7] 检查 A07 workspace policy..."
if [ -f "$APP_HOME/workspace-policies.json" ]; then
    __green "检测到受控 workspace policy: $APP_HOME/workspace-policies.json"
else
    __yellow "尚未启用 A07 workspace policy。command.dispatch 将 fail closed，不会回退到共享可写代码目录。"
    echo "  cp $CURRENT_LINK/workspace-policies.example.json $APP_HOME/workspace-policies.json"
    echo "  编辑可信 repository/baseRef/trustedRemoteUrl/trustedRemoteRef，并在 .env 设置 CODEX_WORKSPACE_POLICIES_FILE"
fi

if [ "$INSTALL_MODE" = "instance" ]; then
    __yellow "instance 安装永不自动 enable/start/restart/register。完成身份、凭据和空闲移交核验后再显式启动:"
    echo "  $BIN_DST start"
elif [ "${START_CODEX_WS_AGENT:-n}" = "y" ]; then
    restart_agent_service
else
    __yellow "未自动启动服务。完成身份/凭据/空闲移交核验后再显式启动:"
    echo "  systemctl restart $SERVICE_NAME"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "Codex WebSocket Agent 部署完成"
echo "==========================================${NC}"
echo "安装模式: $INSTALL_MODE${INSTANCE:+ ($INSTANCE)}"
echo "应用目录: $APP_HOME"
echo "当前 release: $CURRENT_LINK"
echo "配置文件: $APP_HOME/.env"
echo "Profile:  $APP_HOME/codex-profiles.conf"
echo "Workspace policy 示例: $CURRENT_LINK/workspace-policies.example.json"
echo "管理脚本: $BIN_DST"
echo "服务单元: $SERVICE_NAME ($SERVICE_DST)"
