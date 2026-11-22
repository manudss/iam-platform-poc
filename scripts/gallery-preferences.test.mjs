// Actual production Angular bundle, fictional API and delayed preferences write.
// Proves a synchronization gap in the browser test, not the unique historical CI failure cause.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmGalleryPreferencesWrite } from './lib/gallery-preferences.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = resolve(process.env.GALLERY_WEB_ROOT ?? 'apps/web/dist/web/browser');
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };
const app = { id: 'peoplehub', name: 'PeopleHub', description: 'Fictional application', protocol: 'oidc', url: 'https://example.invalid' };
test('Gallery star is optimistic; reload persistence assertion must wait for the successful PUT, not the moved card', async () => {
  const server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = resolve(root, '.' + name); assert.ok(file.startsWith(root + '/') || file === root);
      let content; try { content = await readFile(file); } catch { file = resolve(root, 'index.csr.html'); content = await readFile(file); }
      res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream'); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] });
  try {
    for (const fixed of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
      const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'fictional', exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url') + '.fixture';
      await context.addInitScript(t => localStorage.setItem('iam.session', t), token);
      let releaseWrite, sawWrite; const gate = new Promise(r => { releaseWrite = r; }); const started = new Promise(r => { sawWrite = r; });
      let persisted = { favourites: [], order: [] }, completed = false;
      await context.route('**/*', async route => {
        const u = new URL(route.request().url()); if (u.origin !== origin) return route.abort();
        if (u.pathname === '/session/bootstrap') return route.fulfill({ status: 404, body: 'No session edge' });
        if (!u.pathname.startsWith('/api/')) return route.continue();
        let data = {};
        if (u.pathname.endsWith('/me/access')) data = { subject: 'fictional', admin: false, restricted: false, plugins: {} };
        else if (u.pathname.endsWith('/launchpad/preferences')) {
          const incoming = route.request().postDataJSON(); sawWrite(); await gate; persisted = incoming;
        } else if (u.pathname.endsWith('/launchpad')) data = { apps: [app], preferences: persisted };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
      });
      const page = await context.newPage();
      try {
        await page.goto(origin + '/my-applications'); await page.locator('.lp-star').waitFor();
        const click = () => page.locator('[data-app=peoplehub] .lp-star').click();
        const write = fixed ? confirmGalleryPreferencesWrite(page, click).then(() => { completed = true; }) : click();
        await started; await page.locator('[aria-label=Favourites] [data-app=peoplehub]').waitFor();
        assert.deepEqual(persisted.favourites, [], 'visible favourite precedes server acknowledgement');
        if (!fixed) {
          await page.reload(); await page.locator('.lp-card').waitFor();
          assert.equal(await page.locator('[aria-label=Favourites] [data-app=peoplehub]').count(), 0, 'old CI sequence observes loss after premature reload');
          releaseWrite(); await write;
        } else {
          assert.equal(completed, false, 'new helper does not treat optimistic paint as saved');
          releaseWrite(); await write; assert.equal(completed, true);
          await page.reload(); await page.locator('[aria-label=Favourites] [data-app=peoplehub]').waitFor();
          assert.deepEqual(persisted.favourites, ['peoplehub']);
          if (process.env.GALLERY_PERSISTENCE_SHOTS) { await mkdir(process.env.GALLERY_PERSISTENCE_SHOTS, { recursive: true }); await page.screenshot({ path: resolve(process.env.GALLERY_PERSISTENCE_SHOTS, 'acknowledged-reload.png'), fullPage: true }); }
        }
      } finally { releaseWrite(); await context.close(); }
    }
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('preferences acknowledgement helper refuses a failed PUT', async () => {
  const page = { waitForResponse: async () => ({ ok: () => false, status: () => 503 }) };
  await assert.rejects(confirmGalleryPreferencesWrite(page, async () => {}), /503/);
});
