'use strict';

// Tiny same-origin facade over `hermes serve`.
//
//   GET/POST/... /api/*   → forwarded to HERMES_TARGET (127.0.0.1:9119)
//   GET/POST/... /auth/*  → forwarded too (v0.20.0 login/logout live here,
//                           NOT under /api/*; cookies must pass verbatim)
//   WS            /api/ws → raw upgrade passthrough (bidirectional, no parsing)
//   everything else       → static web/dist/ (SPA fallback to index.html)
//
// Zero-dep (node:http only). The /api/ws path is a true TCP passthrough: the
// client's upgrade request head is replayed to the backend, and raw bytes flow
// both ways. JSON-RPC frames are never parsed.

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 4000;
const TARGET_RAW = process.env.HERMES_TARGET || '127.0.0.1:9119';

// Multi-connection registry: secret-file store + CRUD (see connections-store.js).
const connectionsStore = require('./connections-store');

// Serve the SPA bundle from web/dist by default; DIST_DIR overrides for
// testing an alternate build (e.g. a gate-stripped diagnostic bundle).
const DIST = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.resolve(__dirname, '..', 'web', 'dist');

// Desktop-plugins door: the renderer's runtime plugin loader reads
// `<hermes home>/desktop-plugins/<name>/plugin.js` off local disk in the
// Electron shell. In the web port that "disk" is THIS host's folder, exposed
// as a virtual `/plugins` root. Override with HERMES_PLUGINS_DIR.
const PLUGINS_DIR = process.env.HERMES_PLUGINS_DIR || path.join(os.homedir(), '.hermes', 'desktop-plugins');

// Web-fs door: filesystem access for the desktop Files rail, rooted at
// WEB_FS_ROOT (default the agent's home). Symlink-aware: every realpath must
// stay inside the (real) root.
const WEB_FS_ROOT = process.env.WEB_FS_ROOT || os.homedir();

// Docker: the gateway reports HOST paths (sessions' cwd, git roots), but the
// container's WEB_FS_ROOT is the bind-mounted /workspace. When
// WEB_FS_HOST_ROOT is set (the host dir that got mounted onto WEB_FS_ROOT),
// rewrite host-prefixed requests onto the container root so the Files rail
// and file opens resolve instead of failing "outside web-fs root".
const WEB_FS_HOST_ROOT = process.env.WEB_FS_HOST_ROOT || '';

// Interactive terminal default cwd. In docker this is the mounted workspace
// (WEB_FS_ROOT); on a bare host, the agent's home.
const TERM_DEFAULT_CWD = process.env.HERMES_TERM_CWD || os.homedir();

// Server-side settings store: the renderer mirrors durable UI preferences
// (theme, mode, plugin decisions, user themes) here so they follow the user
// across devices instead of living in per-browser localStorage. A JSON file on
// the server; override path (docker should point at a mounted volume).
const SETTINGS_FILE = process.env.HERMES_WEB_SETTINGS_FILE ||
  path.join(os.homedir(), '.hermes', 'hermes-desktop-web-settings.json');

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

function parseTarget() {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(TARGET_RAW)
    ? TARGET_RAW
    : `http://${TARGET_RAW}`;
  const u = new URL(raw);
  const protocol = u.protocol === 'https:' ? 'https:' : 'http:';
  const port = u.port || (protocol === 'https:' ? '443' : '80');
  return { protocol, hostname: u.hostname, port, host: u.host };
}

// ── Multi-gateway routing ───────────────────────────────────────────────────
// A non-local request (REST or WS) carries the registry connection id; the
// proxy looks up the stored connection and forwards to ITS url, injecting
// X-Hermes-Session-Token + the connection's extra headers server-side. The
// browser never sees or sends the token and never hits the remote origin
// directly (CORS + secret safety). No connection id → legacy single-backend
// path (HERMES_TARGET, no auth injection) — byte-identical behavior.

function parseRemoteTarget(rawUrl) {
  const u = new URL(rawUrl);
  const protocol = u.protocol === 'https:' ? 'https:' : 'http:';
  const port = u.port || (protocol === 'https:' ? '443' : '80');
  return { protocol, hostname: u.hostname, port, host: u.host, basePath: u.pathname.replace(/\/+$/, '') };
}

// Resolve the upstream for a request: null → the local HERMES_TARGET.
// Throws with a status when the connection is missing or malformed.
function resolveRoute(req) {
  const connectionId = req.headers['x-hermes-connection-id'];
  if (!connectionId || connectionId === connectionsStore.LOCAL_CONNECTION_ID) {
    return null;
  }
  const conn = connectionsStore.get(connectionId);
  if (!conn) {
    const err = new Error(`no connection with id "${connectionId}"`);
    err.status = 404;
    throw err;
  }
  if (!conn.url) {
    const err = new Error(`connection "${conn.label}" has no url`);
    err.status = 400;
    throw err;
  }
  return { conn, target: parseRemoteTarget(conn.url) };
}

// Auth + extra headers for a remote upstream. The client's own header is
// consumed for routing and NEVER forwarded upstream (HOP_BY_HOP hygiene).
function remoteUpstreamHeaders(headers, target, conn, base) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'x-hermes-connection-id') continue;
    out[k] = v;
  }
  if (conn.token) out['X-Hermes-Session-Token'] = conn.token;
  if (Array.isArray(conn.headers)) {
    for (const h of conn.headers) {
      if (h && h.name) out[h.name] = String(h.value ?? '');
    }
  }
  out.host = target.host;
  return out;
}

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function forwardHeaders(headers, target) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = target.host;
  return out;
}

// Rebuild an upstream upgrade request head from the client's raw headers,
// dropping hop-by-hop headers and rewriting Host. Preserves the original
// header casing/order via rawHeaders so Sec-WebSocket-* negotiation is intact.
function upgradeHeaders(req, target) {
  const headers = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.Host = target.host;
  headers.Connection = 'Upgrade';
  headers.Upgrade = 'websocket';
  return headers;
}

// ---------------------------------------------------------------------------
// HTTP forwarding
// ---------------------------------------------------------------------------

function proxyHttp(req, res) {
  let route;
  try {
    route = resolveRoute(req);
  } catch (err) {
    res.writeHead(err.status || 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || String(err) }));
    return;
  }

  const target = route ? route.target : parseTarget();
  const mod = target.protocol === 'https:' ? https : http;
  const headers = route
    ? remoteUpstreamHeaders(req.headers, target, route.conn, parseTarget().host)
    : forwardHeaders(req.headers, target);

  const upstream = mod.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: route ? route.target.basePath + req.url : req.url,
      method: req.method,
      headers,
    },
    (upRes) => {
      const headers = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers[k] = v;
      }
      res.writeHead(upRes.statusCode || 502, headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_gateway', detail: err.message || String(err) }));
  });

  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// WS upgrade passthrough
// ---------------------------------------------------------------------------

function proxyUpgrade(req, socket, head) {
  // Unhandled 'error' on the raw client socket (RST before/while the upstream
  // dials) would crash the process; absorb it — the close/teardown handlers
  // below own destruction.
  socket.on('error', () => {});
  req.on('error', () => {});

  // The bridge dials remotes with ?connection=<id> (browsers cannot set WS
  // handshake headers); normalize it onto the routing header and strip it
  // from the upstream URL so the remote gateway never sees the proxy-side id.
  try {
    const u0 = new URL(req.url, 'http://localhost');
    const connParam = u0.searchParams.get('connection');
    if (connParam && !req.headers['x-hermes-connection-id']) {
      req.headers['x-hermes-connection-id'] = connParam;
      u0.searchParams.delete('connection');
      req.url = u0.pathname + u0.search;
    }
  } catch {
    /* malformed URL → fall through to the normal path */
  }

  let route;
  try {
    route = resolveRoute(req);
  } catch (err) {
    const status = err.status || 502;
    try {
      socket.write(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Bad Request'}\r\nConnection: close\r\n\r\n`);
    } catch {
      /* socket already gone */
    }
    socket.destroy();
    return;
  }

  const target = route ? route.target : parseTarget();
  const mod = target.protocol === 'https:' ? https : http;

  // Remote upgrades carry ?connection=<id>; the token is injected HERE
  // (server-side) and must not be part of the same-origin URL the browser
  // sees. Local upgrades keep the client's URL verbatim (ticket path).
  let upstreamPath = req.url;
  let upstreamHeaders;
  if (route) {
    const u = new URL(req.url, 'http://localhost');
    u.searchParams.set('token', route.conn.token || '');
    upstreamPath = route.target.basePath + u.pathname + u.search;
    upstreamHeaders = remoteUpstreamHeaders(req.headers, target, route.conn, parseTarget().host);
  } else {
    upstreamHeaders = upgradeHeaders(req, target);
  }

  const upstream = mod.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: upstreamPath,
    headers: upstreamHeaders,
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.setNoDelay(true);
    upSocket.setNoDelay(true);
    upSocket.on('error', () => {});

    // node's raw 'upgrade' event does not write the handshake reply — the
    // proxy must serialize the backend's 101 back to the client itself.
    try {
      socket.write(`HTTP/1.1 101 ${upRes.statusMessage || 'Switching Protocols'}\r\n`);
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n');
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (lk === 'connection' || lk === 'upgrade') continue;
        if (HOP_BY_HOP.has(lk)) continue;
        socket.write(`${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`);
      }
      socket.write('\r\n');

      // Forward any bytes already buffered on either side of the handshake.
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
    } catch {
      try {
        upSocket.destroy();
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }

    socket.pipe(upSocket);
    upSocket.pipe(socket);

    const teardown = () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      try {
        upSocket.destroy();
      } catch {
        /* ignore */
      }
    };
    socket.on('error', teardown);
    upSocket.on('error', teardown);
    socket.on('close', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());
  });

  // Backend rejected the upgrade (e.g. HTTP 403 auth failure). Mirror its
  // status + headers + body back to the client verbatim.
  upstream.on('response', (upRes) => {
    try {
      const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}\r\n`;
      socket.write(statusLine);
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        socket.write(`${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`);
      }
      socket.write('\r\n');
      upRes.pipe(socket);
    } catch {
      socket.destroy();
    }
  });

  upstream.on('error', (err) => {
    try {
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
        socket.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${String(err.code)}\n`);
      } else {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    } catch {
      /* socket gone */
    }
    socket.destroy();
  });

  upstream.end();
}

// ---------------------------------------------------------------------------
// Static serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Extensions that benefit from transport compression. Images and
// already-compressed formats are never compressed (wasted CPU, often larger
// output); everything here is text-like and wins from gzip/br.
// .woff2 is already brotli-compressed by the font tooling — compressing it
// again adds nothing and risks double-encoded responses, so it stays out.
const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.svg',
  '.txt', '.xml', '.md', '.markdown', '.ttf', '.otf', '.woff',
]);

// In-memory cache of on-the-fly compressed bodies so repeated requests for
// the same asset don't re-compress. Key: `${target}\0${encoding}`; entry:
// { mtimeMs, body }. Entries are validated against the source file's mtime
// and evicted (oldest first) once the cap is reached.
const COMPRESS_CACHE = new Map();
const COMPRESS_CACHE_MAX = 30;

// Parse Accept-Encoding. Returns 'br' | 'gzip' | null. Brotli is preferred
// when the client accepts both. An empty header or a bare '*' means "no
// preference" → no compression (a wildcard would otherwise match anything).
function acceptedEncoding(acceptEncoding) {
  if (!acceptEncoding || !String(acceptEncoding).trim()) return null;
  const header = String(acceptEncoding).toLowerCase().trim();
  if (header === '*') return null;
  const accepted = new Set();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';');
    const enc = name.trim();
    if (!enc) continue;
    let q = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)/.exec(p.trim());
      if (m) q = parseFloat(m[1]);
    }
    if (q > 0) accepted.add(enc);
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip') || accepted.has('x-gzip')) return 'gzip';
  return null;
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(DIST, rel);

  // Confine to DIST even if normalization was defeated.
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    filePath = path.join(DIST, 'index.html');
  }

  fs.stat(filePath, (statErr, stat) => {
    const target = !statErr && stat.isFile() ? filePath : path.join(DIST, 'index.html');
    const ext = path.extname(target).toLowerCase();
    const enc = acceptedEncoding(req.headers['accept-encoding']);
    const compressible = COMPRESSIBLE.has(ext);
    const baseHeaders = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control':
        ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    };

    const send = (body, headers) => {
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (!compressible || !enc) {
      // Raw path (or explicitly uncompressed): still Vary-marked for
      // compressible types so caches re-negotiate per Accept-Encoding.
      const headers = { ...baseHeaders };
      if (compressible) headers['Vary'] = 'Accept-Encoding';
      fs.readFile(target, (readErr, data) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        send(data, headers);
      });
      return;
    }

    // Compressible and client accepts an encoding: serve a precompressed
    // variant (<file>.gz / <file>.br) when present, else compress on the
    // fly with an mtime-keyed cache so repeats skip re-compression.
    // 'gzip' encoding ↔ '.gz' on disk; 'br' ↔ '.br'.
    const variant = target + (enc === 'br' ? '.br' : '.gz');
    fs.stat(variant, (variantErr, variantStat) => {
      if (!variantErr && variantStat.isFile()) {
        fs.readFile(variant, (readErr, data) => {
          if (readErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }
          send(data, {
            ...baseHeaders,
            'Vary': 'Accept-Encoding',
            'Content-Encoding': enc,
          });
        });
        return;
      }

      fs.stat(target, (targetErr, targetStat) => {
        const mtimeMs = targetErr ? 0 : targetStat.mtimeMs;
        const cacheKey = target + '\0' + enc;
        const hit = COMPRESS_CACHE.get(cacheKey);
        if (hit && hit.mtimeMs === mtimeMs) {
          send(hit.body, {
            ...baseHeaders,
            'Vary': 'Accept-Encoding',
            'Content-Encoding': enc,
          });
          return;
        }

        // Async zlib runs on the libuv threadpool, so a 19MB shiki chunk
        // does not block the event loop. Brotli q4 ≈ gzip speed.
        fs.readFile(target, (readErr, data) => {
          if (readErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }
          const finish = (compressErr, body) => {
            if (compressErr) {
              // Compression failed: fall back to raw bytes (still Vary'd).
              send(data, { ...baseHeaders, 'Vary': 'Accept-Encoding' });
              return;
            }
            if (COMPRESS_CACHE.size >= COMPRESS_CACHE_MAX) {
              COMPRESS_CACHE.delete(COMPRESS_CACHE.keys().next().value);
            }
            COMPRESS_CACHE.set(cacheKey, { mtimeMs, body });
            send(body, {
              ...baseHeaders,
              'Vary': 'Accept-Encoding',
              'Content-Encoding': enc,
            });
          };
          if (enc === 'br') {
            zlib.brotliCompress(
              data,
              { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
              finish
            );
          } else {
            zlib.gzip(data, finish);
          }
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Desktop-plugins door (web port)
// ---------------------------------------------------------------------------

// GET /api/plugins-door/list → { entries: [{name, path, isDirectory}] }
// Only folders containing a plugin.js are listed (the renderer loader probes
// readFileText and skips 404s, but pre-filtering keeps the door honest).
// GET /api/plugins-door/file?path=/plugins/<name>/plugin.js → { path, text }
// Path is strictly validated: no traversal, single segment, exact filename.
function servePluginsDoor(req, res) {
  const send = (status, obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    // Web port perf: plugin.js payloads are large JS-in-JSON (vietnamese-ui
    // 188KB raw). Compress when the client accepts it — same zero-dep zlib
    // approach as serveStatic, but only for the (potentially large) file
    // response; list responses stay tiny and uncompressed.
    const enc = acceptedEncoding(req.headers['accept-encoding']);
    if (enc && body.length > 1024) {
      try {
        if (enc === 'br') {
          res.writeHead(status, { ...headers, 'Content-Encoding': 'br', 'Vary': 'Accept-Encoding' });
          res.end(zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }));
        } else {
          res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
          res.end(zlib.gzipSync(body, { level: 9 }));
        }
        return;
      } catch {
        // Fall through to uncompressed on compress failure.
      }
    }
    res.writeHead(status, headers);
    res.end(body);
  };

  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    send(400, { error: 'bad_request' });
    return;
  }

  if (u.pathname === '/api/plugins-door/list') {
    let dirents = [];
    try {
      dirents = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    } catch {
      // No door yet — empty listing; the renderer's poll picks it up later.
    }
    const entries = dirents
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLUGINS_DIR, d.name, 'plugin.js')))
      .map((d) => ({ name: d.name, path: `/plugins/${d.name}`, isDirectory: true }));
    send(200, { entries });
    return;
  }

  if (u.pathname === '/api/plugins-door/file') {
    const virt = u.searchParams.get('path') || '';
    const m = /^\/plugins\/([^/]+)\/plugin\.js$/.exec(virt);
    if (!m) {
      send(400, { error: 'bad_path', detail: 'expected /plugins/<name>/plugin.js' });
      return;
    }
    const rootResolved = path.resolve(PLUGINS_DIR);
    const fileResolved = path.resolve(rootResolved, m[1], 'plugin.js');
    if (!fileResolved.startsWith(rootResolved + path.sep)) {
      send(400, { error: 'bad_path', detail: 'outside plugins root' });
      return;
    }
    fs.readFile(fileResolved, (err, data) => {
      if (err) {
        send(404, { error: 'not_found' });
        return;
      }
      send(200, { path: virt, text: data.toString('utf8') });
    });
    return;
  }

  send(404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// Web-fs door (web port) — filesystem access for the desktop Files rail
// ---------------------------------------------------------------------------

// Minimal extension→MIME map for data URLs (no deps).
const DATA_URL_MIME = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.csv': 'text/csv',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
};

function dataUrlMime(filePath) {
  return DATA_URL_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Resolve a requested path under WEB_FS_ROOT, rejecting traversal lexically.
function resolveWebFsPath(requestedPath) {
  const root = path.resolve(WEB_FS_ROOT);
  let p = requestedPath || '/';
  // Host→container path translation (docker): the gateway reports host paths
  // (e.g. /home/walos/G/work), but the container sees the bind-mounted
  // /workspace. Map the host root prefix onto the container root. Exact root
  // → '/' so an empty dir (the mounted home) resolves to the root itself.
  if (WEB_FS_HOST_ROOT) {
    const hostRoot = path.resolve(WEB_FS_HOST_ROOT);
    if (p === hostRoot) {
      // Empty string → path.resolve(root, '') === root (a '/' would be
      // treated as absolute and escape the root).
      p = '';
    } else if (p.startsWith(hostRoot + path.sep)) {
      // Slice the host prefix, then drop the leading separator so
      // path.resolve(root, rest) keeps the root (a leading '/' would make
      // the slice absolute and discard root).
      p = p.slice(hostRoot.length).replace(/^[/\\]+/, '');
    }
  }
  const target = path.resolve(root, p);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }
  return { root, target };
}

// Symlink-aware containment: the realpath of `p` must stay inside the realpath
// of the root. Returns the realpath, or null when missing/outside.
function realpathWithinRoot(p) {
  let rootReal;
  let real;
  try {
    rootReal = fs.realpathSync(WEB_FS_ROOT);
    real = fs.realpathSync(p);
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return null;
  }
  return real;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, cb) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 16 * 1024 * 1024) {
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      cb(null, body ? JSON.parse(body) : {});
    } catch {
      cb(new Error('bad_json'), null);
    }
  });
  req.on('error', () => cb(new Error('read_error'), null));
}

function serveWebFs(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams.get('path') || '';

  if (u.pathname === '/web-fs/list' && req.method === 'GET') {
    const r = resolveWebFsPath(q);
    if (!r) return sendJson(res, 400, { error: 'bad_path', detail: 'outside web-fs root' });
    const real = realpathWithinRoot(r.target);
    if (!real) return sendJson(res, 404, { error: 'not_found' });
    let dirents;
    try {
      dirents = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      return sendJson(res, 404, { error: 'not_found' });
    }
    const entries = dirents
      .filter((d) => d.isDirectory() || d.isFile() || d.isSymbolicLink())
      .map((d) => ({ name: d.name, path: path.join(r.target, d.name), isDirectory: d.isDirectory() }));
    return sendJson(res, 200, { entries });
  }

  if (u.pathname === '/web-fs/read-text' && req.method === 'GET') {
    const r = resolveWebFsPath(q);
    if (!r) return sendJson(res, 400, { error: 'bad_path' });
    const real = realpathWithinRoot(r.target);
    if (!real) return sendJson(res, 404, { error: 'not_found' });
    fs.readFile(real, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not_found' });
      sendJson(res, 200, { path: r.target, text: data.toString('utf8') });
    });
    return;
  }

  if (u.pathname === '/web-fs/read-data-url' && req.method === 'GET') {
    const r = resolveWebFsPath(q);
    if (!r) return sendJson(res, 400, { error: 'bad_path' });
    const real = realpathWithinRoot(r.target);
    if (!real) return sendJson(res, 404, { error: 'not_found' });
    fs.readFile(real, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not_found' });
      sendJson(res, 200, { dataUrl: `data:${dataUrlMime(real)};base64,${data.toString('base64')}` });
    });
    return;
  }

  if (u.pathname === '/web-fs/write-text' && req.method === 'POST') {
    readJsonBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'bad_body' });
      if (typeof body.path !== 'string' || typeof body.content !== 'string') {
        return sendJson(res, 400, { error: 'bad_body', detail: 'expected {path, content}' });
      }
      const r = resolveWebFsPath(body.path);
      if (!r) return sendJson(res, 400, { error: 'bad_path' });
      const parentReal = realpathWithinRoot(path.dirname(r.target));
      if (!parentReal) return sendJson(res, 400, { error: 'bad_path', detail: 'parent dir missing or outside root' });
      // Existing target (incl. dangling symlink) must not resolve outside the
      // root — otherwise writeFile would follow it and clobber a file there.
      try {
        fs.lstatSync(r.target);
        if (!realpathWithinRoot(r.target)) {
          return sendJson(res, 400, { error: 'bad_path', detail: 'target resolves outside web-fs root' });
        }
      } catch {
        // Nonexistent → brand-new file under the already-verified parent.
      }
      fs.writeFile(r.target, body.content, 'utf8', (werr) => {
        if (werr) return sendJson(res, 500, { error: 'write_failed', detail: werr.message });
        sendJson(res, 200, { path: r.target });
      });
    });
    return;
  }

  if (u.pathname === '/web-fs/git-root' && req.method === 'GET') {
    const r = resolveWebFsPath(q);
    if (!r) return sendJson(res, 400, { error: 'bad_path' });
    let dir = realpathWithinRoot(r.target);
    if (!dir) {
      // Non-existent path (e.g. an unsaved new file): walk up from its parent.
      const pr = resolveWebFsPath(path.dirname(q) || '/');
      dir = pr ? realpathWithinRoot(pr.target) : null;
    }
    if (!dir) return sendJson(res, 200, { root: null });
    let cur = dir;
    for (;;) {
      if (fs.existsSync(path.join(cur, '.git'))) return sendJson(res, 200, { root: cur });
      const next = path.dirname(cur);
      if (next === cur || !realpathWithinRoot(next)) break;
      cur = next;
    }
    return sendJson(res, 200, { root: null });
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// Interactive terminal (web port) — real PTY via node-pty over WS /web-term
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Minimal RFC6455 server-side connection: text frames in/out, ping→pong, and a
// close handshake. Enough for a terminal; no external `ws` dependency.
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragments = [];
    this.closed = false;
    this.closeEmitted = false;
    this.onMessage = null;
    this.onClose = null;
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this._notifyClose());
  }

  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this._parseFrame()) {
      /* consume frames until one is incomplete */
    }
  }

  _parseFrame() {
    const buf = this.buf;
    if (buf.length < 2) return false;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._notifyClose();
        try { this.socket.destroy(); } catch {}
        return false;
      }
      len = Number(big);
      offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return false;
    const payload = buf.slice(offset, offset + len);
    this.buf = buf.slice(offset + len);
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this._dispatch(opcode, fin, payload);
    return true;
  }

  _dispatch(opcode, fin, payload) {
    if (opcode === 0x8) {
      this._sendFrame(0x8, payload.slice(0, 125));
      this._notifyClose();
      try { this.socket.destroy(); } catch {}
      return;
    }
    if (opcode === 0x9) {
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x1) {
        this.fragOpcode = 0x1;
        this.fragments = [];
      }
      if (this.fragOpcode !== 0x1) return;
      this.fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.fragOpcode = 0;
        if (this.onMessage) this.onMessage(text);
      }
    }
  }

  sendText(str) {
    if (this.closed) return;
    this._sendFrame(0x1, Buffer.from(str, 'utf8'));
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {}
  }

  _notifyClose() {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  close() {
    if (this.closed) return;
    this._sendFrame(0x8, Buffer.alloc(0));
    this._notifyClose();
    try { this.socket.destroy(); } catch {}
  }
}

function handleTermUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const ws = new WsConn(socket);
  if (head && head.length) ws._feed(head);

  let ptyMod;
  try {
    ptyMod = require('node-pty');
  } catch {
    ws.sendText(JSON.stringify({ type: 'exit', code: 1, signal: null }));
    ws.close();
    return;
  }

  const u = new URL(req.url, 'http://localhost');
  const shell = process.env.SHELL || '/bin/bash';
  const cwdRaw = u.searchParams.get('cwd') || TERM_DEFAULT_CWD;
  const cols = Math.max(2, Math.floor(Number(u.searchParams.get('cols'))) || 80);
  const rows = Math.max(1, Math.floor(Number(u.searchParams.get('rows'))) || 24);

  let cwd = cwdRaw;
  try {
    if (!fs.statSync(cwd).isDirectory()) cwd = TERM_DEFAULT_CWD;
  } catch {
    cwd = TERM_DEFAULT_CWD;
  }

  let term;
  try {
    term = ptyMod.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  } catch {
    ws.sendText(JSON.stringify({ type: 'exit', code: 1, signal: null }));
    ws.close();
    return;
  }

  ws.onMessage = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      try {
        term.resize(Math.max(2, Math.floor(msg.cols)), Math.max(1, Math.floor(msg.rows)));
      } catch {}
    }
  };

  ws.onClose = () => {
    try { term.kill(); } catch {}
  };

  term.onData((data) => ws.sendText(JSON.stringify({ type: 'output', data })));
  term.onExit(({ exitCode, signal }) => {
    ws.sendText(JSON.stringify({ type: 'exit', code: exitCode, signal: signal ?? null }));
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// Server-side settings store
// ---------------------------------------------------------------------------
// Durable UI preferences (theme, mode, plugin decisions, user themes) that the
// renderer mirrors so they follow the user across devices. Shape: a flat JSON
// object of localStorage key → string value, exactly as the renderer stores
// them. GET returns the whole store; PUT merges the incoming object.

function readSettingsStore() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function serveSettings(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(readSettingsStore()));
    return;
  }

  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let incoming = {};
      try {
        incoming = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }
      if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected_object' }));
        return;
      }
      // Value whitelist: only plain strings are accepted (localStorage values).
      const merged = { ...readSettingsStore() };
      for (const [k, v] of Object.entries(incoming)) {
        if (typeof v === 'string' && k.length < 256 && v.length < 4 * 1024 * 1024) {
          merged[k] = v;
        }
      }
      try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(merged));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'write_failed', detail: String(err.message || err) }));
      }
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, PUT' });
  res.end(JSON.stringify({ error: 'method_not_allowed' }));
}

// ---------------------------------------------------------------------------
// Connections registry door (web port) — the v2 multi-connection registry
// ---------------------------------------------------------------------------
// Served BY the proxy (local, never forwarded — must precede the generic
// /api/* forward). Tokens/header values never cross to the browser:
//   GET    /web-connections             → redacted registry
//   PUT    /web-connections             → save/upsert (accepts plaintext)
//   DELETE /web-connections/<id>        → remove (retarget primary to local)
//   POST   /web-connections/<id>/primary→ set primary
//   POST   /web-connections/<id>/test   → proxy probes <url>/api/status
//
// Probe flow: the proxy performs the HTTP call (the browser can't — CORS +
// the token never leaves the server). GET <url>/api/status is public
// (unauthenticated); auth errors (401/403) mean the gateway is up but the
// stored token is wrong/absent.

function serveConnections(req, res) {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/web-connections') {
    if (req.method === 'GET') {
      sendJson(res, 200, connectionsStore.list());
      return;
    }
    if (req.method === 'PUT') {
      readJsonBody(req, (err, body) => {
        if (err) return sendJson(res, 400, { error: 'bad_body', detail: String(err && err.message || err) });
        try {
          const result = connectionsStore.save(body);
          sendJson(res, 200, result);
        } catch (saveErr) {
          sendJson(res, saveErr.status || 500, { error: saveErr.message || String(saveErr) });
        }
      });
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed', Allow: 'GET, PUT' });
    return;
  }

  const m = /^\/web-connections\/([^/]+)(?:\/(primary|test))?$/.exec(u.pathname);
  if (!m) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const id = decodeURIComponent(m[1]);
  const action = m[2] || null;

  if (action === null && req.method === 'DELETE') {
    try {
      sendJson(res, 200, connectionsStore.remove(id));
    } catch (removeErr) {
      sendJson(res, removeErr.status || 500, { error: removeErr.message || String(removeErr) });
    }
    return;
  }

  if (action === 'primary' && req.method === 'POST') {
    try {
      sendJson(res, 200, connectionsStore.setPrimary(id));
    } catch (primaryErr) {
      sendJson(res, primaryErr.status || 500, { error: primaryErr.message || String(primaryErr) });
    }
    return;
  }

  if (action === 'test' && req.method === 'POST') {
    const conn = connectionsStore.get(id);
    if (!conn) {
      sendJson(res, 404, { error: `no connection with id "${id}"` });
      return;
    }
    testConnection(conn)
      .then((result) => sendJson(res, 200, result))
      .catch((testErr) => sendJson(res, 502, { error: 'test_failed', detail: String(testErr && testErr.message || testErr) }));
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed', Allow: 'DELETE, POST' });
}

// Probe one remote gateway: GET <url>/api/status (public). Reachable = the
// gateway answered; ok = the stored token authenticated (401/403 → token
// wrong/absent but host reachable).
function testConnection(conn) {
  const target = parseRemoteTarget(conn.url);
  const mod = target.protocol === 'https:' ? https : http;
  const headers = { Host: target.host };
  if (conn.token) headers['X-Hermes-Session-Token'] = conn.token;
  if (Array.isArray(conn.headers)) {
    for (const h of conn.headers) {
      if (h && h.name) headers[h.name] = String(h.value ?? '');
    }
  }

  return new Promise((resolve) => {
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.basePath}/api/status`,
        method: 'GET',
        headers,
        timeout: 10_000,
      },
      (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          let status = null;
          try {
            status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* non-JSON body — still reachable */
          }
          const authFailed = upRes.statusCode === 401 || upRes.statusCode === 403;
          const result = {
            ok: upRes.statusCode >= 200 && upRes.statusCode < 300,
            reachable: true,
            error: authFailed
              ? `gateway reachable but auth failed (HTTP ${upRes.statusCode})`
              : upRes.statusCode >= 400
                ? `gateway answered HTTP ${upRes.statusCode}`
                : null,
          };
          if (status && typeof status === 'object') {
            if (typeof status.version === 'string') result.version = status.version;
            if (typeof status.install_id === 'string' && status.install_id) {
              result.installId = status.install_id;
              // Remember the last-known backend identity for the dedup hint.
              try {
                const registry = connectionsStore.loadRegistry();
                const stored = registry.connections.find((c) => c.id === conn.id);
                if (stored && stored.installId !== status.install_id) {
                  stored.installId = status.install_id;
                  connectionsStore.saveRegistry(registry);
                }
              } catch {
                /* best-effort */
              }
            }
          }
          resolve(result);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reachable: false, error: 'timed out probing gateway', version: null });
    });
    req.on('error', (err) => {
      resolve({
        ok: false,
        reachable: false,
        error: err.code === 'ECONNREFUSED' ? 'connection refused' : String(err.message || err),
        version: null,
      });
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// VS Code Marketplace door
// ---------------------------------------------------------------------------
// The renderer's theme marketplace used to be Electron-main-only
// (window.hermesDesktop.themes); in the web port the proxy performs the
// HTTPS calls (gallery search + .vsix download/zip extract) so the browser
// never hits CORS or size limits. Endpoints:
//   GET /api/marketplace/search?q=<query>&limit=<n>
//   GET /api/marketplace/fetch?id=<publisher.extension>

const marketplace = require('./marketplace');

function serveMarketplace(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const respond = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (u.pathname.endsWith('/search')) {
    const q = u.searchParams.get('q') || '';
    const limit = Number(u.searchParams.get('limit')) || 20;
    marketplace
      .searchMarketplaceThemes(q, limit)
      .then((items) => respond(200, { items }))
      .catch((err) => respond(502, { error: 'marketplace_search_failed', detail: String(err.message || err) }));
    return;
  }

  if (u.pathname.endsWith('/fetch')) {
    const id = u.searchParams.get('id') || '';
    marketplace
      .fetchMarketplaceThemes(id)
      .then((result) => respond(200, result))
      .catch((err) => respond(502, { error: 'marketplace_fetch_failed', detail: String(err.message || err) }));
    return;
  }

  respond(404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // Web-fs door: filesystem for the desktop Files rail (local, same-origin).
  if (req.url.startsWith('/web-fs/')) {
    serveWebFs(req, res);
    return;
  }
  // Connections registry door (multi-gateway CRUD + test probe) — local, not
  // forwarded; secrets stay server-side.
  if (req.url.startsWith('/web-connections')) {
    serveConnections(req, res);
    return;
  }
  // Server-side settings store (theme/plugin prefs follow the user across
  // devices) — local, not forwarded.
  if (req.url.startsWith('/web-settings')) {
    serveSettings(req, res);
    return;
  }
  // VS Code Marketplace door — served BY the proxy (browser-safe HTTPS), not
  // forwarded. Must come before the generic /api/* forward.
  if (req.url.startsWith('/api/marketplace/')) {
    serveMarketplace(req, res);
    return;
  }
  // The plugins door is served BY the proxy (it is the web port's "local
  // disk") — must be intercepted before the generic /api/* forward.
  if (req.url.startsWith('/api/plugins-door/')) {
    servePluginsDoor(req, res);
    return;
  }
  // /api/* AND /auth/* — v0.20.0 routes login/logout under /auth/, and the
  // whole point is same-origin cookie passthrough. Everything else is static.
  if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
    proxyHttp(req, res);
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  // Interactive terminal: terminate locally (real PTY), never forwarded.
  if (pathname === '/web-term') {
    handleTermUpgrade(req, socket, head);
    return;
  }
  if (!req.url.startsWith('/api/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // Remote gateways dial through ?connection=<id> (token injected server-side);
  // no param → the local HERMES_TARGET ticket path, unchanged.
  proxyUpgrade(req, socket, head);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[hermes-web proxy] http://127.0.0.1:${PORT} → ${TARGET_RAW}`);
});
