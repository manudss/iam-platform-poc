// Real-browser UI end-to-end (local only): starts Dolt, the Rust core, the NestJS API and `ng serve`, then drives the Angular
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
run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core') });
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081' } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // forged callback (another state): the code is ignored, nobody is signed in
  await page.goto('http://localhost:4200/callback?code=attacker-code&state=forged-state');
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('state mismatch'));
  assert.equal(new URL(page.url()).pathname, '/'); // the code left the address bar
  assert.equal(await page.locator('text=Assignments on Dolt main').count(), 0);
  // recommended flow: console -> core login form -> back to the console with code+state
  await page.goto('http://localhost:4200/');
  await page.screenshot({ path: join(out, '1-signin.png') });
  await Promise.all([page.waitForURL(/127\.0\.0\.1:8081\/authorize/), page.click('#signin-browser')]);
  await page.waitForSelector('input[name=password]'); await page.screenshot({ path: join(out, '1b-core-login-form.png') });
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'wrong');
  await Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
  await page.waitForSelector('text=Wrong user or password');
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await Promise.all([page.waitForURL(/localhost:4200/), page.click('button[type=submit]')]);
  await page.waitForSelector('text=Assignments on Dolt main');
  await page.waitForSelector('text=demo-bob : payment-creator');
  assert.ok((await page.textContent('[role=status]')).includes('browser flow'));
  assert.equal(new URL(page.url()).search, ''); // no code or state left in the URL
  await page.screenshot({ path: join(out, '2-logged-in.png') });
  // SoD violation
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  await page.waitForSelector('text=SoD: demo-bob has payment-creator and payment-approver');
  await page.screenshot({ path: join(out, '3-sod-violation.png') });
  await page.getByRole('button', { name: 'Merge into main' }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('Merge refused (409)'));
  // clean change, merge, activate
  const inputs = page.locator('main input:not([type=password])');
  await inputs.nth(0).fill('demo-alice'); await inputs.nth(1).fill('accountant');
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('Simulation OK'));
  await page.getByRole('button', { name: 'Merge into main' }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('Merged into main'));
  await page.waitForSelector('text=demo-alice : accountant');
  await page.getByRole('button', { name: 'Activate current main' }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('Activated main head as #1'));
  await page.screenshot({ path: join(out, '4-activated.png') });
  assert.deepEqual(errors, [], 'no page errors');
  console.log('UI E2E PASSED; screenshots in ' + out);
} finally {
  await browser?.close(); await stopAll(); rmSync(dir, { recursive: true, force: true });
                      }
