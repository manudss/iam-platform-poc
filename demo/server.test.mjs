// Routing contract of the hosted-demo edge, tested against the real server with stub upstreams.
// Regression: /authorize/webauthn.js (the passkey ceremony script) and /authorize/theme fell through
// to the Angular app because the rule matched only '/authorize' and '/authorize/login' exactly. The
// SPA answered HTML with a 200, the browser refused to run it as a script, and the hosted
// "Use my passkey" button did nothing (local dev proxies by prefix, so only the hosted path broke).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const stub = (name) => new Promise((ok) => {
  const s = http.createServer((req, res) => {
    const type = name === 'core' && req.url === '/authorize/webauthn.js' ? 'text/javascript; charset=utf-8' : 'text/plain';
    res.writeHead(200, { 'content-type': type });
    res.end(`${name} ${req.method} ${req.url}`);
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const req = (port, method, path, headers = {}, body) => new Promise((ok, ko) => {
  const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], location: res.headers['location'], cookies: [res.headers['set-cookie'] ?? []].flat(), body: b })); });
  r.on('error', ko);
  r.end(body);
});

test('the edge routes the core, API and SPA paths to the right upstream', async () => {
  const [core, api, ssr] = await Promise.all([stub('core'), stub('api'), stub('ssr')]);
  const edgePort = await freePort();
  const edge = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: { ...process.env, PORT: String(edgePort), IAM_CORE_PORT: String(core.address().port), API_PORT: String(api.address().port), SSR_PORT: String(ssr.address().port) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req(edgePort, 'GET', '/healthz'); if (h.status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

    // The whole sign-in surface belongs to the core, assets included.
    for (const [method, path] of [
      ['GET', '/authorize?client_id=demo-web&response_type=code'],
      ['POST', '/authorize/login'],
      ['GET', '/authorize/webauthn.js'],
      ['GET', '/authorize/theme?mode=dark&back=%2Fauthorize'],
      ['POST', '/token'],
      ['GET', '/jwks.json'],
      ['GET', '/.well-known/openid-configuration'],
    ]) {
      const r = await req(edgePort, method, path);
      assert.equal(r.status, 200, `${method} ${path}`);
      assert.ok(r.body.startsWith('core '), `${method} ${path} must reach the core, got: ${r.body}`);
    }
    // The ceremony script keeps its JavaScript MIME type: a text/html answer is what broke the hosted passkey button.
    const js = await req(edgePort, 'GET', '/authorize/webauthn.js');
    assert.match(js.type, /^text\/javascript/, 'the passkey ceremony script must be served as JavaScript, not HTML');

    // API and SPA keep their routes.
    assert.ok((await req(edgePort, 'GET', '/api/health')).body.startsWith('api '), '/api goes to the API');
    assert.ok((await req(edgePort, 'GET', '/login')).body.startsWith('ssr '), '/login goes to the SSR app');
    assert.ok((await req(edgePort, 'GET', '/overview')).body.startsWith('ssr '), 'other pages go to the SSR app');

    // Internal upstreams stay unreachable, and the SPA never takes posts.
    assert.equal((await req(edgePort, 'GET', '/api/internal/plugins')).status, 404);
    assert.equal((await req(edgePort, 'GET', '/core/internal/plugins')).status, 404);
    assert.equal((await req(edgePort, 'POST', '/login')).status, 405);
  } finally {
    edge.kill('SIGKILL');
    for (const s of [core, api, ssr]) s.close();
  }
});

test('GET / redirects to the server-rendered sign-in page, keeping the query string', async () => {
  const [core, api, ssr] = await Promise.all([stub('core'), stub('api'), stub('ssr')]);
  const edgePort = await freePort();
  const edge = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: { ...process.env, PORT: String(edgePort), IAM_CORE_PORT: String(core.address().port), API_PORT: String(api.address().port), SSR_PORT: String(ssr.address().port) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req(edgePort, 'GET', '/healthz'); if (h.status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    // The anonymous landing must reach the sign-in page server-side: no client-side bounce, no "Loading..." flash.
    const root = await req(edgePort, 'GET', '/');
    assert.equal(root.status, 302);
    assert.equal(root.location, '/login');
    const withQuery = await req(edgePort, 'GET', '/?branch=personal%2Falice&ticket=abcdefghij');
    assert.equal(withQuery.status, 302);
    assert.equal(withQuery.location, '/login?branch=personal%2Falice&ticket=abcdefghij');
    assert.equal((await req(edgePort, 'HEAD', '/')).status, 302, 'health checks over HEAD follow the same rule');
    // The redirect target itself keeps proxying to the SSR app.
    assert.ok((await req(edgePort, 'GET', '/login')).body.startsWith('ssr '), '/login still goes to the SSR app');
  } finally {
    edge.kill('SIGKILL');
    for (const s of [core, api, ssr]) s.close();
  }
});

test('session cookie: issued at the token exchange, refreshed at renewal, cleared at sign-out', async () => {
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: 'demo-alice', exp })).toString('base64url')}.s`;
  const core = http.createServer((rq, res) => {
    if (rq.method === 'POST' && (rq.url === '/token' || rq.url === '/session/extend')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id_token: jwt, expires_in: 1800 }));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`core ${rq.method} ${rq.url}`);
  });
  await new Promise((ok) => core.listen(0, '127.0.0.1', ok));
  const ssr = await Promise.resolve().then(() => new Promise((ok) => { const s = http.createServer((rq, res) => res.end(`ssr ${rq.method} ${rq.url}`)); s.listen(0, '127.0.0.1', () => ok(s)); }));
  const edgePort = await freePort();
  const edge = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: { ...process.env, PORT: String(edgePort), IAM_CORE_PORT: String(core.address().port), SSR_PORT: String(ssr.address().port) }, stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await req(edgePort, 'GET', '/healthz')).status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

    // The token exchange (console path /core/token, and the IdP-relative /token) sets the HttpOnly session cookie.
    for (const path of ['/core/token', '/token', '/core/session/extend']) {
      const r = await req(edgePort, 'POST', path, { 'content-type': 'application/json' }, '{}');
      assert.equal(r.status, 200, `${path}`);
      const cookie = r.cookies.find((c) => c.startsWith('iam_session='));
      assert.ok(cookie, `${path} must set the session cookie`);
      assert.ok(cookie.includes(`iam_session=${jwt}`), `${path} cookie carries the token`);
      assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && cookie.includes('Secure') && cookie.includes('Path=/'), `${path} cookie attributes: ${cookie}`);
      const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
      assert.ok(maxAge > 1700 && maxAge <= 1800, `${path} cookie follows the token lifetime: ${cookie}`);
      assert.deepEqual(JSON.parse(r.body).id_token, jwt, 'the token answer itself is unchanged');
    }

    // Sign-out clears the cookie (and refuses cross-site posts without the custom header).
    assert.equal((await req(edgePort, 'POST', '/session/logout')).status, 403);
    const out = await req(edgePort, 'POST', '/session/logout', { 'x-requested-with': 'XMLHttpRequest' });
    assert.equal(out.status, 204);
    assert.ok(out.cookies.some((c) => c.startsWith('iam_session=;') && c.includes('Max-Age=0')), `sign-out clears the cookie: ${out.cookies}`);

    // Bootstrap re-reads the session for the console: custom header required, expired cookies refused.
    assert.equal((await req(edgePort, 'GET', '/session/bootstrap')).status, 403);
    assert.equal((await req(edgePort, 'GET', '/session/bootstrap', { 'x-requested-with': 'XMLHttpRequest' })).status, 401);
    const boot = await req(edgePort, 'GET', '/session/bootstrap', { 'x-requested-with': 'XMLHttpRequest', cookie: `iam_session=${jwt}` });
    assert.equal(boot.status, 200);
    assert.equal(JSON.parse(boot.body).id_token, jwt);
    const stale = `h.${Buffer.from(JSON.stringify({ sub: 'demo-alice', exp: Math.floor(Date.now() / 1000) - 10 })).toString('base64url')}.s`;
    assert.equal((await req(edgePort, 'GET', '/session/bootstrap', { 'x-requested-with': 'XMLHttpRequest', cookie: `iam_session=${stale}` })).status, 401);

    // The document routes split on the cookie: a signed-in visitor lands on the launchpad, an anonymous one on sign-in.
    const authed = { cookie: `iam_session=${jwt}` };
    assert.equal((await req(edgePort, 'GET', '/', undefined, undefined)).location, '/login');
    assert.equal((await req(edgePort, 'GET', '/', authed)).location, '/my-applications');
    assert.equal((await req(edgePort, 'GET', '/login', authed)).location, '/my-applications');
    assert.ok((await req(edgePort, 'GET', '/login?preview=1', authed)).body.startsWith('ssr '), 'the framed sign-in preview still renders');
    assert.equal((await req(edgePort, 'GET', '/my-applications')).location, '/login');
    assert.ok((await req(edgePort, 'GET', '/my-applications', authed)).body.startsWith('ssr '), 'the launchpad renders with a session');
  } finally {
    edge.kill('SIGKILL');
    core.closeAllConnections(); await new Promise((ok) => core.close(ok));
    ssr.close();
  }
});

test('sign-in routes do not time out at 15 s before the 30 s core gate budget', { timeout: 23000 }, async () => {
  const core = http.createServer((_req, res) => { setTimeout(() => res.end('gate form ready'), 16000); });
  await new Promise((ok) => core.listen(0, '127.0.0.1', ok));
  const edgePort = await freePort();
  const edge = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: { ...process.env, PORT: String(edgePort), IAM_CORE_PORT: String(core.address().port), IAM_GATE_TIMEOUT_MS: '30000' }, stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await req(edgePort, 'GET', '/healthz')).status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
    for (const r of await Promise.all(['/core/authorize', '/core/authorize/login', '/authorize', '/authorize/login'].map((p) => req(edgePort, 'GET', p)))) {
      assert.equal(r.status, 200, 'a slow but valid gate answer must reach the browser');
      assert.equal(r.body, 'gate form ready');
    }
  } finally { edge.kill('SIGKILL'); core.closeAllConnections(); await new Promise((ok) => core.close(ok)); }
});
