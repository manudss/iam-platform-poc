// End-to-end check of the ONE-COMMAND local dev stack (infra/docker-compose.dev.yml), run by the
// dev-stack CI job and usable by hand (`node scripts/dev-stack-check.mjs`) while the stack is up.
// Proves, through the console origin (http://127.0.0.1:4200, overridable with BASE):
//   1. the Angular console dev server answers,
//   2. the API answers through the console proxy (web container -> api container),
//   3. the core login form is served through the console proxy (web -> core),
//   4. a full PKCE sign-in as demo-alice works (form POST -> code -> token exchange),
//   5. the signed-in token reads the seeded Dolt assignments through the API (demo-bob present).
// Exits non-zero on the first failed step, printing the step that failed. No secrets involved:
// the demo credentials are the public fictional placeholders of the repository.
const BASE = (process.env.BASE ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES ?? 15); // first run compiles the Rust core
import { createHash, randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fail = (step, detail) => { console.error(`FAIL ${step}: ${detail}`); process.exit(1); };
const ok = (step, detail = '') => console.log(`OK   ${step}${detail ? ' - ' + detail : ''}`);

async function waitFor(step, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e.message; }
    if (Date.now() > deadline) fail(step, `not ready after ${Math.round(timeoutMs / 60000)} min (${last})`);
    await sleep(3000);
  }
}

// 1-3. the three containers answer through the console origin (core compiled on first run: long wait)
await waitFor('console (ng serve)', async () => {
  const r = await fetch(`${BASE}/`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return true;
}, WAIT_MINUTES * 60_000);
ok('console (ng serve)', BASE);

await waitFor('api through the console proxy', async () => {
  const r = await fetch(`${BASE}/api/health`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return true;
}, 5 * 60_000);
ok('api through the console proxy', `${BASE}/api/health`);

await waitFor('core login form through the console proxy', async () => {
  const r = await fetch(`${BASE}/core/health`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return true;
}, WAIT_MINUTES * 60_000);
ok('core through the console proxy', `${BASE}/core/health`);

// 4. PKCE sign-in through the real form endpoints (no browser needed; the flow carries no cookies)
const state = b64url(randomBytes(24));
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const authParams = new URLSearchParams({
  response_type: 'code', client_id: 'demo-web', redirect_uri: 'http://localhost:4200/callback',
  state, code_challenge: challenge, code_challenge_method: 'S256',
});
const form = await fetch(`${BASE}/core/authorize?${authParams}`);
if (!form.ok) fail('authorize form', `HTTP ${form.status}`);
const html = await form.text();
if (!html.includes('authorize/login')) fail('authorize form', 'no login form in the page');
ok('authorize form');

const login = await fetch(`${BASE}/core/authorize/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...Object.fromEntries(authParams), username: 'demo-alice', password: 'demo-only-not-a-secret' }),
});
if (login.status !== 302) fail('login', `expected 302, got HTTP ${login.status}`);
const location = login.headers.get('location') ?? '';
const code = new URL(location, BASE).searchParams.get('code');
if (!code) fail('login', `no code in the redirect: ${location.slice(0, 120)}`);
if (new URL(location, BASE).searchParams.get('state') !== state) fail('login', 'state mismatch in the redirect');
ok('login (form POST -> 302 code)');

const token = await fetch(`${BASE}/core/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: 'http://localhost:4200/callback', client_id: 'demo-web' }),
});
const tokens = await token.json().catch(() => ({}));
const access = tokens.access_token ?? tokens.id_token;
if (!token.ok || typeof access !== 'string') fail('token exchange', `HTTP ${token.status}`);
ok('token exchange');

// 5. the token reads the seeded fictional data through the API
const res = await fetch(`${BASE}/api/tenants/acme-demo/assignments`, { headers: { authorization: `Bearer ${access}` } });
const body = await res.text();
if (!res.ok) fail('seeded data with the signed-in token', `HTTP ${res.status}: ${body.slice(0, 200)}`);
if (!body.includes('demo-bob')) fail('seeded data with the signed-in token', 'demo-bob missing from the assignments');
ok('seeded data with the signed-in token', 'demo-bob present');

console.log('DEV STACK CHECK PASSED');
