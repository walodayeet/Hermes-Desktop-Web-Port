'use strict';

// Unit smoke for proxy/oauth-relay.js — acceptance item 2.
// Deterministic random → verify PKCE pair + authorize URL + state mismatch
// rejection. Run: node proxy/oauth-relay.smoke.js
const assert = require('assert');
const crypto = require('crypto');
const { createOauthRelay, generatePkcePair, generateState, parseLoopbackCallback, buildAuthorizeUrl, tokenNeedsRefresh, normalizeTokenResponse } = require('./oauth-relay');

// Deterministic random for reproducible pairs.
function detRandom(seed) {
  let s = seed >>> 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      out[i] = (s >> 16) & 0xff;
    }
    return out;
  };
}

const random = detRandom(42);
const pkce = generatePkcePair(random);
assert.strictEqual(pkce.method, 'S256');
assert.ok(/^[A-Za-z0-9_-]+$/.test(pkce.verifier), 'verifier is b64url');
assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128, 'verifier length in RFC 7636 range');
// challenge === b64url(sha256(verifier))
const expectedChallenge = Buffer.from(crypto.createHash('sha256').update(pkce.verifier, 'ascii').digest())
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
assert.strictEqual(pkce.challenge, expectedChallenge, 'S256 challenge derivation');
assert.notStrictEqual(pkce.verifier, pkce.challenge);

const state = generateState(random);
assert.ok(/^[A-Za-z0-9_-]{32}$/.test(state), 'state is 32-char b64url (24 bytes)');

// Authorize URL shape (fake base with a path prefix).
const authUrl = buildAuthorizeUrl('http://gateway.example:9119/hermes', {
  challenge: pkce.challenge,
  redirectUri: 'http://127.0.0.1:41234/callback',
  state,
  provider: '',
});
const u = new URL(authUrl);
assert.strictEqual(u.origin + u.pathname, 'http://gateway.example:9119/hermes/auth/native/authorize');
assert.strictEqual(u.searchParams.get('code_challenge'), pkce.challenge);
assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:41234/callback');
assert.strictEqual(u.searchParams.get('state'), state);
assert.strictEqual(u.searchParams.get('provider'), null);

// Provider included when given.
const withProv = new URL(buildAuthorizeUrl('http://x', { challenge: 'c', redirectUri: 'http://127.0.0.1:1/cb', state: 's', provider: 'basic' }));
assert.strictEqual(withProv.searchParams.get('provider'), 'basic');

// State mismatch on the loopback callback → throws (CSRF).
assert.throws(() => parseLoopbackCallback('/callback?code=abc&state=wrong', state), /state mismatch/);
assert.throws(() => parseLoopbackCallback('/callback?code=abc&state=' + state, 'other'), /state mismatch/);
// Missing code → throws.
assert.throws(() => parseLoopbackCallback('/callback?state=' + state, state), /missing authorization code/);
// Gateway error param surfaces.
assert.throws(() => parseLoopbackCallback('/callback?error=access_denied&error_description=nope', state), /access_denied/);
// Happy path.
assert.deepStrictEqual(parseLoopbackCallback('/callback?code=abc&state=' + state, state), { code: 'abc' });

// normalizeTokenResponse: snake_case → camel; missing access_token throws.
assert.deepStrictEqual(
  normalizeTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_at: 123, provider: 'basic', user_id: 'u1' }),
  { accessToken: 'at', refreshToken: 'rt', expiresAt: 123, provider: 'basic', userId: 'u1' }
);
assert.throws(() => normalizeTokenResponse({}), /missing access_token/);

// tokenNeedsRefresh skew.
const t = { expiresAt: 1_000_000 };
assert.strictEqual(tokenNeedsRefresh(t, 1_000_000 - 61, 60), false);
assert.strictEqual(tokenNeedsRefresh(t, 1_000_000 - 60, 60), true);
assert.strictEqual(tokenNeedsRefresh({ expiresAt: 0 }, 1), true);

// begin() with an oauth-incapable connection → native_pkce_unavailable.
(async () => {
  const fakeStore = {
    get: (id) => (id === 'c1' ? { id: 'c1', label: 'tok', url: 'http://tok.example' } : null),
    findByUrl: () => null,
    setOauth: () => {},
  };
  const relay = createOauthRelay({ store: fakeStore, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ auth_flows: ['cookie'] }) }) });
  try {
    await relay.begin('c1');
    assert.fail('should have thrown native_pkce_unavailable');
  } catch (err) {
    assert.strictEqual(err.code, 'native_pkce_unavailable');
  }
  console.log('SMOKE OK: pkce/state/authorize-url/loopback-parse/token-normalize/needs-refresh/native_pkce_unavailable');
})().catch((e) => { console.error(e); process.exit(1); });
