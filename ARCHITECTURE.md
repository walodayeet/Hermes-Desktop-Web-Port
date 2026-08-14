# Hermes Desktop Web

Web port of the Hermes Electron desktop app — a mobile-first chat client for
`hermes serve` (the same backend the desktop app talks to). Goal: full chat
experience in the browser, tuned for phones.

## Architecture

```
web/     — Vite + React + TypeScript SPA (mobile-first, PWA)
proxy/   — tiny Node HTTP/WS proxy: same-origin /api + /api/ws → hermes serve
```

Why a proxy: browsers block `ws://` mixed content on HTTPS pages. Serving the
SPA and proxying `/api/*` + `/api/ws` from one origin avoids CORS/mixed-content
entirely. In dev, Vite proxies to it or to 9119 directly.

## Backend (hermes serve)

- Live on this host: `127.0.0.1:9119` (also `100.74.228.7:9119` over Tailscale)
- `GET /api/status` → auth_required, auth_providers, gateway state
- **v0.20.0 auth = cookie flow** (NOT the older `?token=` flow):
  - `POST /auth/password-login` `{provider:"basic", username, password}` → HttpOnly session cookie
  - `GET /api/auth/providers`, `GET /api/auth/me`, `POST /auth/logout`
  - `POST /api/auth/ws-ticket` → single-use `{ticket, ttl_seconds}` (30s TTL) for WS auth
- `WS /api/ws?ticket=...` → newline-delimited JSON-RPC 2.0
- Full method/event catalog: see `hermes-gateway-protocol` skill reference:
  `/home/walos/.hermes/skills/devops/hermes-gateway-protocol/references/gateway-protocol-reference.md`
  (NOTE: skill reference predates v0.20.0 — actual field names were verified
  against `hermes_cli/dashboard_auth/` + `tui_gateway/server.py` source:
  `prompt.submit {text, session_id}`, `approval.respond {session_id, choice}`,
  `clarify.respond {request_id, answer}`, `session.most_recent`.)

### Key methods
`prompt.submit {message, session_id?}` (streams events), `session.create`,
`session.list {limit?, offset?}`, `session.resume`, `session.history`,
`session.delete`, `session.steer`, `session.interrupt`, `session.title`,
`session.active_list`, `model.list`, `clarify.respond {id, response}`,
`approval.respond {id, approved}`, `session.usage`.

### Key events
`gateway.ready`, `session.info`, `message.start`, `message.delta` (streaming
text), `message.complete`, `thinking.delta`, `reasoning.delta`,
`tool.start` `tool.progress` `tool.complete` (with summary), `status.update`,
`clarify.request {id, question, options?}`, `approval.request {id, command,
message?}`, `error`.

## Work split (two agents, parallel)

### Agent 1 — `web/` (the whole frontend)
Vite + React + TypeScript, mobile-first. Deps kept minimal (ponytail):
React, zustand (state), Tailwind v4 optional — a hand-rolled CSS design
system is acceptable if cleaner. PWA via `vite-plugin-pwa` (manifest +
service worker, offline shell).

Required UX (mobile-first is the whole point):
- Login screen (username/password → token in localStorage)
- Chat view: streaming deltas rendered progressively, thinking blocks
  collapsible, tool events as compact cards (name + status, expandable
  detail), error toasts
- Bottom-fixed composer: auto-grow textarea, Enter=send, Shift+Enter=newline,
  safe-area insets, disabled while streaming (with Stop button)
- Session drawer: hamburger, session list (title, preview, time), create new,
  delete (confirm), switch; works as bottom sheet on narrow screens
- Clarify requests → bottom sheet with option buttons
- Approval requests → inline approve/deny card (mobile-sized buttons)
- Dark/light/system theme, responsive 320px→desktop
- Connection status pill (connected/connecting/reconnecting/offline)

Dev endpoint default: `VITE_API_BASE=http://127.0.0.1:9119` (dev proxy).
No credentials hardcoded — user logs in.

### Agent 2 — `proxy/` + repo plumbing
- Node proxy (Express or plain node:http + ws). Endpoints:
  - `GET /api/status` → forward
  - `POST /api/auth/login` → forward
  - `WS /api/ws` → upgrade + forward to `127.0.0.1:9119` (target configurable
    via env `HERMES_TARGET`), same-origin so no CORS needed
  - serve `web/dist/` statically
- Port via env `PORT` (default 4000). `npm start`. Minimal deps (express +
  ws, or zero-dep node:http).
- Root: `README.md` (run instructions), `.gitignore` (node_modules, dist,
  .env), `package.json` workspaces if needed — keep it simple.

## Conventions

- DO NOT `git commit` — leave the working tree; orchestrator commits.
- Verify your half runs: web agent runs `npm run build` + dev server;
  proxy agent curls `/api/status` through the proxy and tests WS upgrade.
- Credentials for testing the live backend live in `~/.hermes/.env`
  (`HERMES_DASHBOARD_BASIC_AUTH_*`) — read them there, never print values
  to output, never commit.
