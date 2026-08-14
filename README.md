# Hermes Desktop Web

Web port of the Hermes Electron desktop app — mobile-first chat client for
`hermes serve`.

## Architecture

```
web/     — Vite + React + TypeScript SPA (mobile-first, PWA)
proxy/   — tiny Node HTTP/WS facade over hermes serve
```

The proxy serves the SPA and forwards `/api/*` + `/api/ws` to the backend from
one origin, so the browser never hits CORS or `ws://` mixed-content.

## Prerequisites

- Node 20+ (proxy uses `node:http` + `ws`)
- `hermes serve` running on `127.0.0.1:9119` (override with `HERMES_TARGET`)

## Install

```sh
npm install
```

## Run

```sh
# build the SPA (web/)
npm run build

# start the proxy on :4000
npm start
```

Then open <http://127.0.0.1:4000>.

### Proxy env

| Var            | Default          | Purpose                             |
|----------------|------------------|-------------------------------------|
| `PORT`         | `4000`           | Proxy listen port                   |
| `HERMES_TARGET`| `127.0.0.1:9119` | Backend `host:port` (or `http://…`) |

## Development

```sh
# web dev server (Vite, hot reload; see web/ for VITE_API_BASE)
npm run dev
```

## Endpoints

- `GET /api/status` → backend status
- `POST /auth/password-login` → backend login (v0.20.0 cookie flow)
- `WS /api/ws?ticket=…` → backend JSON-RPC gateway (pure passthrough; the SPA
  mints single-use 30s tickets via `POST /api/auth/ws-ticket`)
- everything else → static `web/dist/` (SPA fallback to `index.html`)

No credentials are stored in this repo. The proxy forwards auth headers,
cookies, and query params verbatim; it never parses or logs them.
