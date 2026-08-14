#!/usr/bin/env bash
# Sync the renderer from an upstream hermes-agent checkout.
#
# Usage:
#   ./scripts/sync-renderer.sh                      # uses HERMES_UPSTREAM_DIR or ~/.hermes/hermes-agent
#   ./scripts/sync-renderer.sh /path/to/hermes-agent
#
# What it does:
#   rsync apps/desktop/src + apps/shared/src → web/src + shared/src
#   keeps web/src/web-bridge.ts + web/src/login-gate.ts (web-specific)
#   drops *.test.* (vitest is not installed here)
#   re-applies scripts/reapply-port-patches.mjs (idempotent)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UPSTREAM="${1:-${HERMES_UPSTREAM_DIR:-$HOME/.hermes/hermes-agent}}"
if [ ! -d "$UPSTREAM/apps/desktop/src" ]; then
  echo "error: upstream not found at $UPSTREAM" >&2
  echo "clone it first:  git clone https://github.com/NousResearch/hermes-agent.git" >&2
  echo "then:            ./scripts/sync-renderer.sh /path/to/hermes-agent" >&2
  exit 1
fi

rsync -a --delete --exclude=web-bridge.ts --exclude=login-gate.ts --exclude=server-settings.ts "$UPSTREAM/apps/desktop/src/" web/src/
rsync -a --delete "$UPSTREAM/apps/shared/src/" shared/src/
find shared/src web/src -name '*.test.*' -delete
node scripts/reapply-port-patches.mjs web/src
echo "synced (web-bridge.ts, login-gate.ts preserved, port patches reapplied)"
