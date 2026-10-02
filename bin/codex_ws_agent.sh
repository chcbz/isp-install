#!/usr/bin/env bash
set -euo pipefail

APP_NAME="codex-ws-agent"
INSTANCE=""
ACTION=""

usage() {
  echo "Usage: $0 [--instance SAFE_SLUG] {start|stop|restart|status|workspace}" >&2
}

validate_instance_slug() {
  local value="$1"
  [ "${#value}" -le 63 ] || return 1
  [[ "$value" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
}

if [ "${1:-}" = "--instance" ]; then
  [ "$#" -ge 3 ] || { usage; exit 2; }
  INSTANCE="$2"
  validate_instance_slug "$INSTANCE" || {
    echo "invalid instance slug: use 1-63 lowercase letters, digits, or interior hyphens" >&2
    exit 2
  }
  shift 2
fi
ACTION="${1:-start}"

DEFAULT_APP_HOME="${CODEX_WS_AGENT_DEFAULT_APP_HOME:-/home/isp/apps/$APP_NAME}"
INSTANCE_ROOT="${CODEX_WS_AGENT_INSTANCE_ROOT:-/home/isp/apps/${APP_NAME}-instances}"
SYSTEMD_DIR="${CODEX_WS_AGENT_SYSTEMD_DIR:-/etc/systemd/system}"
PROC_ROOT="${CODEX_WS_AGENT_PROC_ROOT:-/proc}"
SYSTEMCTL_BIN="${CODEX_WS_AGENT_SYSTEMCTL:-systemctl}"
NODE_BIN="${CODEX_WS_AGENT_NODE_BIN:-/home/isp/apps/node/bin/node}"

if [ -n "$INSTANCE" ]; then
  APP_HOME="$INSTANCE_ROOT/$INSTANCE"
  SERVICE_NAME="$APP_NAME@$INSTANCE.service"
  SERVICE_TEMPLATE="$SYSTEMD_DIR/$APP_NAME@.service"
  SYSTEMD_ONLY=1
else
  APP_HOME="$DEFAULT_APP_HOME"
  SERVICE_NAME="$APP_NAME.service"
  SERVICE_TEMPLATE="$SYSTEMD_DIR/$APP_NAME.service"
  SYSTEMD_ONLY=0
fi

PID_FILE="$APP_HOME/codex-ws-agent.pid"
LOG_DIR="$APP_HOME/logs"
SESSION="${APP_NAME}${INSTANCE:+-$INSTANCE}"
APP_ENTRY="agent-client.mjs"
WORKSPACE_ENTRY="workspace-manager.mjs"
VALIDATE_ARGS=(--validate)

safe_absolute_path() {
  local value="$1"
  [[ "$value" =~ ^/[A-Za-z0-9_./-]+$ ]] || return 1
  [ "$(realpath -m -- "$value")" = "${value%/}" ]
}

safe_absolute_path "$APP_HOME" || {
  echo "unsafe application root: $APP_HOME" >&2
  exit 2
}
if [ -L "$APP_HOME" ] || { [ -e "$APP_HOME" ] && [ ! -d "$APP_HOME" ]; }; then
  echo "application root is not a real directory: $APP_HOME" >&2
  exit 1
fi

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node binary not found" >&2
  exit 1
fi

ensure_log_dir() {
  if [ -L "$LOG_DIR" ] || { [ -e "$LOG_DIR" ] && [ ! -d "$LOG_DIR" ]; }; then
    echo "unsafe log directory: $LOG_DIR" >&2
    return 1
  fi
  mkdir -p -- "$LOG_DIR"
}

systemctl_cmd() {
  "$SYSTEMCTL_BIN" "$@"
}

has_systemd_service() {
  command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 || [ -x "$SYSTEMCTL_BIN" ] || return 1
  if [ "${CODEX_WS_AGENT_LAUNCHER_TEST_MODE:-0}" != "1" ]; then
    [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ] || return 1
  fi
  systemctl_cmd cat "$SERVICE_NAME" >/dev/null 2>&1
}

service_property() {
  systemctl_cmd show "$SERVICE_NAME" -p "$1" --value 2>/dev/null | sed -n '1p'
}

proc_cwd() {
  readlink -f -- "$PROC_ROOT/$1/cwd" 2>/dev/null || true
}

proc_start_ticks() {
  local raw rest
  raw="$(cat "$PROC_ROOT/$1/stat" 2>/dev/null || true)"
  [ -n "$raw" ] || return 1
  rest="${raw##*) }"
  awk '{print $20}' <<<"$rest"
}

cmdline_has_exact_token() {
  local pid="$1" expected="$2"
  [ -f "$PROC_ROOT/$pid/cmdline" ] || return 1
  tr '\0' '\n' < "$PROC_ROOT/$pid/cmdline" | grep -Fx -- "$expected" >/dev/null
}

pid_cgroup_has_unit() {
  local pid="$1" path
  [ -f "$PROC_ROOT/$pid/cgroup" ] || return 1
  while IFS=: read -r _ _ path; do
    [ "${path##*/}" = "$SERVICE_NAME" ] && return 0
  done < "$PROC_ROOT/$pid/cgroup"
  return 1
}

write_pid_identity() {
  local pid="$1" ticks tmp
  ticks="$(proc_start_ticks "$pid" || true)"
  [ -n "$ticks" ] || return 1
  if [ -L "$PID_FILE" ] || { [ -e "$PID_FILE" ] && [ ! -f "$PID_FILE" ]; }; then
    echo "unsafe PID record: $PID_FILE" >&2
    return 1
  fi
  tmp="$PID_FILE.next-$$"
  (umask 077; printf 'pid=%s\nstart_ticks=%s\nservice=%s\napp_home=%s\n' \
    "$pid" "$ticks" "$SERVICE_NAME" "$APP_HOME" > "$tmp")
  mv -Tf -- "$tmp" "$PID_FILE"
}

validate_instance_unit() {
  local fragment
  [ -f "$SERVICE_TEMPLATE" ] && [ ! -L "$SERVICE_TEMPLATE" ] || {
    echo "instance service template is missing or unsafe: $SERVICE_TEMPLATE" >&2
    return 1
  }
  fragment="$(service_property FragmentPath)"
  [ -n "$fragment" ] || {
    echo "systemd did not report a fragment for $SERVICE_NAME" >&2
    return 1
  }
  [ "$(realpath -m -- "$fragment")" = "$(realpath -m -- "$SERVICE_TEMPLATE")" ] || {
    echo "refusing foreign unit binding for $SERVICE_NAME: $fragment" >&2
    return 1
  }
}

validate_instance_pid() {
  local pid="$1" expected_home actual_home
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || {
    echo "invalid MainPID for $SERVICE_NAME: $pid" >&2
    return 1
  }
  expected_home="$(realpath -e -- "$APP_HOME" 2>/dev/null || true)"
  actual_home="$(proc_cwd "$pid")"
  [ -n "$expected_home" ] && [ "$actual_home" = "$expected_home" ] || {
    echo "refusing foreign PID $pid for $SERVICE_NAME: working root mismatch" >&2
    return 1
  }
  cmdline_has_exact_token "$pid" "$APP_HOME/$APP_ENTRY" || {
    echo "refusing foreign PID $pid for $SERVICE_NAME: exact entrypoint mismatch" >&2
    return 1
  }
  pid_cgroup_has_unit "$pid" || {
    echo "refusing foreign PID $pid for $SERVICE_NAME: cgroup/unit mismatch" >&2
    return 1
  }
  write_pid_identity "$pid"
}

instance_service_state() {
  local active pid
  validate_instance_unit || return 1
  if ! active="$(service_property ActiveState)"; then
    echo "failed to read ActiveState for $SERVICE_NAME" >&2
    return 1
  fi
  if ! pid="$(service_property MainPID)"; then
    echo "failed to read MainPID for $SERVICE_NAME" >&2
    return 1
  fi
  case "$active" in
    active|activating|reloading)
      validate_instance_pid "$pid" || return 1
      ;;
    inactive|failed|deactivating)
      if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
        validate_instance_pid "$pid" || return 1
      fi
      ;;
    *)
      echo "refusing unknown systemd state for $SERVICE_NAME: $active" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$active"
}

run_instance_systemd_action() {
  local action="$1" active
  has_systemd_service || {
    echo "instance controls require the installed systemd unit $SERVICE_NAME; no tmux/nohup fallback is allowed" >&2
    return 1
  }
  if ! active="$(instance_service_state)"; then
    return 1
  fi
  case "$action" in
    start)
      systemctl_cmd start "$SERVICE_NAME" || return 1
      instance_service_state >/dev/null || return 1
      ;;
    stop)
      systemctl_cmd stop "$SERVICE_NAME" || return 1
      rm -f -- "$PID_FILE"
      ;;
    restart)
      systemctl_cmd restart "$SERVICE_NAME" || return 1
      instance_service_state >/dev/null || return 1
      ;;
    status)
      systemctl_cmd --no-pager --full status "$SERVICE_NAME"
      ;;
    *) return 2 ;;
  esac
}

run_default_systemd_action() {
  local action="$1"
  case "$action" in
    start|stop|restart) systemctl_cmd "$action" "$SERVICE_NAME" ;;
    status) systemctl_cmd --no-pager --full status "$SERVICE_NAME" ;;
    *) return 2 ;;
  esac
}

read_pid_file() {
  if [ -f "$PID_FILE" ] && [ ! -L "$PID_FILE" ]; then
    sed -n -E 's/^(pid=)?([0-9]+)$/\2/p' "$PID_FILE" | sed -n '1p'
  fi
}

is_default_agent_pid() {
  local pid="${1:-}" expected_home actual_home
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  expected_home="$(realpath -e -- "$APP_HOME" 2>/dev/null || true)"
  actual_home="$(proc_cwd "$pid")"
  [ -n "$expected_home" ] && [ "$actual_home" = "$expected_home" ] || return 1
  cmdline_has_exact_token "$pid" "$APP_ENTRY" \
    || cmdline_has_exact_token "$pid" "./$APP_ENTRY" \
    || cmdline_has_exact_token "$pid" "$APP_HOME/$APP_ENTRY"
}

find_default_agent_pid() {
  local pid
  pid="$(read_pid_file || true)"
  if is_default_agent_pid "$pid"; then echo "$pid"; return 0; fi
  while read -r pid; do
    if is_default_agent_pid "$pid"; then echo "$pid"; return 0; fi
  done < <(pgrep -f "$APP_ENTRY" 2>/dev/null || true)
  return 1
}

has_tmux_session() {
  command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null
}

status_default_agent() {
  local pid
  pid="$(find_default_agent_pid || true)"
  if [ -n "$pid" ]; then
    printf '%s\n' "$pid" > "$PID_FILE"
    echo "codex-ws-agent running | PID: $pid"
    return 0
  fi
  if has_tmux_session; then
    echo "codex-ws-agent tmux session exists but node process is not running | tmux: $SESSION"
    return 1
  fi
  echo "codex-ws-agent stopped"
  return 3
}

start_default_agent() {
  local pid log_file
  ensure_log_dir
  pid="$(find_default_agent_pid || true)"
  if [ -n "$pid" ]; then printf '%s\n' "$pid" > "$PID_FILE"; echo "codex-ws-agent already running | PID: $pid"; return 0; fi
  log_file="$LOG_DIR/startlog_$(date +%Y%m%d_%H%M%S).log"
  (cd "$APP_HOME" && "$NODE_BIN" "$APP_ENTRY" "${VALIDATE_ARGS[@]}") >/tmp/codex_ws_agent_validate.log 2>&1 || {
    echo "codex-ws-agent validation failed" >&2
    cat /tmp/codex_ws_agent_validate.log >&2 || true
    return 1
  }
  if command -v tmux >/dev/null 2>&1; then
    if has_tmux_session; then tmux kill-session -t "$SESSION" 2>/dev/null || true; fi
    tmux new-session -d -s "$SESSION" "cd '$APP_HOME' && exec '$NODE_BIN' '$APP_ENTRY' >> '$log_file' 2>&1"
  else
    (cd "$APP_HOME" && nohup setsid "$NODE_BIN" "$APP_ENTRY" > "$log_file" 2>&1 < /dev/null &)
  fi
  sleep 2
  pid="$(find_default_agent_pid || true)"
  if [ -n "$pid" ]; then printf '%s\n' "$pid" > "$PID_FILE"; echo "codex-ws-agent started | PID: $pid | LOG: $log_file"; return 0; fi
  echo "codex-ws-agent failed to start | LOG: $log_file" >&2
  tail -40 "$log_file" 2>/dev/null || true
  return 1
}

stop_default_agent() {
  local pid
  pid="$(find_default_agent_pid || true)"
  if [ -z "$pid" ]; then
    if has_tmux_session; then tmux kill-session -t "$SESSION" 2>/dev/null || true; echo "codex-ws-agent stopped | cleaned stale tmux: $SESSION"; else echo "codex-ws-agent already stopped"; fi
    rm -f -- "$PID_FILE"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do if ! kill -0 "$pid" 2>/dev/null; then break; fi; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  if has_tmux_session; then tmux kill-session -t "$SESSION" 2>/dev/null || true; fi
  rm -f -- "$PID_FILE"
  echo "codex-ws-agent stopped | PID: $pid"
}

workspace_action() {
  local subaction="${1:-}"
  shift || true
  case "$subaction" in
    ensure|inspect) ;;
    archive)
      if [ "$SYSTEMD_ONLY" = "1" ]; then
        local active
        if ! active="$(instance_service_state)"; then
          return 1
        fi
        [ "$active" != "active" ] && [ "$active" != "activating" ] && [ "$active" != "reloading" ] || {
          echo "refusing workspace archive while $SERVICE_NAME is running" >&2
          return 1
        }
      elif [ -n "$(find_default_agent_pid || true)" ]; then
        echo "refusing workspace archive while codex-ws-agent is running; stop the service first" >&2
        return 1
      fi
      ;;
    *)
      echo "Usage: $0 [--instance SAFE_SLUG] workspace {ensure|inspect|archive} --policy ID --task ID --agent ID [--role ROLE]" >&2
      return 2
      ;;
  esac
  if [ ! -f "$APP_HOME/$WORKSPACE_ENTRY" ]; then
    echo "workspace manager not installed: $APP_HOME/$WORKSPACE_ENTRY" >&2
    return 1
  fi
  (cd "$APP_HOME" && "$NODE_BIN" "$WORKSPACE_ENTRY" "$subaction" "$@")
}

case "$ACTION" in
  start|stop|restart|status)
    if [ "$SYSTEMD_ONLY" = "1" ]; then
      run_instance_systemd_action "$ACTION"
    elif has_systemd_service; then
      run_default_systemd_action "$ACTION"
    else
      case "$ACTION" in
        start) start_default_agent ;;
        stop) stop_default_agent ;;
        restart) stop_default_agent; start_default_agent ;;
        status) status_default_agent ;;
      esac
    fi
    ;;
  workspace)
    shift || true
    workspace_action "$@"
    ;;
  *) usage; exit 2 ;;
esac
