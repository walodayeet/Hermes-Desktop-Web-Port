# Hermes-Desktop-Web — web port of the Hermes Electron desktop app.
#
# Multi-stage build:
#   stage 1 (builder): npm ci (compiles node-pty), tsc + vite build of web/
#   stage 2 (runtime): slim node image, copies built dist + node_modules,
#                      runs the zero-dep proxy (proxy/server.js)
#
# The container is ONLY the web UI facade. It connects to a Hermes agent
# backend via HERMES_TARGET (default 127.0.0.1:9119 — set it to your host's
# `hermes dashboard`/`hermes serve` endpoint). See docker-compose.yml and
# README.md for the full matrix.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder

# node-pty needs a compiler + python to build its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install workspace deps (web + proxy). package-lock.json pins everything.
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY proxy/package.json proxy/package.json
COPY shared/package.json shared/package.json
RUN npm ci

# Build the renderer.
COPY web/ web/
COPY shared/ shared/
COPY scripts/precompress.mjs scripts/precompress.mjs
RUN npm run build --workspace web && node scripts/precompress.mjs

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

# Runtime needs a shell for the /web-term PTY (node-pty spawns it) and the
# filesystem door should have a real directory to expose.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace

WORKDIR /app

# Copy built app + deps (including the compiled node-pty native addon from
# the builder — same node major, same ABI). Workspaces hoist deps to /app/node_modules;
# the per-workspace dirs mostly contain package.json shims, but copy them too.
COPY --from=builder /app/web/dist web/dist
COPY --from=builder /app/node_modules node_modules
COPY proxy/ proxy/
COPY web/package.json web/package.json
COPY package.json ./

# Renderer assets are hash-named; static cache is immutable-safe.
ENV NODE_ENV=production \
    PORT=4000 \
    WEB_FS_ROOT=/workspace \
    HERMES_TERM_CWD=/workspace \
    HERMES_PLUGINS_DIR=/plugins

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "proxy/server.js"]
