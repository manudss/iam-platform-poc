import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { warmSignin } from './warm-signin.mjs';

const ready = () => ({ mode: 'choice', chains: [{ id: 'password-only' }] });
const form = '<input name="username"><input name="password">';
const defaults = { publicOrigin: 'https://lyam.dss.name', retryDelayMs: 0, log() {} };

test('warms the real direct-API route and core gate entry over HTTP, with no credential', async () => {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === '/tenants/acme-demo/signin/options') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(ready())); }
    else if (req.url.startsWith('/authorize?')) res.end(form);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  try {
    const origin = `http://127.0.0.1:${s.address().port}`;
    await warmSignin({ ...defaults, apiOrigin: origin, coreOrigin: origin });
    assert.equal(seen.length, 2);
    const q = new URL(seen[1].url, origin).searchParams;
    assert.equal(q.get('chain'), 'password-only');
    assert.equal(q.get('redirect_uri'), 'https://lyam.dss.name/callback');
    assert.equal(q.get('code_challenge').length, 43);
    assert.ok(seen.every((r) => r.method === 'GET' && !r.headers.authorization && !r.headers['x-api-admin-token']));
    assert.ok(!seen.some((r) => r.url.includes('password=') || r.url.includes('/token')));
  } finally { s.closeAllConnections(); await new Promise((ok) => s.close(ok)); }
});

test('404 options is not readiness and never reaches the gate', async () => {
  let calls = 0;
  await assert.rejects(warmSignin({ ...defaults, attempts: 1, fetchFn: async () => { calls++; return new Response('', { status: 404 }); } }), /sign-in readiness failed/);
  assert.equal(calls, 1);
});

test('retries a temporarily unavailable gate and only accepts the real form', async () => {
  let entryCalls = 0;
  await warmSignin({ ...defaults, fetchFn: async (url) => url.includes('/signin/options') ? Response.json(ready()) : ++entryCalls === 1 ? new Response('unavailable', { status: 503 }) : new Response(form) });
  assert.equal(entryCalls, 2);
});

test('does not expose an edge after persistent gate failure or a misleading HTML 200', async () => {
  for (const result of [new Response('error', { status: 503 }), new Response('<h1>Sign-in error</h1>')]) {
    await assert.rejects(warmSignin({ ...defaults, attempts: 1, fetchFn: async (url) => url.includes('/signin/options') ? Response.json(ready()) : result }), /sign-in readiness failed/);
  }
});

test('rejects a missing seeded chain and aborted requests', async () => {
  await assert.rejects(warmSignin({ ...defaults, attempts: 1, fetchFn: async () => Response.json({ mode: 'legacy' }) }), /sign-in readiness failed/);
  await assert.rejects(warmSignin({ ...defaults, attempts: 1, fetchFn: async () => { throw new DOMException('timed out', 'TimeoutError'); } }), /sign-in readiness failed/);
});

test('the startup script runs readiness before serving and the image includes it', () => {
  const start = readFileSync(new URL('./start.sh', import.meta.url), 'utf8');
  const image = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  assert.ok(start.indexOf('node /app/demo/warm-signin.mjs') < start.indexOf('exec node /app/demo/server.mjs'));
  assert.match(image, /COPY demo\/server.mjs .*demo\/warm-signin.mjs \/app\/demo\//);
  assert.ok(!start.includes(':3000/api/tenants/'));
});
