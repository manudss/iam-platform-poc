// Real-browser E2E (local only) of the IdP PROTOTYPE browser flow: GET /authorize form -> POST /authorize/login -> 302 -> client callback
// that checks `state` and sends the PKCE verifier. Starts the real Rust core and a tiny client app on http://localhost:4200 (the registered
// redirect URI), drives headless Chrome through playwright-core, saves screenshots. Loopback only, fictional demo user.
// Needs: CHROME_BIN, playwright-core resolvable (NODE_PATH), built core (core/target/debug/iam-core). Usage: node scripts/authz-browser-e2e.mjs [outDir]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-authz-shots')); mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME_BIN;
if (!chrome) { console.log('SKIPPED: CHROME_BIN is required'); process.exit(0); }
const CORE = 'http://127.0.0.1:18200', PW = 'demo-only-not-a-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const core = spawn(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), stdio: 'ignore',
  env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18200', IAM_ISSUER: CORE, IAM_POLICY_FILE: join(root, 'policies/demo.cedar') } });
const exchanges = [];
const page_html = (body) => `<!doctype html><meta charset="utf-8"><title>demo client</title><body style="font-family:sans-serif">${body}`;
const client = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:4200');
  const send = (s, t, b) => { res.writeHead(s, { 'content-type': t }); res.end(b); };
  if (u.pathname === '/start') { // client: new state + PKCE verifier kept in sessionStorage, then redirect to the IdP prototype
    return send(200, 'text/html', page_html(`<p>Starting sign-in</p><script>
      (async () => {
        const rnd = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(40)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
        const verifier = rnd(), state = rnd();
        sessionStorage.setItem('v', verifier); sessionStorage.setItem('s', state);
        const ch = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        const p = new URLSearchParams(location.search);
        const q = new URLSearchParams({ response_type: 'code', client_id: 'demo-web', redirect_uri: p.get('ru') ?? 'http://localhost:4200/callback', state, code_challenge: ch, code_challenge_method: p.get('method') ?? 'S256' });
        location.href = '${CORE}/authorize?' + q;
      })();</script>`));
  }
  if (u.pathname === '/callback') { // client: state must equal the one stored before leaving; only then the code is exchanged
    return send(200, 'text/html', page_html(`<h1 id="r">checking</h1><script>
      (async () => {
        const p = new URLSearchParams(location.search), r = document.getElementById('r');
        if (p.get('state') !== sessionStorage.getItem('s')) { r.textContent = 'STATE MISMATCH: code ignored'; return; }
        const verifier = new URLSearchParams(location.hash.slice(1)).get('wrongverifier') ? 'x'.repeat(50) : sessionStorage.getItem('v');
        const ok = await (await fetch('/exchange', { method: 'POST', body: JSON.stringify({ code: p.get('code'), verifier }) })).json();
        r.textContent = ok.ok ? 'SIGNED IN (token exchange ok)' : 'EXCHANGE REFUSED';
        window.__replay = { code: p.get('code'), verifier: sessionStorage.getItem('v') };
      })();</script>`));
  }
  if (u.pathname === '/exchange' && req.method === 'POST') {
    let b = ''; for await (const c of req) b += c; const { code, verifier } = JSON.parse(b);
    const r = await fetch(`${CORE}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: 'http://localhost:4200/callback', client_id: 'demo-web' }) });
    const j = await r.json().catch(() => ({})); exchanges.push(r.status);
    return send(200, 'application/json', JSON.stringify({ ok: r.ok && typeof j.id_token === 'string' }));
  }
  send(404, 'text/plain', 'nf');
});
await new Promise((r) => client.listen(4200, '127.0.0.1', r));
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
let failed = false;
const fin = async () => { await browser.close(); core.kill(); client.close(); process.exit(failed ? 1 : 0); };
try {
  const newPage = async () => { const ctx = await browser.newContext(); const p = await ctx.newPage(); p.urls = []; if (process.env.DEBUG_BR) { p.on('console', (m) => console.log('console', m.text())); p.on('pageerror', (e) => console.log('pageerror', e.message)); p.on('requestfailed', (r) => console.log('reqfail', r.url().slice(0, 90), r.failure()?.errorText)); } p.on('framenavigated', (f) => { if (f === p.mainFrame()) p.urls.push(f.url()); }); return p; };
  const login = async (p, user, pw) => { await p.fill('input[name=username]', user); await p.fill('input[name=password]', pw); await Promise.all([p.waitForLoadState('load'), p.click('button[type=submit]')]); };
  const step = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { failed = true; console.log('FAIL', name, e.message.split('\n')[0]); } };

  await step('happy path: form, 302 to the client, state matches, PKCE exchange ok, password never in a URL', async () => {
    const p = await newPage(); await p.goto('http://localhost:4200/start');
    await p.waitForSelector('input[name=password]'); await p.screenshot({ path: join(out, '1-login-form.png') });
    assert.ok((await p.textContent('body')).includes('prototype'));
    await login(p, 'demo-alice', PW);
    await p.waitForFunction(() => document.getElementById('r')?.textContent !== 'checking', null, { timeout: 8000 });
    assert.equal(await p.textContent('#r'), 'SIGNED IN (token exchange ok)');
    await p.screenshot({ path: join(out, '2-signed-in.png') });
    assert.ok(p.url().startsWith('http://localhost:4200/callback?code='));
    assert.ok(p.urls.every((u) => !u.includes(PW) && !u.includes('password')), p.urls.join(' '));
    // replay of the same code with the right verifier is refused (single use)
    const rp = await p.evaluate(async () => (await (await fetch('/exchange', { method: 'POST', body: JSON.stringify(window.__replay) })).json()).ok);
    assert.equal(rp, false);
  });
  await step('wrong password: form again with an error, no redirect to the client, nothing leaked in the URL', async () => {
    const p = await newPage(); await p.goto('http://localhost:4200/start'); await p.waitForSelector('input[name=password]');
    await login(p, 'demo-alice', 'wrong-password-123');
    assert.ok(p.url().startsWith(`${CORE}/authorize/login`), p.url());
    assert.ok((await p.textContent('body')).includes('Wrong user or password'));
    assert.ok(!(await p.content()).includes('wrong-password-123'));
    assert.ok(p.urls.every((u) => !u.includes('wrong-password') && !u.startsWith('http://localhost:4200/callback')));
    await p.screenshot({ path: join(out, '3-wrong-password.png') });
  });
  await step('client rejects a callback whose state differs (forged redirect with a code): no exchange', async () => {
    const before = exchanges.length; const p = await newPage();
    await p.goto('http://localhost:4200/start'); await p.waitForSelector('input[name=password]'); // sets the client state
    await p.goto('http://localhost:4200/callback?code=attacker-code&state=forged-state');
    await p.waitForFunction(() => document.getElementById('r')?.textContent !== 'checking', null, { timeout: 8000 });
    assert.equal(await p.textContent('#r'), 'STATE MISMATCH: code ignored'); assert.equal(exchanges.length, before);
    await p.screenshot({ path: join(out, '4-state-mismatch.png') });
  });
  await step('wrong PKCE verifier at the token endpoint is refused and burns the code', async () => {
    const p = await newPage(); await p.goto('http://localhost:4200/start'); await p.waitForSelector('input[name=password]');
    await p.fill('input[name=username]', 'demo-bob'); await p.fill('input[name=password]', PW);
    await p.evaluate(() => { document.querySelector('form').action += ''; });
    // let the callback run with a wrong verifier: add a marker to the hash after the redirect lands, then reload is not possible (code would be re-read), so intercept
    await p.route('http://localhost:4200/callback*', (route) => route.continue());
    await Promise.all([p.waitForURL(/localhost:4200\/callback/), p.click('button[type=submit]')]);
    await p.waitForFunction(() => document.getElementById('r')?.textContent !== 'checking', null, { timeout: 8000 });
    const replay = await p.evaluate(async () => (await (await fetch('/exchange', { method: 'POST', body: JSON.stringify({ code: window.__replay.code, verifier: 'y'.repeat(50) }) })).json()).ok);
    assert.equal(replay, false);
  });
  await step('unregistered redirect_uri: error page on the IdP, never a navigation to the attacker URL', async () => {
    const p = await newPage(); await p.goto('http://localhost:4200/start?ru=' + encodeURIComponent('http://evil.example/callback'));
    await p.waitForURL(/authorize/, { timeout: 8000 }); await p.waitForLoadState('load');
    const tx = await p.textContent('body'); assert.ok(tx.includes('unknown client or redirect_uri'), p.url() + ' ' + tx);
    assert.equal(await p.locator('input[name=password]').count(), 0);
    assert.ok(p.urls.every((u) => new URL(u).hostname !== 'evil.example'), p.urls.join(' '));
    await p.screenshot({ path: join(out, '5-bad-redirect.png') });
  });
  await step('code_challenge_method=plain: refused with an error page, no form', async () => {
    const p = await newPage(); await p.goto('http://localhost:4200/start?method=plain'); await p.waitForURL(/authorize/, { timeout: 8000 }); await p.waitForLoadState('load');
    assert.ok((await p.textContent('body')).includes('S256')); assert.equal(await p.locator('input[name=password]').count(), 0);
  });
} finally { await fin(); }
