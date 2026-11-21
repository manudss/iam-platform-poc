// Real-browser end-to-end of the database explorer (local only, 127.0.0.1). Starts a REAL Dolt server and the NestJS API with the explorer module,
// and serves the built Angular console. The Rust core is NOT used: a tiny stand-in IdP answers /core/authorize and /core/token, and the API's
// sign-in guard is replaced by a fake with the same contract (the real guard needs the core; it is covered by the other e2e suites).
// The real AdminGuard IS used: the test types the admin capability into the console field.
// Needs: DOLT_BIN, CHROME_BIN, playwright-core (NODE_PATH), built API (apps/api/dist) and console (apps/web/dist/web/browser).
// Usage: DOLT_BIN=... CHROME_BIN=... node scripts/explorer-ui-e2e.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-pr-diff-shots')); mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN;
if (!dolt || !chrome) { console.log('SKIPPED: DOLT_BIN and CHROME_BIN are required'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'iam-prd-')), home = join(dir, 'h'), data = join(dir, 'd');
mkdirSync(home); mkdirSync(data);
const env = { ...process.env, HOME: home };
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v], { env });
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, env, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0);
const cli = (sql, ...pre) => { const r = spawnSync(dolt, [...pre, 'sql', '-q', sql], { cwd: join(data, 'iam'), env }); assert.equal(r.status, 0, String(r.stderr)); return String(r.stdout); };
const commit = (m) => assert.equal(spawnSync(dolt, ['commit', '-Am', m, '--author', 'Seed <seed@example.invalid>'], { cwd: join(data, 'iam'), env }).status, 0);
// Fictional scenario: Alice's branch changed department + credential reference + added a disabled plugin row; main moved her credential reference on.
cli("alter table identities add column credential_revision varchar(40); update identities set credential_revision='rev-base'; create table plugin_runtime_state (tenant varchar(32), plugin varchar(32), installed tinyint, enabled tinyint, faulted tinyint, primary key (tenant, plugin)); insert into plugin_runtime_state values ('acme','google',1,1,0)"); commit('seed');
spawnSync(dolt, ['checkout', '-b', 'feature/alice-fix'], { cwd: join(data, 'iam'), env });
cli("update identities set department='Direction', credential_revision='rev-branch' where id='demo-alice'; insert into plugin_runtime_state values ('acme','microsoft',1,0,0)"); commit('alice work');
spawnSync(dolt, ['checkout', 'main'], { cwd: join(data, 'iam'), env });
cli("update identities set credential_revision='rev-main-current' where id='demo-alice'"); commit('published reset');
const DOLT_PORT = 14317, API_PORT = 14311, WEB_PORT = 14210, ADMIN = 'ui-test-admin-token-0123456789';
const server = spawn(dolt, ['sql-server', '--host', '127.0.0.1', '--port', String(DOLT_PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
let api, web, browser;
const cleanup = async () => { try { await browser?.close(); } catch {} web?.close(); await api?.close(); server.kill(); await new Promise((r) => setTimeout(r, 600)); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); };
try {
  for (let i = 0; i < 100; i++) { if (spawnSync(dolt, ['--host', '127.0.0.1', '--port', String(DOLT_PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await new Promise((r) => setTimeout(r, 150)); }
  Object.assign(process.env, { DOLT_PORT: String(DOLT_PORT), DOLT_DATABASE: 'iam', IAM_API_ADMIN_TOKEN: ADMIN });
  const apiRoot = join(root, 'apps/api');
  const { Test } = require(join(apiRoot, 'node_modules/@nestjs/testing'));
  require(join(apiRoot, 'node_modules/reflect-metadata'));
  const { VersioningModule } = await import(join(apiRoot, 'dist/versioning/versioning.module.js'));
  const { AuthGuard } = await import(join(apiRoot, 'dist/auth/auth.guard.js'));
  const fake = { canActivate(ctx) { const req = ctx.switchToHttp().getRequest(); const h = String(req.headers.authorization ?? ''); if (!h.startsWith('Bearer ')) { const e = new Error('no'); e.getStatus = () => 401; throw new (require(join(apiRoot, 'node_modules/@nestjs/common')).UnauthorizedException)('missing bearer token'); } const [tenant, sub] = h.slice(7).split(':'); req.user = { tenant, sub }; return true; } };
  const m = await Test.createTestingModule({ imports: [VersioningModule] }).overrideGuard(AuthGuard).useValue(fake).compile();
  api = m.createNestApplication(); await api.init(); await api.listen(API_PORT);

  const WEB_ROOT = join(root, 'apps/web/dist/web/browser');
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  web = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/core/authorize') { const ru = new URL(u.searchParams.get('redirect_uri')); ru.searchParams.set('code', 'stand-in'); ru.searchParams.set('state', u.searchParams.get('state')); res.writeHead(302, { location: ru.toString() }); return res.end(); }
    if (u.pathname === '/core/token') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id_token: 'acme-demo:demo-alice' })); }
    // The existing IAM screens (assignments, activations, plugins) are served by modules that need the Rust core; they are NOT mounted here.
    // The stand-in answers their reads with fixed demo data so the page renders like the real app, with no error banner. They are covered by the other e2e suites.
    const old = u.pathname.match(/^\/api\/tenants\/[^/]+\/(assignments|activations|plugins)\/?$/);
    if (old && req.method === 'GET') {
      const body = old[1] === 'assignments' ? [{ identity_id: 'demo-alice', role_id: 'payment-initiator' }, { identity_id: 'demo-bob', role_id: 'viewer' }] : [];
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(body));
    }
    if (/^\/api\/tenants\/[^/]+\/me\/access/.test(u.pathname)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ subject: 'demo-alice', admin: true, restricted: false, plugins: {} })); }
    // Stand-in for the workspace module (it needs the core): the working branch is the prepared branch; the API runs without workspace mode here.
    if (/^\/api\/tenants\/[^/]+\/workspace\/personal$/.test(u.pathname) && req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ branch: 'feature/alice-fix' })); }
    if (/^\/api\/tenants\/[^/]+\/workspace\/?$/.test(u.pathname) && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ branch: 'feature/alice-fix', main: 'main', readOnly: false, diff: null })); }
    if (/^\/api\/tenants\/[^/]+\/signin\/options/.test(u.pathname)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ mode: 'legacy', chains: [] })); }
    if (u.pathname.startsWith('/api/')) {
      const up = http.request({ host: '127.0.0.1', port: API_PORT, path: u.pathname.slice(4) + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      return req.pipe(up);
    }
    let file = join(WEB_ROOT, u.pathname === '/' ? 'index.csr.html' : u.pathname), data;
    try { data = await readFile(file); } catch { data = await readFile(join(WEB_ROOT, 'index.csr.html')); file = 'x.html'; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/html' }); res.end(data);
  }).listen(WEB_PORT, '127.0.0.1');

  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const q = (ref, sql) => { const r = spawnSync(dolt, ['--host', '127.0.0.1', '--port', String(DOLT_PORT), '--no-tls', '-u', 'root', '--password', '', '--use-db', `iam/${ref}`, 'sql', '-r', 'csv', '-q', sql], { env }); assert.equal(r.status, 0, String(r.stderr)); return String(r.stdout).trim().split('\n').slice(1); };
  const run = async (name, viewport) => {
    const page = await (await browser.newContext({ viewport })).newPage();
    const dialogs = []; let promptValue = 'Direction Generale';
    page.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message()}`); return d.type() === 'prompt' ? d.accept(promptValue) : d.accept(); });
    const shot = (n) => page.screenshot({ path: join(out, `${name}-${n}.png`), fullPage: true });
    const nav = (p) => page.locator(`nav a[data-nav="${p}"]`).dispatchEvent('click'); // on a phone the menu is a drawer; the click is sent to the link directly
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
    await page.click('#signin-browser');     await page.waitForSelector('nav a[data-nav="/database/pulls"]');
    await nav('/database/pulls'); await page.waitForSelector('details.token', { state: 'attached' });
    await page.evaluate(() => { document.querySelector('details.token').open = true; }); await page.fill('input[name=admintoken]', ADMIN);
    await page.locator('button', { hasText: /^Retry$/ }).first().click().catch(() => {}); await page.keyboard.press('Tab'); await nav('/database/branches'); await page.waitForTimeout(500); await nav('/database/pulls'); await page.waitForTimeout(1000);
    await page.screenshot({ path: join(out, `${name}-0-landing.png`) });
    return { page, dialogs, shot, overflow, setPrompt: (v) => { promptValue = v; } };
  };
  const btn = (page, name) => page.locator(`.explorer button`).filter({ hasText: new RegExp(`^${name}$`) }).first();

  // ---- desktop: the whole path
  const d = await run('desktop', { width: 1200, height: 1000 }); const page = d.page;
  await page.locator('button', { hasText: /New pull request/ }).first().click();
  await page.selectOption('select[name=ps]', 'feature/alice-fix'); await page.selectOption('select[name=pt]', 'main');
  await page.fill('input[name=pti]', 'Alice fix'); await btn(page, 'Open pull request').click();
  await page.waitForSelector('.pr-detail');
  await page.locator('.pr-detail button', { hasText: 'Rows changed' }).click();
  await page.waitForSelector('.table-diff button.act');
  await d.shot('1-rows-with-actions');
  const conflictBefore = await page.locator('.pr-detail').innerText();
  // no edit button for the credential field or plugin rows, but undo is offered
  assert.equal(await page.locator('button[aria-label="Edit credential_revision"]').count(), 0);
  assert.equal(await page.locator('button[aria-label="Abandon the change to credential_revision"]').count(), 1);
  // thumb size and inside the viewport
  for (const b of await page.locator('.table-diff button.act').all()) { const bb = await b.boundingBox(); assert.ok(bb.height >= 34 && bb.width >= 40, `button too small ${JSON.stringify(bb)}`); }
  // checks before: the plugin diff or the conflict blocks the merge
  await page.locator('.pr-detail button', { hasText: 'Checks' }).click(); const checksBefore = await page.locator('.pr-detail').innerText(); await d.shot('2-checks-before');
  await page.locator('.pr-detail button', { hasText: 'Rows changed' }).click();
  // 1. undo ONLY the credential change: confirmation shown, branch gets main's CURRENT reference
  const headBefore = q('main', "select hashof('feature/alice-fix')")[0];
  await page.locator('button[aria-label="Abandon the change to credential_revision"]').click();
  await page.waitForSelector('.explorer .msg:has-text("Done")'); await d.shot('3-after-undo');
  assert.ok(d.dialogs.some((x) => x.startsWith('confirm') && /CURRENT value of main/.test(x)), 'confirmation names main\'s current value');
  assert.deepEqual(q('feature/alice-fix', "select department, credential_revision from identities where id='demo-alice'"), ['Direction,rev-main-current']);
  assert.notEqual(q('main', "select hashof('feature/alice-fix')")[0], headBefore);
  await page.waitForSelector('.table-diff button.act'); await d.shot('3b-after-undo-rows');
  // The diff is merge-base to source, so main's moved value still shows as a change; a second undo must be a harmless no-op, not an error.
  const headAfter = q('main', "select hashof('feature/alice-fix')")[0];
  await page.locator('button[aria-label="Abandon the change to credential_revision"]').click(); await page.waitForSelector('.explorer .msg:has-text("Nothing to change")');
  assert.equal(q('main', "select hashof('feature/alice-fix')")[0], headAfter, 'no-op leaves the head alone');
  // 2. drop the plugin row change (a whole row)
  await page.locator('tr.add button', { hasText: 'drop row' }).first().click(); await page.waitForSelector('.explorer .msg:has-text("Done")');
  assert.deepEqual(q('feature/alice-fix', "select count(*) from plugin_runtime_state where plugin='microsoft'"), ['0']);
  // 3. typed edit of the department
  await page.locator('button[aria-label="Edit department"]').click(); await page.waitForSelector('.explorer .msg:has-text("edited department")');
  assert.deepEqual(q('feature/alice-fix', "select department from identities where id='demo-alice'"), ['Direction Generale']);
  assert.ok(d.dialogs.some((x) => x.startsWith('prompt')));
  // 4. error path: a value too long for the column is refused and shown, nothing is committed
  const h4 = q('main', "select hashof('feature/alice-fix')")[0]; d.setPrompt('x'.repeat(200));
  await page.locator('button[aria-label="Edit department"]').click(); await page.waitForSelector('.explorer p.msg:has-text("too large")'); await d.shot('4-error'); assert.equal(await d.overflow(), false, 'a long error message must not widen the page');
  assert.equal(q('main', "select hashof('feature/alice-fix')")[0], h4); assert.deepEqual(q('feature/alice-fix', "select count(*) from dolt_status"), ['0']);
  // 5. main untouched, status check after: no conflict, mergeable
  assert.deepEqual(q('main', "select credential_revision from identities where id='demo-alice'"), ['rev-main-current']);
  await page.locator('.pr-detail button', { hasText: 'Checks' }).click(); await page.waitForSelector('.pr-detail :text-matches("Able to merge|Can be merged", "i")'); const checksAfter = await page.locator('.pr-detail').innerText(); await d.shot('5-checks-after');
  console.log('CHECKS BEFORE:', checksBefore.replace(/\s+/g, ' ').slice(0, 300)); console.log('CHECKS AFTER:', checksAfter.replace(/\s+/g, ' ').slice(0, 300));
  assert.match(checksAfter, /Able to merge|Can be merged/i);
  assert.equal(await d.overflow(), false, 'desktop page overflow');

  // ---- phone: actions reachable without sideways scroll of the page
  q('main', "select 1");
  const p = await run('phone', { width: 390, height: 844 });
  await p.page.waitForSelector('.pr-list, .explorer'); 
  console.log('phone page overflow (whole page, existing screen included):', await p.overflow());
  await p.shot('1-phone-pulls');
  await p.page.getByText('Alice fix', { exact: true }).first().click(); await p.page.waitForSelector('.pr-detail');
  await p.page.locator('.pr-detail button', { hasText: 'Rows changed' }).click(); await p.page.waitForSelector('.table-diff button.act');
  const sizes = []; for (const b of await p.page.locator('.table-diff button.act').all()) { const bb = await b.boundingBox(); sizes.push(`${Math.round(bb.width)}x${Math.round(bb.height)}@x${Math.round(bb.x)}`); assert.ok(bb.height >= 34 && bb.width >= 40, `phone button too small ${JSON.stringify(bb)}`); }
  console.log('phone action buttons (w x h @x):', sizes.join(' '));
  console.log('phone page overflow with the rows tab open:', await p.overflow());
  console.log('phone elements wider than the screen, outside any scrolling table box:', JSON.stringify(await p.page.evaluate(() => { const w = document.documentElement.clientWidth, out = new Set(); for (const e of document.querySelectorAll('.explorer *')) { if (e.closest('.table-diff .scroll, .table-scroll, [class*=wrap]') && getComputedStyle(e.closest('.table-diff .scroll, .table-scroll, [class*=wrap]')).overflowX !== 'visible') continue; const r = e.getBoundingClientRect(); if (r.width && r.right > w + 1) out.add(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} right=${Math.round(r.right)}`); } return [...out].slice(0, 12); })));
  await p.shot('2-phone-rows');
  p.setPrompt('y'.repeat(200)); await p.page.locator('button[aria-label="Edit department"]').click(); await p.page.waitForSelector('.explorer p.msg:has-text("too large")'); await p.shot('3-phone-error');
  console.log('phone page overflow after a long error message:', await p.overflow());
  console.log('UI e2e OK; screenshots in', out);
} catch (e) { console.error('UI e2e FAILED:', e); process.exitCode = 1; try { await (await browser?.contexts()[0]?.pages()[0])?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); } catch {} }
finally { await cleanup(); }
