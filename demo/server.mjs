// Hosted-demo edge server (no dependencies): serves the built Angular console and proxies the
// core and API over the SAME origin, so the browser never needs a loopback URL.
//   /core/*     -> 127.0.0.1:8081 (prefix stripped)
//   /api/*      -> 127.0.0.1:3000 (prefix stripped)
//   /authorize*, /token, /jwks.json, /.well-known/* -> 127.0.0.1:8081 (IdP form posts relatively)
//   /healthz    -> 200 (platform health check)
// Everything else falls back to index.html (Angular client routes, e.g. /callback).
import http from 'node:http';
import { framingHeaders } from './frame-policy.mjs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const WEB_ROOT = process.env.WEB_ROOT ?? '/app/web/dist/web/browser';
const CORE = { host: '127.0.0.1', port: Number(process.env.IAM_CORE_PORT ?? 8081) };
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 3000) };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };

function proxy(req, res, target, strip) {
  const path = strip ? req.url.replace(/^\/(core|api)/, '') || '/' : req.url;
  const upstream = http.request({ host: target.host, port: target.port, path, method: req.method, headers: { ...req.headers, host: `${target.host}:${target.port}`, 'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http' }, timeout: 15000 }, (u) => {
    res.writeHead(u.statusCode ?? 502, u.headers);
    u.pipe(res);
  });
  upstream.on('timeout', () => { upstream.destroy(); if (!res.headersSent) res.writeHead(504); res.end('upstream timeout'); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream unavailable'); });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (/^\/(api|core)\/internal(?:\/|$)/i.test(p)) { res.writeHead(404); return res.end('not found'); }
  try {
    if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (p === '/core' || p.startsWith('/core/')) return proxy(req, res, CORE, true);
    if (p === '/api' || p.startsWith('/api/')) {
      // The admin capability token lives only server-side: the edge attaches it to proxied API calls so
      // signed-in demo visitors can use simulation / plugin admin without ever seeing the secret.
      if (process.env.IAM_API_ADMIN_TOKEN) req.headers['x-api-admin-token'] = process.env.IAM_API_ADMIN_TOKEN;
      return proxy(req, res, API, true);
    }
    if (p === '/authorize' || p === '/authorize/login' || p === '/token' || p === '/jwks.json' || p.startsWith('/.well-known/')) return proxy(req, res, CORE, false);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    const safe = normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = join(WEB_ROOT, safe === '/' ? 'index.html' : safe);
    let data, ext = extname(file);
    try { data = await readFile(file); }
    catch { data = await readFile(join(WEB_ROOT, 'index.html')); ext = '.html'; } // SPA fallback
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600', ...(ext === '.html' ? framingHeaders(p, url.search) : {}) });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end('demo server error');
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`demo edge listening on 0.0.0.0:${PORT} (web root ${WEB_ROOT})`));
