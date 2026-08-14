# Hermes Desktop Web (unofficial)

A **web port of the Hermes Electron desktop app** (`hermes-agent/apps/desktop`),
not a reimplementation. The renderer — the real desktop UI (chat, sessions,
profiles, command center, settings, plugins) — is copied verbatim and runs in
the browser; only the Electron shell is replaced by a web bridge.

> **Unofficial community project.** Not affiliated with or endorsed by Nous
> Research. See [NOTICE.md](NOTICE.md).

> **Self-host your Hermes agent and talk to it from any browser or phone.**
> The agent stays on your server; this is the UI layer in front of it.

## How the port works

```
browser ──▶ proxy/server.js ──▶ hermes dashboard / hermes serve (HERMES_TARGET)
              │  /api/* + /auth/* + WS /api/ws  (same-origin passthrough)
              │  static web/dist/
```

The Electron app has one native seam: `window.hermesDesktop`, provided by the
main process's preload script. The renderer never touches Node/Electron
directly — everything goes through that bridge. The web port keeps the
renderer byte-for-byte and supplies the bridge from the browser:

- `web/src/web-bridge.ts` — same-origin REST (`hermesDesktop.api`), WS ticket
  minting (`getGatewayWsUrl` → `POST /api/auth/ws-ticket`), file picking via
  the browser File System Access API (Chromium) or a hidden `<input type=file>`
  (iOS Safari), clipboard, and safe no-ops for genuinely native features (pet
  overlay, HUD windows, updater, OS file dialogs…). The renderer guards
  optional members and degrades gracefully.
- `web/src/login-gate.ts` — pre-boot auth gate. The Electron shell
  authenticates out-of-band (env credentials, native OAuth); a browser can't,
  so the gate checks the session cookie (`GET /api/auth/me`) and renders a
  minimal sign-in form (`POST /auth/password-login`) before the app boots.

## Prerequisites

- A running **Hermes agent** with the web backend: `hermes dashboard --host 127.0.0.1 --port 9119 --no-open`
  (or `hermes serve`). The web UI is a facade in front of that endpoint.
- Node 20+ **or** Docker.

## Run with Docker (recommended)

```sh
cp .env.example .env        # set HERMES_TARGET to your agent backend
docker compose up -d --build
# open http://127.0.0.1:4000, sign in with your gateway credentials
```

The container runs only the web UI; the agent itself keeps running on your
host/server. Point `HERMES_TARGET` at it:

| Setup | `HERMES_TARGET` |
|---|---|
| Agent on same host (bare metal) | `127.0.0.1:9119` |
| Docker Desktop on same machine | `host.docker.internal:9119` |
| Agent on another machine (LAN / Tailscale) | `<agent-ip>:9119` |
| Agent containerized in compose | `hermes-agent:9119` |

## Run without Docker

The launcher mirrors the [hermes-webui](https://github.com/nesquena/hermes-webui)
project's workflow — clone, `./start.sh`, done. `start.sh` (bash wrapper) loads
`.env`, pre-flights, then delegates to `scripts/bootstrap.py` (Python 3,
stdlib only): installs deps if missing, builds the renderer if needed, starts
the proxy, waits for health, and opens the browser.

```sh
./start.sh                # install + build + start + open browser
./start.sh --no-browser   # server only
./start.sh --port 8080    # different port (or PORT=8080 ./start.sh)
./start.sh --rebuild      # force a renderer rebuild
```

Daemon control (like webui's `ctl.sh`):

```sh
./ctl.sh start            # background daemon (pid + log in ~/.hermes)
./ctl.sh status           # PID, uptime, health
./ctl.sh logs --follow    # tail the log
./ctl.sh stop / restart
```

Manual (the old way):

```sh
npm install
npm run build        # build the renderer (web/)
npm start            # proxy on :4000 → serves app + forwards API/WS
# open http://127.0.0.1:4000, sign in with your gateway credentials
```

### Dev

```sh
npm run dev          # Vite dev server (hot reload) on :5175
# dev proxies /api + /auth to HERMES_TARGET via web/vite.config.ts
```

### Env

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Proxy listen port |
| `HERMES_TARGET` | `127.0.0.1:9119` | Backend `host:port` or `http(s)://host:port` |
| `WEB_FS_ROOT` | *(docker: `/workspace`; bare: `$HOME`)* | Root of the Files rail / file browser door |
| `HERMES_TERM_CWD` | *(docker: `/workspace`)* | Default cwd for the in-browser terminal |
| `HERMES_PLUGINS_DIR` | *(docker: `/plugins`; bare: `~/.hermes/desktop-plugins`)* | Desktop-plugins door |
| `VITE_HERMES_BASE` | *(same-origin)* | Point the renderer at a backend directly (dev) |

## Desktop plugins in the web port

The Electron shell loads plugins from `<hermes home>/desktop-plugins/<name>/plugin.js`
off local disk (fs-watched, hot-reloaded). The web port has no Electron fs, so
the **proxy serves that folder** as a virtual `/plugins` root:

- `GET /api/plugins-door/list` → `{entries:[{name,path,isDirectory}]}` (dirs with a plugin.js)
- `GET /api/plugins-door/file?path=/plugins/<name>/plugin.js` → `{path,text}` (strictly validated)

The runtime plugin loader (unchanged, browser-native: blob import + SDK
specifier rewrite) talks to it through the web bridge
(`desktopPluginsRoot`/`readDir`/`readFileText`), and its 5-second poll
replaces fs-watching: drop a folder into the plugins dir on the proxy host →
plugin appears in ~5s; remove it → unloads. Plugins with a backend (e.g.
file-ops) reach it via the normal `/api/plugins/*` forward.
Override the folder with `HERMES_PLUGINS_DIR`.

## ⚠️ Security

The web UI is **a full interface to your agent**: chat, filesystem access
(`WEB_FS_ROOT`), an interactive terminal (`/web-term`), and plugin loading.
Anyone who logs in gets agent-level control of the host.

- The password auth used by the login gate is fine on a **trusted LAN or
  behind a VPN/tunnel** — not for direct public-internet exposure.
- Prefer SSH tunnel: `ssh -N -L 4000:127.0.0.1:4000 user@server`, then browse
  to `http://127.0.0.1:4000`.
- Or expose via Tailscale (bind the agent's dashboard to your tailnet IP and
  point `HERMES_TARGET` at it).
- If you must put it on the public internet, front it with TLS + a reverse
  proxy and use your Hermes backend's OAuth provider rather than the password
  form. Never leave `WEB_FS_ROOT` at `/` and never bind the filesystem/terminal
  doors to an unauthenticated public endpoint.

## Layout

```
web/       — the desktop app's renderer (copied) + web-bridge.ts + login-gate.ts
shared/    — @hermes/shared package (gateway client, ws-url, billing types)
proxy/     — zero-dep Node same-origin facade (HTTP + WS passthrough, static)
scripts/   — bootstrap.py (webui-style launcher), sync-renderer.sh,
             reapply-port-patches.mjs (idempotent post-sync patcher)
start.sh   — webui-style entry point (clone → ./start.sh → done)
ctl.sh     — daemon controller (start/stop/restart/status/logs)
```

## Upstream sync

The renderer tracks `hermes-agent/apps/desktop`. Re-sync from the upstream
GitHub repo:

```sh
npm run sync:renderer -- /path/to/hermes-agent-checkout
# or: npm run sync:renderer   (uses HERMES_UPSTREAM_DIR, defaults to a clone
#                             in node_modules/.cache if you set HERMES_UPSTREAM_REPO)
```

The sync rsyncs `apps/desktop/src` + `apps/shared/src`, keeps the web-specific
`web-bridge.ts` / `login-gate.ts`, drops `*.test.*`, and re-applies the port
patches from `scripts/reapply-port-patches.mjs` (idempotent — safe to run any
number of times).

## License

MIT. The renderer is derived from
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
(MIT, © Nous Research); see [LICENSE](LICENSE).
