# OAuth proxy-relay for the web port's multi-gateway feature

## Goal

Make gated `hermes serve` gateways (cookie/PKCE auth) connectable from the web
port's multi-gateway registry, matching the desktop's RFC 8252 native-PKCE
flow — but with the PROXY performing the loopback exchange so the browser never
handles the secret.

## Why proxy relay (not browser-native)

- A browser tab can't listen on a loopback port (native-app affordance).
- The desktop opens `/auth/native/authorize?...&redirect_uri=http://127.0.0.1:<port>/callback` in the system browser and listens. The web port's proxy (Node) CAN listen.
- The proxy completes `/auth/native/token` (code + code_verifier → bearer tokens), stores them in the existing connections file (mode 0600), and injects `Authorization: Bearer <access_token>` on forwarded requests. Browser never sees the token.

## Auth flow contract (from desktop native-oauth.ts + hermes_cli/dashboard_auth/routes.py)

1. `GET <base>/api/status` (public) → `auth_flows` array. `native_pkce` present ⇒ flow available. (Older gateways: fall back to token mode; no OAuth.)
2. PKCE S256 pair: `verifier` = b64url(32 random bytes); `challenge` = b64url(sha256(verifier)).
3. `state` = b64url(24 random bytes) — CSRF.
4. Open in browser: `<base>/auth/native/authorize?provider=<p>&code_challenge=<challenge>&code_challenge_method=S256&redirect_uri=<loopback>&state=<state>`
   - `provider` optional (empty selects the sole registered session provider).
   - `redirect_uri` must be loopback (`_validate_loopback_redirect_uri`).
5. Gateway redirects browser to `<loopback>/callback?code=<code>&state=<state>` (or `?error=`).
6. POST `<base>/auth/native/token` body `{ code, code_verifier, redirect_uri }` → `{ access_token, refresh_token, expires_at, provider, user_id }` (snake_case).
7. Refresh: POST `<base>/auth/native/refresh` body `{ refresh_token, provider }` → same shape. 401 on dead RT → clear tokens, prompt re-login.
8. Auth on requests: `Authorization: Bearer <access_token>` (native bearer, cookieless).
9. Token expiry: `expires_at` (seconds); refresh early by 60s skew (`tokenNeedsRefresh`).

## Architecture

- **`proxy/oauth-relay.js`** (NEW, zero-dep node:http): state machine per pending flow:
  - `begin(connId, provider?)` → mint PKCE pair + state, stash `{ connId, verifier, state, redirectUri }` (in-memory + short TTL, e.g. 10 min), return `{ authorizeUrl, redirectUri }` to the renderer.
  - Loopback listener: a single ephemeral `http.Server` on `127.0.0.1:<port>` (pick a free port), path `/callback`; parses code+state, validates state, POSTs `/auth/native/token`, stores tokens into the connections file (`oauth: { access_token, refresh_token, expires_at, provider, user_id }`), responds "you can close this tab", resolves the pending flow.
  - `status(connId)` → `{ connected, expiresAt, provider }`.
  - `disconnect(connId)` → clear stored oauth tokens.
  - `bearer(connId)` → returns a fresh access token (refresh if near expiry), or null.
- **`proxy/server.js`**: 
  - New routes: `POST /web-connections/<id>/oauth/begin`, `GET /web-connections/<id>/oauth/status`, `POST /web-connections/<id>/oauth/disconnect`.
  - `proxyHttp`/`proxyUpgrade`: when routing to an oauth connection, inject `Authorization: Bearer <bearer>` (instead of / in addition to X-Hermes-Session-Token).
- **`web/src/web-bridge.ts`**: implement `oauthLoginConnectionConfig` → calls begin, returns `{ ok: true, baseUrl, connected: false, authorizeUrl }`; `oauthLogoutConnectionConfig` → disconnect. The renderer's existing Connections UI (upstream-synced, `connections-registry.tsx`) already opens the authorize URL + polls status — verify it does, wire to it.
- **Storage**: extend `connections-store.js` connection entries with `oauth: {...}` (secret, same 0600 file, same redaction rules — `tokenSet` stays false for oauth; add `oauthConnected: true` + `oauthExpiresAt` to the public view).

## Security

- Browser never sees access/refresh tokens — only `oauthConnected` + expiry.
- `redirect_uri` is always loopback (the gateway validates it too).
- `state` validated before code redemption (CSRF).
- Code verifier never leaves the proxy; single-use by the gateway.
- Tokens stored only in the 0600 connections file (same as token mode).

## Files (whitelist)

- `proxy/oauth-relay.js` (NEW)
- `proxy/server.js`
- `proxy/connections-store.js`
- `web/src/web-bridge.ts`

Everything else (renderer UI, gateway store) is upstream-synced — the bridge surface already exists; wire to it. Do NOT edit `connections-registry.tsx` or `global.d.ts` except via the patcher if truly needed (note it; don't do it).

## Acceptance (MUST all pass)

1. `node -e "require('./proxy/oauth-relay.js'); console.log('ok')"` → ok.
2. Unit-ish: relay mints PKCE + authorize URL for a fake base; `parseLoopbackCallback`-equivalent rejects state mismatch.
3. End-to-end (no real OAuth provider needed — the gateway's OWN password provider supports native flow): register a connection to `http://host.docker.internal:9119`, call begin, open the returned authorizeUrl in headless CDP, complete the password login, verify the loopback callback fires, the proxy stores tokens, and `GET /web-connections` shows `oauthConnected: true` (token bytes absent).
4. Bearer injection: with tokens stored, a routed `/api/profiles` via the proxy returns 200 (not 401).
5. Build: `cd web && npm run build` exits 0.
6. Write `REPORT.md` with the exact outputs of 1, 3, 4 and `git diff --stat`.

## Do-not-touch

- No commits (pre-commit hook blocks; leave working tree dirty).
- Do NOT edit upstream-synced renderer files except via patcher, and only if unavoidable.
- No secrets in REPORT.md — redact tokens.
