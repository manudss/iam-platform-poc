// Unit coverage for the local console-edge admin capability injection (apps/web/proxy.docker.cjs).
// These tests FAIL against the silently-ignored `onProxyReq` variant: they exercise the
// `configure(proxy)` + 'proxyReq' event contract that Vite 8's proxy actually honours.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const TOKEN = 'local-dev-api-token';
process.env.IAM_API_ADMIN_TOKEN = TOKEN;
const conf = require('./proxy.docker.cjs');

function runProxyReq(req) {
  assert.equal(typeof conf['/api'].configure, 'function', 'the /api context must use configure(proxy)');
  assert.equal(conf['/api'].onProxyReq, undefined, 'a plain onProxyReq key is ignored by Vite and must not be used');
  const proxy = new EventEmitter();
  conf['/api'].configure(proxy);
  const headers = {};
  const proxyReq = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
  proxy.emit('proxyReq', proxyReq, req);
  return headers;
}

test('attaches the capability for a local console GET', () => {
  const h = runProxyReq({ method: 'GET', headers: { host: 'localhost:4200' } });
  assert.equal(h['x-api-admin-token'], TOKEN);
});

test('attaches the capability for a same-origin console POST', () => {
  const h = runProxyReq({ method: 'POST', headers: { host: 'localhost:4200', origin: 'http://localhost:4200' } });
  assert.equal(h['x-api-admin-token'], TOKEN);
});

test('attaches the capability for a mutating call without Origin (curl, node fetch, IDE)', () => {
  const h = runProxyReq({ method: 'POST', headers: { host: '127.0.0.1:4200' } });
  assert.equal(h['x-api-admin-token'], TOKEN);
});

test('refuses the capability to a cross-site mutation (foreign Origin)', () => {
  const h = runProxyReq({ method: 'POST', headers: { host: 'localhost:4200', origin: 'http://evil.example' } });
  assert.equal(h['x-api-admin-token'], undefined);
});

test('refuses the capability to a foreign Host (DNS rebinding belt and braces)', () => {
  const h = runProxyReq({ method: 'GET', headers: { host: 'evil.example' } });
  assert.equal(h['x-api-admin-token'], undefined);
});

test('still proxies the other contexts unchanged and without the capability', () => {
  for (const k of ['/core', '/authorize', '/token', '/jwks.json', '/.well-known']) {
    assert.ok(conf[k], `${k} route preserved`);
    assert.equal(conf[k].configure, undefined, `${k} gets no injection`);
  }
});
