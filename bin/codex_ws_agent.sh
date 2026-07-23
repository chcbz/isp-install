#!/usr/bin/env bash
set -euo pipefail

APP_HOME="/home/isp/apps/codex-ws-agent"
NODE_BIN="/home/isp/apps/node/bin/node"
PID_FILE="$APP_HOME/codex-ws-agent.pid"
LOG_DIR="$APP_HOME/logs"
SESSION="codex-ws-agent"
APP_ENTRY="agent-client.mjs"
WORKSPACE_ENTRY="workspace-manager.mjs"
ACTION="${1:-start}"
VALIDATE_ARGS=(--validate)
SERVICE_NAME="codex-ws-agent.service"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node binary not found" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

has_systemd_service() {
  command -v systemctl >/dev/null 2>&1 || return 1
  [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ] || return 1
  systemctl cat "$SERVICE_NAME" >/dev/null 2>&1
}

run_systemd_action() {
  local action="$1"
  case "$action" in
    start|stop|restart)
      systemctl "$action" "$SERVICE_NAME"
      ;;
    status)
      systemctl --no-pager --full status "$SERVICE_NAME"
      ;;
    *)
      return 2
      ;;
  esac
}

read_pid_file() {
  if [ -f "$PID_FILE" ]; then
    sed -n '1p' "$PID_FILE" 2>/dev/null | tr -cd '0-9'
  fi
}

is_agent_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -F "$APP_ENTRY" >/dev/null
}

find_agent_pid() {
  local pid
  pid="$(read_pid_file || true)"
  if is_agent_pid "$pid"; then
    echo "$pid"
    return 0
  fi

  pgrep -f "$APP_HOME/$APP_ENTRY|$APP_ENTRY" 2>/dev/null | while read -r pid; do
    if is_agent_pid "$pid"; then
      echo "$pid"
      return 0
    fi
  done | head -1
}

has_tmux_session() {
  command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null
}

write_pid() {
  local pid="$1"
  echo "$pid" > "$PID_FILE"
}

status_agent() {
  local pid
  pid="$(find_agent_pid || true)"
  if [ -n "$pid" ]; then
    write_pid "$pid"
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

start_agent() {
  local pid log_file
  pid="$(find_agent_pid || true)"
  if [ -n "$pid" ]; then
    write_pid "$pid"
    echo "codex-ws-agent already running | PID: $pid"
    return 0
  fi

  log_file="$LOG_DIR/startlog_$(date +%Y%m%d_%H%M%S).log"

  (
    cd "$APP_HOME"
    "$NODE_BIN" "$APP_ENTRY" "${VALIDATE_ARGS[@]}"
  ) >/tmp/codex_ws_agent_validate.log 2>&1 || {
    echo "codex-ws-agent validation failed" >&2
    cat /tmp/codex_ws_agent_validate.log >&2 || true
    return 1
  }

  if command -v tmux >/dev/null 2>&1; then
    if has_tmux_session; then
      tmux kill-session -t "$SESSION" 2>/dev/null || true
    fi
    tmux new-session -d -s "$SESSION" "cd '$APP_HOME' && exec '$NODE_BIN' '$APP_ENTRY' >> '$log_file' 2>&1"
  else
    cd "$APP_HOME"
    nohup setsid "$NODE_BIN" "$APP_ENTRY" > "$log_file" 2>&1 < /dev/null &
  fi

  sleep 2
  pid="$(find_agent_pid || true)"
  if [ -n "$pid" ]; then
    write_pid "$pid"
    echo "codex-ws-agent started | PID: $pid | LOG: $log_file"
    return 0
  fi

  echo "codex-ws-agent failed to start | LOG: $log_file" >&2
  tail -40 "$log_file" 2>/dev/null || true
  return 1
}

stop_agent() {
  local pid
  pid="$(find_agent_pid || true)"
  if [ -z "$pid" ]; then
    if has_tmux_session; then
      tmux kill-session -t "$SESSION" 2>/dev/null || true
      echo "codex-ws-agent stopped | cleaned stale tmux: $SESSION"
    else
      echo "codex-ws-agent already stopped"
    fi
    rm -f "$PID_FILE"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  if has_tmux_session; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "codex-ws-agent stopped | PID: $pid"
}


workspace_action() {
  local subaction="${1:-}"
  shift || true
  case "$subaction" in
    ensure|inspect)
      ;;
    archive)
      if [ -n "$(find_agent_pid || true)" ]; then
        echo "refusing workspace archive while codex-ws-agent is running; stop the service first" >&2
        return 1
      fi
      ;;
    *)
      echo "Usage: $0 workspace {ensure|inspect|archive} --policy ID --task ID --agent ID [--role ROLE]" >&2
      return 2
      ;;
  esac
  if [ ! -f "$APP_HOME/$WORKSPACE_ENTRY" ]; then
    echo "workspace manager not installed: $APP_HOME/$WORKSPACE_ENTRY" >&2
    return 1
  fi
  (
    cd "$APP_HOME"
    "$NODE_BIN" "$WORKSPACE_ENTRY" "$subaction" "$@"
  )
}

case "$ACTION" in
  start)
    if has_systemd_service; then
      run_systemd_action start
      exit $?
    fi
    start_agent
    ;;
  stop)
    if has_systemd_service; then
      run_systemd_action stop
      exit $?
    fi
    stop_agent
    ;;
  restart)
    if has_systemd_service; then
      run_systemd_action restart
      exit $?
    fi
    stop_agent
    start_agent
    ;;
  status)
    if has_systemd_service; then
      run_systemd_action status
      exit $?
    fi
    status_agent
    ;;
  workspace)
    shift || true
    workspace_action "$@"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|workspace}" >&2
    exit 2
    ;;
esac
