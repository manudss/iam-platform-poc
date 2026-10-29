// Real-core/API/Dolt browser regression for Organizations install, expiry, and IdP key rotation.
// Needs built core/API, DOLT_BIN, CHROME_BIN, and NODE_PATH resolving playwright-core.
// Uses a 12s real server TTL. One case pauses the browser clock to model a suspended tab,
// but the rejecting 401 comes from the real API. No fake API responses or forged tokens.
// Usage: DOLT_BIN=... CHROME_BIN=... NODE_PATH=... node scripts/session-expiry-e2e.mjs [outDir]
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
const startCore = (ttl) => { run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), env: { ...process.env, ...GATE, IAM_TOKEN_TTL_SECS: String(ttl) } }); return procs.at(-1); };
let core = startCore(12);
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_WORKSPACE_MODE:'1',IAM_PLUGIN_STORE:'dolt',IAM_DIRECTORY_AUTH:'1',IAM_CREDENTIAL_FILE:join(dir,'credentials.json'),IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  let page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  await page.clock.install();
  const BASE = 'http://localhost:4200'; let installs = 0;
  page.on('request', r => { if (r.url().includes('/plugins/org-manager/install')) installs++; });
  const login = async () => {
    await page.click('#signin-browser'); await page.waitForSelector('input[name=password]');
    await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
    await page.click('button[type=submit]'); await page.waitForSelector('[name=globalBranch]');
    await page.locator('details.token').evaluate(e=>e.open=true);await page.fill('input[name=admintoken]',ADMIN_TOKEN);await page.getByRole('button',{name:'Refresh branches',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[name=globalBranch]')?.textContent.includes('main'));
    if(!(await page.locator('[name=globalBranch] option').allTextContents()).includes('expiry-work')){await page.fill('[name=workspaceNewBranch]','expiry-work');await page.getByRole('button',{name:'Create & select',exact:true}).click();}else await page.selectOption('[name=globalBranch]','expiry-work');
    await page.waitForSelector('#plugin-install',{timeout:6000}).catch(async e=>{console.log(await page.textContent('body'));throw e});
  };
  const token = async () => { await page.locator('details.token').evaluate(e=>e.open=true); await page.fill('input[name=admintoken]', ADMIN_TOKEN); };
  const shot = n => page.screenshot({ path: join(out, n + '.png'), fullPage: true });
  await page.goto(BASE + '/plugins/org-manager'); await login();
  await token(); await page.check('input[name=gi]');
  // Simulate a suspended tab's timer/client clock only. The core and API use REAL time and an authentic signed token.
  await page.clock.pauseAt(Date.now()); await sleep(13000);
  const rejected = page.waitForResponse(r => r.url().includes('/plugins/org-manager/install'));
  await page.click('#plugin-install'); assert.equal((await rejected).status(), 401);
  await page.waitForSelector('#signin-browser'); await page.clock.resume();
  assert.equal(installs, 1); await shot('expired-install-refused');
  await page.close(); page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  page.on('request', r => { if (r.url().includes('/plugins/org-manager/install')) installs++; });
  await page.goto(BASE + '/plugins/org-manager'); await login();
  assert.equal(await page.locator('input[name=gi]').isChecked(), false); await page.check('input[name=gi]');
  // Idle on the exact plugin from the report. No API fixture, clock override, or forged token.
  await page.waitForSelector('#signin-browser', { timeout: 18000 });
  assert.match(await page.locator('[role=status]').first().innerText(), /Session expired or invalid/);
  assert.equal(installs, 1); await shot('expiry-login');
  await login(); assert.equal(new URL(page.url()).pathname, '/plugins/org-manager');
  assert.equal(await page.locator('input[name=gi]').isChecked(), false); assert.equal(installs, 1);
  await token(); await page.check('input[name=gi]'); await page.click('#plugin-install');
  await page.waitForFunction(() => document.querySelector('#plugin-note')?.textContent.includes('Installed Organizations.'));
  assert.equal(installs, 2); await shot('organizations-installed');
  // Restart just the real IdP, not the API (whose JWKS cache still holds the old signing key).
  process.kill(-core.pid, 'SIGTERM'); await new Promise(r => core.once('exit', r)); core = startCore(300);
  for (let i=0;i<60;i++) { try { if ((await fetch(BASE+'/core/jwks.json')).ok) break; } catch {} await sleep(100); }
  await page.click('nav a[data-nav="/assignments"]');
  await page.waitForSelector('#signin-browser');
  assert.match(await page.locator('[role=status]').first().innerText(), /Session expired or invalid/);
  assert.equal(installs, 2); await shot('restart-login');
  await page.click('#signin-browser'); await page.waitForSelector('input[name=password]');
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await page.click('button[type=submit]'); await page.waitForSelector('[name=globalBranch]');await page.locator('details.token').evaluate(e=>e.open=true);await page.fill('[name=admintoken]',ADMIN_TOKEN);await page.getByRole('button',{name:'Refresh branches',exact:true}).click();await page.selectOption('[name=globalBranch]','expiry-work'); await page.waitForSelector('nav a.active[data-nav="/assignments"]');
  await page.waitForSelector('#assignments td'); assert.equal(installs,2);
  // New key accepted after restart. The old key still fails closed, no admin capability in browser persisted storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })); assert.ok(!stored.includes(ADMIN_TOKEN));
  console.log('PASS server 401 expired Organizations install (suspended client timer), real 12-second idle expiry, return to Organizations, no automatic install, explicit install, core restart rejection, reconnect and fresh key accepted');
} finally { await browser?.close(); await stopAll(); rmSync(dir, { recursive: true, force: true }); }
