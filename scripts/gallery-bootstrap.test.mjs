// Real built Angular shell + router. All API responses and identities are fictional fixtures.
// Build the web application first. No connection to the demo API or external application is made.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = resolve(process.env.GALLERY_WEB_ROOT ?? 'apps/web/dist/web/browser');
const shots = process.env.GALLERY_BOOTSTRAP_SHOTS;
const app = { id: 'fixture', name: 'Fixture application', description: 'Local fictional application', protocol: 'oidc', url: 'https://example.invalid' };
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };

test('a delayed workspace bootstrap keeps the real shell gallery mounted; a true branch switch still cancels edits', async () => {
  const server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = resolve(root, '.' + name); assert.ok(file.startsWith(root + '/') || file === root);
      let content;
      try { content = await readFile(file); } catch {
        file = resolve(root, 'index.csr.html');
        try { content = await readFile(file); } catch { file = resolve(root, 'index.html'); content = await readFile(file); }
      }
      res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream'); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] });
  try {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 1050 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport });
      const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'demo-alice', exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url') + '.fixture';
      await context.addInitScript(t => localStorage.setItem('iam.session', t), token);
      let release; const personal = new Promise(r => { release = r; });
      await context.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.origin !== origin) return route.abort();
        if (u.pathname === '/session/bootstrap') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'No session edge in fixture' });
        if (!u.pathname.startsWith('/api/')) return route.continue();
        if (/\/branding\/logo-horizontal-(light|dark)\.svg$/.test(u.pathname)) {
          const variant = u.pathname.includes('-dark') ? 'dark' : 'light';
          return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: await readFile(resolve('apps/web/public/lyam-logo-horizontal-' + variant + '.svg')) });
        }
        let data = {};
        if (u.pathname.endsWith('/workspace/personal')) { await personal; data = { branch: 'personal/demo-alice', status: 'created' }; }
        else if (u.pathname.endsWith('/me/access')) data = { subject: 'demo-alice', admin: true, restricted: false, plugins: {} };
        else if (u.pathname.endsWith('/launchpad')) data = { apps: [app], preferences: { favourites: [], order: [] } };
        else if (u.pathname.endsWith('/branches')) data = { branches: [{ name: 'main', default: true }, { name: 'personal/demo-alice' }] };
        else if (u.pathname.endsWith('/plugins')) data = { plugins: [] };
        else if (u.pathname.endsWith('/plugins/menu')) data = { entries: [] };
        else if (u.pathname.endsWith('/profile/self')) data = { values: {} };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      try {
        await page.goto(origin + '/my-applications'); await page.locator('.lp-card').waitFor();
        await page.locator('#lp-organise').click(); await page.locator('#lp-save').waitFor();
        const save = await page.locator('#lp-save').elementHandle();
        await page.locator('.lp-star').click();
        release();
        await page.waitForFunction(() => document.querySelector('#branch-picker-button')?.textContent.includes('personal/demo-alice'));
        assert.equal(await save.evaluate(x => x.isConnected), true, 'same editor survives shell branch epoch');
        await page.locator('#lp-save').waitFor();
        await page.locator('[aria-label="Favourites"] [data-app="fixture"]').waitFor();
        assert.equal(await page.locator('.lp-launch').count(), 0);
        if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: resolve(shots, label + '.png'), fullPage: true }); }
        await page.locator('select[name=globalBranch]').selectOption('main', { force: true });
        await page.locator('#lp-organise').waitFor(); assert.equal(await page.locator('#lp-save').count(), 0, 'real branch switch still cancels editing');
        assert.deepEqual(errors, []);
      } finally { release(); await context.close(); }
    }
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
