// Local-only: proves that enabling an advanced plugin that replaces the base Password method
// (auth-password-lockout on main, auth-password-policy from the policy feature branch) leaves the
// existing methods/chains usable end to end: the console keeps showing them in use with no
// availability alert, the method's drawer names the replacement plugin as its provider, and a real
// sign-in through the `password-only` chain still succeeds after Review & Apply.
// Run: DOLT_BIN=<dolt> NATS_SERVER_BIN=<nats> CHROME_BIN=<chrome> NODE_PATH=<playwright-core node_modules> \
//      [REPLACEMENT_PLUGIN=auth-password-lockout] node scripts/auth-replacement-e2e.mjs <shot-dir>
// Needs a built core (core/target/debug/iam-core), built API (apps/api/dist) and built web SSR
// (apps/web/dist/web/server/server.mjs). Drives real Chrome via playwright-core; captures screenshots.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import assert from 'node:assert/strict';
import { openManage } from './branch-ui.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'repl-e2e-'));
mkdirSync(outDir, { recursive: true });
const PLUGIN = process.env.REPLACEMENT_PLUGIN ?? 'auth-password-lockout';
const shot = (page, name) => page.screenshot({ path: join(outDir, name + '.png'), fullPage: true });
const { chromium } = createRequire(import.meta.url)('playwright-core');
const chrome = process.env.CHROME_BIN ?? execFileSync('bash', ['-c', 'command -v google-chrome'], { encoding: 'utf8' }).trim();
const dolt = process.env.DOLT_BIN ?? 'dolt';
const NATS = process.env.NATS_SERVER_BIN ?? 'nats-server';
const ADMIN_TOKEN = 'local-demo-plugin-admin-token';
const GATE = {
  IAM_AUTH_GATE_ADDR: '127.0.0.1:3000',
  IAM_AUTH_GATE_TOKEN: 'local-gate-token-demo',
  IAM_CORE_ADMIN_TOKEN: 'local-core-token-demo',
};
const PORTS = [4200, 4000, 8081, 3000, 3307, 4222];

const portOpen = (port) => new Promise((resolve) => { const s = net.createConnection(port, '127.0.0.1'); s.once('connect', () => { s.end(); resolve(true); }); s.once('error', () => resolve(false)); });
const kids = [];
let browser;
const run = (bin, args, opts = {}) => { const k = spawn(bin, args, { stdio: 'ignore', detached: true, ...opts }); kids.push(k); return k; };
const cleanup = () => { browser?.close().catch(() => {}); for (const k of kids) try { process.kill(-k.pid, 'SIGKILL'); } catch { try { k.kill('SIGKILL'); } catch {} } };
process.on('exit', cleanup);

// Kill anything still holding our ports from a previous run.
for (const port of PORTS) { try { execFileSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' }); } catch {} }
await sleep(500);

const dir = mkdtempSync(join(tmpdir(), 'repl-e2e-state-'));
const data = join(dir, 'dolt');
mkdirSync(data);
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v]);
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0, 'schema loads');

run(dolt, ['sql-server', '--host', '127.0.0.1', '--port', '3307', '--data-dir', data], { cwd: data });
run(NATS, ['-c', join(root, 'conf/nats-local.conf')]);
for (let i = 0; i < 80 && !(await portOpen(3307)); i++) await sleep(250);
assert.ok(await portOpen(3307), 'dolt up');
for (let i = 0; i < 40 && !(await portOpen(4222)); i++) await sleep(250);
assert.ok(await portOpen(4222), 'nats up');

import { openSync } from 'node:fs';
const coreLog = openSync('/tmp/repl-core.log', 'w');
const coreKid = spawn(join(root, 'core/target/debug/iam-core'), [], { stdio: ['ignore', coreLog, coreLog], detached: true, 
  cwd: join(root, 'core'),
  env: {
    ...process.env, ...GATE,
    RUST_LOG: process.env.RUST_LOG ?? 'debug',
    IAM_CORE_NATS_URL: '127.0.0.1:4222', IAM_CORE_NATS_USER: 'core', IAM_CORE_NATS_PASSWORD: 'core-dev',
    IAM_CORE_STATE_DIR: join(dir, 'core-state'),
  },
});
kids.push(coreKid);
const apiLog = openSync('/tmp/repl-api.log', 'w');
const apiKid = spawn('node', ['dist/main.js'], {
  stdio: ['ignore', apiLog, apiLog], detached: true,
  cwd: join(root, 'apps/api'),
  env: {
    ...process.env,
    IAM_BUS_NATS_URL: '127.0.0.1:4222', IAM_BUS_NATS_USER: 'api-host', IAM_BUS_NATS_PASSWORD: 'api-host-dev',
    IAM_WORKSPACE_MODE: '1', IAM_PLUGIN_STORE: 'dolt', IAM_DIRECTORY_AUTH: '1',
    IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081',
    IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_CORE_ADMIN_TOKEN: GATE.IAM_CORE_ADMIN_TOKEN,
    IAM_API_ADMIN_TOKEN: ADMIN_TOKEN,
    IAM_AUTHN_DEMO_SEED: '1',
    IAM_AUTHN_FILE: join(dir, 'enroll.json'), IAM_CREDENTIAL_FILE: join(dir, 'cred.json'),
  },
});
kids.push(apiKid);
run('node', ['dist/web/server/server.mjs'], { cwd: join(root, 'apps/web'), env: { ...process.env, PORT: '4000', IAM_WEB_API_ORIGIN: 'http://127.0.0.1:4200' } });
run('node', ['demo/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4200', IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } });
for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
assert.ok(await portOpen(4200), 'web up');
console.log('stack up; plugin under test:', PLUGIN);

const BASE = 'http://localhost:4200';
browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
let lastToken = null;
page.on('response', async (r) => { if (r.url().endsWith('/token') && r.ok()) { try { lastToken = (await r.json()).id_token; } catch {} } });
const claims = () => JSON.parse(Buffer.from(lastToken.split('.')[1], 'base64url').toString());
const noAlert = async (l) => assert.equal(await page.locator('[role=alert]').count(), 0, l + ': no alert (' + (await page.locator('[role=alert]').allInnerTexts()).join('|') + ')');
const item = (key) => page.locator(`.it[data-key="${key}"]`);
const editOf = async (key) => { await item(key).getByRole('button', { name: 'Edit', exact: true }).click(); await page.waitForSelector('#authn-edit'); };
const done = async () => { await page.locator('#authn-edit').getByRole('button', { name: 'Done', exact: true }).click(); await page.waitForSelector('#authn-edit', { state: 'detached' }); };
const usedKeys = async () => (await page.locator('#authn-used .it[data-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).sort();
const signInFirstStep = async (user, pw, chain) => {
  const sel = chain ? `[data-chain="${chain}"], #signin-browser` : '#signin-browser, #signin-methods [data-chain]';
  await page.waitForSelector(sel);
  await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.locator(sel).first().click()]);
  try {
    await page.waitForSelector('input[name=username]', { timeout: 12000 });
  } catch (e) {
    await shot(page, 'ERR-signin');
    console.log('signin diag: url=' + page.url() + ' body=' + (((await page.textContent('body').catch(() => '')) ?? '')).replace(/\s+/g,' ').slice(0, 400));
    const probe = await fetch(page.url()).catch((e) => null);
    console.log('probe status: ' + (probe ? probe.status : 'fetch failed') + ' body=' + (probe ? (await probe.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200) : ''));
    const { execSync } = await import('node:child_process');
    console.log('--- core log tail ---'); try { console.log(execSync('tail -c 3000 /tmp/repl-core.log', { encoding: 'utf8' })); } catch {}
    console.log('--- api log tail ---'); try { console.log(execSync('tail -c 3000 /tmp/repl-api.log', { encoding: 'utf8' })); } catch {}
    throw e;
  }
  await page.fill('input[name=username]', user);
  if (pw !== undefined) await page.fill('input[name=password]', pw);
};
const submit = () => Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
const login1 = async () => {
  await page.goto(`${BASE}/login`);
  await signInFirstStep('demo-alice', 'demo-only-not-a-secret');
  await page.click('button[type=submit]');
  await page.waitForSelector('[name=globalBranch]');
  await page.locator('details.token').evaluate((e) => (e.open = true));
  await page.fill('[name=admintoken]', ADMIN_TOKEN);
};
const createBranch = async (name) => {
  await openManage(page);
  await page.fill('[name=workspaceNewBranch]', name);
  await page.getByRole('button', { name: 'Create & select', exact: true }).click();
  await page.waitForFunction((n) => document.querySelector('[name=globalBranch]')?.value === n, name);
  await page.waitForTimeout(200);
};

// Bearer token for direct admin API calls (classic flow, before any chain is live).
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
let auth = {};
for (let i = 0; i < 40; i++) {
  auth = await (await fetch(BASE + '/core/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'demo-web', redirect_uri: BASE + '/callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', username: 'demo-alice', password: 'demo-only-not-a-secret' }) })).json().catch(() => ({}));
  if (auth.code) break;
  await sleep(1000);
}
assert.ok(auth.code, 'classic authorize works before apply: ' + JSON.stringify(auth));
const tok = await (await fetch(BASE + '/core/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.code, code_verifier: verifier, client_id: 'demo-web', redirect_uri: BASE + '/callback' }) })).json();
const call = (method, path, body, branch) => fetch('http://127.0.0.1:3000/tenants/acme-demo' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok.id_token, 'x-api-admin-token': ADMIN_TOKEN, ...(branch ? { 'x-iam-branch': branch } : {}) }, body: body ? JSON.stringify(body) : undefined });

const gotoBranch = async (url) => {
  await page.goto(url);
  await page.waitForSelector('[name=globalBranch]');
  await page.selectOption('[name=globalBranch]', 'repl-e2e');
  await page.waitForTimeout(400);
};
await login1();
await createBranch('repl-e2e');

// 1. /auth-methods with the seeded example config: password method + chains in use, served by the base plugin.
await gotoBranch(BASE + '/auth-methods');
await page.waitForSelector('#authn-methods');
await item('m:password').waitFor();
const before = await usedKeys();
assert.ok(before.includes('c:password-only'), 'c:password-only in use before');
assert.ok(await page.locator('.it[data-key="m:password"].bad').count() === 0, 'm:password available before');
await noAlert('before');
await editOf('m:password');
const drawerBefore = (await page.textContent('#authn-edit')) ?? '';
assert.match(drawerBefore, /plugin auth-password(?!-)/, 'm:password served by base auth-password before enable (got: ' + drawerBefore.slice(0, 200) + ')');
await done();
await shot(page, '1-auth-methods-before');

// 2. Install + enable the replacement plugin through the admin API (staged on the branch);
// the console pixels below prove the result.
const list = await (await call('GET', '/plugins', undefined, 'repl-e2e')).json();
const entry = (list.plugins ?? list).find((x) => x.id === PLUGIN);
assert.ok(entry, PLUGIN + ' in the catalogue');
const hooks = entry.requests?.sensitiveHooks ?? [];
const grantAll = { install: true, hooks, uiComponents: !!entry.requests?.uiComponents };
const inst = await call('POST', '/plugins/' + PLUGIN + '/install', { grants: grantAll }, 'repl-e2e');
assert.ok(inst.ok, 'install: ' + inst.status + ' ' + (await inst.text()));
const en = await call('POST', '/plugins/' + PLUGIN + '/enable', { grants: { hooks } }, 'repl-e2e');
assert.ok(en.ok, 'enable: ' + en.status + ' ' + (await en.text()));
await gotoBranch(BASE + '/plugins');
const card2 = page.locator(`[data-plugin="${PLUGIN}"]`);
await card2.waitFor({ timeout: 15000 });
await card2.getByRole('button', { name: 'Details' }).click();
await page.getByRole('button', { name: /Lifecycle/ }).click();
await page.waitForTimeout(1000);
await shot(page, '2-plugin-enabled');
console.log('cycle diag: disable=' + await page.locator('#plugin-disable').count() + ' enable=' + await page.locator('#plugin-enable').count() + ' text=' + (((await page.textContent('.pdetail').catch(() => '')) ?? '')).replace(/\s+/g,' ').slice(0, 300));

// 3. /auth-methods again: same entries in use, no alert, and the method is now served by the replacement plugin.
await gotoBranch(BASE + '/auth-methods');
await page.waitForSelector('#authn-methods .it[data-key="m:password"]');
await noAlert('after enable');
assert.ok(!/no longer active/.test((await page.textContent('body')) ?? ''), 'no "no longer active" notice');
assert.deepEqual(await usedKeys(), before, 'same methods/chains still in use after enable');
assert.equal(await page.locator('.it[data-key="m:password"].bad').count(), 0, 'm:password still available after enable');
await editOf('m:password');
const drawerAfter = (await page.textContent('#authn-edit')) ?? '';
assert.match(drawerAfter, new RegExp('plugin ' + PLUGIN + '(?!-)'), 'm:password now served by ' + PLUGIN + ' (got: ' + drawerAfter.slice(0, 200) + ')');
await done();
await shot(page, '3-auth-methods-after');

// 4. Review & Apply so the live registry carries the replacement, then a real sign-in still works.
const applyRes = await call('POST', '/workspace/apply', { confirm: true }, 'repl-e2e');
assert.ok(applyRes.ok, 'apply: ' + applyRes.status + ' ' + (await applyRes.text()));
await page.click('header #user-menu-button'); await page.click('#user-menu-signout');
await page.goto(BASE + '/login');
await page.locator('[data-chain="password-only"]').waitFor({ timeout: 15000 });
await shot(page, '4-login-chains');
await signInFirstStep('demo-alice', 'demo-only-not-a-secret', 'password-only');
await submit();
await page.waitForSelector('[name=globalBranch]', { timeout: 20000 });
assert.ok(lastToken, 'token issued');
assert.equal(claims().auth_chain, 'password-only', 'signed in through the password-only chain');
await shot(page, '5-signed-in');

// 5. Disable the replacement again on the branch: availability falls back to the base plugin, still no alert.
const dis = await call('POST', '/plugins/' + PLUGIN + '/disable', undefined, 'repl-e2e');
assert.ok(dis.ok, 'disable: ' + dis.status + ' ' + (await dis.text()));
await gotoBranch(BASE + '/auth-methods');
await page.waitForSelector('#authn-methods .it[data-key="m:password"]');
await noAlert('after disable');
assert.deepEqual(await usedKeys(), before, 'same methods/chains still in use after disable');
await editOf('m:password');
const drawerFinal = (await page.textContent('#authn-edit')) ?? '';
assert.match(drawerFinal, /plugin auth-password(?!-)/, 'm:password served by base again after disable');
await done();
await shot(page, '6-auth-methods-disabled');

console.log('replacement e2e ok; screenshots in ' + outDir);
