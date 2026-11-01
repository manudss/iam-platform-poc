// Real-browser UI end-to-end (local only): starts Dolt, the Rust core, the NestJS API and `ng serve`, then drives the Angular administration (sidebar pages, deep links, refresh, mobile) with headless Chrome through playwright-core, and saves screenshots. Binds to 127.0.0.1 only.
// console with headless Chrome through playwright-core, and saves screenshots. Binds to 127.0.0.1 only.
// Needs: DOLT_BIN, CHROME_BIN, playwright-core resolvable (npm i playwright-core), built core and API (core/target/debug/iam-core, apps/api/dist).
// Usage: DOLT_BIN=... CHROME_BIN=... node scripts/ui-e2e.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core'); // honours NODE_PATH

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-ui-shots'));
mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN;
if (!dolt || !chrome) { console.log('SKIPPED: DOLT_BIN and CHROME_BIN are required'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'iam-ui-')), home = join(dir, 'h'), data = join(dir, 'd');
mkdirSync(home); mkdirSync(data);
const env = { ...process.env, HOME: home };
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v], { env });
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, env, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0);
const procs = [];
// Each child starts in its OWN process group (detached) so the whole tree (npx -> ng serve, node, ...) can be stopped by group, never by a name pattern.
const run = (cmd, args, opts) => procs.push(spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts }));
const portOpen = (port) => new Promise((ok) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); ok(true); }); c.once('error', () => ok(false)); });
// Descendants of the children we started, snapshotted BEFORE stopping anything (`ng serve` moves its server into its own session, so a group kill alone misses it).
const descendants = (roots) => {
  const rows = spawnSync('ps', ['-e', '-o', 'pid=,ppid=']).stdout.toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const out = []; const walk = (pid) => { for (const k of kids.get(pid) ?? []) { walk(k); out.push(k); } }; roots.forEach(walk);
  return out; // leaves first
};
const stopAll = async () => {
  const tree = descendants(procs.map((p) => p.pid));
  for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (let i = 0; i < 40 && ((await portOpen(4200)) || (await portOpen(8081)) || (await portOpen(3000)) || (await portOpen(3307))); i++) {
    if (i === 20) { for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } }
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const port of [4200, 8081, 3000, 3307]) if (await portOpen(port)) console.log('WARNING: port ' + port + ' still in use after cleanup');
};
run(dolt, ['sql-server', '--host', '127.0.0.1', '--port', '3307', '--data-dir', data], { cwd: data, env });
const GATE = { IAM_AUTH_GATE_ADDR: '127.0.0.1:3000', IAM_AUTH_GATE_TOKEN: 'local-gate-token-demo' }; // sign-in goes through the plugin gate (API on :3000)
const ADMIN_TOKEN = 'local-demo-plugin-admin-token';
run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), env: { ...process.env, ...GATE } });
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { // records every distinct [role=status] text of the current document
    window.__statuses = [];
    const rec = () => { for (const e of document.querySelectorAll('[role=status]')) { const t = (e.textContent ?? '').trim(); if (t && !window.__statuses.includes(t)) window.__statuses.push(t); } };
    new MutationObserver(rec).observe(document, { subtree: true, childList: true, characterData: true });
  });
  page.on('dialog', (d) => d.accept());
  const BASE = 'http://localhost:4200';
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: true });
  const path = () => new URL(page.url()).pathname;
  const status = (txt) => page.waitForFunction((t) => [...document.querySelectorAll('[role=status]')].some((e) => e.textContent?.includes(t)), txt);
  const noBanner = async (label) => { assert.equal(await page.locator('[role=alert]').count(), 0, label + ': no alert'); const t = (await page.textContent('body')) ?? ''; assert.ok(!/Cannot GET|Internal server error|HTTP 5\d\d|Failed to fetch|admin capability required/.test(t), label + ': no error banner'); };
  const nav = (p) => page.click(`nav a[data-nav="${p}"]`);
  const setToken = async () => { await page.evaluate(() => { document.querySelector('details.token').open = true; }); await page.fill('input[name=admintoken]', ADMIN_TOKEN); };
  // the core login form: wrong password first when asked, then the right one; returns to the console
  const coreLogin = async (wrongFirst = false) => {
    await page.waitForSelector('#signin-browser');
    await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.click('#signin-browser')]);
    await page.waitForSelector('input[name=password]');
    if (wrongFirst) {
      await shot('1b-core-login-form');
      await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'wrong');
      await Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
      await page.waitForSelector('text=Wrong user or password');
    }
    await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
    await Promise.all([page.waitForURL(/localhost:4200(?!\/core)/), page.click('button[type=submit]')]);
  };

  // ---- sign-in: forged callback, protected deep link, return to the page asked for ----
  await page.goto(`${BASE}/callback?code=attacker-code&state=forged-state`);
  await status('state mismatch');
  assert.equal(path(), '/login'); assert.equal(new URL(page.url()).search, ''); // the code left the address bar
  assert.equal(await page.locator('nav').count(), 0, 'no administration layout without a token');
  await page.goto(`${BASE}/database/pulls`);
  await page.waitForSelector('#signin-browser'); assert.equal(path(), '/login'); await shot('1-signin');
  await coreLogin(true);
  await page.waitForSelector('nav a.active[data-nav="/database/pulls"]');
  assert.equal(path(), '/database/pulls'); assert.equal(new URL(page.url()).search, ''); // back on the page that was asked for, no code or state left
  // The console later replaces this message (e.g. when it opens the personal branch), so the sign-in message is read from every status text seen by this document, not only the current one.
  assert.ok((await page.evaluate(() => window.__statuses)).some((t) => t.includes('browser flow')), 'the browser-flow sign-in message was shown');
  assert.match(await page.locator('header .who').innerText(), /demo-alice/);
  await shot('2-signed-in-deep-link');

  // ---- IAM pages: assignments, SoD, merge, activation ----
  await page.setViewportSize({ width: 1280, height: 900 });
  await nav('/assignments');
  try { await page.waitForSelector('#assignments td:text-is("demo-bob")', { timeout: 30000 }); }
  catch (e) { // diagnostics for CI: what the page really showed, so a failure is explainable from the log alone
    console.log('DIAG url', page.url(), '\nDIAG statuses', JSON.stringify(await page.evaluate(() => window.__statuses)), '\nDIAG body', (await page.evaluate(() => document.body.innerText)).slice(0, 1500));
    await shot('diag-assignments').catch(() => undefined); throw e;
  }
  assert.ok((await page.locator('#assignments tr', { hasText: 'demo-bob' }).first().innerText()).includes('payment-creator'));
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  await page.waitForSelector('text=SoD: demo-bob has payment-creator and payment-approver');
  await shot('3-sod-violation');
  await page.getByRole('button', { name: 'Merge into main' }).click(); await status('Merge refused (409)');
  await page.fill('input[name=identity]', 'demo-alice'); await page.fill('input[name=role]', 'accountant');
  await page.getByRole('button', { name: 'Simulate', exact: true }).click(); await status('Simulation OK');
  await page.getByRole('button', { name: 'Merge into main' }).click(); await status('Merged into main');
  await page.waitForSelector('#assignments td:text-is("accountant")');
  await nav('/activation');
  await page.getByRole('button', { name: 'Activate current main' }).click(); await status('Activated main head as #1');
  await page.waitForSelector('td:text-is("#1")'); await shot('4-activated');
  await nav('/overview'); await page.waitForSelector('.stat'); assert.ok((await page.locator('.stat').count()) >= 5); await noBanner('overview'); await shot('4b-overview');

  // ---- plugins ----
  await nav('/plugins'); await page.waitForSelector('#plugins table');
  await setToken(); await noBanner('plugins list'); await shot('5-plugins-list');
  const row = page.locator('tr[data-plugin=auth-password-lockout]');
  await row.getByRole('button', { name: 'Manage' }).click();
  await page.waitForFunction(() => location.pathname === '/plugins/auth-password-lockout');
  await page.locator('input[name=gi]').check(); await page.click('#plugin-install');
  await page.waitForFunction(() => /Installed/.test(document.querySelector('#plugin-note')?.textContent ?? ''));
  await page.waitForSelector('#plugin-form');
  await page.locator('label[data-field=maxFailures] input').fill('3'); await page.click('#plugin-save');
  await page.waitForFunction(() => /saved|Saved|configured/i.test(document.querySelector('#plugin-note')?.textContent ?? ''));
  assert.equal(await page.locator('label[data-field=maxFailures] input').inputValue(), '3', 'the saved value comes back from the API');
  await page.locator('[data-hook="auth.authenticate"]').check(); await page.click('#plugin-enable');
  await page.waitForSelector('#plugin-disable');
  await noBanner('enabled'); await shot('6-plugin-enabled');
  await page.click('#plugin-disable'); await page.waitForSelector('#plugin-enable');
  await noBanner('disabled'); await shot('7-plugin-disabled-back-to-base');

  // refresh on a deep link: the in-memory token is gone, so sign-in comes first and then the same plugin page opens again
  await page.reload(); await page.waitForSelector('#signin-browser'); assert.equal(path(), '/login');
  await coreLogin();
  await page.waitForSelector('#plugins table'); assert.equal(path(), '/plugins/auth-password-lockout');
  await page.waitForSelector('#plugin-form'); await noBanner('plugin deep link after refresh'); await shot('7b-plugin-deep-link-after-refresh');
  await setToken();

  // ---- hooks journal plugin: off by default, enable, a REAL hook call (sign-in gate -> plugin registry), read it, rights, disable ----
  const gate = (subject) => fetch('http://127.0.0.1:3000/internal/auth/authenticate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': GATE.IAM_AUTH_GATE_TOKEN }, body: JSON.stringify({ tenant: 'acme-demo', subject, password: 'Pa55-never-stored-' + subject }) });
  assert.equal(await page.locator('nav a[data-nav="/journal"]').count(), 0, 'journal menu entry absent while the plugin is off');
  await nav('/plugins'); await page.waitForSelector('#plugins table');
  await gate('e2e-before-enable'); // a real hook call made while the plugin is off: must never appear
  await page.locator('tr[data-plugin=hooks-journal]').getByRole('button', { name: 'Manage' }).click();
  await page.waitForFunction(() => location.pathname === '/plugins/hooks-journal');
  await page.click('#plugin-install'); await page.waitForFunction(() => /Installed/.test(document.querySelector('#plugin-note')?.textContent ?? ''));
  await page.click('#plugin-enable'); await page.waitForSelector('#plugin-disable');
  await page.waitForSelector('nav a[data-nav="/journal"]', { timeout: 15000 });
  const r1 = await gate('e2e-journal-A'); assert.equal(r1.status, 200); // real auth.authenticate through the registry
  await nav('/journal'); await page.waitForSelector('#jr-table');
  await page.click('#jr-next'); await page.waitForSelector('#jr-step');
  const stepText = await page.locator('#jr-step').innerText();
  assert.match(stepText, /auth\.authenticate/); assert.match(stepText, /auth-password/); assert.match(stepText, /\[masked\]/);
  const body1 = (await page.textContent('body')) ?? '';
  assert.ok(!body1.includes('Pa55-never-stored'), 'no password in the journal page'); assert.ok(!body1.includes('e2e-before-enable'), 'nothing before the plugin was enabled');
  assert.match(body1, /e2e-journal-A/); assert.equal(await page.locator('#jr-table tbody tr').count(), 1);
  const pos0 = await page.inputValue('#jr-scrub'); await page.selectOption('#jr-speed', { label: 'Fit the period in 60 s' }); await page.click('#jr-play');
  await page.waitForFunction((p) => document.querySelector('#jr-scrub').value !== p, pos0); await page.click('#jr-play');
  assert.match(await page.locator('#jr-clock').innerText(), /no hook is called again/);
  await shot('6b-journal-player');
  // rights: without the admin capability the journal answers 403 (the token is only typed in the console on local setups)
  await page.evaluate(() => { document.querySelector('details.token').open = true; }); await page.fill('input[name=admintoken]', ''); await page.click('#jr-period'); await page.selectOption('#jr-period', '1h');
  await page.waitForSelector('#jr-problem'); assert.match(await page.locator('#jr-problem').innerText(), /admin/i); await setToken();
  // disable: the page disappears, a call made while disabled is not recorded after re-enabling
  await nav('/plugins'); await page.locator('tr[data-plugin=hooks-journal]').getByRole('button', { name: 'Manage' }).click();
  await page.click('#plugin-disable'); await page.waitForSelector('#plugin-enable');
  await page.waitForFunction(() => !document.querySelector('nav a[data-nav="/journal"]'), null, { timeout: 15000 });
  await gate('e2e-while-disabled'); await page.click('#plugin-enable'); await page.waitForSelector('#plugin-disable');
  await gate('e2e-journal-C'); await nav('/journal'); await page.waitForSelector('#jr-table'); await page.click('#jr-period'); await page.selectOption('#jr-period', '24h');
  await page.locator('#jr-scrub').fill('1000'); // move to the end of the period: every recorded call has been "seen"
  await page.waitForSelector('#jr-table tbody tr td:has-text("auth.authenticate")');
  await page.waitForFunction(() => document.querySelectorAll('#jr-table tbody tr').length >= 2);
  assert.equal(await page.locator('#jr-table tbody tr').count(), 2, 'A and C only: the call made while disabled is absent');
  await noBanner('journal');

  // ---- database explorer, section by section (one component instance across the sections) ----
  await page.setViewportSize({ width: 1280, height: 1100 });
  const btn = (name, scope = '.explorer') => page.locator(`${scope} button`).filter({ hasText: new RegExp(`^${name}$`) }).first();
  await nav('/database/branches'); await page.waitForSelector('text=protected'); await shot('8-explorer-1-branches');
  await page.fill('input[name=nb]', 'ui-demo'); await btn('Create branch').click(); await page.waitForSelector('td:has-text("ui-demo")');
  await nav('/database/data'); await page.selectOption('select[name=dr]', 'ui-demo'); await page.click('button:has-text("roles")');
  await page.waitForSelector('th:has-text("label")');
  await btn('Add a row').click();
  await page.fill('textarea[name=ej]', JSON.stringify({ id: 'auditor', label: 'Auditor', is_sensitive: 0 }));
  await page.fill('input[name=em]', 'add auditor role'); await btn('Commit change').click();
  await page.waitForSelector('td:has-text("Auditor")'); await shot('8-explorer-2-data-edit');
  await page.selectOption('select[name=dr]', 'main'); await page.click('button:has-text("roles")'); await page.waitForSelector('text=read only');
  assert.equal(await page.locator('.explorer button:text-is("Edit")').count(), 0);
  await nav('/database/compare'); await page.selectOption('select[name=cf]', 'main'); await page.selectOption('select[name=ct]', 'ui-demo'); await btn('Compare', '.explorer form').click();
  await page.click('button:has-text("show rows")'); await page.waitForSelector('tr.add'); await shot('8-explorer-3-compare');
  await nav('/database/sql'); await page.selectOption('select[name=sr]', 'main'); await page.selectOption('select[name=sm]', 'write');
  await page.fill('textarea[name=sq]', "insert into roles values ('x','x',false)"); await btn('Apply and commit').click();
  await page.waitForSelector('.explorer .msg:has-text("protected")');
  await page.selectOption('select[name=sr]', 'ui-demo'); await page.fill('textarea[name=sq]', "update roles set label = 'Internal auditor' where id = 'auditor'"); await btn('Preview changes').click();
  await page.waitForSelector('text=Preview only'); await shot('8-explorer-4-sql-preview');
  await page.selectOption('select[name=sm]', 'read'); await page.fill('textarea[name=sq]', 'select * from mysql.user'); await btn('Run').click();
  await page.waitForSelector('.explorer .msg:has-text("not reachable")');
  await nav('/database/pulls'); await page.selectOption('select[name=ps]', 'ui-demo'); await page.selectOption('select[name=pt]', 'main');
  await page.fill('input[name=pti]', 'Add auditor role'); await btn('Open pull request').click();
  await page.waitForSelector('text=Can be merged');
  assert.equal(await btn('Approve').isDisabled(), true); await page.waitForSelector('text=someone else has to approve');
  assert.equal(await page.locator('.msg.error').count(), 0); await page.waitForSelector('text=demo-alice');
  await shot('8-explorer-5-pull-request');
  await btn('Merge').click(); await page.waitForSelector('.explorer .msg:has-text("Merged as")');
  await nav('/database/history'); await page.selectOption('select[name=hr]', 'main'); await page.waitForSelector('li.merge'); await shot('8-explorer-6-history');
  assert.match(await page.locator('.explorer ol.log').innerText(), /Merge pull request #1: Add auditor role/);
  await noBanner('explorer end');
  // an internal jump changes the address too: branches -> compare with main
  await nav('/database/branches'); await page.waitForSelector('text=protected');
  // the IAM pages still work after the explorer merged a PR into Dolt main
  await nav('/activation');
  await page.getByRole('button', { name: 'Activate current main' }).click(); await status('Activated main head as #2');
  await noBanner('activation after PR merge');

  // ---- phone width: no sideways scroll, the menu opens from the burger, pages stay usable ----
  await page.setViewportSize({ width: 390, height: 800 });
  for (const p of ['/overview', '/assignments', '/plugins', '/database/branches', '/database/data', '/database/pulls']) {
    await page.goto(BASE + p).catch(() => {}); // a full load drops the token: sign in again, which lands back on the same page
    await page.waitForSelector('#signin-browser, main.content section, main.content .stats');
    if (path() === '/login') await coreLogin();
    await page.waitForFunction((x) => location.pathname.startsWith(x), p);
    await page.waitForSelector('main.content section, main.content .stats');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 2, `${p}: horizontal overflow of ${over}px at 390px`);
  }
  await page.click('button.burger'); await page.waitForSelector('.layout.open nav a'); await page.waitForTimeout(500); await page.screenshot({ path: join(out, '9-mobile-menu.png') });
  await page.click('nav a[data-nav="/overview"]'); await page.waitForFunction(() => !document.querySelector('.layout.open'));
  await page.waitForTimeout(500); await page.screenshot({ path: join(out, '9-mobile-overview.png') });
  assert.deepEqual(errors, [], 'no page errors');
  console.log('UI E2E PASSED; screenshots in ' + out);
} finally {
  await browser?.close(); await stopAll(); rmSync(dir, { recursive: true, force: true });
}
