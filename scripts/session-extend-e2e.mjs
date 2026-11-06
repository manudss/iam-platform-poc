// Real-core/API/Dolt browser test of the session timer: inverted bar, warning dialog, "Stay signed in" (token renewal), expiry afterwards.
// Needs built core/API, DOLT_BIN, CHROME_BIN, and NODE_PATH resolving playwright-core.
// Uses a 20s real server TTL (the warning is a third of the token life, ~6s). One case pauses the browser clock to model a suspended tab,
// No fake API responses or forged tokens: the renewal is the real POST /core/session/extend.
// Usage: DOLT_BIN=... CHROME_BIN=... NODE_PATH=... node scripts/session-extend-e2e.mjs [outDir]
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
startCore(20);
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const BASE = 'http://localhost:4200';
  const extended = []; page.on('response', (r) => { if (r.url().endsWith('/core/session/extend')) extended.push(r.status()); });
  const shot = (n) => page.screenshot({ path: join(out, n + '.png') });
  await page.goto(BASE + '/plugins/org-manager');
  await page.click('#signin-browser'); await page.waitForSelector('input[name=password]');
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await page.click('button[type=submit]'); await page.waitForSelector('#session-timer');
  // The bar starts nearly full and goes down.
  const w0 = await page.$eval('#session-fill', (e) => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width);
  assert.ok(w0 > 0.85, 'bar starts nearly full, got ' + w0);
  await sleep(4000);
  const w1 = await page.$eval('#session-fill', (e) => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width);
  assert.ok(w1 < w0, 'bar goes down');
  // Near the end: the dialog offers to stay signed in.
  await page.waitForSelector('#session-dialog', { timeout: 15000 }); await shot('session-warning');
  await page.click('#session-extend');
  await page.waitForSelector('#session-dialog', { state: 'detached' });
  assert.deepEqual(extended, [200]);
  const w2 = await page.$eval('#session-fill', (e) => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width);
  assert.ok(w2 > 0.85, 'bar is full again after renewal, got ' + w2);
  // Past the ORIGINAL expiry (20s after sign-in) the person is still signed in.
  await sleep(9000);
  assert.equal(await page.locator('#signin-browser').count(), 0); await shot('session-still-signed-in');
  // Left alone, the renewed token expires too: back to the sign-in page.
  await page.waitForSelector('#signin-browser', { timeout: 30000 });
  console.log('PASS session bar goes down, warning dialog, Stay signed in renews the token (real 200), still signed in past the first expiry, expiry afterwards');
} finally { await browser?.close(); await stopAll(); rmSync(dir, { recursive: true, force: true }); }
