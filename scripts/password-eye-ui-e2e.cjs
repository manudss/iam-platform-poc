// Real Rust sign-in page, production Angular bundle and actual plugin custom elements.
// Local fixtures only for account data and PIN enrollment, no external accounts or effects.
// Needs: built core + Angular, CHROME_BIN and playwright-core via NODE_PATH.
const { chromium } = require('playwright-core');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'apps/web/dist/web/browser');
const out = path.resolve(process.argv[2] || '/tmp/password-eye-shots'); fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, IAM_CORE_ADDR: '127.0.0.1:14321', IAM_POLICY_FILE: path.join(root, 'policies/demo.cedar') };
for (const k of ['IAM_AUTH_GATE_ADDR', 'IAM_AUTH_GATE_TOKEN', 'IAM_CORE_NATS_URL', 'IAM_CORE_STATE_DIR', 'IAM_PLUGIN_PACKAGE', 'IAM_PLUGIN_WAT', 'IAM_CORE_GRPC_ADDR']) delete env[k];
const core = spawn(path.join(root, 'core/target/debug/iam-core'), [], { cwd: path.join(root, 'core'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let coreLog = ''; core.stdout.on('data', d => coreLog += d); core.stderr.on('data', d => coreLog += d);
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  let f;
  if (pathname === '/plugin-fixture') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture-theme.css"><style>body{font:16px system-ui;background:var(--bg);color:var(--ink);margin:0;padding:24px}main{max-width:600px;margin:auto}section{background:var(--card);padding:16px;border:1px solid var(--line);border-radius:12px;margin:12px 0}</style></head><body><main><h1>Profile controls</h1><section><h2>Password</h2><iam-password-profile></iam-password-profile></section><section><h2>PIN</h2><iam-pin-profile></iam-pin-profile></section></main><script type="module">import '/plugin-password.mjs';import '/plugin-pin.mjs';</script></body></html>`); return;
  }
  if (pathname === '/fixture-theme.css') f = path.join(root, 'core/crates/iam-core/src/branding-default.css');
  else if (pathname === '/plugin-password.mjs') f = path.join(root, 'plugins/auth-password/screens/profile.mjs');
  else if (pathname === '/plugin-pin.mjs') f = path.join(root, 'plugins/auth-digit-code/screens/profile.mjs');
  else { f = path.join(web, pathname); if (!path.extname(f)) f = path.join(web, 'index.csr.html'); if (!fs.existsSync(f)) f = path.join(web, 'index.html'); }
  res.setHeader('Content-Type', /\.m?js$/.test(f) ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(fs.readFileSync(f));
});
async function check(page, input, button, label) {
  await input.fill('demo-only-typed-value'); assert.equal(await input.getAttribute('type'), 'password', label);
  assert.equal(await button.textContent(), '', label + ': icon only');
  assert.equal(await button.getAttribute('aria-label'), 'Show what you typed');
  assert.equal(await button.locator('svg').getAttribute('aria-hidden'), 'true');
  const i = await input.boundingBox(), b = await button.boundingBox(), svg = await button.locator('svg').boundingBox();
  assert.ok(b.x >= i.x && b.y >= i.y && b.x + b.width <= i.x + i.width + 1 && b.y + b.height <= i.y + i.height + 1, label + ': eye entirely inside field');
  const ink = await button.evaluate(e => getComputedStyle(e).color), bg = await input.evaluate(e => getComputedStyle(e).backgroundColor);
  const luminance = rgb => rgb.match(/[0-9.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const a = luminance(ink), c = luminance(bg); assert.ok((Math.max(a, c) + .05) / (Math.min(a, c) + .05) >= 3, label + ': visible icon contrast');
  assert.equal(svg.width, 20); assert.equal(svg.height, 20); assert.ok(b.width >= 40 && b.height >= 24, label + ': usable hit area');
  assert.ok(await input.evaluate(e => parseFloat(getComputedStyle(e).paddingInlineEnd) >= 44), label + ': text cannot cover eye');
  await button.click(); assert.equal(await input.getAttribute('type'), 'text'); assert.equal(await button.getAttribute('aria-pressed'), 'true');
  assert.equal(await input.inputValue(), 'demo-only-typed-value'); assert.equal(await input.evaluate(e => e.getRootNode().activeElement === e), true, label + ': pointer keeps input focus');
  await button.click(); assert.equal(await input.getAttribute('type'), 'password');
  await input.focus(); await page.keyboard.press('Tab'); assert.equal(await button.evaluate(e => e.getRootNode().activeElement === e), true, label + ': keyboard reaches eye');
  const url = page.url(); await page.keyboard.press('Space'); assert.equal(await input.getAttribute('type'), 'text');
  await page.keyboard.press('Enter'); assert.equal(await input.getAttribute('type'), 'password'); assert.equal(page.url(), url, label + ': eye does not submit');
  await page.keyboard.press('Space'); await page.keyboard.press('Tab'); assert.equal(await input.getAttribute('type'), 'password', label + ': leaving remasks');
}
(async () => {
  let browser;
  try {
    await new Promise(r => server.listen(14322, '127.0.0.1', r));
    let ready = false; for (let n = 0; n < 100; n++) { try { if ((await fetch('http://127.0.0.1:14321/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ready, 'core ready: ' + coreLog);
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 }, colorScheme: theme });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('https://picsum.photos/**', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
      await page.route('**/api/**', async r => {
        const p = new URL(r.request().url()).pathname; let data = {};
        if (p.includes('/branding/') && p.endsWith('.svg')) { await r.fulfill({ contentType: 'image/svg+xml', body: fs.readFileSync(path.join(root, 'apps/web/public/lyam-logo-horizontal-' + (p.includes('dark') ? 'dark' : 'light') + '.svg'), 'utf8') }); return; }
        if (p.includes('/branding/')) { await r.fulfill({ status: 404, body: '' }); return; }
        if (p.endsWith('/me/access')) data = { admin: true, restricted: false, plugins: {}, screenAccess: false };
        else if (p.endsWith('/workspace/personal')) data = { branch: 'demo-alice', status: 'reused' };
        else if (p.endsWith('/workspace')) data = { diff: { rows: { total: 0 }, tables: [] } };
        else if (p.endsWith('/versioning/branches')) data = { branches: [{ name: 'main' }, { name: 'demo-alice' }] };
        else if (p.endsWith('/plugins/menu')) data = { entries: [] };
        else if (p.endsWith('/plugins')) data = { plugins: [] };
        else if (p.endsWith('/launchpad')) data = { apps: [], preferences: {} };
        await r.fulfill({ json: data });
      });
      const shot = async name => { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': no horizontal overflow'); await page.screenshot({ path: path.join(out, `${mobile ? 'mobile' : 'desktop'}-${theme}-${name}.png`), fullPage: true }); };
      await page.goto('http://127.0.0.1:14321/authorize?response_type=code&client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A4200%2Fcallback&state=ui-test&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256');
      await check(page, page.locator('[name=password]'), page.locator('.reveal-btn'), 'real Rust sign-in');
      await shot('signin'); await page.locator('[name=password]').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Space'); await shot('signin-revealed-keyboard');
      await page.addInitScript(({ theme }) => { localStorage.setItem('iam.session', 'x.' + btoa(JSON.stringify({ sub: 'demo-alice', tenant: 'acme-demo', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })) + '.x'); localStorage.setItem('iam.theme', theme); }, { theme });
      await page.goto('http://127.0.0.1:14322/my-applications');
      if (mobile) await page.getByRole('button', { name: 'Toggle menu' }).click();
      await page.locator('details.token summary').click();
      await check(page, page.locator('[name=admintoken]'), page.locator('details.token .reveal-btn'), 'production Angular directive'); await shot('angular');
      await page.route('**/auth/me/enrollments', r => r.fulfill({ json: { enrollments: {}, methods: [{ id: 'pin-demo', type: 'digit-code', name: 'Demo PIN', length: 6 }] } }));
      await page.goto('http://127.0.0.1:14322/plugin-fixture'); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('iam-pin-profile .change').click();
      await check(page, page.locator('iam-password-profile .next'), page.locator('iam-password-profile .reveal-btn').nth(1), 'actual password plugin');
      await check(page, page.locator('iam-pin-profile .pin'), page.locator('iam-pin-profile .reveal-btn'), 'actual PIN plugin'); await shot('plugins');
      assert.deepEqual(errors, []); console.log('PASS', mobile ? 'mobile' : 'desktop', theme, 'Rust sign-in + Angular + password/PIN plugins: inset geometry, keyboard, focus, no submit, remasking'); await page.close();
    }
  } finally { if (browser) await browser.close(); core.kill('SIGTERM'); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
