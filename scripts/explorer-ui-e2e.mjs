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
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-explorer-shots')); mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN;
if (!dolt || !chrome) { console.log('SKIPPED: DOLT_BIN and CHROME_BIN are required'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'iam-exp-')), home = join(dir, 'h'), data = join(dir, 'd');
mkdirSync(home); mkdirSync(data);
const env = { ...process.env, HOME: home };
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v], { env });
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, env, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0);
const DOLT_PORT = 14307, API_PORT = 14301, WEB_PORT = 14200, ADMIN = 'ui-test-admin-token-0123456789';
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
    if (u.pathname.startsWith('/api/')) {
      const up = http.request({ host: '127.0.0.1', port: API_PORT, path: u.pathname.slice(4) + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      return req.pipe(up);
    }
    let file = join(WEB_ROOT, u.pathname === '/' ? 'index.html' : u.pathname), data;
    try { data = await readFile(file); } catch { data = await readFile(join(WEB_ROOT, 'index.html')); file = 'x.html'; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/html' }); res.end(data);
  }).listen(WEB_PORT, '127.0.0.1');

  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 1500 } })).newPage();
  page.on('dialog', (d) => d.accept());
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: true });
  const status = () => page.locator('.explorer .msg').first().innerText();
  const btn = (name, scope = '.explorer') => page.locator(`${scope} button`).filter({ hasText: new RegExp(`^${name}$`) }).first();

  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await page.click('#signin-browser'); await page.waitForSelector('app-dolt-explorer');
  await page.fill('input[name=vadmin]', ADMIN);
  await btn('Branches').click(); await page.waitForSelector('text=protected');
  await shot('1-branches');

  // new branch from main
  await page.fill('input[name=nb]', 'ui-demo'); await btn('Create branch').click(); await page.waitForSelector('td:has-text("ui-demo")');
  // edit a row on the branch through the Data tab
  await btn('Data').click(); await page.selectOption('select[name=dr]', 'ui-demo'); await page.click('button:has-text("roles")');
  await page.waitForSelector('th:has-text("label")');
  await btn('Add a row').click();
  await page.fill('textarea[name=ej]', JSON.stringify({ id: 'auditor', label: 'Auditor', is_sensitive: 0 }));
  await page.fill('input[name=em]', 'add auditor role'); await btn('Commit change').click();
  await page.waitForSelector('td:has-text("Auditor")'); await shot('2-data-edit');
  // main is read only
  await page.selectOption('select[name=dr]', 'main'); await page.click('button:has-text("roles")'); await page.waitForSelector('text=read only');
  assert.equal(await page.locator('.explorer button:text-is("Edit")').count(), 0);
  // compare
  await btn('Compare').first().click(); await page.selectOption('select[name=cf]', 'main'); await page.selectOption('select[name=ct]', 'ui-demo'); await btn('Compare', '.explorer form').click();
  await page.click('button:has-text("show rows")'); await page.waitForSelector('tr.add'); await shot('3-compare');
  // SQL: a write on main is refused, a dry run on the branch shows the change
  await btn('SQL').click(); await page.selectOption('select[name=sr]', 'main'); await page.selectOption('select[name=sm]', 'write');
  await page.fill('textarea[name=sq]', "insert into roles values ('x','x',false)"); await btn('Apply and commit').click();
  await page.waitForSelector('.explorer .msg:has-text("protected")');
  await page.selectOption('select[name=sr]', 'ui-demo'); await page.fill('textarea[name=sq]', "update roles set label = 'Internal auditor' where id = 'auditor'"); await btn('Preview changes').click();
  await page.waitForSelector('text=Preview only'); await shot('4-sql-preview');
  await page.selectOption('select[name=sm]', 'read'); await page.fill('textarea[name=sq]', "select * from mysql.user"); await btn('Run').click();
  await page.waitForSelector('.explorer .msg:has-text("not reachable")');
  // pull request, merge
  await btn('Pull requests').click(); await page.selectOption('select[name=ps]', 'ui-demo'); await page.selectOption('select[name=pt]', 'main');
  await page.fill('input[name=pti]', 'Add auditor role'); await btn('Open pull request').click();
  await page.waitForSelector('text=Can be merged');
  // the author (demo-alice) cannot approve through the UI
  assert.equal(await btn('Approve').isDisabled(), true); await page.waitForSelector('text=someone else has to approve');
  assert.doesNotMatch(await page.locator('p.msg').first().innerText(), /Cannot|error|failed/i); await page.waitForSelector('text=demo-alice');
  await shot('5-pull-request');
  await btn('Merge').click(); await page.waitForSelector('.explorer .msg:has-text("Merged as")');
  // history on main shows the merge commit
  await btn('History').click(); await page.selectOption('select[name=hr]', 'main'); await page.waitForSelector('li.merge'); await shot('6-history');
  const text = await page.locator('.explorer ol.log').innerText(); assert.match(text, /Merge pull request #1: Add auditor role/);
  console.log('UI e2e OK; screenshots in', out);
} catch (e) { console.error('UI e2e FAILED:', e); process.exitCode = 1; try { await (await browser?.contexts()[0]?.pages()[0])?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); } catch {} }
finally { await cleanup(); }
