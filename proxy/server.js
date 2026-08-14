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
const path = require('path');

const PORT = Number(process.env.PORT) || 4000;
const TARGET_RAW = process.env.HERMES_TARGET || '127.0.0.1:9119';

const DIST = path.resolve(__dirname, '..', 'web', 'dist');

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
  const target = parseTarget();
  const mod = target.protocol === 'https:' ? https : http;

  const upstream = mod.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: forwardHeaders(req.headers, target),
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
  const target = parseTarget();
  const mod = target.protocol === 'https:' ? https : http;

  const upstream = mod.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: upgradeHeaders(req, target),
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.setNoDelay(true);
    upSocket.setNoDelay(true);

    // node's raw 'upgrade' event does not write the handshake reply — the
    // proxy must serialize the backend's 101 back to the client itself.
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
    const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}\r\n`;
    socket.write(statusLine);
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      socket.write(`${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`);
    }
    socket.write('\r\n');
    upRes.pipe(socket);
  });

  upstream.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
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
    fs.readFile(target, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control':
          ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(data);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // /api/* AND /auth/* — v0.20.0 routes login/logout under /auth/, and the
  // whole point is same-origin cookie passthrough. Everything else is static.
  if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
    proxyHttp(req, res);
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/api/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket, head);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[hermes-web proxy] http://127.0.0.1:${PORT} → ${TARGET_RAW}`);
});
