# Hermes Desktop Web

A **web port of the Hermes Electron desktop app** (`hermes-agent/apps/desktop`),
not a reimplementation. The renderer — the real desktop UI (chat, sessions,
profiles, command center, settings, plugins) — is copied verbatim and runs in
the browser; only the Electron shell is replaced by a web bridge.

## How the port works

```
browser ──▶ proxy/server.js ──▶ hermes serve (127.0.0.1:9119)
              │  /api/* + /auth/* + WS /api/ws  (same-origin passthrough)
              │  static web/dist/
```

The Electron app has one native seam: `window.hermesDesktop`, provided by the
main process's preload script. The renderer never touches Node/Electron
directly — everything goes through that bridge. The web port keeps the
renderer byte-for-byte and supplies the bridge from the browser:

- `web/src/web-bridge.ts` — same-origin REST (`hermesDesktop.api`), WS ticket
  minting (`getGatewayWsUrl` → `POST /api/auth/ws-ticket`), clipboard, and
  safe no-ops for genuinely native features (pet overlay, HUD windows,
  updater, OS file dialogs…). The renderer guards optional members and
  degrades gracefully.
- `web/src/login-gate.ts` — pre-boot auth gate. The Electron shell
  authenticates out-of-band (env credentials, native OAuth); a browser can't,
  so the gate checks the session cookie (`GET /api/auth/me`) and renders a
  minimal sign-in form (`POST /auth/password-login`) before the app boots.

## Desktop plugins in the web port

The Electron shell loads plugins from `<hermes home>/desktop-plugins/<name>/plugin.js`
off local disk (fs-watched, hot-reloaded). The web port has no Electron fs, so
the **proxy serves that folder** as a virtual `/plugins` root:

- `GET /api/plugins-door/list` → `{entries:[{name,path,isDirectory}]}` (dirs with a plugin.js)
- `GET /api/plugins-door/file?path=/plugins/<name>/plugin.js` → `{path,text}` (strictly validated)

The runtime plugin loader (unchanged, browser-native: blob import + SDK
specifier rewrite) talks to it through the web bridge
(`desktopPluginsRoot`/`readDir`/`readFileText`), and its 5-second poll
replaces fs-watching: drop a folder into `~/.hermes/desktop-plugins/` on the
proxy host → plugin appears in ~5s; remove it → unloads. Plugins with a
backend (e.g. file-ops) reach it via the normal `/api/plugins/*` forward.
Override the folder with `HERMES_PLUGINS_DIR`.

The renderer source is copied from `apps/desktop/src` + `apps/shared/src`.
When the upstream desktop app changes, re-copy those trees; the bridge and
gate live in `web/src/web-bridge.ts` + `web/src/login-gate.ts` and are the
only web-specific files.

## Prerequisites

- Node 20+
- `hermes serve` running on `127.0.0.1:9119` (override: `HERMES_TARGET`)

## Run

```sh
npm install
npm run build        # build the renderer (web/)
npm start            # proxy on :4000 → serves app + forwards API/WS
# open http://127.0.0.1:4000, sign in with your gateway credentials
```

### Dev

```sh
npm run dev          # Vite dev server (hot reload) on :5175
# dev proxies /api + /auth to 127.0.0.1:9119 via web/vite.config.ts
```

### Env

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Proxy listen port |
| `HERMES_TARGET` | `127.0.0.1:9119` | Backend `host:port` |
| `VITE_HERMES_BASE` | *(same-origin)* | Point the renderer at a backend directly |

## Layout

```
web/       — the desktop app's renderer (copied) + web-bridge.ts + login-gate.ts
shared/    — @hermes/shared package (gateway client, ws-url, billing types)
proxy/     — zero-dep Node same-origin facade (HTTP + WS passthrough, static)
```

## Upstream sync

The renderer tracks `hermes-agent/apps/desktop`. Re-sync:

```sh
rsync -a --delete /path/to/hermes-agent/apps/desktop/src/ web/src/
rsync -a --delete /path/to/hermes-agent/apps/shared/src/ shared/src/
# keep: web/src/web-bridge.ts, web/src/login-gate.ts (web-specific)
# drop: *.test.* (vitest not installed here)
```
