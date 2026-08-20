'use strict';

// RFC 8252 native-PKCE OAuth relay for the web port's multi-gateway feature.
//
// Gated `hermes serve` gateways authenticate with cookies / native PKCE, and a
// browser tab cannot listen on a loopback port — so the PROXY plays the
// "native app" side of the flow:
//
//   1. begin(connKey, provider?) — probe <base>/api/status for `native_pkce`
//      (older gateways fall back to token mode; no OAuth), mint a PKCE S256
//      pair + CSRF state, bind an ephemeral 127.0.0.1:<port> listener at
//      /callback, and return the gateway /auth/native/authorize URL for the
//      browser to open.
//   2. The gateway 302s the browser to <loopback>/callback?code=&state=; the
//      listener validates state (CSRF), POSTs /auth/native/token with
//      { code, code_verifier, redirect_uri }, normalizes the snake_case
//      response, and stores the tokens on the registry connection (0600 file).
//      The browser never sees the tokens.
//   3. status/disconnect/bearer — status reports connectivity, disconnect
//      clears tokens, bearer() returns a fresh access token (refreshing near
//      expiry via /auth/native/refresh with a 60s skew; a dead refresh token
//      clears + returns null so the caller surfaces a 401).
//
// Tokens are stored as `oauth: { accessToken, refreshToken, expiresAt,
// provider, userId }` (camelCase, mirroring the desktop's NativeTokenSet) on
// the registry connection — same 0600 file, same redaction rules.
//
// Factory with injectable fetch/random for unit tests. Zero-dep (node:http +
// node:crypto + global fetch, Node ≥ 18).

const http = require('http');
const crypto = require('crypto');

const NATIVE_FLOW_ID = 'native_pkce';

// Pending-flow TTL: the user has this long to complete sign-in before the
// loopback listener is torn down.
const PENDING_TTL_MS = 10 * 60 * 1000;

// Refresh slightly early so a token doesn't expire in flight (mirrors the
// desktop's tokenNeedsRefresh skew and the server's 60s cookie floor).
const REFRESH_SKEW_SECONDS = 60;

const HTTP_TIMEOUT_MS = 15_000;

/** base64url without `=` padding (RFC 7636 §4). */
function b64url(raw) {
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * PKCE S256 pair: verifier = 32 random bytes b64url (43 chars, within RFC
 * 7636's 43–128 range); challenge = b64url(sha256(verifier)).
 */
function generatePkcePair(randomImpl) {
  const verifier = b64url(randomImpl(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge, method: 'S256' };
}

/** High-entropy CSRF `state` for the loopback round trip. */
function generateState(randomImpl) {
  return b64url(randomImpl(24));
}

/** True if a gateway `/api/status` body advertises the native PKCE flow. */
function statusSupportsNativeFlow(body) {
  return Boolean(body && Array.isArray(body.auth_flows) && body.auth_flows.includes(NATIVE_FLOW_ID));
}

/** Build the gateway `/auth/native/authorize` URL (provider optional). */
function buildAuthorizeUrl(baseUrl, params) {
  const parsed = new URL(baseUrl);
  const prefix = parsed.pathname.replace(/\/+$/, '');
  const q = new URLSearchParams({
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    redirect_uri: params.redirectUri,
    state: params.state,
  });
  if (params.provider) q.set('provider', params.provider);
  return `${parsed.protocol}//${parsed.host}${prefix}/auth/native/authorize?${q.toString()}`;
}

/** Gateway endpoint URL for a base URL (keeps any path prefix). */
function endpointUrl(baseUrl, suffix) {
  const parsed = new URL(baseUrl);
  const prefix = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${prefix}${suffix}`;
}

/**
 * Parse the loopback redirect (path+query, e.g. "/callback?code=…&state=…")
 * and validate `state` — a mismatch throws (CSRF, RFC 6749 §10.12) and the
 * code is never redeemed. Also surfaces the gateway's `error` param.
 */
function parseLoopbackCallback(requestUrl, expectedState) {
  const parsed = new URL(requestUrl, 'http://127.0.0.1');
  const error = parsed.searchParams.get('error');
  if (error) {
    const desc = parsed.searchParams.get('error_description') || '';
    throw new Error(`Gateway rejected native login: ${error}${desc ? ` (${desc})` : ''}`);
  }
  const code = parsed.searchParams.get('code') || '';
  const state = parsed.searchParams.get('state') || '';
  if (!code) throw new Error('Loopback callback missing authorization code');
  if (!expectedState || state !== expectedState) {
    throw new Error('Loopback callback state mismatch (possible CSRF)');
  }
  return { code };
}

/** Normalize a `/auth/native/token` (or refresh) response (snake_case → camel). */
function normalizeTokenResponse(body) {
  const accessToken = String((body && body.access_token) || '');
  if (!accessToken) throw new Error('Gateway token response missing access_token');
  const expiresAt = Number(body && body.expires_at);
  return {
    accessToken,
    refreshToken: String((body && body.refresh_token) || ''),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    provider: String((body && body.provider) || ''),
    userId: String((body && body.user_id) || ''),
  };
}

/** True when a stored token set is at/near expiry and should be refreshed. */
function tokenNeedsRefresh(tokens, nowSeconds, skewSeconds = REFRESH_SKEW_SECONDS) {
  if (!tokens || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= 0) return true;
  return nowSeconds >= tokens.expiresAt - skewSeconds;
}

function createOauthRelay(opts) {
  const store = opts && opts.store;
  if (!store || typeof store.get !== 'function') {
    throw new Error('oauth-relay: a connections store with get() is required');
  }
  const fetchImpl = (opts && opts.fetchImpl) || ((...args) => fetch(...args));
  const randomImpl = (opts && opts.randomImpl) || ((n) => crypto.randomBytes(n));

  // state → pending flow entry. In-memory only (a relay restart just orphans
  // the browser's sign-in; the 10-min TTL reaps the listener either way).
  const pending = new Map();

  function resolveConnection(connKey) {
    // connKey is a connection id OR a gateway URL (the legacy gateway-settings
    // UI operates on URL, not registry id).
    let conn = store.get(connKey);
    if (!conn && typeof store.findByUrl === 'function') conn = store.findByUrl(connKey);
    return conn || null;
  }

  async function fetchJson(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const text = await res.text().catch(() => '');
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    return { res, body };
  }

  function expire(state) {
    const entry = pending.get(state);
    if (!entry) return;
    pending.delete(state);
    clearTimeout(entry.timer);
    try {
      entry.server.close();
    } catch {
      /* already closed */
    }
  }

  async function redeem(entry, code) {
    const { res, body } = await fetchJson(endpointUrl(entry.baseUrl, '/auth/native/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: entry.verifier,
        redirect_uri: entry.redirectUri,
      }),
    });
    if (!res.ok) {
      const err = new Error(`native token exchange failed (HTTP ${res.status})`);
      err.status = 502;
      throw err;
    }
    const tokens = normalizeTokenResponse(body);
    // Store onto the connection resolved at begin time (by id or by URL).
    store.setOauth(entry.connKey, tokens);
    return tokens;
  }

  function handleCallback(server, state, req, res) {
    let respond = (status, text) => {
      try {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
      } catch {
        /* socket gone */
      }
    };
    // Always tear the listener down once the callback fires (success or
    // failure) — one flow, one callback.
    try {
      server.close();
    } catch {
      /* not listening */
    }
    expire(state);

    const entry = pending.get(state);
    let requestUrl;
    try {
      requestUrl = req.url;
    } catch {
      respond(400, 'Bad request');
      return;
    }

    let parsed;
    try {
      parsed = parseLoopbackCallback(requestUrl, state);
    } catch (err) {
      respond(400, String(err && err.message || err));
      return;
    }

    if (!entry) {
      // State validated but no pending entry (expired between the TTL reaper
      // and this callback) — refuse to redeem an orphaned code.
      respond(400, 'Sign-in expired; close this tab and try again.');
      return;
    }

    redeem(entry, parsed.code)
      .then(() => {
        respond(200, 'Authorization received. You can close this tab and return to Hermes.');
      })
      .catch((err) => {
        respond(502, String(err && err.message || err));
      });
  }

  /**
   * Begin the native-PKCE relay for a connection (by id or URL).
   * Returns { authorizeUrl, redirectUri, baseUrl }. Throws with `status` and
   * `code: 'native_pkce_unavailable'` when the gateway doesn't advertise it.
   */
  async function begin(connKey, provider) {
    const conn = resolveConnection(connKey);
    if (!conn) {
      const err = new Error(`no connection for oauth key "${connKey}"`);
      err.status = 404;
      throw err;
    }
    if (!conn.url) {
      const err = new Error(`connection "${conn.label}" has no url`);
      err.status = 400;
      throw err;
    }
    const baseUrl = conn.url;

    // Capability gate: older gateways (no native_pkce) fall back to token
    // mode — surface a distinct error the bridge maps to the renderer.
    const probe = await fetchJson(endpointUrl(baseUrl, '/api/status'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!probe.res.ok) {
      const err = new Error(`gateway status probe failed (HTTP ${probe.res.status})`);
      err.status = 502;
      throw err;
    }
    if (!statusSupportsNativeFlow(probe.body)) {
      const err = new Error('native_pkce_unavailable');
      err.status = 400;
      err.code = 'native_pkce_unavailable';
      throw err;
    }

    const pkce = generatePkcePair(randomImpl);
    const state = generateState(randomImpl);

    const server = http.createServer((req, res) => handleCallback(server, state, req, res));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const entry = { connKey, baseUrl, verifier: pkce.verifier, redirectUri, server, timer: null };
    pending.set(state, entry);
    entry.timer = setTimeout(() => expire(state), PENDING_TTL_MS);
    if (entry.timer.unref) entry.timer.unref();

    const authorizeUrl = buildAuthorizeUrl(baseUrl, {
      challenge: pkce.challenge,
      redirectUri,
      state,
      provider,
    });
    return { authorizeUrl, redirectUri, baseUrl };
  }

  function status(connKey) {
    const conn = resolveConnection(connKey);
    const oauth = conn && conn.oauth && conn.oauth.accessToken ? conn.oauth : null;
    if (oauth) {
      return {
        connected: true,
        expiresAt: Number.isFinite(oauth.expiresAt) && oauth.expiresAt > 0 ? oauth.expiresAt : null,
        provider: oauth.provider || null,
      };
    }
    return { connected: false, expiresAt: null, provider: null };
  }

  function disconnect(connKey) {
    const conn = resolveConnection(connKey);
    if (!conn) {
      const err = new Error(`no connection for oauth key "${connKey}"`);
      err.status = 404;
      throw err;
    }
    store.setOauth(connKey, null);
    return { ok: true, connected: false };
  }

  /**
   * Fresh access token for an oauth connection, or null when unavailable
   * (no tokens, or refresh failed with 401 → tokens cleared, caller must
   * re-login). Refreshes near expiry (60s skew); rotates stored tokens.
   */
  async function bearer(connKey) {
    const conn = resolveConnection(connKey);
    const oauth = conn && conn.oauth;
    if (!oauth || !oauth.accessToken) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!tokenNeedsRefresh(oauth, nowSeconds)) return oauth.accessToken;

    if (!oauth.refreshToken) {
      // Nothing to refresh with — dead session.
      store.setOauth(connKey, null);
      return null;
    }

    const { res, body } = await fetchJson(endpointUrl(conn.url, '/auth/native/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: oauth.refreshToken, provider: oauth.provider || '' }),
    });

    if (res.status === 401) {
      // Dead/expired refresh token → clear, force re-login (matches the
      // desktop: 401 on refresh ⇒ clear tokens, prompt re-login).
      store.setOauth(connKey, null);
      return null;
    }
    if (!res.ok) {
      const err = new Error(`native refresh failed (HTTP ${res.status})`);
      err.status = 502;
      throw err;
    }
    const tokens = normalizeTokenResponse(body);
    store.setOauth(connKey, tokens);
    return tokens.accessToken;
  }

  return { begin, status, disconnect, bearer };
}

module.exports = {
  NATIVE_FLOW_ID,
  buildAuthorizeUrl,
  createOauthRelay,
  endpointUrl,
  generatePkcePair,
  generateState,
  normalizeTokenResponse,
  parseLoopbackCallback,
  statusSupportsNativeFlow,
  tokenNeedsRefresh,
};
