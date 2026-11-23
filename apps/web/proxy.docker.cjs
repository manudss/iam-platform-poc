// Docker dev proxy for `ng serve`: same routes as proxy.docker.json, plus the LOCAL edge behaviour
// of the hosted demo (demo/server.mjs): the server side attaches the admin capability to proxied API
// calls, so a signed-in developer uses the administration screens without typing any token.
//
// IMPORTANT (Vite 8 / http-proxy-3, Angular 22 dev server): a plain `onProxyReq` option key is
// silently IGNORED. The supported hook is `configure(proxy)`, listening on the 'proxyReq' event.
// Regression-covered by proxy.docker.test.cjs and by scripts/dev-stack-check.mjs step 7.
//
// Trust model (unchanged): every published port of the dev stack stays on 127.0.0.1. On top of that
// the capability is attached only when the request really comes from the local console:
//   - the Host header must be a loopback console host (Vite's allowedHosts default independently
//     refuses foreign Host headers; this is belt and braces against DNS rebinding);
//   - a mutating request carrying an Origin header must originate from the local console origin
//     (cross-site pages cannot mint a Bearer token anyway - it lives in memory/localStorage, never
//     in a cookie - this just refuses them the capability too).
// The value stays server-side (compose environment): it is never written to the browser, the logs
// or the docs. IAM_API_ADMIN_TOKEN here is the documented local placeholder.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_ORIGINS = new Set(['http://localhost:4200', 'http://127.0.0.1:4200', 'http://[::1]:4200']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isLocalHostHeader(host) {
  const m = /^(\[[^\]]+\]|[^:]+)(:\d+)?$/.exec(String(host ?? '').trim());
  return !!m && LOCAL_HOSTS.has(m[1]);
}

const conf = JSON.parse(readFileSync(join(__dirname, 'proxy.docker.json'), 'utf8'));
const token = process.env.IAM_API_ADMIN_TOKEN || '';
if (token && conf['/api']) {
  conf['/api'].configure = (proxy) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      if (!isLocalHostHeader(req.headers?.host)) return;
      const method = String(req.method ?? 'GET').toUpperCase();
      const origin = req.headers?.origin;
      if (!SAFE_METHODS.has(method) && origin !== undefined && !LOCAL_ORIGINS.has(String(origin))) return;
      proxyReq.setHeader('x-api-admin-token', token);
    });
  };
}
module.exports = conf;
