# Multi-gateway support for the Hermes-Desktop-Web port

## Goal

The Electron desktop app gained a v2 **multi-connection registry** ("Settings →
Gateways → Connections"): register many agent sources (local runtime + remote
gateways + cloud + ssh) and switch the active backend. The web port already
syncs the renderer for this feature (`connections-registry.tsx`,
`gateway-settings.tsx`, `store/gateway.ts`, `hermes.ts` routing) but its bridge
stubs everything out, so the feature is **visible but dead** in the browser.

Make the web port use it **gracefully**: full remote-gateway routing, graceful
degrade for the kinds that need native plumbing (ssh/cloud).

## Scope decision (remote gateways; ssh/cloud degrade)

- **remote** (LAN/Tailscale/internet HTTP(S) gateway URL + token + extra
  headers): FULL support — register, test, edit, remove, make-primary, route
  chat/REST/WS to it.
- **local**: the single implicit same-origin backend, unchanged (primary
  default, non-removable).
- **ssh / cloud**: degrade — hide or show a "not supported in the web port"
  hint. No tunnel/OAuth plumbing.

## What is already upstream-synced (DO NOT EDIT except via patcher)

- `web/src/store/gateway.ts` — full multi-connection routing (secondaries map,
  `registryBackendScopeKey`, `getConnectionFor` dial, `setApiRequestConnection`).
- `web/src/hermes.ts` — `setApiRequestConnection`/`getApiRequestConnection`,
  `activeConnection()` → `getConnectionFor`, `api()` carries `connectionId`.
- `web/src/app/settings/connections-registry.tsx` — the full Settings UI; calls
  `window.hermesDesktop.connections.{list,save,remove,setPrimary,test}`.
- `web/src/sdk/index.ts` — `getAgentRoster` / `getProfileRoutes` consumers.
- `web/src/global.d.ts` — the exact bridge contract (below).

## What is web-specific and editable directly

- `web/src/web-bridge.ts` — preserved by `sync-renderer.sh` (`--exclude`). The
  shim. Currently stubs `connections.*`, lacks `getConnectionFor`,
  `getGatewayWsUrlFor`, `getAgentRoster`.
- `proxy/server.js` — local-only proxy; never upstream-clobbered. Single static
  `HERMES_TARGET`. Needs multi-target routing + a connections CRUD door.
- `proxy/` is the right home for a new `connections-store.js` (secret file I/O).

## Contract the bridge must satisfy (from `global.d.ts`)

```ts
connections: {
  list: () => Promise<DesktopConnectionsRegistry>          // { version:2, primary, secureTokenStorage, connections[] }
  save: (payload: DesktopRegistryConnectionInput) =>
    Promise<{ ok, connection, registry }>
  remove: (id) => Promise<{ ok, registry }>
  setPrimary: (id) => Promise<{ ok, registry }>
  test: (id) => Promise<{ ok?, reachable?, error?, version? }>
}
getConnectionFor?: ({ connectionId?, profile? }) => Promise<HermesConnection>
getGatewayWsUrlFor?: ({ connectionId?, profile? }) => Promise<GatewayWsUrlResult>
getAgentRoster?: () => Promise<DesktopAgentRoster>
getProfileRoutes: (profiles) => Promise<DesktopPluginProfileRoute[]>  // already stubbed -> []
```

`DesktopRegistryConnection` (renderer view — never carries token bytes):
`{ id, kind, label, url?, authMode?, org?, host?, user?, port?, keyPath?,
remoteHermesPath?, remoteProfile?, tokenSet, tokenPreview, headerNames?,
installId? }`.

`DesktopRegistryConnectionInput` (save): `{ id?, kind, label, url?, authMode?,
token?, allowPlainTextToken?, headers? (name→new|keep|null), org?, host?, ... }`.

`HermesConnection`: `{ baseUrl, isFullscreen, mode, authMode, remoteHost?,
remoteIdentity?, remoteKind?, remoteHermesVersion?, nativeOverlayWidth, source,
token, wsUrl, logs, profile?, connectionId?, sharedPrimary?, sharedRemote?,
windowButtonPosition }`.

## Auth model (from `hermes_cli/web_server.py`)

- Remote gateway REST auth: header `X-Hermes-Session-Token: <token>` OR legacy
  `Authorization: Bearer <token>`.
- Remote gateway WS auth: `?token=<token>` query param.
- Public `GET /api/status` (unauthenticated) → `{ auth_required, install_id,
  auth_flows, version? }`. Used for the **test** probe and **install_id**
  dedup ("same backend" hint).
- Local backend stays cookie/`?ticket=`-based (same-origin), unchanged.

## Routing design (browser can't hit remote directly — CORS)

All remote traffic MUST flow through the same-origin proxy, which then
forwards to the remote upstream and injects auth. Concrete plan:

1. **Registry storage** — new file, secrets separated from the non-secret
   settings store. Default `~/.hermes/hermes-web-connections.json` (mode 0600),
   overridable via `HERMES_WEB_CONNECTIONS_FILE`. Shape:
   `{ version: 2, primary: 'local', connections: [ ...with plaintext token for
   remote when user consents (keyring-less Linux parity) ] }`. Local entry is
   implicit (not persisted) — mirror `DesktopConnectionsRegistry` to the
   renderer with a synthesized local row.

2. **Proxy CRUD door** (served locally, like `/web-settings`):
   - `GET /web-connections` → registry (tokens redacted → `tokenSet`/`tokenPreview`).
   - `PUT /web-connections` → save (accepts token/headers, stores plaintext).
   - `DELETE /web-connections/<id>` → remove (retarget primary to local if needed).
   - `POST /web-connections/<id>/primary` → set primary.
   - `POST /web-connections/<id>/test` → proxy performs the `/api/status` probe
     (browser can't due to CORS) and returns `{ ok, reachable, version, error }`.
   Dedup rules mirror `connection-registry.ts`: one local; unique label
   (case-insensitive); remote/cloud unique by normalized URL.

3. **REST routing** — bridge `api()` injects `X-Hermes-Connection-Id: <id>`
   when the request carries a non-local `connectionId`; proxy reads it, looks up
   the upstream, injects `X-Hermes-Session-Token` + extra headers, forwards.
   No header → local `HERMES_TARGET` (byte-identical legacy path).

4. **WS routing** — `getGatewayWsUrlFor({connectionId, profile})` returns a
   SAME-ORIGIN ws URL with `?connection=<id>` (and the local `?ticket=` for
   local). Proxy upgrade handler reads `connection`, selects the remote
   upstream, injects `?token=<token>` + headers, TCP-passthroughs. Local path
   unchanged.

5. **Roster + routes** — `getAgentRoster()`: enumerate the local backend's
   profiles (`/api/profiles`?) + reachability-probe each remote via
   `/api/status`; collapse duplicate `install_id`. `getProfileRoutes()` returns
   routes for local + remote sources (remote profiles enumerated the same way).
   Keep it minimal: if a remote is unreachable, list it in `sources` with
   `error`, don't fail the call.

## Acceptance (executable)

- `cd web && npm run build` exits 0.
- Proxy unit smoke: `node -e "require('./proxy/connections-store')"` loads.
- CDP: register a remote pointing at `http://127.0.0.1:9119` (the local backend
  re-addressed), test → `reachable`, make-primary → active gateway resolves to
  it, `/api/auth/me` returns 200 through the proxy with the routing header.
- Local-only regression: no `X-Hermes-Connection-Id` header → identical legacy
  path; `/api/auth/me` still 200.

## Do-not-touch fences

- Do NOT edit `web/src/store/gateway.ts`, `web/src/hermes.ts`,
  `connections-registry.tsx`, `global.d.ts`, or any other upstream-synced file
  except through `scripts/reapply-port-patches.mjs`.
- Do NOT store connection secrets in `web/dist`, git, or the non-secret
  settings file. Only the 0600 connections file.
- Do NOT break the local single-backend path (it must stay byte-identical when
  no remote is configured).
