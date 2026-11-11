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
const req = (port, method, path) => new Promise((ok, ko) => {
  const r = http.request({ host: '127.0.0.1', port, path, method }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], body: b })); });
  r.on('error', ko);
  r.end();
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
