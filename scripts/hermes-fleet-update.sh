#!/usr/bin/env bash
#
# hermes-fleet-update.sh — update ALL Hermes agent backends (host + docker fleet).
#
# Targets:
#   host      ~/.hermes/hermes-agent  (git install, venv python)
#   containers hermes-dad hermes-cousin hermes-family hermes-grandpa hermes-telegram
#              (git installs at /usr/local/lib/hermes-agent, /usr/local/bin/hermes)
#
# Per agent:
#   1. `hermes update --check` → report how many commits behind
#   2. `hermes update -y`       → pull + reinstall deps (updater handles service
#                                 restarts; for containers the updater also runs,
#                                 but the RUNNING gateway/serve processes are old
#                                 code, so we docker restart the container)
#   3. Verify: git rev-parse HEAD before/after + health probe
#
# The host update may restart hermes-dashboard.service (this machine's backend).
# Run this from a shell OUTSIDE the current Hermes chat session if you need the
# conversation to survive, or accept that the chat backend reconnects.
#
# Usage:  bash hermes-fleet-update.sh [--check-only] [--skip-host] [--skip-docker]
#   --check-only  only report update availability, change nothing
#   --skip-host   update only docker containers
#   --skip-docker update only the host
#
set -u

HOST_DIR="${HOME}/.hermes/hermes-agent"
HOST_PY="${HOST_DIR}/venv/bin/python"
HOST_SERVICES=(hermes-dashboard.service hermes-gateway.service)
# Containers that run `hermes serve` (headless backend) expose a 9119 health
# endpoint that the fleet-update script probes. Messaging-only containers
# (grandpa, telegram) run gateway but no serve — probe their gateway instead
# (any hermes process alive + well).
SERVE_CONTAINERS=(hermes-dad hermes-cousin hermes-family hermes-kim hermes-long)
GATEWAY_ONLY=(hermes-grandpa hermes-telegram)

CHECK_ONLY=0
SKIP_HOST=0
SKIP_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --skip-host) SKIP_HOST=1 ;;
    --skip-docker) SKIP_DOCKER=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if command -v sg >/dev/null 2>&1 && ! docker ps >/dev/null 2>&1; then
  DOCKER="sg docker -c"
  echo "[docker] using 'sg docker -c' wrapper (user is in docker group)"
else
  DOCKER=""
fi

docker_stdout() { # docker_stdout <container> <cmd...> — returns stdout, strips marker
  local out
  if [ -n "$DOCKER" ]; then
    out=$($DOCKER "docker exec $1 sh -c '${*:2}; echo __RC=\$?'" 2>/dev/null)
  else
    out=$(docker exec "$1" sh -c "${*:2}; echo __RC=\$?" 2>/dev/null)
  fi
  printf '%s' "${out%__RC=*}"
}

status() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()     { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn()   { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
fail()   { printf '\033[1;31m✘\033[0m %s\n' "$*"; }

FAILURES=0

###############################################################################
# Host
###############################################################################
host_update() {
  status "HOST ${HOST_DIR}"

  if [ ! -d "${HOST_DIR}/.git" ]; then
    fail "host: ${HOST_DIR} is not a git checkout — cannot hermes update"
    FAILURES=$((FAILURES + 1))
    return 1
  fi

  local before after
  before=$(git -C "${HOST_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)

  if [ "$CHECK_ONLY" = "1" ]; then
    "${HOST_PY}" -m hermes_cli.main update --check 2>&1 | head -6
    return 0
  fi

  status "host: running hermes update -y (this may restart the dashboard service)"
  if ! "${HOST_PY}" -m hermes_cli.main update -y; then
    fail "host: hermes update failed (exit $?)"
    FAILURES=$((FAILURES + 1))
    return 1
  fi

  after=$(git -C "${HOST_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)
  if [ "$before" = "$after" ]; then
    warn "host: HEAD unchanged (${before:0:8}) — already current or update no-op"
  else
    ok "host: ${before:0:8} → ${after:0:8}"
  fi

  # The updater should have restarted services; verify.
  for svc in "${HOST_SERVICES[@]}"; do
    if systemctl --user is-active --quiet "$svc" 2>/dev/null; then
      ok "host: ${svc} active"
    else
      warn "host: ${svc} not active — check manually"
    fi
  done
}

###############################################################################
# Docker containers
###############################################################################
container_update() {
  local name="$1"

  # family container is currently exited (networking conflict at boot) — report
  # and skip rather than failing the whole run.
  local running
  if [ -n "$DOCKER" ]; then
    running=$($DOCKER "docker inspect -f '{{.State.Running}}' ${name}" 2>/dev/null)
  else
    running=$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)
  fi
  if [ "$running" != "true" ]; then
    warn "${name}: not running (state: $running) — skipping update; start it first"
    return 0
  fi

  local before after
  before=$(docker_stdout "$name" "cd /usr/local/lib/hermes-agent && git rev-parse HEAD")
  before="${before:-unknown}"

  if [ "$CHECK_ONLY" = "1" ]; then
    status "${name}: update check"
    docker_stdout "$name" "cd /usr/local/lib/hermes-agent && hermes update --check 2>&1 | head -6"
    return 0
  fi

  status "${name}: hermes update -y"
  # The update reloads new code onto disk. Its exit code is unreliable under
  # `sg docker -c` (the wrapper masks docker exec's real status, and piping
  # through `tail` makes `$?` = tail's status = 0 on both success and failure),
  # so treat the update as best-effort and let the before/after HEAD
  # comparison below be the source of truth. Capture output for diagnostics.
  local upd_out
  upd_out=$(docker_stdout "$name" "cd /usr/local/lib/hermes-agent && bash -c 'set -o pipefail; hermes update -y 2>&1 | tail -30'")
  printf '  %s\n' "$upd_out" | sed 's/^/    /'

  after=$(docker_stdout "$name" "cd /usr/local/lib/hermes-agent && git rev-parse HEAD")
  after="${after:-unknown}"
  if [ "$before" = "$after" ]; then
    warn "${name}: HEAD unchanged (${before:0:8}) — already current or no-op"
    # No new code fetched — nothing to reload; still continue (restart is
    # harmless but pointless, so return to skip it).
    return 0
  else
    ok "${name}: ${before:0:8} → ${after:0:8}"
  fi

  # Running gateway/serve are OLD code — restart the container so the
  # entrypoint relaunches them on the new install.
  status "${name}: docker restart (relaunch gateway + serve on new code)"
  if [ -n "$DOCKER" ]; then
    $DOCKER "docker restart ${name}" >/dev/null || { fail "${name}: docker restart failed"; FAILURES=$((FAILURES + 1)); return 1; }
  else
    docker restart "$name" >/dev/null || { fail "${name}: docker restart failed"; FAILURES=$((FAILURES + 1)); return 1; }
  fi

  HEALTH_SLEEP=12
  # Health probe after restart. Serve-capable containers expose /api/health on
  # 9119; messaging-only containers (grandpa/telegram) have no serve — verify
  # a live hermes process instead.
  sleep "$HEALTH_SLEEP"
  local health
  if printf '%s\n' "${SERVE_CONTAINERS[@]}" | grep -qx "$name"; then
    health=$(docker_stdout "$name" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9119/api/health 2>/dev/null")
    if [ "$health" = "200" ]; then
      ok "${name}: healthy (serve /api/health 200)"
    else
      warn "${name}: serve health probe returned '$health' — check logs"
    fi
  else
    # No serve: confirm the gateway process came back up.
    health=$(docker_stdout "$name" "ps aux | grep -c '[h]ermes gateway run'")
    case "$health" in
      1|2|3|4|5|6|7|8|9) ok "${name}: gateway process running" ;;
      *) warn "${name}: gateway process count '$health' unexpected — check logs" ;;
    esac
  fi
}

###############################################################################
# Main
###############################################################################
if [ "$SKIP_HOST" = "0" ]; then
  host_update
fi

if [ "$SKIP_DOCKER" = "0" ]; then
  for c in "${SERVE_CONTAINERS[@]}" "${GATEWAY_ONLY[@]}"; do
    container_update "$c"
  done
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  warn "${FAILURES} agent(s) failed — review output above."
  exit 1
fi
ok "All agents updated."
