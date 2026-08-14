#!/usr/bin/env bash
# Daemon controller for Hermes-Desktop-Web (mirrors nesquena/hermes-webui's ctl.sh).
#
#   ./ctl.sh start [bootstrap args...]   Start as a background daemon
#   ./ctl.sh stop                        Stop the daemon
#   ./ctl.sh restart [bootstrap args...] Stop, then start again
#   ./ctl.sh status                      Show daemon + health status
#   ./ctl.sh logs [--lines N] [--follow] Show the daemon log
#
# State lives in ~/.hermes (HERMES_HOME): pid + state files, log file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
PID_FILE="${HERMES_WEB_PID_FILE:-${HERMES_HOME}/hermes-desktop-web.pid}"
LOG_FILE="${HERMES_WEB_LOG_FILE:-${HERMES_HOME}/hermes-desktop-web.log}"
STATE_FILE="${HERMES_WEB_CTL_STATE_FILE:-${HERMES_HOME}/hermes-desktop-web.ctl.env}"
PYTHON="${HERMES_WEB_PYTHON:-python3}"

usage() {
  cat <<'EOF'
Usage: ./ctl.sh <command> [args]

Commands:
  start [bootstrap args...]   Start Hermes Desktop Web as a background daemon
  stop                        Stop the daemon
  restart [bootstrap args...] Stop, then start again
  status                      Show daemon, host/port, log, and health status
  logs [--lines N] [--follow] Show the daemon log (default tail -n 100 -f)
EOF
}

ensure_home() { mkdir -p "${HERMES_HOME}"; }

# Minimal .env loader: applies repo .env if present, preserving existing shell vars.
load_repo_dotenv() {
  local env_file="${REPO_ROOT}/.env"
  [[ -f "${env_file}" ]] || return 0
  local preserved=() line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="$(echo "${line}" | sed 's/^[[:space:]]*//')"
    [[ -z "${line}" || "${line}" == \#* || "${line}" != *=* ]] && continue
    key="${line%%=*}"
    key="$(echo "${key}" | sed 's/^export[[:space:]]*//; s/[[:space:]]//g')"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "${key}" in UID|GID|EUID|EGID|PPID) continue ;; esac
    if [[ -n "${!key+x}" ]]; then preserved+=("${key}=${!key}"); fi
  done < "${env_file}"
  set -a
  # shellcheck source=/dev/null
  source "${env_file}"
  set +a
  local assignment
  for assignment in "${preserved[@]}"; do export "${assignment}"; done
}

_pid_from_file() {
  [[ -f "${PID_FILE}" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "${PID_FILE}")"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${pid}"
}

_is_alive() { kill -0 "$1" >/dev/null 2>&1; }

_is_ours() {
  # The recorded PID can be the bootstrap.py python parent OR the node
  # proxy/server.js child — both belong to this repo's web port.
  local pid="$1" args
  args="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
  [[ -n "${args}" ]] || return 1
  [[ "${args}" == *"${REPO_ROOT}"* && \
     ( "${args}" == *"scripts/bootstrap.py"* || "${args}" == *"proxy/server.js"* ) ]]
}

_write_state() {
  local pid="$1" port="$2"
  {
    printf 'PID=%q\n' "${pid}"
    printf 'REPO_ROOT=%q\n' "${REPO_ROOT}"
    printf 'PORT=%q\n' "${port}"
    printf 'LOG_FILE=%q\n' "${LOG_FILE}"
    printf 'STARTED_AT=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${STATE_FILE}"
}

_current_pid() {
  local pid
  pid="$(_pid_from_file)" || return 1
  if _is_alive "${pid}" && _is_ours "${pid}"; then
    printf '%s\n' "${pid}"
    return 0
  fi
  rm -f "${PID_FILE}" "${STATE_FILE}"
  return 1
}

_probe_host() {
  case "${PORT:-4000}" in
    "") echo "127.0.0.1" ;;
    *) echo "127.0.0.1" ;;
  esac
}

start_cmd() {
  ensure_home
  load_repo_dotenv
  local port="${PORT:-4000}"

  if _current_pid >/dev/null 2>&1; then
    echo "[ctl] already running (PID $(_current_pid)) — nothing started"
    return 0
  fi
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${port}/" 2>/dev/null; then
    echo "[ctl] something already serves :${port} (not managed by ctl.sh)"
    echo "      use ./start.sh --port ${port} to attach, or stop the other process"
    return 0
  fi

  echo "[ctl] starting Hermes Desktop Web on :${port} (log: ${LOG_FILE})"
  nohup "${PYTHON}" "${REPO_ROOT}/scripts/bootstrap.py" --no-browser --log "${LOG_FILE}" "$@" \
    >> "${LOG_FILE}" 2>&1 &
  local pid=$!
  echo "${pid}" > "${PID_FILE}"
  _write_state "${pid}" "${port}"

  # Wait for health like webui's ctl.sh.
  local i
  for i in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${port}/" 2>/dev/null; then
      echo "[ctl] ● running — http://127.0.0.1:${port} (PID ${pid})"
      return 0
    fi
    sleep 1
  done
  echo "[ctl] ✗ not healthy after 30s — check log: ${LOG_FILE}"
  return 1
}

stop_cmd() {
  local pid
  if pid="$(_current_pid 2>/dev/null)"; then
    echo "[ctl] stopping PID ${pid}…"
    kill "${pid}" 2>/dev/null || true
    local i
    for i in $(seq 1 10); do
      _is_alive "${pid}" || break
      sleep 1
    done
    if _is_alive "${pid}"; then
      echo "[ctl] forcing kill…"
      kill -9 "${pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}" "${STATE_FILE}"
    echo "[ctl] stopped"
  else
    echo "[ctl] not running"
  fi
}

status_cmd() {
  ensure_home
  load_repo_dotenv
  local port="${PORT:-4000}" pid uptime health
  if pid="$(_current_pid 2>/dev/null)"; then
    uptime="$(ps -p "${pid}" -o etime= 2>/dev/null | sed 's/^ *//' || true)"
    health="$(curl -sf --max-time 2 -o /dev/null "http://127.0.0.1:${port}/" && echo ok || echo unreachable)"
    echo "● hermes-desktop-web — running"
    echo "  PID:     ${pid}"
    echo "  Uptime:  ${uptime:-unknown}"
    echo "  Bound:   :${port}"
    echo "  Log:     ${LOG_FILE}"
    echo "  Health:  ${health}"
  else
    if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${port}/" 2>/dev/null; then
      echo "● hermes-desktop-web — running (not managed by ctl.sh)"
      echo "  Bound:   :${port}"
      echo "  Note:    manage it via its own supervisor or kill the process directly"
    else
      echo "● hermes-desktop-web — stopped"
      echo "  Bound:   :${port}"
    fi
  fi
}

logs_cmd() {
  ensure_home
  local lines=100 follow=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --lines) shift; lines="${1:-100}"; [[ "${lines}" =~ ^[0-9]+$ ]] || { echo "[ctl] --lines requires a number" >&2; return 2; } ;;
      --lines=*) lines="${1#--lines=}" ;;
      --follow|-f) follow=1 ;;
      --no-follow) follow=0 ;;
      *) echo "[ctl] unknown logs option: $1" >&2; return 2 ;;
    esac
    shift
  done
  touch "${LOG_FILE}"
  if (( follow )); then
    tail -n "${lines}" -f "${LOG_FILE}"
  else
    tail -n "${lines}" "${LOG_FILE}"
  fi
}

cmd="${1:-}"
if [[ $# -gt 0 ]]; then shift; fi

case "${cmd}" in
  start) start_cmd "$@" ;;
  stop) stop_cmd ;;
  restart) stop_cmd; start_cmd "$@" ;;
  status) status_cmd ;;
  logs) logs_cmd "$@" ;;
  -h|--help|help|"") usage ;;
  *) echo "[ctl] unknown command: ${cmd}" >&2; usage >&2; exit 2 ;;
esac
