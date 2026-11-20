// Real-browser end-to-end for account blocks and sign-in levels (CI and local): Dolt, NATS, the Rust core, the NestJS API (workspace mode) and `ng serve`,
// all fictional demo data, bound to 127.0.0.1 only, nothing live. Blocks an account after proof of the first factor and reads the card on the core's sign-in page,
// lifts it, locks an account by failures, refuses a self-block, builds the shipped chains, enrols an authenticator app (test secret, shown once), raises the
// administration level to 8, checks 403 step-up-required below it, the eligible chains, the console re-sign-in page, and the refusal of an unreachable level.
// Needs: DOLT_BIN, NATS_SERVER_BIN, CHROME_BIN, playwright-core (NODE_PATH), built core and API. Usage: node scripts/account-blocks-e2e.mjs [outDir]
// Usage: DOLT_BIN=... CHROME_BIN=... node scripts/auth-methods-e2e.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openManage } from './branch-ui.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { totpAt } = await import(join(root, 'apps/api/dist/authn/totp.js'));
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-authn-shots')); mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN; if (!dolt || !chrome) { console.log('SKIPPED: DOLT_BIN and CHROME_BIN are required'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'iam-authn-')), home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data);
const denv = { ...process.env, HOME: home };
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v], { env: denv });
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, env: denv, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0);
const procs = [];
const run = (cmd, args, opts) => procs.push(spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts }));
const portOpen = (port) => new Promise((ok) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); ok(true); }); c.once('error', () => ok(false)); });
const stopAll = async () => {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
};
for (const port of [4200, 8081, 3000, 3307]) if (await portOpen(port)) { console.log('port ' + port + ' busy, stop it first'); process.exit(1); }
run(dolt, ['sql-server', '--host', '127.0.0.1', '--port', '3307', '--data-dir', data], { cwd: data, env: denv });
const NATS = process.env.NATS_SERVER_BIN ?? process.env.NATS_BIN;
assert.ok(NATS, 'NATS_SERVER_BIN is required');
run(NATS, ['-c', join(root, 'conf/nats-local.conf')]);
await new Promise(r => setTimeout(r, 1000));
const GATE = { IAM_CORE_ADMIN_TOKEN: 'local-core-token-demo', IAM_AUTH_GATE_ADDR: '127.0.0.1:3000', IAM_AUTH_GATE_TOKEN: 'local-gate-token-demo' };
const ADMIN_TOKEN = 'local-demo-plugin-admin-token';
run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), env: { ...process.env, ...GATE, IAM_CORE_NATS_URL: '127.0.0.1:4222', IAM_CORE_NATS_PASSWORD: 'core-dev', IAM_CORE_STATE_DIR: join(dir, 'core-state') } });
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_BUS_NATS_URL: '127.0.0.1:4222', IAM_BUS_NATS_USER: 'api-host', IAM_BUS_NATS_PASSWORD: 'api-host-dev', IAM_CORE_ADMIN_TOKEN: GATE.IAM_CORE_ADMIN_TOKEN, IAM_WORKSPACE_MODE: '1', IAM_PLUGIN_STORE: 'dolt', IAM_DIRECTORY_AUTH: '1', IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN, IAM_AUTHN_FILE: join(dir, 'enroll.json'), IAM_CREDENTIAL_FILE: join(dir, 'cred.json') } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1, MAP *picsum.photos ~NOTFOUND'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  let lastToken = null;
  page.on('response', async (r) => { if (r.url().endsWith('/token') && r.ok()) { try { lastToken = (await r.json()).id_token; } catch {} } });
  const BASE = 'http://localhost:4200', PW = 'demo-only-not-a-secret';
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: false });
  const claimsOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const directSignIn = async (username, password) => {
    const a = await (await post('/core/authorize', { client_id: 'demo-web', redirect_uri: BASE + '/callback', code_challenge: challenge, username, password })).json();
    if (!a.code) return { ok: false, body: a };
    const t = await (await post('/core/token', { code: a.code, code_verifier: verifier, client_id: 'demo-web', redirect_uri: BASE + '/callback' })).json();
    return { ok: !!t.id_token, token: t.id_token };
  };
  const api = (token, method, path, body, branch) => fetch('http://127.0.0.1:3000/tenants/acme-demo' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-api-admin-token': ADMIN_TOKEN, ...(branch ? { 'x-iam-branch': branch } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = async (r) => { try { return await r.json(); } catch { return {}; } };
  const classicFirstStep = async (user, pw) => {
    await page.goto(`${BASE}/login`);
    await page.waitForSelector('#signin-browser, #signin-methods [data-chain]');
    await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.locator('#signin-browser, #signin-methods [data-chain]').first().click()]);
    await page.waitForSelector('input[name=username]'); await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw);
    await Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
  };
  const bodyText = () => page.textContent('body');

  // ---- 0. a bearer token for the administrator (demo-alice, classic sign-in, level 3)
  const alice = await directSignIn('demo-alice', PW); assert.ok(alice.ok, 'alice signs in');
  const T1 = alice.token; assert.equal(claimsOf(T1).sub, 'demo-alice');

  // ---- 1. an administrator blocks demo-bob; the card appears only AFTER the first factor is proved
  const blk = await api(T1, 'POST', '/accounts/demo-bob/blocks', { kind: 'suspended', message: 'Paused while we check a payment request. Contact the finance office.' });
  assert.equal(blk.status < 300, true, 'block created: ' + blk.status + ' ' + JSON.stringify(await json(blk.clone())));
  await classicFirstStep('demo-bob', 'wrong-password');
  assert.doesNotMatch(await bodyText(), /BLK-|Paused while/, 'nothing about the block is revealed before the first factor is proved');
  await classicFirstStep('demo-bob', PW);
  await page.waitForSelector('#blocked-card', { timeout: 15000 });
  const card = await page.locator('#blocked-card').innerText();
  assert.match(card, /Paused while we check a payment request/); assert.match(card, /BLK-[A-Z0-9]{4}/);
  assert.match(await bodyText(), /Account suspended/i);
  await shot('1-blocked-card');
  assert.equal((await directSignIn('demo-bob', PW)).ok, false, 'a blocked account gets no token');

  // ---- 2. nobody blocks themselves; the block is lifted by the administrator
  const self = await api(T1, 'POST', '/accounts/demo-alice/blocks', { kind: 'suspended', message: 'self' });
  assert.equal(self.status >= 400, true, 'self-block refused: ' + self.status);
  const list = await json(await api(T1, 'GET', '/account-blocks'));
  const bobBlock = list.accounts.find((a) => a.subject === 'demo-bob').blocks[0];
  const lift = await api(T1, 'DELETE', `/accounts/demo-bob/blocks/${encodeURIComponent(bobBlock.id)}`); assert.equal(lift.status < 300, true, 'lifted');
  assert.equal((await directSignIn('demo-bob', PW)).ok, true, 'after the unblock the person signs in');

  // ---- 3. automatic lock: 5 failures, then even the right password meets the card
  for (let i = 0; i < 5; i++) assert.equal((await directSignIn('demo-bob', 'wrong-' + i)).ok, false);
  await classicFirstStep('demo-bob', PW);
  await page.waitForSelector('#blocked-card', { timeout: 15000 });
  assert.match(await bodyText(), /locked/i); await shot('3-locked-card');
  const list2 = await json(await api(T1, 'GET', '/account-blocks'));
  const lock = list2.accounts.find((a) => a.subject === 'demo-bob').blocks[0];
  assert.equal(lock.origin, 'automatic');
  assert.equal((await api(T1, 'DELETE', `/accounts/demo-bob/blocks/${encodeURIComponent(lock.id)}`)).status < 300, true);
  assert.equal((await directSignIn('demo-bob', PW)).ok, true, 'unlocked');

  // ---- 4. the shipped chains, an authenticator app enrolled live (test secret shown once), Applied from a branch
  const seed = (await import(join(root, 'apps/api/dist/authn/config.js'))).SEED_CONFIG;
  const mk = async (name) => { const r = await api(T1, 'POST', '/versioning/branches', { name, from: 'main' }); assert.equal(r.status < 300, true, 'branch ' + name + ': ' + r.status + ' ' + JSON.stringify(await json(r.clone()))); };
  await mk('blocks-e2e-1');
  const putCfg = await api(T1, 'PUT', '/auth', { config: seed }, 'blocks-e2e-1'); assert.equal(putCfg.status < 300, true, 'chains saved: ' + putCfg.status + ' ' + JSON.stringify(await json(putCfg.clone())));
  const enr = await json(await api(T1, 'POST', '/auth/enrollments/demo-alice/authenticator-app', {}, 'blocks-e2e-1'));
  const secret = enr.shownOnce.secret; assert.match(secret, /^[A-Z2-7]{16,}$/);
  const ap1 = await json(await api(T1, 'POST', '/workspace/apply', { confirm: true }, 'blocks-e2e-1')); assert.equal(ap1.applied, true, JSON.stringify(ap1));

  // ---- 5. sign in through password then authenticator: level 8
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('[data-chain="password-then-authenticator"]');
  await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.locator('[data-chain="password-then-authenticator"]').first().click()]);
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', PW);
  await Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
  await page.waitForSelector('input[name=a_code]'); await shot('5-authenticator-step');
  await page.fill('input[name=a_code]', totpAt(secret, Date.now(), 30, 6));
  await Promise.all([page.waitForURL(/localhost:4200(?!\/core)/), page.click('button[type=submit]')]);
  await page.waitForSelector('nav');
  const T2 = lastToken; assert.equal(claimsOf(T2).auth_level, 8, 'level 8 after password + authenticator');

  // ---- 6. an unreachable level is refused when saved; a reachable one needs a level-8 session and is applied
  await mk('blocks-e2e-2');
  const sec = await json(await api(T2, 'GET', '/security', undefined, 'blocks-e2e-2'));
  const tooHigh = await api(T2, 'PUT', '/security', { config: { ...sec.working, adminMinLevel: 10 } }, 'blocks-e2e-2');
  assert.equal(tooHigh.status, 400, 'level 10 is refused (no chain reaches it): ' + tooHigh.status);
  const weak = await api(T1, 'PUT', '/security', { config: { ...sec.working, adminMinLevel: 8 } }, 'blocks-e2e-2');
  assert.equal(weak.status, 400, 'a level-3 session cannot raise the level to 8: ' + weak.status);
  const okSave = await api(T2, 'PUT', '/security', { config: { ...sec.working, adminMinLevel: 8 } }, 'blocks-e2e-2'); assert.equal(okSave.status < 300, true, 'saved at 8: ' + okSave.status);
  const ap2 = await json(await api(T2, 'POST', '/workspace/apply', { confirm: true }, 'blocks-e2e-2')); assert.equal(ap2.applied, true, JSON.stringify(ap2));

  // ---- 7. below the level the administration says step-up-required; the eligible chains are only those that reach 8
  const denied = await api(T1, 'GET', '/auth/enrollment-stats'); const dj = await json(denied);
  assert.equal(denied.status, 403); assert.equal(dj.code, 'step-up-required'); assert.equal(dj.requiredLevel, 8);
  assert.equal((await api(T2, 'GET', '/auth/enrollment-stats')).status, 200, 'the level-8 session keeps working');
  const opts = await json(await api(T1, 'GET', '/auth/me/step-up?level=8'));
  const ids = (opts.chains ?? []).map((c) => c.id);
  assert.ok(ids.includes('password-then-authenticator'), 'offers the authenticator chain: ' + ids.join(','));
  assert.ok(!ids.includes('password-only') && !ids.includes('password-then-e-mail-code'), 'never a weaker chain: ' + ids.join(','));

  // ---- 8. the console re-sign-in page lists only those chains (real API)
  await page.addInitScript((t) => { try { localStorage.setItem('iam.session', t); } catch {} }, T1);
  await page.goto(`${BASE}/step-up?kind=admin&level=8&current=3`);
  await page.waitForSelector('text=Password then authenticator', { timeout: 15000 });
  assert.doesNotMatch(await bodyText(), /Password only/); await shot('8-step-up-page');
  assert.deepEqual(errors.filter((e) => !/step-up|403/.test(e)), []);
  console.log('PASS account blocks: card after first factor, self-block refused, unblock, automatic lock, chains, level 8, step-up-required, unreachable level refused, re-sign-in page');
} catch (e) {
  console.error('FAILED:', e.message); try { const pg = browser?.contexts()[0]?.pages()[0]; console.error('URL:', pg?.url()); console.error('TEXT:', (await pg?.innerText('body'))?.slice(0, 1200)); } catch {} try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); } catch {}
  process.exitCode = 1;
} finally { await browser?.close(); await stopAll(); }
