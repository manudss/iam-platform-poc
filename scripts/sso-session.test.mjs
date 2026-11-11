import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createOidcEngine } from '../plugins/oidc-provider/handlers.mjs';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const oc = await import(require.resolve('openid-client'));

test('one sign-in opens two distinct OIDC apps; the configured deadline requires a new sign-in', async () => {
  let base;
  const apps = ['first', 'second'].map(id => ({ id, name: id, description: '', protocol: 'oidc', enabled: true, redirect_uris: ['http://localhost/cb'], allowed_roles: ['employee'], scopes: ['profile'], allow_refresh_tokens: false, attribute_mapping: { sub: 'id', name: 'display_name' } }));
  const engine = createOidcEngine({ liveApps: async () => apps, pluginActive: async () => true, directoryUser: async () => ({ id: 'alice', display_name: 'Alice', roles: ['employee'] }), secretGet: async () => undefined, sessionSeconds: async () => 3, env: {}, emit: () => {}, warn: () => {} });
  const server = http.createServer((req, res) => {
    req.params = { tenant: 'test' };
    req.url = req.url.replace('/sso/test/oidc', '');
    engine.middleware(req, res, e => { res.statusCode = 500; res.end(String(e)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const issuer = `${base}/sso/test/oidc`, jar = new Map();
  const request = async url => {
    const r = await fetch(url, { redirect: 'manual', headers: { cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; ') } });
    for (const c of r.headers.getSetCookie()) { const pair = c.split(';')[0], i = pair.indexOf('='); jar.set(pair.slice(0,i), pair.slice(i+1)); }
    return r;
  };
  const follow = async url => {
    for(let n=0;n<12;n++) {
      if(url.startsWith('http://localhost/cb')) return { cb: new URL(url) };
      if(new URL(url).pathname.startsWith('/sso-interaction/')) return { uid: new URL(url).pathname.split('/').pop() };
      const r = await request(url); assert.ok(r.status>=300&&r.status<400, `${r.status}: ${await r.text()}`);
      url = new URL(r.headers.get('location'),base).href;
    }
    throw new Error('redirect loop');
  };
  const req = { headers: { host: new URL(base).host }, protocol: 'http' };
  const authorize = async id => {
    const config = await oc.discovery(new URL(issuer),id,undefined,oc.None(),{execute:[oc.allowInsecureRequests]});
    const verifier=oc.randomPKCECodeVerifier(), challenge=await oc.calculatePKCECodeChallenge(verifier);
    const result=await follow(oc.buildAuthorizationUrl(config,{redirect_uri:'http://localhost/cb',scope:'openid profile',state:id,code_challenge:challenge,code_challenge_method:'S256'}).href);
    return {config,verifier,...result};
  };
  const finish = async (auth,id) => {
    const done = await engine.complete('test',auth.uid,'alice','allow',req);
    const {cb}=await follow(done.redirectTo);
    const tokens=await oc.authorizationCodeGrant(auth.config,cb,{pkceCodeVerifier:auth.verifier,expectedState:id});
    assert.equal(tokens.claims().sub,'alice');
  };
  try {
    const first=await authorize('first'); assert.ok(first.uid);
    const p=await engine.forTenant('test',req);
    assert.equal((await p.provider.Interaction.find(first.uid)).prompt.name,'login');
    await finish(first,'first');
    const second=await authorize('second'); assert.ok(second.uid);
    assert.equal((await p.provider.Interaction.find(second.uid)).prompt.name,'consent','second app needs consent, not credentials');
    await finish(second,'second');
    await new Promise(resolve=>setTimeout(resolve,4100));
    const expired=await authorize('first'); assert.ok(expired.uid);
    assert.equal((await p.provider.Interaction.find(expired.uid)).prompt.name,'login','deadline forces a fresh sign-in');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
