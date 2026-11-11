// Hosted-demo edge server (no dependencies): serves the built Angular console and proxies the
// core and API over the SAME origin, so the browser never needs a loopback URL.
//   /core/*     -> 127.0.0.1:8081 (prefix stripped)
//   /api/*      -> 127.0.0.1:3000 (prefix stripped)
//   /authorize*, /token, /jwks.json, /.well-known/* -> 127.0.0.1:8081 (IdP form posts relatively)
//   /healthz    -> 200 (platform health check)
// Session cookie (docs/session.md): a successful token exchange or renewal also stores the token in an
// HttpOnly, SameSite=Lax cookie, so a DOCUMENT request (which never carries Authorization) shows the
// session to the server-side render. The cookie is the durable copy; the console keeps only its in-memory
// token and re-reads it through GET /session/bootstrap (custom header required, so no cross-site page can
// pull it). API calls keep their Bearer header: the cookie never authenticates a write, so no CSRF surface
// is added. POST /session/logout clears the cookie.
// GET / redirects to the server-rendered sign-in page (anonymous) or to /my-applications (cookie present),
// so the first HTML is always the right page instead of a SPA bootstrap bouncing client-side.
// Everything else goes to the Angular SSR server (127.0.0.1:4000): it serves the static assets and renders
// /login and /my-applications server-side; the other routes stay client-rendered.
import http from 'node:http';
import { framingHeaders } from './frame-policy.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const CORE = { host: '127.0.0.1', port: Number(process.env.IAM_CORE_PORT ?? 8081) };
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 3000) };
const SSR = { host: '127.0.0.1', port: Number(process.env.SSR_PORT ?? 4000) };
// The gate may legitimately use its 30 s budget on the free tier. The edge must not cut it at 15 s.
const signinTimeoutMs = (path, env = process.env) => /^\/(?:core\/)?authorize(?:\/login)?$/.test(path) ? Math.max(15000, Number(env.IAM_GATE_TIMEOUT_MS) || 30000) + 15000 : 15000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const SESSION_COOKIE = 'iam_session';
const secureCookie = (env = process.env) => env.IAM_SESSION_COOKIE_INSECURE !== '1';
const parseCookies = (req) => {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
};
/** The token's own exp (seconds), or null when unreadable: the cookie's Max-Age follows the session length. */
const tokenExp = (t) => { try { const p = JSON.parse(Buffer.from(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return typeof p.exp === 'number' && Number.isFinite(p.exp) ? p.exp : null; } catch { return null; } };
const sessionCookie = (token) => {
  const exp = tokenExp(token), maxAge = exp === null ? undefined : Math.max(0, exp - Math.floor(Date.now() / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
};
const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}; Max-Age=0`;

/** Proxy for the token endpoints: buffers the (small) JSON answer to attach the session cookie on success. */
function proxySessionIssue(req, res, target, strip, timeoutMs = 15000) {
  const path = strip ? req.url.replace(/^\/(core|api)/, '') || '/' : req.url;
  const upstream = http.request({ host: target.host, port: target.port, path, method: req.method, headers: { ...req.headers, host: `${target.host}:${target.port}`, 'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http' }, timeout: timeoutMs }, (u) => {
    const chunks = [];
    u.on('data', (c) => chunks.push(c));
    u.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...u.headers };
      try {
        const json = JSON.parse(body.toString('utf8'));
        if ((u.statusCode ?? 500) < 300 && typeof json.id_token === 'string') {
          const prev = headers['set-cookie'];
          headers['set-cookie'] = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), sessionCookie(json.id_token)];
        }
      } catch { /* not a JSON token answer: forwarded untouched */ }
      res.writeHead(u.statusCode ?? 502, headers);
      res.end(body);
    });
  });
  upstream.on('timeout', () => { upstream.destroy(); if (!res.headersSent) res.writeHead(504); res.end('upstream timeout'); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream unavailable'); });
  req.pipe(upstream);
}

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
    // Console session endpoints (docs/session.md). The custom header keeps cross-site pages out; SameSite=Lax
    // already keeps the cookie off subresource requests, so the token only ever reaches same-origin fetch.
    if (p === '/session/bootstrap') {
      if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') { res.writeHead(403); return res.end('forbidden'); }
      const token = parseCookies(req)[SESSION_COOKIE], exp = token ? tokenExp(token) : null;
      if (!token || (exp !== null && exp * 1000 <= Date.now())) { res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ error: 'no_session' })); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ id_token: token }));
    }
    if (p === '/session/logout') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('method not allowed'); }
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') { res.writeHead(403); return res.end('forbidden'); }
      res.writeHead(204, { 'set-cookie': clearSessionCookie() });
      return res.end();
    }
    if (p === '/core' || p.startsWith('/core/')) {
      if (req.method === 'POST' && (p === '/core/token' || p === '/core/session/extend')) return proxySessionIssue(req, res, CORE, true, signinTimeoutMs(p));
      return proxy(req, res, CORE, true, undefined, signinTimeoutMs(p));
    }
    if (p === '/api' || p.startsWith('/api/')) {
      // The admin capability token lives only server-side: the edge attaches it to proxied API calls so
      // signed-in demo visitors can use simulation / plugin admin without ever seeing the secret.
      if (process.env.IAM_API_ADMIN_TOKEN) req.headers['x-api-admin-token'] = process.env.IAM_API_ADMIN_TOKEN;
      return proxy(req, res, API, true);
    }
    // /authorize and everything under it (login post, theme toggle, the passkey ceremony script
    // /authorize/webauthn.js): an exact-match here once sent the ceremony script to the SPA, which
    // answered HTML, the browser refused it as a script, and "Use my passkey" did nothing.
    if (p === '/authorize' || p.startsWith('/authorize/') || p === '/jwks.json' || p.startsWith('/.well-known/')) return proxy(req, res, CORE, false, undefined, signinTimeoutMs(p));
    if (p === '/token') {
      if (req.method === 'POST') return proxySessionIssue(req, res, CORE, false, signinTimeoutMs(p));
      return proxy(req, res, CORE, false, undefined, signinTimeoutMs(p));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    // The console home is guarded. Anonymous: straight to the server-rendered sign-in page (the methods list
    // is in the first HTML). With a session cookie: straight to the server-rendered launchpad. Both avoid the
    // SPA bootstrap bouncing client-side.
    const session = parseCookies(req)[SESSION_COOKIE];
    if (p === '/') { res.writeHead(302, { location: `${session ? '/my-applications' : '/login'}${url.search}` }); return res.end(); }
    // Same decision at the two document routes themselves: /login with a live session goes to the console
    // (a query string - sign-in preview, branch test - still renders the page), /my-applications without a
    // session goes to sign-in.
    if (p === '/login' && session && !url.search) { res.writeHead(302, { location: '/my-applications' }); return res.end(); }
    if (p === '/my-applications' && !session) { res.writeHead(302, { location: `/login${url.search}` }); return res.end(); }
    // The SSR render waits for the API options; a cold Dolt can need ~30 s on the first hit, well over the default proxy timeout.
    return proxy(req, res, SSR, false, () => ({ 'cache-control': 'no-store', ...framingHeaders(p, url.search) }), 75000);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end('demo server error');
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`demo edge listening on 0.0.0.0:${PORT} (SSR upstream ${SSR.host}:${SSR.port})`));
