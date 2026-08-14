#!/usr/bin/env bash
# WebUI-style launcher for Hermes-Desktop-Web (mirrors nesquena/hermes-webui).
#
#   ./start.sh                # install deps if needed, build if needed, start,
#                             # wait for health, open browser
#   ./start.sh --no-browser   # same, but don't open a browser
#   ./start.sh --port 8080    # override listen port
#   ./start.sh --rebuild      # force a renderer rebuild
#
# The heavy lifting lives in scripts/bootstrap.py (Python 3, stdlib only).
# This wrapper exists so the entry point feels identical to the WebUI project:
# clone, ./start.sh, done.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env if present (filter shell-readonly vars, same as webui's start.sh).
if [[ -f "${REPO_ROOT}/.env" ]]; then
  _hdw_env_filtered="$(mktemp "${TMPDIR:-/tmp}/hdw-env.XXXXXX")"
  grep -vE '^[[:space:]]*(export[[:space:]]+)?(UID|GID|EUID|EGID|PPID)=' \
    "${REPO_ROOT}/.env" > "${_hdw_env_filtered}" || true
  set -a
  # shellcheck source=/dev/null
  source "${_hdw_env_filtered}"
  set +a
  rm -f "${_hdw_env_filtered}"
  unset _hdw_env_filtered
fi

PYTHON="${HERMES_WEB_PYTHON:-}"
if [[ -z "${PYTHON}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then
    PYTHON="$(command -v python)"
  else
    echo "[hdw] Python 3 is required to run bootstrap.py" >&2
    exit 1
  fi
fi

# Pre-flight: if something already answers on our port, tell the user plainly
# and don't double-start (bootstrap.py re-checks, but an early clear message
# beats waiting for the health timeout).
_HDW_PORT="${PORT:-4000}"
_HDW_NEXT=""
for _arg in "$@"; do
  if [[ -n "${_HDW_NEXT}" ]]; then
    _HDW_PORT="${_arg}"
    _HDW_NEXT=""
    continue
  fi
  case "${_arg}" in
    --port)
      _HDW_NEXT=1
      ;;
    --port=*)
      _HDW_PORT="${_arg#--port=}"
      ;;
  esac
done
if command -v curl >/dev/null 2>&1; then
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${_HDW_PORT}/" 2>/dev/null; then
    echo "[hdw] already serving http://127.0.0.1:${_HDW_PORT} — nothing started"
    echo "      (use ./ctl.sh restart to bounce it, or ./ctl.sh stop to stop)"
    exit 0
  fi
fi

exec "${PYTHON}" "${REPO_ROOT}/scripts/bootstrap.py" "$@"
