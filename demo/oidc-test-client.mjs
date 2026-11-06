#!/usr/bin/env node
// Demo OIDC relying party for the hosted POC (plugin `oidc-provider`, see docs/sso-oidc.md).
// Zero dependency (Node 18+): starts a tiny local app on http://localhost:<port>/callback,
// prints the sign-in URL to open in the browser, then shows the tokens and the userinfo answer.
// Fictional demo only: public client protected by PKCE, no secret anywhere.
//
//   node demo/oidc-test-client.mjs [issuer] [client_id] [port]
//   node demo/oidc-test-client.mjs https://iam-pr25.onrender.com/api/sso/acme-demo/oidc wiki
import http from 'node:http';
import crypto from 'node:crypto';

const [issuer = 'http://localhost:8080/api/sso/acme-demo/oidc', clientId = 'wiki', port = 4300] = process.argv.slice(2);
const redirectUri = `http://localhost:${port}/callback`;
const b64 = (b) => Buffer.from(b).toString('base64url');
const verifier = b64(crypto.randomBytes(32));
const challenge = b64(crypto.createHash('sha256').update(verifier).digest());
const state = b64(crypto.randomBytes(12));

const get = async (url, n = 0) => {
  try { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return await r.json(); }
  catch (e) { // the free host sleeps: one cold start can take a minute
    if (n >= 12) throw e; console.log(`waiting for the host to wake (${e.message.slice(0, 60)})...`);
    await new Promise((r) => setTimeout(r, 10000)); return get(url, n + 1);
  }
};

console.log(`Issuer:   ${issuer}`);
console.log(`Client:   ${clientId} (public client, PKCE S256)`);
const disco = await get(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
console.log(`Provider: ${disco.issuer}`);

const auth = new URL(disco.authorization_endpoint);
auth.searchParams.set('response_type', 'code');
auth.searchParams.set('client_id', clientId);
auth.searchParams.set('redirect_uri', redirectUri);
auth.searchParams.set('scope', 'openid profile email');
auth.searchParams.set('state', state);
auth.searchParams.set('code_challenge', challenge);
auth.searchParams.set('code_challenge_method', 'S256');

const done = new Promise((resolve, reject) => {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, redirectUri);
    if (u.pathname !== '/callback') { res.statusCode = 404; res.end(); return; }
    const html = (t, b) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<meta charset="utf-8"><title>${t}</title><body style="font:16px system-ui;max-width:34rem;margin:10vh auto"><h1>${t}</h1><p>${b}</p><p>You can close this tab and go back to the terminal.</p>`); };
    try {
      if (u.searchParams.get('error')) throw new Error(`${u.searchParams.get('error')} - ${u.searchParams.get('error_description') || 'refused'}`);
      if (u.searchParams.get('state') !== state) throw new Error('bad state (possible mix-up, start again)');
      const code = u.searchParams.get('code');
      const tr = await fetch(disco.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }) });
      if (!tr.ok) throw new Error(`token exchange: ${tr.status} ${await tr.text()}`);
      const tokens = await tr.json();
      const ui = await (await fetch(disco.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json();
      const idt = tokens.id_token ? JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()) : null;
      html('Signed in', `The application received an ID token and an access token for <b>${ui.sub || idt?.sub}</b>.`);
      server.close(); resolve({ tokens, idt, ui });
    } catch (e) { html('Sign-in failed', e.message); server.close(); reject(e); }
  });
  server.listen(port, () => {
    console.log(`\nLocal app listening on ${redirectUri}`);
    console.log('\n>>> Open this URL in the browser where you use the console:\n');
    console.log(auth.href + '\n');
  });
  setTimeout(() => { server.close(); reject(new Error('timed out after 10 minutes without a callback')); }, 600000).unref();
});

try {
  const { tokens, idt, ui } = await done;
  console.log('--- ID token (decoded) ---'); console.log(JSON.stringify(idt, null, 2));
  console.log('--- Access token ---'); console.log(`${tokens.access_token?.slice(0, 24)}... (expires in ${tokens.expires_in}s, type ${tokens.token_type})`);
  if (tokens.refresh_token) console.log('--- Refresh token ---'); console.log(`${tokens.refresh_token.slice(0, 24)}... (rotated at each use)`);
  console.log('--- userinfo (what the application actually receives) ---'); console.log(JSON.stringify(ui, null, 2));
} catch (e) { console.error(`\nFailed: ${e.message}`); process.exitCode = 1; }
