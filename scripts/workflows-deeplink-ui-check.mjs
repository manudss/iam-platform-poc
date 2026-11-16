/** Production web bundle, local mocked API. No live service, account, or external action.
 * npm --prefix apps/web run build
 * NODE_PATH=/path/to/playwright-core/node_modules CHROME_BIN=/usr/bin/google-chrome node scripts/workflows-deeplink-ui-check.mjs /tmp/lyam-workflows-ui
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = resolve('apps/web/dist/web/browser');
const out = resolve(process.argv[2] ?? '/tmp/lyam-workflows-ui'); mkdirSync(out, { recursive: true });
const calls = []; let enabled = true;
const jwt = `h.${Buffer.from(JSON.stringify({ sub: 'demo-alice', exp: Math.floor(Date.now()/1000)+1800 })).toString('base64url')}.s`;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = (d, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (path === '/session/bootstrap') return json({ id_token: jwt });
  if (path.startsWith('/api/')) {
    const p = path.replace('/api/tenants/acme-demo', ''); calls.push({ p, method: req.method, branch: req.headers['x-iam-branch'] });
    if (p === '/workspace/personal') { await new Promise(r => setTimeout(r, 120)); return json({ branch: 'personal/demo-alice', status: 'reused' }); }
    if (p === '/me/access') return json({ subject: 'demo-alice', admin: true, restricted: true, plugins: { 'workflows-iga': enabled } });
    if (p === '/plugins') return req.headers['x-iam-branch'] ? json({ plugins: [{ id: 'workflows-iga', enabled }] }) : json({ message: 'Choose a working data branch before using administration' }, 400);
    if (p.startsWith('/branding/') && p.endsWith('.svg')) { res.writeHead(200, {'content-type':'image/svg+xml'}); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="0" y="30" fill="white" font-size="30">lyam</text></svg>'); }
    if (p.endsWith('/theme.css')) { res.writeHead(200, {'content-type':'text/css'}); return res.end(''); }
    if (p === '/plugins/menu') return json({ entries: [] });
    if (p === '/versioning/branches') return json({ branches: [{ name: 'main' }, { name: 'personal/demo-alice' }] });
    if (p === '/workflows') return json({ definitions: [{ id: 'wf-local-fixture', name: 'Local regression fixture', description: 'Mocked API: no external effects', active: true, tags: [], trigger: null, graph: { nodes: [], edges: [] }, stats: { runs: 0, succeeded: 0, failed: 0, successRate: 0, lastStatus: null, lastAt: null }, updatedAt: '2026-11-16T00:00:00Z' }] });
    if (p === '/workflow-runs') return json({ runs: [] });
    if (p.endsWith('/demo-sheet')) return json({ name: 'Local test fixture', source: 'demo', columns: [], rows: [] });
    if (p === '/versioning/branches/personal%2Fdemo-alice') return json({});
    return json({ branches: [], changes: [], tables: [], links: [], settings: {}, values: {} });
  }
  let file = join(root, path); if (!existsSync(file) || !extname(path)) file = join(root, 'index.csr.html');
  try { const body = readFileSync(file); res.writeHead(200, { 'content-type': ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)] ?? 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (let i = 0; i < 2; i++) {
    await page.goto(origin+'/workflows');
    await page.getByRole('link', { name: 'Local regression fixture', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/workflows');
  }
  assert.ok(calls.filter(c => c.p === '/plugins').every(c => c.branch === 'personal/demo-alice'));
  assert.ok(calls.filter(c => c.p === '/workflows').every(c => c.branch === 'personal/demo-alice'));
  await page.waitForFunction(() => !document.body.innerText.includes('Opening your branch'));
  await page.screenshot({ path: join(out, 'workflows-deeplink-fixed.png'), fullPage: true });
  enabled = false;
  await page.reload(); await page.waitForURL('**/plugins');
  await page.screenshot({ path: join(out, 'workflows-disabled-redirect.png'), fullPage: true });
  console.log(JSON.stringify({ passed: true, directAndRefresh: true, disabledStillBlocked: true, branchScopedCalls: calls.filter(c => c.p === '/plugins' || c.p === '/workflows'), screenshots: out }));
} finally { await browser.close(); await new Promise(r => server.close(r)); }
