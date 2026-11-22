// Production Angular bundle with global CSS and local API fixtures, never a production account.
// Build apps/web first; install playwright-core separately and provide it via NODE_PATH.
const { chromium } = require('playwright-core');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'apps/web/dist/web/browser');
const out = path.resolve(process.argv[2] || '/tmp/personal-stepup-shots'); fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let f = path.join(web, url.pathname);
  if (!path.extname(f)) f = path.join(web, 'index.csr.html');
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
  res.end(fs.readFileSync(f));
});
const method = (id, name, level, types) => ({ id, name, declaredLevel: level, effectiveLevel: level, mfa: true, simulated: false, recommended: false, steps: types.map(type => ({ name: type, type, simulated: false })) });
const chains = [method('pw-mail', 'Password and email', 6, ['password', 'email-otp']), method('mail-pin', 'Email and PIN', 7, ['email-otp', 'digit-code']), method('pw-totp', 'Password and authenticator', 8, ['password', 'totp'])];
(async () => {
  let browser;
  const records = [];
  try {
    await new Promise(r => server.listen(14329, '127.0.0.1', r));
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
    for (const width of [320, 390, 1280]) for (const initial of ['/my-applications', '/my-profile']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const requests = [], errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
      await page.addInitScript(() => {
        localStorage.setItem('iam.session', 'x.' + btoa(JSON.stringify({ sub: 'fixture-admin', tenant: 'acme-demo', auth_level: 3, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })) + '.x');
        localStorage.setItem('iam.theme', 'light');
      });
      await page.route('https://picsum.photos/**', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
      await page.route('**/core/authorize**', r => r.fulfill({ contentType: 'text/html', body: '<p>Local sign-in destination fixture</p>' }));
      await page.route('**/api/**', async r => {
        const p = new URL(r.request().url()).pathname; requests.push(p);
        let data = {};
        if (p.includes('/branding/') && p.endsWith('.svg')) return r.fulfill({ contentType: 'image/svg+xml', body: fs.readFileSync(path.join(root, 'apps/web/public/lyam-logo-horizontal-light.svg'), 'utf8') });
        if (p.endsWith('/me/access')) data = { subject: 'fixture-admin', admin: true, restricted: true, plugins: {}, screenAccess: false };
        else if (p.endsWith('/auth/me/admin-assurance')) data = { ok: false, requiredLevel: 5, currentLevel: 3, reason: 'level' };
        else if (p.endsWith('/me/step-up')) data = { level: 5, chains };
        else if (p.endsWith('/me/profile')) data = { user: { display_name: 'Fixture Admin' }, values: {}, fields: [], sections: {} };
        else if (p.endsWith('/profile-components')) data = { components: [] };
        else if (p.endsWith('/launchpad')) data = { apps: [{ id: 'fixture-app', name: 'Fixture application', description: 'Local test application', protocol: 'oidc', url: 'https://example.invalid' }], preferences: { favourites: [], order: [] } };
        else if (/\/(workspace|versioning|plugins)(\/|$)/.test(p) || p.endsWith('/branding/draft')) return r.fulfill({ status: 403, json: { code: 'step-up-required', requiredLevel: 5, currentLevel: 3, message: 'Administration fixture refused' } });
        else if (p.includes('/branding')) return r.fulfill({ status: 404, body: '' });
        await r.fulfill({ json: data });
      });
      const forbidden = () => requests.filter(p => /\/(workspace|versioning|plugins)(\/|$)/.test(p) || p.endsWith('/branding/draft'));
      await page.goto('http://127.0.0.1:14329' + initial);
      await page.locator(initial === '/my-profile' ? '#mp-form' : '#lp-organise').waitFor();
      if (initial === '/my-applications') await page.locator('.lp-empty').filter({ hasText: 'Loading applications' }).waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).pathname, initial); assert.deepEqual(forbidden(), []);
      await page.screenshot({ path: path.join(out, initial.slice(1) + '-' + width + '.png'), fullPage: true });
      // On mobile, open the real sidebar, then use its guarded admin link.
      if (width < 900) await page.locator('button.burger').click();
      await page.locator('[data-nav="/users"]').click(); await page.locator('#su-reason').waitFor();
      assert.equal(new URL(page.url()).pathname, '/step-up');
      assert.deepEqual(await page.locator('#signin-methods [data-chain]').evaluateAll(es => es.map(e => e.dataset.chain)), chains.map(c => c.id));
      assert.ok(await page.locator('#su-profile').isVisible()); assert.ok(await page.locator('#su-applications').isVisible());
      assert.deepEqual(forbidden(), []);
      await page.locator('#su-profile').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.locator(':focus').count(), 1);
      await page.screenshot({ path: path.join(out, 'step-up-' + width + '.png'), fullPage: true });
      const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ tag: e.tagName, cls: e.className, width: e.getBoundingClientRect().width })).slice(0, 15) }));
      assert.ok(overflow.scroll <= width, 'step-up overflow: ' + JSON.stringify(overflow));
      assert.ok(await page.locator('#signin-methods').evaluate(e => [...e.querySelectorAll('button')].every(b => b.getBoundingClientRect().right <= e.getBoundingClientRect().right + 1)), 'method rows must stay within their card');
      await page.locator('#su-cancel').click(); await page.locator('#lp-organise').waitFor();
      assert.equal(new URL(page.url()).pathname, '/my-applications'); assert.deepEqual(forbidden(), []);
      await page.goto('http://127.0.0.1:14329/step-up?kind=admin&level=5&current=3&return=%2Fusers');
      await page.locator('#su-profile').click(); await page.locator('#mp-form').waitFor();
      assert.equal(new URL(page.url()).pathname, '/my-profile'); assert.deepEqual(forbidden(), []);
      if (width === 390 && initial === '/my-applications') {
        await page.goto('http://127.0.0.1:14329/step-up?kind=admin&level=5&current=3&return=%2Fusers');
        await page.locator('[data-chain="pw-mail"]').click();
        await page.waitForURL('**/core/authorize**');
        assert.equal(new URL(page.url()).searchParams.get('chain'), 'pw-mail');
        const stored = await page.evaluate(() => ({ subject: sessionStorage.getItem('iam.stepup.subject'), back: sessionStorage.getItem('iam.return') }));
        assert.deepEqual(stored, { subject: 'fixture-admin', back: '/users' });
      }
      assert.deepEqual(errors, []);
      records.push({ initial, width, protectedCalls: forbidden().length, pageErrors: errors.length, offered: chains.map(c => c.id), cancel: '/my-applications', profile: '/my-profile' });
      await page.close();
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ fixtures: true, records }, null, 2));
    console.log(JSON.stringify({ passed: records.length, records }, null, 2));
  } finally { await browser?.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
