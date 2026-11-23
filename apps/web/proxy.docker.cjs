// Docker dev proxy for `ng serve`: same routes as proxy.docker.json, plus the LOCAL edge behaviour
// of the hosted demo (demo/server.mjs): the server side attaches the admin capability to proxied API
// calls, so a signed-in developer uses the administration screens without typing any token.
// Trust model (unchanged): every published port of the dev stack stays on 127.0.0.1, so only a browser
// on this machine reaches the console; the value itself stays server-side (compose environment), never
// in the bundle, the chat or the docs. IAM_API_ADMIN_TOKEN here is the documented local placeholder.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const conf = JSON.parse(readFileSync(join(__dirname, 'proxy.docker.json'), 'utf8'));
const token = process.env.IAM_API_ADMIN_TOKEN || '';
if (token && conf['/api']) {
  conf['/api'].onProxyReq = (proxyReq) => { proxyReq.setHeader('x-api-admin-token', token); };
}
module.exports = conf;
