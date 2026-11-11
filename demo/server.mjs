// Hosted-demo edge server (no dependencies): serves the built Angular console and proxies the
// core and API over the SAME origin, so the browser never needs a loopback URL.
//   /core/*     -> 127.0.0.1:8081 (prefix stripped)
//   /api/*      -> 127.0.0.1:3000 (prefix stripped)
//   /authorize*, /token, /jwks.json, /.well-known/* -> 127.0.0.1:8081 (IdP form posts relatively)
//   /healthz    -> 200 (platform health check)
// Everything else goes to the Angular SSR server (127.0.0.1:4000): it serves the static assets and renders
// /login server-side (the methods list is in the first HTML); the other routes stay client-rendered.
import http from 'node:http';
import { framingHeaders } from './frame-policy.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const CORE = { host: '127.0.0.1', port: Number(process.env.IAM_CORE_PORT ?? 8081) };
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 3000) };
const SSR = { host: '127.0.0.1', port: Number(process.env.SSR_PORT ?? 4000) };
// The gate may legitimately use its 30 s budget on the free tier. The edge must not cut it at 15 s.
const signinTimeoutMs = (path, env = process.env) => /^\/(?:core\/)?authorize(?:\/login)?$/.test(path) ? Math.max(15000, Number(env.IAM_GATE_TIMEOUT_MS) || 30000) + 15000 : 15000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };

function proxy(req, res, target, strip, htmlHeaders, timeoutMs = 15000) {
  const path = strip ? req.url.replace(/^\/(core|api)/, '') || '/' : req.url;
  const upstream = http.request({ host: target.host, port: target.port, path, method: req.method, headers: { ...req.headers, host: `${target.host}:${target.port}`, 'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http' }, timeout: timeoutMs }, (u) => {
    const headers = { ...u.headers };
    // Page responses keep the edge's policy headers (frame rules, no HTML caching): they stay the edge's job.
    if (htmlHeaders && /text\/html/i.test(String(u.headers['content-type'] ?? ''))) Object.assign(headers, htmlHeaders());
    res.writeHead(u.statusCode ?? 502, headers);
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
    if (p === '/core' || p.startsWith('/core/')) return proxy(req, res, CORE, true, undefined, signinTimeoutMs(p));
    if (p === '/api' || p.startsWith('/api/')) {
      // The admin capability token lives only server-side: the edge attaches it to proxied API calls so
      // signed-in demo visitors can use simulation / plugin admin without ever seeing the secret.
      if (process.env.IAM_API_ADMIN_TOKEN) req.headers['x-api-admin-token'] = process.env.IAM_API_ADMIN_TOKEN;
      return proxy(req, res, API, true);
    }
    // /authorize and everything under it (login post, theme toggle, the passkey ceremony script
    // /authorize/webauthn.js): an exact-match here once sent the ceremony script to the SPA, which
    // answered HTML, the browser refused it as a script, and "Use my passkey" did nothing.
    if (p === '/authorize' || p.startsWith('/authorize/') || p === '/token' || p === '/jwks.json' || p.startsWith('/.well-known/')) return proxy(req, res, CORE, false, undefined, signinTimeoutMs(p));
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    // The SSR render waits for the API options; a cold Dolt can need ~30 s on the first hit, well over the default proxy timeout.
    return proxy(req, res, SSR, false, () => ({ 'cache-control': 'no-store', ...framingHeaders(p, url.search) }), 75000);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end('demo server error');
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`demo edge listening on 0.0.0.0:${PORT} (SSR upstream ${SSR.host}:${SSR.port})`));
