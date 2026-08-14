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

- Default: `127.0.0.1:9119` (override `HERMES_TARGET`; docker default resolves the host gateway)
- `GET /api/status` → auth_required, auth_providers, gateway state
- **v0.20.0 auth = cookie flow** (NOT the older `?token=` flow):
  - `POST /auth/password-login` `{provider:"basic", username, password}` → HttpOnly session cookie
  - `GET /api/auth/providers`, `GET /api/auth/me`, `POST /auth/logout`
  - `POST /api/auth/ws-ticket` → single-use `{ticket, ttl_seconds}` (30s TTL) for WS auth
- `WS /api/ws?ticket=...` → newline-delimited JSON-RPC 2.0
- Full method/event catalog: see the Hermes `tui_gateway` protocol reference in
  the hermes-agent docs/source (`hermes_cli/dashboard_auth/` + `tui_gateway/server.py`):
  `prompt.submit {text, session_id}`, `approval.respond {session_id, choice}`,
  `clarify.respond {request_id, answer}`, `session.most_recent`.

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

## Current implementation notes

- The renderer is **copied verbatim** from `NousResearch/hermes-agent/apps/desktop/src`
  + `apps/shared/src` (see `scripts/sync-renderer.sh`). Only the Electron shell
  is replaced:
  - `web/src/web-bridge.ts` — browser implementation of `window.hermesDesktop`
  - `web/src/login-gate.ts` — pre-boot password gate
  - `scripts/reapply-port-patches.mjs` — idempotent post-sync patches
- The proxy is a **zero-dep** `node:http` server (no Express/ws packages):
  HTTP passthrough for `/api/*` + `/auth/*`, raw TCP upgrade passthrough for
  `WS /api/ws`, static `web/dist/` with SPA fallback.
- Env: `PORT`, `HERMES_TARGET`, `WEB_FS_ROOT`, `HERMES_TERM_CWD`,
  `HERMES_PLUGINS_DIR` (see README table). No credentials hardcoded — the
  user signs in through the login gate.
- Dev endpoint default: `VITE_API_BASE=http://127.0.0.1:9119` (dev proxy);
  `VITE_HERMES_BASE` points the renderer at a backend directly.

## Conventions

- Keep `web/src/web-bridge.ts` + `web/src/login-gate.ts` web-specific;
  everything else in `web/src` tracks upstream.
- Run the real checks before claiming done: `npm run build`, and boot the
  proxy to verify it serves `web/dist/` + forwards `/api/status` and a WS
  upgrade.
- Never commit credentials; test against a local backend only.
