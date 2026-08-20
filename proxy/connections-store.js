'use strict';

// Connections registry store — the web port's secret-file I/O for the v2
// multi-connection registry (Settings → Gateways → Connections).
//
// Persisted shape (the on-disk secret file):
//
//   {
//     "version": 2,
//     "primary": "<connection id>",          // 'local' by default
//     "connections": [                       // NON-local entries only
//       {
//         "id": "…",                         // server-minted (crypto.randomUUID)
//         "kind": "remote",                  // 'cloud' degrades like remote
//         "label": "…",                      // unique, case-insensitive
//         "url": "http://host:port",         // remote/cloud only
//         "authMode": "token",
//         "token": "<plaintext>",            // secret — 0600 file
//         "oauth": {                         // secret — RFC 8252 native tokens
//           "accessToken": "…",              //   (only when authMode=oauth)
//           "refreshToken": "…",
//           "expiresAt": 1780000000,
//           "provider": "…",
//           "userId": "…"
//         },
//         "headers": { "Name": "value" },    // extra gateway headers (secrets)
//         "installId": "…"                   // last-known /api/status install_id
//       }
//     ]
//   }
//
// The LOCAL connection is implicit: never stored, always synthesized as
// { id: 'local', kind: 'local', label: 'Local', tokenSet: false, … } on read.
//
// Dedup rules (mirroring the renderer's findDuplicateConnection):
//   - at most ONE local entry, ever;
//   - labels are unique case-insensitively;
//   - remote/cloud entries are unique by normalized URL (trim, strip trailing
//     slashes, lowercase).
//
// Secrets never leave this module's redacted views: the renderer-facing
// registry carries `tokenSet`/`tokenPreview` (last 4 chars) + `headerNames`
// only; oauth connections keep `tokenSet` false and expose just
// `oauthConnected`/`oauthExpiresAt`. The file is written mode 0600.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOCAL_CONNECTION_ID = 'local';

const CONNECTIONS_FILE =
  process.env.HERMES_WEB_CONNECTIONS_FILE ||
  path.join(os.homedir(), '.hermes', 'hermes-web-connections.json');

// Mirror the renderer's normalizeGatewayUrl (connections-registry.tsx):
// trim, drop trailing slashes, lowercase.
function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function defaultRegistry() {
  return { version: 2, primary: LOCAL_CONNECTION_ID, connections: [] };
}

// Read + validate the on-disk registry. Missing/corrupt file → defaults.
function loadRegistry() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
  } catch {
    return defaultRegistry();
  }
  const connections = Array.isArray(raw && raw.connections)
    ? raw.connections.filter(
        (c) =>
          c &&
          typeof c === 'object' &&
          typeof c.id === 'string' &&
          c.id !== LOCAL_CONNECTION_ID &&
          typeof c.label === 'string'
      )
    : [];
  const primary =
    typeof raw.primary === 'string' && raw.primary !== LOCAL_CONNECTION_ID && connections.some((c) => c.id === raw.primary)
      ? raw.primary
      : LOCAL_CONNECTION_ID;
  return { version: 2, primary, connections };
}

// Atomic-ish write with mode 0600 (temp + rename so a crash can't leave a
// truncated secret file). The parent dir (.hermes) already exists in practice;
// mkdirSync-recursive keeps it robust.
function saveRegistry(registry) {
  fs.mkdirSync(path.dirname(CONNECTIONS_FILE), { recursive: true });
  const tmp = CONNECTIONS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONNECTIONS_FILE);
  fs.chmodSync(CONNECTIONS_FILE, 0o600);
}

// findIndex helper for the dedup rules above.
function duplicateIndex(registry, candidate) {
  const { id, kind, label, url } = candidate;
  const normLabel = String(label || '').trim().toLowerCase();
  const normUrl = normalizeUrl(url);

  return registry.connections.findIndex((c) => {
    if (id && c.id === id) return false; // self-edit never collides
    if (String(c.label || '').trim().toLowerCase() === normLabel) return true;
    if ((kind === 'remote' || kind === 'cloud') && (c.kind === 'remote' || c.kind === 'cloud')) {
      if (normUrl && normalizeUrl(c.url) === normUrl) return true;
    }
    return false;
  });
}

function tokenPreview(token) {
  const t = String(token || '');
  return t.length <= 4 ? t : t.slice(-4);
}

// ── CRUD (server-side operations; the proxy door maps HTTP verbs onto these) ──

// Renderer-facing view: token bytes → tokenSet/tokenPreview; headers → names.
// OAuth tokens are never exposed — only `oauthConnected` + `oauthExpiresAt`
// (+ provider) so the UI can show sign-in state. `tokenSet` stays false for
// oauth-only connections.
function toPublicConnection(c) {
  const oauth = c && c.oauth && c.oauth.accessToken ? c.oauth : null;
  const tokenSet = Boolean(c.token);
  const out = {
    id: c.id,
    kind: c.kind,
    label: c.label,
    tokenSet,
    tokenPreview: tokenSet ? tokenPreview(c.token) : null,
    oauthConnected: Boolean(oauth),
  };
  if (oauth) {
    out.oauthExpiresAt =
      Number.isFinite(oauth.expiresAt) && oauth.expiresAt > 0 ? oauth.expiresAt : null;
    if (oauth.provider) out.oauthProvider = oauth.provider;
  }
  if (c.url) out.url = c.url;
  if (c.authMode) out.authMode = c.authMode;
  if (c.org) out.org = c.org;
  if (c.host) out.host = c.host;
  if (c.user) out.user = c.user;
  if (c.port) out.port = c.port;
  if (c.keyPath) out.keyPath = c.keyPath;
  if (c.remoteHermesPath) out.remoteHermesPath = c.remoteHermesPath;
  if (c.remoteProfile) out.remoteProfile = c.remoteProfile;
  if (Array.isArray(c.headers) && c.headers.length) {
    out.headerNames = c.headers.map((h) => h.name);
  } else if (c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)) {
    out.headerNames = Object.keys(c.headers);
  }
  if (c.installId) out.installId = c.installId;
  return out;
}

// Synthesized local row — never persisted.
function localConnection() {
  return {
    id: LOCAL_CONNECTION_ID,
    kind: 'local',
    label: 'Local',
    tokenSet: false,
    tokenPreview: null,
    oauthConnected: false,
  };
}

function toPublicRegistry(registry) {
  return {
    version: 2,
    primary: registry.primary,
    secureTokenStorage: false,
    connections: [localConnection(), ...registry.connections.map(toPublicConnection)],
  };
}

function list() {
  return toPublicRegistry(loadRegistry());
}

// Upsert from the renderer's DesktopRegistryConnectionInput. `headers` is the
// authoritative name → value map when present: a typed value replaces the
// stored secret, null keeps it, an absent name clears it.
function save(input) {
  const registry = loadRegistry();
  const kind = input && typeof input.kind === 'string' ? input.kind : 'remote';

  if (kind === 'local') {
    // One local entry, ever: no-op returning the current registry (the renderer
    // guards duplicates before calling, but stay safe server-side too).
    return { registry: toPublicRegistry(registry), connection: localConnection(), changed: false };
  }

  if (!input || typeof input.label !== 'string' || !input.label.trim()) {
    const err = new Error('label is required');
    err.status = 400;
    throw err;
  }

  if ((kind === 'remote' || kind === 'cloud') && !normalizeUrl(input.url)) {
    const err = new Error('url is required for remote/cloud connections');
    err.status = 400;
    throw err;
  }

  const existing = registry.connections.find((c) => input.id && c.id === input.id);
  const candidate = {
    id: existing ? existing.id : crypto.randomUUID(),
    kind: kind === 'cloud' ? 'cloud' : 'remote', // ssh/cloud degrade; web supports remote (+cloud-as-remote)
    label: input.label.trim(),
    url: kind === 'remote' || kind === 'cloud' ? normalizeUrl(input.url) || undefined : undefined,
    authMode: input.authMode || 'token',
    installId: existing ? existing.installId : undefined,
  };

  // Headers: authoritative when present (name → new value | null=keep |
  // absent=clear). Otherwise keep the stored set untouched.
  const headerMap = {};
  const storedHeaders = existing && Array.isArray(existing.headers) ? existing.headers : [];
  for (const h of storedHeaders) {
    headerMap[h.name] = h.value;
  }
  if (input.headers !== undefined && input.headers !== null && typeof input.headers === 'object') {
    for (const [name, value] of Object.entries(input.headers)) {
      const trimmed = String(name || '').trim();
      if (!trimmed) continue;
      if (value === null) {
        // keep the saved secret for this name
        if (!(trimmed in headerMap)) headerMap[trimmed] = '';
        continue;
      }
      headerMap[trimmed] = String(value);
    }
    // Names present in the map but missing from the authoritative input are
    // removed rows → clear.
    for (const name of Object.keys(headerMap)) {
      if (!(name in input.headers)) delete headerMap[name];
    }
  }
  const headers = Object.entries(headerMap)
    .filter(([, v]) => v !== undefined)
    .map(([name, value]) => ({ name, value }));
  if (headers.length) candidate.headers = headers;

  // Token: typed value replaces; omitted keeps the stored one.
  if (typeof input.token === 'string' && input.token.length > 0) {
    candidate.token = input.token;
  } else if (existing) {
    candidate.token = existing.token;
  }

  // ssh-only fields: accepted (stored) so the UI round-trips them, though the
  // web port has no tunnel plumbing — ssh connections are display-only.
  if (input.org) candidate.org = input.org;
  if (input.host) candidate.host = input.host;
  if (input.user) candidate.user = input.user;
  if (input.port) candidate.port = input.port;
  if (input.keyPath) candidate.keyPath = input.keyPath;
  if (input.remoteHermesPath) candidate.remoteHermesPath = input.remoteHermesPath;
  if (input.remoteProfile) candidate.remoteProfile = input.remoteProfile;

  const dupeAt = duplicateIndex(registry, candidate);
  if (dupeAt !== -1) {
    const dupe = registry.connections[dupeAt];
    const err = new Error(
      dupe.kind === 'local' ? 'duplicate local connection' : `duplicate connection "${dupe.label}"`
    );
    err.status = 409;
    throw err;
  }

  const replaced = existing ? registry.connections.map((c) => (c.id === candidate.id ? candidate : c)) : [...registry.connections, candidate];
  registry.connections = replaced;
  saveRegistry(registry);
  return { registry: toPublicRegistry(registry), connection: toPublicConnection(candidate), changed: true };
}

function remove(id) {
  const registry = loadRegistry();
  if (id === LOCAL_CONNECTION_ID) {
    const err = new Error('local connection cannot be removed');
    err.status = 400;
    throw err;
  }
  registry.connections = registry.connections.filter((c) => c.id !== id);
  if (registry.primary === id) registry.primary = LOCAL_CONNECTION_ID;
  saveRegistry(registry);
  return { registry: toPublicRegistry(registry) };
}

function setPrimary(id) {
  const registry = loadRegistry();
  if (id === LOCAL_CONNECTION_ID) {
    registry.primary = LOCAL_CONNECTION_ID;
  } else if (!registry.connections.some((c) => c.id === id)) {
    const err = new Error(`no connection with id "${id}"`);
    err.status = 404;
    throw err;
  } else {
    registry.primary = id;
  }
  saveRegistry(registry);
  return { registry: toPublicRegistry(registry) };
}

// Resolve a stored connection by id; local → null (the proxy's own target).
function get(id) {
  if (!id || id === LOCAL_CONNECTION_ID) return null;
  return loadRegistry().connections.find((c) => c.id === id) || null;
}

// Resolve a stored connection whose normalized url matches (the legacy
// gateway-settings UI operates on URL, not connection id).
function findByUrl(url) {
  const norm = normalizeUrl(url);
  if (!norm) return null;
  return loadRegistry().connections.find((c) => normalizeUrl(c.url) === norm) || null;
}

// Store (or clear, with null) the oauth token set on a connection resolved by
// id or URL. Tokens live only in the 0600 file — never in any public view.
function setOauth(connKey, oauth) {
  const registry = loadRegistry();
  let entry = registry.connections.find((c) => c.id === connKey);
  if (!entry) {
    const norm = normalizeUrl(connKey);
    if (norm) entry = registry.connections.find((c) => normalizeUrl(c.url) === norm);
  }
  if (!entry) {
    const err = new Error(`no connection for oauth key "${connKey}"`);
    err.status = 404;
    throw err;
  }
  if (oauth === null || oauth === undefined) {
    delete entry.oauth;
  } else {
    entry.oauth = oauth;
  }
  saveRegistry(registry);
  return entry;
}

module.exports = {
  CONNECTIONS_FILE,
  LOCAL_CONNECTION_ID,
  duplicateIndex,
  findByUrl,
  get,
  list,
  loadRegistry,
  localConnection,
  normalizeUrl,
  remove,
  save,
  setOauth,
  setPrimary,
  toPublicConnection,
  toPublicRegistry,
  tokenPreview,
};
