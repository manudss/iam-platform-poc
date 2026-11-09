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
import { openManage } from './branch-ui.mjs';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const CORE_TOKEN = 'local-core-admin-token-demo';
// Step 3: the API requires the real event bus; CI provides NATS_SERVER_BIN.
const NATS = process.env.NATS_SERVER_BIN ?? process.env.NATS_BIN;
assert.ok(NATS, 'NATS_SERVER_BIN is required');
if (NATS) { run(NATS, ['-c', join(root, 'conf/nats-local.conf')]); await sleep(1000); }
run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), env: { ...process.env, ...GATE, IAM_CORE_ADMIN_TOKEN: CORE_TOKEN, ...(NATS ? { IAM_CORE_NATS_URL: '127.0.0.1:4222', IAM_CORE_NATS_PASSWORD: 'core-dev' } : {}) } });
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_BUS_NATS_URL: '127.0.0.1:4222', IAM_BUS_NATS_USER: 'api-host', IAM_BUS_NATS_PASSWORD: 'api-host-dev', IAM_WORKSPACE_MODE: '1', IAM_PLUGIN_STORE: 'dolt', IAM_DIRECTORY_AUTH: '1', IAM_CREDENTIAL_FILE: join(dir, 'credentials.json'), IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_CORE_ADMIN_TOKEN: CORE_TOKEN, IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } }); // the console is built for workspace mode (personal branch + Review & Apply), like demo/start.sh and scripts/workspace-e2e.mjs
if (!process.env.WEB_ALREADY_SERVED) run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
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
  const noBanner = async (label) => { const alerts = await page.locator('[role=alert]').allTextContents(); assert.equal(alerts.length, 0, label + ': no alert (got: ' + JSON.stringify(alerts) + ')'); const t = (await page.textContent('body')) ?? ''; assert.ok(!/Cannot GET|Internal server error|HTTP 5\d\d|Failed to fetch|admin capability required/.test(t), label + ': no error banner'); };
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

  // ---- public privacy page: no sign-in, reachable at /privacy (required by the e-mail sending configuration) ----
  await page.goto(`${BASE}/privacy`);
  await page.waitForSelector('#privacy-page');
  const privacy = (await page.textContent('#privacy-page')) ?? '';
  assert.match(privacy, /Politique de confidentialité/);
  assert.match(privacy, /Resend/);
  assert.match(privacy, /iam@dss\.name/);
  assert.equal(await page.locator('nav').count(), 0, 'privacy page shows no administration layout');
  await shot('1a-privacy');

  await page.goto(`${BASE}/database/pulls`);
  await page.waitForSelector('#signin-browser'); assert.equal(path(), '/login'); await shot('1-signin');
  await coreLogin(true);
  await page.waitForSelector('nav a.active[data-nav="/database/pulls"]');
  assert.equal(path(), '/database/pulls'); assert.equal(new URL(page.url()).search, ''); // back on the page that was asked for, no code or state left
  // The console later replaces this message (e.g. when it opens the personal branch), so the sign-in message is read from every status text seen by this document, not only the current one.
  assert.ok((await page.evaluate(() => window.__statuses)).some((t) => t.includes('browser flow')), 'the browser-flow sign-in message was shown');
  assert.match(await page.locator('header .who').innerText(), /demo-alice/);
  await shot('2-signed-in-deep-link');

  // Workspace administration is fail-closed: without the admin capability token the console asks for it and opens no data branch.
  // (the bar may show the mapped sentence or the raw "admin capability required" of the next guarded call, so match the stable part)
  try { await page.waitForFunction(() => document.body.innerText.includes('admin capability') && document.body.innerText.includes('Choose your working branch')); }
  catch (e) { // diagnostics for CI: what the page really showed, so a failure is explainable from the log alone
    console.log('DIAG url', page.url(), '\nDIAG statuses', JSON.stringify(await page.evaluate(() => window.__statuses)), '\nDIAG body', (await page.evaluate(() => document.body.innerText)).slice(0, 1500));
    await shot('diag-token-gate').catch(() => undefined); throw e;
  }
  await setToken();
  await openManage(page); await page.getByRole('button', { name: 'Refresh branches' }).click();
  await status('personal branch');

  // ---- IAM pages: assignments, SoD staging, refused then successful Review & Apply, activation journal ----
  await page.setViewportSize({ width: 1280, height: 900 });
  await nav('/assignments');
  try { await page.waitForSelector('#assignments tr:has-text("demo-bob")', { timeout: 30000 }); }
  catch (e) { // diagnostics for CI: what the page really showed, so a failure is explainable from the log alone
    console.log('DIAG url', page.url(), '\nDIAG statuses', JSON.stringify(await page.evaluate(() => window.__statuses)), '\nDIAG body', (await page.evaluate(() => document.body.innerText)).slice(0, 1500));
    await shot('diag-assignments').catch(() => undefined); throw e;
  }
  assert.ok((await page.locator('#assignments tr', { hasText: 'demo-bob' }).first().innerText()).includes('payment-creator'));
  await page.locator('#assignments tr', { hasText: 'demo-bob' }).first().getByRole('button', { name: 'Manage roles' }).click();
  await page.selectOption('select[name=assignmentRole]', 'payment-approver');
  // Stage the SoD-conflicting assignment on the personal branch, then try to publish it: Apply must be refused with the violation.
  await page.getByRole('button', { name: 'Stage assignment' }).click();
  await page.waitForSelector('text=SoD: demo-bob has payment-creator and payment-approver');
  await shot('3-sod-violation');
  await page.getByRole('button', { name: 'Close assignment editor' }).click();
  await page.waitForSelector('#assignment-editor', { state: 'detached' });
  await page.click('#review-apply'); await page.waitForSelector('#workspace-apply');
  await page.click('#workspace-apply'); await status('Apply refused');
  // The refused change stays on its branch. A clean change goes from a fresh branch to main and is journaled as an activation.
  await openManage(page); await page.fill('input[name=workspaceNewBranch]', 'ui-clean'); await page.getByRole('button', { name: 'Create & select' }).click();
  await status('Working on ui-clean');
  await page.waitForSelector('#assignments tr:has-text("demo-alice")');
  await page.locator('#assignments tr', { hasText: 'demo-alice' }).first().getByRole('button', { name: 'Manage roles' }).click();
  await page.selectOption('select[name=assignmentRole]', 'accountant');
  await page.getByRole('button', { name: 'Stage assignment' }).click(); await status('Simulation OK');
  await page.getByRole('button', { name: 'Close assignment editor' }).click();
  await page.waitForSelector('#assignment-editor', { state: 'detached' });
  await page.click('#review-apply'); await page.waitForSelector('#workspace-apply');
  await page.click('#workspace-apply'); await status('Applied');
  await nav('/assignments'); await page.waitForSelector('#assignments .pill:text-is("accountant")');
  await nav('/activation'); await page.waitForSelector('td:text-is("#1")'); await shot('4-activated');
  await nav('/overview'); await page.waitForSelector('.stat'); assert.ok((await page.locator('.stat').count()) >= 5); await noBanner('overview'); await shot('4b-overview');

  // ---- event bus observer (real core + NATS; only with NATS_BIN) ----
  if (NATS) {
    await nav('/event-bus'); await page.waitForSelector('#bo-player');
    await noBanner('event bus');
    await page.waitForFunction(() => document.querySelector('#bo-since')?.textContent?.match(/[1-9]\d* exchange/));
    await page.selectOption('#bo-speed', { label: 'x10' }); await page.click('#bo-next');
    await page.fill('#bo-scrub', '1000'); await page.dispatchEvent('#bo-scrub', 'input');
    await page.waitForSelector('#bo-table tbody tr td:text("activation.applied")');
    const row = page.locator('#bo-table tbody tr', { hasText: 'activation.applied' }).first();
    assert.ok((await row.textContent()).includes('audit-log'), 'who answered is shown');
    assert.ok(await row.locator('.chip:text("queued: mail-notifier")').count(), 'the durable queue receipt is shown, not mislabelled silent');
    const body = (await page.textContent('body')) ?? '';
    assert.ok(!/local-core-admin-token-demo|local-demo-plugin-admin-token|core-dev/.test(body), 'no secret on the page');
    assert.equal(await page.locator('#bo-player button:text-matches("send|emit|replay again|re-run", "i")').count(), 0, 'no write control');
    await shot('4c-event-bus');
  }

  // ---- plugins ----
  await nav('/plugins'); await page.waitForSelector('#plugins table');
  await setToken(); await noBanner('plugins list'); await shot('5-plugins-list');
  const row = page.locator('tr[data-plugin=auth-password-lockout]');
  await row.getByRole('button', { name: 'Manage' }).click();
  await page.waitForFunction(() => location.pathname === '/plugins/auth-password-lockout');
  // Every action re-opens the plugin afterwards and rebuilds the form from the server, so wait for that re-open (the GET of
  // the form that follows the action) before typing or asserting: filling earlier races the rebuild and the save would send defaults.
  await page.locator('input[name=gi]').check();
  const formGet = () => page.waitForResponse((r) => r.url().includes('/plugins/auth-password-lockout/form') && r.status() === 200);
  await Promise.all([page.waitForResponse((r) => r.url().includes('/plugins/auth-password-lockout/install')), page.click('#plugin-install')]);
  await page.waitForFunction(() => /Installed/.test(document.querySelector('#plugin-note')?.textContent ?? ''));
  await formGet(); await page.waitForSelector('#plugin-form');
  await page.locator('label[data-field=maxFailures] input').fill('3');
  await Promise.all([page.waitForResponse((r) => r.url().includes('/plugins/auth-password-lockout/settings') && r.request().method() === 'PUT'), page.click('#plugin-save')]);
  await page.waitForFunction(() => /saved|Saved|configured/i.test(document.querySelector('#plugin-note')?.textContent ?? ''));
  await formGet();
  assert.equal(await page.locator('label[data-field=maxFailures] input').inputValue(), '3', 'the saved value comes back from the API');
  await page.locator('[data-hook="auth.authenticate"]').check(); await page.click('#plugin-enable');
  await page.waitForSelector('#plugin-disable');
  await noBanner('enabled'); await shot('6-plugin-enabled');
  await page.click('#plugin-disable'); await page.waitForSelector('#plugin-enable');
  await noBanner('disabled'); await shot('7-plugin-disabled-back-to-base');

  // refresh on a deep link: the in-memory token is gone, so sign-in comes first and then the same plugin page opens again
  await page.reload(); await page.waitForSelector('#signin-browser'); assert.equal(path(), '/login');
  await coreLogin();
  await page.waitForFunction(() => document.body.innerText.includes('admin capability')); // the automatic open is refused first (no token in memory after a reload)
  await setToken();
  await openManage(page); await page.getByRole('button', { name: 'Refresh branches' }).click();
  await status('personal branch');
  await page.waitForSelector('#plugins table'); assert.equal(path(), '/plugins/auth-password-lockout');
  await page.waitForSelector('#plugin-form'); await noBanner('plugin deep link after refresh'); await shot('7b-plugin-deep-link-after-refresh');

  // ---- packaged plugin screen (constat 4 acceptance): the Organizations page ships in the plugin's signed folder ----
  // The console has no Organizations page of its own: the sidebar entry comes from the plugin manifest and the
  // generic host route imports the screen module from the plugin package through the assets route.
  // This stack seeds nothing: install organizations on the working branch and enable it with the packaged-components
  // grant its screen needs (the menu entry and the route only exist while the plugin is enabled).
  await nav('/plugins'); await page.locator('tr[data-plugin=organizations]').getByRole('button', { name: 'Manage' }).click();
  await page.waitForFunction(() => location.pathname === '/plugins/organizations');
  await page.locator('#plugin-install, #plugin-enable, #plugin-disable').first().waitFor(); await page.waitForTimeout(500);
  if (await page.locator('#plugin-install').count()) {
    if (await page.locator('input[name=gi]').count()) await page.locator('input[name=gi]').check({ timeout: 5000 }).catch(() => page.locator('input[name=gi]').check());
    await Promise.all([page.waitForResponse((r) => r.url().includes('/plugins/organizations/install')), page.click('#plugin-install')]);
    await page.waitForFunction(() => /Installed/.test(document.querySelector('#plugin-note')?.textContent ?? ''));
  }
  await page.locator('input[name=gc]').waitFor(); await page.locator('input[name=gc]').check();
  await page.click('#plugin-enable'); await page.waitForSelector('#plugin-disable');
  await noBanner('organizations enabled'); await shot('7b2-organizations-enabled');
  const assetStatuses = [];
  page.on('response', (r) => { if (r.url().includes('/plugins/organizations/assets/')) assetStatuses.push(r.url().split('/').pop() + ':' + r.status()); });
  const invP = page.waitForResponse((r) => r.url().includes('/plugins/screens')).then((r) => r.json()).catch(() => '(no inventory response)');
  await nav('/screens/organizations/orgs');
  try { await page.waitForSelector('plg-organizations-orgs #org-table', { timeout: 30000 }); }
  catch (e) {
    const inv = await invP;
    console.log('DIAG url', page.url(), '\nDIAG inventory', JSON.stringify(inv), '\nDIAG problem', await page.locator('#plugin-screen-problem').textContent().catch(() => '(none)'), '\nDIAG assets', JSON.stringify(assetStatuses));
    await shot('diag-packaged-screen').catch(() => undefined); throw e;
  }
  assert.ok(assetStatuses.some((x) => x.endsWith(':200')), 'the packaged module was served by the assets route: ' + JSON.stringify(assetStatuses));
  assert.equal(await page.locator('app-organizations').count(), 0, 'no console-native page anymore');
  const visAlerts = await page.locator('[role=alert]:visible').allTextContents(); // the screen keeps a hidden alert placeholder: only a VISIBLE alert is a failure
  assert.equal(visAlerts.length, 0, 'packaged organizations screen: no visible alert ' + JSON.stringify(visAlerts));
  await shot('7c-packaged-organizations-screen');
  // Disabling the plugin retires the route and the menu: the host says the screen is gone, the sidebar drops the entry.
  await nav('/plugins'); await page.locator('tr[data-plugin=organizations]').getByRole('button', { name: 'Manage' }).click();
  await page.waitForFunction(() => location.pathname === '/plugins/organizations');
  await page.click('#plugin-disable'); await page.waitForSelector('#plugin-enable');
  await page.goto(`${BASE}/screens/organizations/orgs`); // a full reload signs out (memory-only token): the deep link resumes after sign-in
  await page.waitForSelector('#signin-browser');
  await coreLogin();
  await page.waitForFunction(() => location.pathname === '/screens/organizations/orgs');
  await setToken(); // the screens inventory is an admin read: the capability token is memory-only, re-enter it after the reload
  await openManage(page); await page.getByRole('button', { name: 'Refresh branches' }).click(); // ensurePersonal raced the token entry at sign-in: reopen the personal branch now that the token is back
  await status('personal branch');
  try { await page.waitForSelector('#plugin-screen-problem', { timeout: 30000 }); }
  catch (e) { console.log('DIAG2 url', page.url(), '\nDIAG2 body', ((await page.textContent('body')) ?? '').slice(0, 600)); await shot('diag2-disabled-screen').catch(() => undefined); throw e; }
  assert.equal(await page.locator('nav a[data-nav="/screens/organizations/orgs"]').count(), 0, 'the menu entry left with the plugin');
  await shot('7d-packaged-screen-disabled');
  // Re-enabling asks for the packaged-components grant explicitly, then the same screen comes back, still with zero apps/web change.
  await nav('/plugins'); await page.locator('tr[data-plugin=organizations]').getByRole('button', { name: 'Manage' }).click();
  await page.waitForFunction(() => location.pathname === '/plugins/organizations');
  await page.locator('input[name=gc]').check();
  await page.click('#plugin-enable'); await page.waitForSelector('#plugin-disable');
  await nav('/screens/organizations/orgs'); await page.waitForSelector('plg-organizations-orgs #org-table');
  await shot('7e-packaged-screen-back');

  // ---- database explorer, section by section (one component instance across the sections) ----
  await page.setViewportSize({ width: 1280, height: 1100 });
  const btn = (name, scope = '.explorer') => page.locator(`${scope} button`).filter({ hasText: new RegExp(`^${name}$`) }).first();
  await nav('/database/branches'); await page.waitForSelector('text=protected'); await shot('8-explorer-1-branches');
  await page.fill('input[name=nb]', 'ui-demo'); await btn('Create branch').click(); await page.waitForSelector('td:has-text("ui-demo")');
  await openManage(page); await page.getByRole('button', { name: 'Refresh branches' }).click(); // the explorer created ui-demo behind the shell's back: reload the branch list before selecting it
  await page.selectOption('select[name=globalBranch]', 'ui-demo'); await status('Working on ui-demo'); // explorer edits and SQL writes must run on the selected working branch
  await nav('/database/data'); await page.selectOption('select[name=dr]', 'ui-demo'); await page.click('button:has-text("roles")');
  await page.waitForSelector('th:has-text("label")');
  await btn('Add a row').click(); await page.waitForSelector('.explorer .panel textarea');
  await page.fill('label[data-edit-field=id] textarea', 'auditor');
  for (const f of ['label', 'is_sensitive']) await page.locator(`label[data-edit-field=${f}] input[type=checkbox]`).uncheck(); // nullable columns start as NULL (field disabled)
  await page.fill('label[data-edit-field=label] textarea', 'Auditor'); await page.fill('label[data-edit-field=is_sensitive] textarea', '0');
  await page.fill('input[name=em]', 'add auditor role'); await btn('Commit change').click();
  await page.waitForSelector('td:has-text("Auditor")'); await shot('8-explorer-2-data-edit');
  await page.selectOption('select[name=dr]', 'main'); await page.click('button:has-text("roles")'); await page.waitForSelector('.explorer .chip.lock:text("read only")');
  assert.equal(await page.locator('.explorer button:text-is("Edit")').count(), 0);
  await nav('/database/compare'); await page.selectOption('select[name=cf]', 'main'); await page.selectOption('select[name=ct]', 'ui-demo'); await btn('Compare', '.explorer form').click();
  await page.click('button:has-text("show rows")'); await page.waitForSelector('tr.add'); await shot('8-explorer-3-compare');
  await nav('/database/sql'); await page.selectOption('select[name=sr]', 'main'); await page.selectOption('select[name=sm]', 'write');
  await page.fill('textarea[name=sq]', "insert into roles values ('x','x',false)"); await btn('Apply and commit').click();
  await page.waitForSelector('.explorer .msg:has-text("selected working branch")'); // workspace mode: SQL writes only on the selected working branch
  await page.selectOption('select[name=sr]', 'ui-demo'); await page.fill('textarea[name=sq]', "update roles set label = 'Internal auditor' where id = 'auditor'"); await btn('Preview changes').click();
  await page.waitForSelector('text=Preview only'); await shot('8-explorer-4-sql-preview');
  await page.selectOption('select[name=sm]', 'read'); await page.fill('textarea[name=sq]', 'select * from mysql.user'); await btn('Run').click();
  await page.waitForSelector('.explorer .msg:has-text("not reachable")');
  await nav('/database/pulls'); await page.selectOption('select[name=ps]', 'ui-demo'); await page.selectOption('select[name=pt]', 'main');
  await page.fill('input[name=pti]', 'Add auditor role'); await btn('Open pull request').click();
  await page.waitForSelector('text=Can be merged');
  assert.equal(await btn('Approve').isDisabled(), false); // author approval allowed by default
  await btn('Approve').click(); await page.waitForSelector('text=approved');
  assert.equal(await page.locator('.msg.error').count(), 0); await page.waitForSelector('text=demo-alice');
  await shot('8-explorer-5-pull-request');
  // Human Merge now uses the same checked publication path as Review & Apply.
  await btn('Merge').click(); await page.waitForSelector('.explorer .msg:has-text("Merged as")');
  assert.equal(await page.locator('.explorer .msg:has-text("Use the global Apply")').count(), 0);
  await nav('/database/history'); await page.selectOption('select[name=hr]', 'main'); await page.waitForSelector('li.merge'); await shot('8-explorer-6-history');
  assert.match(await page.locator('.explorer ol.log').innerText(), /Apply workspace ui-demo/);
  await noBanner('explorer end');
  // an internal jump changes the address too: branches -> compare with main
  await nav('/database/branches'); await page.waitForSelector('text=protected');
  // the IAM pages still work after the explorer branch was applied to Dolt main
  await nav('/activation'); await page.waitForSelector('td:text-is("#3")'); // startup #1, earlier Apply #2, human PR merge #3
  await noBanner('activation after explorer apply');

  // ---- Users page (redesign): stat cards, live search, rich drawer, footer count ----
  await nav('/users'); await page.waitForSelector('#users-table tbody tr');
  assert.ok((await page.locator('.stats .stat').count()) >= 4, 'users: the four stat cards render');
  await shot('10-users-table');
  await page.fill('input[name=userSearch]', 'camille-martin');
  await page.waitForFunction(() => document.querySelectorAll('#users-table tbody tr').length === 1, { timeout: 10000 });
  await shot('10-users-filtered');
  await page.fill('input[name=userSearch]', '');
  await page.waitForFunction(() => document.querySelectorAll('#users-table tbody tr').length > 1, { timeout: 10000 });
  await page.locator('#users-table tbody tr').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('#user-editor');
  const userSections = await page.locator('#user-editor h4').allTextContents();
  assert.ok(userSections.some((t) => /Identity/.test(t)) && userSections.some((t) => /Security/.test(t)), 'users: the drawer shows the Identity and Security sections (got: ' + JSON.stringify(userSections) + ')');
  assert.ok(userSections.some(t => /Roles & rights/.test(t)), 'Users has the shared role editor');
  await page.locator('#user-editor').getByRole('tab', { name: 'Resulting rights' }).click();
  await page.waitForSelector('app-roles-rights a[href="/policies"]');
  await shot('11-user-drawer');
  await page.locator('#user-editor').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('#user-editor', { state: 'detached' });

  // ---- Profile plugin components in the user sheet (profile-plugins): the PIN plugin's packaged component ----
  // renders inside the drawer. Enable it with its packaged-components grant (no install step, no sensitive hooks).
  await nav('/plugins'); await page.locator('tr[data-plugin=auth-digit-code]').getByRole('button', { name: 'Manage' }).click();
  await page.locator('#plugin-install, #plugin-enable, #plugin-disable').first().waitFor(); await page.waitForTimeout(500);
  if (await page.locator('#plugin-install').count()) {
    await Promise.all([page.waitForResponse((r) => r.url().includes('/plugins/auth-digit-code/install')), page.click('#plugin-install')]);
    await page.locator('#plugin-enable').waitFor();
  }
  await page.locator('input[name=gc]').check(); // allow its packaged UI components in the console
  await Promise.all([page.waitForResponse((r) => r.url().includes('/plugins/auth-digit-code/enable') && r.status() < 300), page.click('#plugin-enable')]);
  await page.waitForSelector('#plugin-disable');

  // The component shows in the sheet, in manage mode, with the immediate-effect note next to its controls.
  const pinText = () => page.evaluate(() => document.querySelector('iam-pin-profile')?.shadowRoot?.textContent ?? '');
  const pinButtons = () => page.evaluate(() => document.querySelector('iam-pin-profile')?.shadowRoot?.querySelectorAll('button').length ?? -1);
  await nav('/users'); await page.waitForSelector('#users-table tbody tr');
  await page.locator('#users-table tbody tr').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('#user-editor');
  await page.waitForFunction(() => { const t = document.querySelector('iam-pin-profile')?.shadowRoot?.textContent ?? ''; return t.length > 10 && !t.includes('Loading...'); }, undefined, { timeout: 15000 });
  assert.match(await pinText(), /take effect immediately/, 'sheet PIN component: the immediate-effect note shows in manage mode');
  const pinProbe = await page.evaluate(async () => {
    const el = document.querySelector('iam-pin-profile');
    const c = el?.context ?? {};
    const h = { 'content-type': 'application/json', authorization: `Bearer ${c.token}`, 'x-api-admin-token': c.adminToken ?? '', ...(c.branch ? { 'x-iam-branch': c.branch } : {}) };
    const enr = await fetch(`${c.api}/auth/enrollments/${encodeURIComponent(c.subject ?? '')}`, { headers: h }).catch((e) => ({ status: -1, message: String(e) }));
    const auth = await fetch(`${c.api}/auth`, { headers: h }).catch((e) => ({ status: -1 }));
    const aj = auth.status === 200 ? await auth.json().catch(() => ({})) : {};
    return { ctx: { surface: c.surface, subject: c.subject, mode: c.mode, branch: c.branch, hasAdmin: !!c.adminToken, hasToken: !!c.token }, enrStatus: enr.status, authStatus: auth.status, seeded: aj?.working?.seeded, workMethods: (aj?.working?.config?.methods ?? []).map((m) => `${m.id}:${m.type}:${m.enabled}`), shadow: (el?.shadowRoot?.textContent ?? '').slice(0, 200) };
  });
  assert.ok((await pinButtons()) > 0, 'sheet PIN component: manage mode offers its controls (probe: ' + JSON.stringify(pinProbe) + ')');
  await shot('11b-user-drawer-pin-manage');

  // Close and re-open the sheet on the SAME user, then on ANOTHER user: the packaged module must register and
  // render every time (loader module cache + customElements.define guard - a re-define used to break re-opens).
  await page.locator('#user-editor').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('#user-editor', { state: 'detached' });
  await page.locator('#users-table tbody tr').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('#user-editor');
  await page.waitForFunction(() => { const t = document.querySelector('iam-pin-profile')?.shadowRoot?.textContent ?? ''; return t.length > 10 && !t.includes('Loading...'); }, undefined, { timeout: 15000 });
  await page.locator('#user-editor').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('#user-editor', { state: 'detached' });
  await page.locator('#users-table tbody tr').nth(1).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('#user-editor');
  await page.waitForFunction(() => { const t = document.querySelector('iam-pin-profile')?.shadowRoot?.textContent ?? ''; return t.length > 10 && !t.includes('Loading...'); }, undefined, { timeout: 15000 });
  await page.locator('#user-editor').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('#user-editor', { state: 'detached' });

  // Readonly mode (Profile fields -> component surfaces): status stays, every mutating control goes away.
  // Sections: add (empty, local), rename, remove; no duplicate name; a real section renames for all its fields (not saved: the next steps keep the saved configuration).
  await nav('/profile-fields'); await page.waitForSelector('#pf-table .pf-group');
  await page.fill('input[name=pf-ns]', 'Emergency'); await page.click('#pf-add-section');
  await page.waitForSelector('.pf-group:has-text("Emergency · 0 field(s)")');
  await page.fill('input[name=pf-ns]', 'emergency'); await page.click('#pf-add-section');
  await page.waitForSelector('.pf-err:has-text("already exists")');
  await page.getByRole('button', { name: 'Rename the section Emergency' }).click();
  await page.fill('input[name=pf-rn]', 'Urgence'); await page.getByRole('button', { name: 'Save name' }).click();
  await page.waitForSelector('.pf-group:has-text("Urgence · 0 field(s)")');
  await page.getByRole('button', { name: 'Move the section Urgence up' }).click();
  const sectionOrder = await page.locator('#pf-table .pf-group').allTextContents();
  await page.click('#pf-save'); await page.waitForSelector('#pf-note');
  await page.reload(); await page.waitForSelector('#signin-browser');
  await coreLogin(); await setToken();
  await nav('/profile-fields');
  await page.waitForSelector('.pf-group:has-text("Urgence · 0 field(s)")');
  assert.deepEqual(await page.locator('#pf-table .pf-group').allTextContents(), sectionOrder, 'empty sections and their order survive save/reload');
  await page.getByRole('button', { name: 'Remove the empty section Urgence' }).click();
  await page.waitForSelector('.pf-group:has-text("Urgence")', { state: 'detached' });
  const names = await page.locator('#pf-table .pf-group').allInnerTexts();
  assert.equal(new Set(names.map((x) => x.split(' · ')[0])).size, names.length, 'a section name shows once: ' + JSON.stringify(names));
  await nav('/profile-fields'); await page.click('#pf-tab-components'); await page.waitForSelector('#pf-components-table tr[data-component="auth-digit-code:pin"]');
  const pinRow = page.locator('#pf-components-table tr[data-component="auth-digit-code:pin"]');
  try {
    await pinRow.locator('.seg').nth(1).locator('label', { hasText: 'status only' }).click({ timeout: 10000 }); // 0 = My profile, 1 = user sheet (admin); segmented radios
  } catch (e) {
    console.log('DIAG pin row html:', await pinRow.innerHTML().catch(() => '<unreadable>'));
    throw e;
  }
  await Promise.all([page.waitForResponse((r) => r.url().includes('/profile-fields') && r.request().method() === 'PUT' && r.status() < 300), page.click('#pf-save')]);
  await nav('/users'); await page.waitForSelector('#users-table tbody tr');
  await page.locator('#users-table tbody tr').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('#user-editor');
  await page.waitForFunction(() => { const t = document.querySelector('iam-pin-profile')?.shadowRoot?.textContent ?? ''; return t.length > 10 && !t.includes('Loading...'); }, undefined, { timeout: 15000 });
  const roText = await pinText();
  assert.match(roText, /Set \(|Not set/, 'readonly PIN component: the method status still shows (got: ' + JSON.stringify(roText.slice(0, 300)) + ')');
  assert.ok(!/Set a new PIN|Revoke/.test(roText), 'readonly PIN component: no mutating label (got: ' + JSON.stringify(roText.slice(0, 200)) + ')');
  assert.equal(await pinButtons(), 0, 'readonly PIN component: no button at all');
  await shot('11c-user-drawer-pin-readonly');
  await page.locator('#user-editor').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('#user-editor', { state: 'detached' });
  // Restore manage mode so the rest of the run and the screenshots stay in the default posture.
  await nav('/profile-fields'); await page.click('#pf-tab-components'); await page.waitForSelector('#pf-components-table tr[data-component="auth-digit-code:pin"]');
  await page.locator('#pf-components-table tr[data-component="auth-digit-code:pin"] .seg').nth(1).locator('label', { hasText: 'status + actions' }).click();
  await Promise.all([page.waitForResponse((r) => r.url().includes('/profile-fields') && r.request().method() === 'PUT' && r.status() < 300), page.click('#pf-save')]);
  await noBanner('users page');

  // ---- Roles catalogue and tabbed drawer; search console and bulk matrix ----
  await openManage(page); await page.fill('input[name=workspaceNewBranch]', 'ui-matrix'); await page.getByRole('button', { name: 'Create & select' }).click();
  await status('Working on ui-matrix');
  await nav('/roles'); await page.waitForSelector('#role-table tbody tr:has-text("payment-creator")');
  await page.locator('#role-table tr', { hasText: 'payment-creator' }).getByRole('button', { name: 'Open role' }).click();
  await page.getByRole('tab', { name: 'Grants', exact: true }).click(); await shot('12-role-grants');
  await page.getByRole('tab', { name: 'SoD rules', exact: true }).click();
  assert.ok((await page.locator('#sod').innerText()).includes('payment-approver'));
  await page.getByRole('button', { name: 'Close role editor' }).click();
  await nav('/assignments'); await page.fill('input[name=assignmentSearch]', 'demo-bob');
  await page.waitForSelector('#assignments tbody tr:has-text("demo-bob") button');
  await page.waitForFunction(() => document.querySelectorAll('#assignments tbody tr:has(button)').length === 1);
  assert.equal(await page.locator('#assignments tbody tr:has(button)').count(), 1);
  await page.getByRole('link', { name: 'Bulk edit matrix' }).click();
  await page.waitForSelector('.selection-list input');
  await page.fill('input[name=assignmentSearch]', 'demo-bob');
  await page.waitForFunction(() => document.querySelectorAll('.selection-list input[type=checkbox]').length > 0 && [...document.querySelectorAll('.selection-layout > section:first-child .check-label')].length === 1);
  await page.getByLabel(/Bob.*demo-bob/).check();
  await page.fill('input[name=matrixRoleSearch]', 'payment-creator');
  await page.getByLabel(/Payment creator.*payment-creator/).check();
  await page.fill('input[name=matrixRoleSearch]', 'payment-approver');
  await page.getByLabel(/Payment approver.*payment-approver/).check();
  await page.getByRole('button', { name: 'Open matrix' }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'demo-bob / payment-approver', exact: true }).isDisabled(), true, 'SoD additions blocked even with existing roles');
  await page.getByRole('checkbox', { name: 'demo-bob / payment-creator', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Stage 1 changes' }).click();
  await page.waitForSelector('#matrix-review', { state: 'detached' });
  assert.equal(await page.getByRole('checkbox', { name: 'demo-bob / payment-creator', exact: true }).isChecked(), false);
  await shot('13-matrix-staged');

  // ---- phone width: no sideways scroll, the menu opens from the burger, pages stay usable ----
  await page.setViewportSize({ width: 390, height: 800 });
  for (const p of ['/overview', '/users', '/roles', '/assignments', '/plugins', '/database/branches', '/database/data', '/database/pulls', ...(NATS ? ['/event-bus'] : [])]) {
    await page.goto(BASE + p).catch(() => {}); // a full load drops the token: sign in again, which lands back on the same page
    await page.waitForSelector('#signin-browser, main.content section, main.content .stats');
    if (path() === '/login') { await coreLogin(); await page.waitForFunction(() => document.body.innerText.includes('admin capability')); await setToken(); await openManage(page); await page.getByRole('button', { name: 'Refresh branches' }).click(); await status('personal branch'); }
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
