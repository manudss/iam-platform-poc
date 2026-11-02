// Real-browser end-to-end of the branch sign-in test (local only): starts Dolt, the Rust core, the NestJS API and
// `ng serve`, signs the administrator in, starts a sign-in test of the personal branch from the branch bar, then
// follows the test link in the new tab: branch-bound login page (banner, no sign-up), sign-in through the core,
// test session (banner, reduced navigation, workspace bar hidden), exit. Saves screenshots. Binds to 127.0.0.1 only.
// Needs: DOLT_BIN, CHROME_BIN, playwright-core resolvable, built core and API. Usage: DOLT_BIN=... CHROME_BIN=... node scripts/branch-test-e2e.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core'); // honours NODE_PATH

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-branch-test-shots'));
mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN;
if (!dolt || !chrome) { console.log('SKIPPED: DOLT_BIN and CHROME_BIN are required'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'iam-bt-')), home = join(dir, 'h'), data = join(dir, 'd');
mkdirSync(home); mkdirSync(data);
const env = { ...process.env, HOME: home };
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v], { env });
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, env, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const run = (cmd, args, opts) => procs.push(spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts }));
const portOpen = (port) => new Promise((ok) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); ok(true); }); c.once('error', () => ok(false)); });
const descendants = (roots) => {
  const rows = spawnSync('ps', ['-e', '-o', 'pid=,ppid=']).stdout.toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const out = []; const walk = (pid) => { for (const k of kids.get(pid) ?? []) { walk(k); out.push(k); } }; roots.forEach(walk);
  return out;
};
const stopAll = async () => {
  const tree = descendants(procs.map((p) => p.pid));
  for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (let i = 0; i < 40 && ((await portOpen(4200)) || (await portOpen(8081)) || (await portOpen(3000)) || (await portOpen(3307))); i++) {
    if (i === 20) { for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } }
    await new Promise((r) => setTimeout(r, 250));
  }
};
run(dolt, ['sql-server', '--host', '127.0.0.1', '--port', '3307', '--data-dir', data], { cwd: data, env });
const GATE = { IAM_AUTH_GATE_ADDR: '127.0.0.1:3000', IAM_AUTH_GATE_TOKEN: 'local-gate-token-demo' };
const ADMIN_TOKEN = 'local-demo-plugin-admin-token', CORE_TOKEN = 'local-core-admin-token-demo';
run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), env: { ...process.env, ...GATE, IAM_CORE_ADMIN_TOKEN: CORE_TOKEN } });
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_WORKSPACE_MODE: '1', IAM_PLUGIN_STORE: 'dolt', IAM_DIRECTORY_AUTH: '1', IAM_CREDENTIAL_FILE: join(dir, 'credentials.json'), IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_CORE_ADMIN_TOKEN: CORE_TOKEN, IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  const BASE = 'http://localhost:4200';
  const shot = (p, n) => p.screenshot({ path: join(out, `${n}.png`), fullPage: true });

  // ---- administrator signs in (normal, live) and opens the console ----
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('#signin-browser');
  await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.click('#signin-browser')]);
  await page.waitForSelector('input[name=password]');
  assert.equal(new URL(page.url()).searchParams.get('branch'), null, 'a normal sign-in carries no branch');
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await Promise.all([page.waitForURL(/localhost:4200(?!\/core)/), page.click('button[type=submit]')]);
  await page.waitForSelector('header .who');
  await page.evaluate(() => { document.querySelector('details.token').open = true; });
  await page.fill('input[name=admintoken]', ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Refresh branches' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('personal branch'));
  await page.waitForSelector('#test-signin');
  assert.match(await page.locator('select[name=globalBranch]').inputValue(), /demo-alice/, 'the personal branch is selected');
  await shot(page, '1-console-branch-bar');

  // ---- start the sign-in test: a new tab opens on the branch-bound login ----
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#test-signin')]);
  await popup.waitForLoadState('load');
  const lu = new URL(popup.url());
  assert.equal(lu.pathname, '/login'); assert.equal(lu.searchParams.get('branch'), 'demo-alice');
  assert.ok((lu.searchParams.get('ticket') ?? '').length >= 10, 'the link carries a ticket');
  await popup.waitForSelector('#branch-test-banner');
  assert.match(await popup.locator('#branch-test-banner').innerText(), /demo-alice/);
  assert.equal(await popup.locator('app-signup').count(), 0, 'sign-up hidden in test mode');
  await shot(popup, '2-test-login-page');

  // ---- sign in on the tested branch: the core form keeps the branch, the session lands in test mode ----
  await Promise.all([popup.waitForURL(/localhost:4200\/core\/authorize/), popup.click('#signin-browser')]);
  const au = new URL(popup.url());
  assert.equal(au.searchParams.get('branch'), 'demo-alice', 'the authorize request is bound to the tested branch');
  assert.ok(au.searchParams.get('ticket'), 'and carries the ticket');
  await popup.waitForSelector('input[name=password]');
  await shot(popup, '3-core-login-on-branch');
  await popup.fill('input[name=username]', 'demo-alice'); await popup.fill('input[name=password]', 'demo-only-not-a-secret');
  await Promise.all([popup.waitForURL(/localhost:4200(?!\/core)/), popup.click('button[type=submit]')]);
  await popup.waitForSelector('.test-bar');
  assert.match(await popup.locator('.test-bar').innerText(), /demo-alice/);
  assert.equal(new URL(popup.url()).pathname, '/my-profile', 'the test session lands on the personal profile');
  await popup.waitForFunction(() => !document.body.innerText.includes('Loading...'), undefined, { timeout: 15000 }); // the branch profile really loads
  assert.ok((await popup.locator('input[name]').count()) > 0, 'profile fields of the tested branch are shown');
  const navLinks = await popup.locator('nav a[data-nav]').allInnerTexts();
  assert.ok(navLinks.length <= 2, 'navigation reduced in test mode: ' + JSON.stringify(navLinks));
  assert.equal(await popup.locator('select[name=globalBranch]').count(), 0, 'the workspace bar is hidden in test mode');
  await shot(popup, '4-test-session-profile');

  // ---- exit: back to the normal login, no banner ----
  await popup.click('#exit-test');
  await popup.waitForSelector('#signin-browser');
  assert.equal(await popup.locator('#branch-test-banner').count(), 0, 'banner gone after exit');
  assert.equal(new URL(popup.url()).search, '', 'no branch or ticket left in the address bar');
  await shot(popup, '5-exit-normal-login');
  console.log('branch-test UI e2e: OK - screenshots in ' + out);
} finally { if (browser) await browser.close(); await stopAll(); }
