// Demo client for the IdP PROTOTYPE browser flow (local only, loopback). Serves http://localhost:4200/start and /callback (the registered redirect URI).
// /start makes a fresh `state` + PKCE verifier (sessionStorage) and redirects to the core's GET /authorize form; /callback checks `state`, exchanges the code
// with the verifier and prints whether sign-in worked (the token itself is NOT displayed). Needs the core running (default http://127.0.0.1:8081).
// It uses port 4200: do not run it together with `ng serve` (the Angular console keeps using the JSON endpoints). Usage: node scripts/demo-client.mjs, then open http://localhost:4200/start
import { createServer } from 'node:http';
const CORE = process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081';

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
    const j = await r.json().catch(() => ({})); 
    return send(200, 'application/json', JSON.stringify({ ok: r.ok && typeof j.id_token === 'string' }));
  }
  send(404, 'text/plain', 'nf');
});
client.listen(4200, '127.0.0.1', () => console.log('demo client on http://localhost:4200/start (core ' + CORE + ')'));
