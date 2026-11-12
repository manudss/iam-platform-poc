// Real-browser end-to-end for passkeys (local only): starts Dolt, the Rust core, the NestJS API (workspace mode)
// and `ng serve`, saves the seeded methods and chains (now including the real passkey method), then
//   1. enrolls a passkey for demo-alice from her own profile, through a CDP VIRTUAL AUTHENTICATOR
//      (real WebAuthn ceremonies in the browser, no hardware needed);
//   2. signs in through the passkey-only chain on the core's real pages (the core-owned ceremony script);
//   3. checks the id_token claims (amr hwk, level 9, not MFA alone).
// Binds to 127.0.0.1 only. Needs: DOLT_BIN, CHROME_BIN, NATS_SERVER_BIN, playwright-core resolvable (NODE_PATH),
// built core and API.
// Usage: DOLT_BIN=... CHROME_BIN=... NATS_SERVER_BIN=... node scripts/auth-webauthn-e2e.mjs [outDir]
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
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-webauthn-shots')); mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN; if (!dolt || !chrome) { console.log('SKIPPED: DOLT_BIN and CHROME_BIN are required'); process.exit(0); }
const NATS = process.env.NATS_SERVER_BIN ?? process.env.NATS_BIN; assert.ok(NATS, 'NATS_SERVER_BIN is required');
const dir = mkdtempSync(join(tmpdir(), 'iam-webauthn-')), home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data);
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  let lastToken = null;
  page.on('response', async (r) => { if (r.url().endsWith('/token') && r.ok()) { try { lastToken = (await r.json()).id_token; } catch {} } });
  const BASE = 'http://localhost:4200';
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: false });
  const claims = () => JSON.parse(Buffer.from(lastToken.split('.')[1], 'base64url').toString());
  const item = (key) => page.locator(`.it[data-key="${key}"]`);
  const editOf = async (key) => { await item(key).getByRole('button', { name: 'Edit', exact: true }).click(); await page.waitForSelector('#authn-edit'); };
  const done = async () => { await page.locator('#authn-edit').getByRole('button', { name: 'Done', exact: true }).click(); await page.waitForSelector('#authn-edit', { state: 'detached' }); };
  const login1 = async () => {
    await page.goto(`${BASE}/login`);
    await page.waitForSelector('#signin-browser');
    await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.locator('#signin-browser').first().click()]);
    await page.waitForSelector('input[name=username]');
    await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
    await page.click('button[type=submit]'); await page.waitForSelector('[name=globalBranch]');
    await page.locator('details.token').evaluate((e) => (e.open = true)); await page.fill('[name=admintoken]', ADMIN_TOKEN);
  };
  const createBranch = async (name) => { await openManage(page); await page.fill('[name=workspaceNewBranch]', name); await page.getByRole('button', { name: 'Create & select', exact: true }).click(); await page.waitForFunction((n) => document.querySelector('[name=globalBranch]')?.value === n, name); await page.waitForTimeout(200); };
  const call = (method, path, body, branch) => fetch('http://127.0.0.1:3000/tenants/acme-demo' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + lastToken, 'x-api-admin-token': ADMIN_TOKEN, ...(branch ? { 'x-iam-branch': branch } : {}) }, body: body ? JSON.stringify(body) : undefined });

  // A virtual authenticator (Chrome DevTools Protocol): a software security key inside the browser, with user
  // verification, so every WebAuthn ceremony below is the real browser flow, approved automatically.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  assert.ok(authenticatorId, 'virtual authenticator created');

  // ---- 1. console sign-in (no chain yet), a working branch, save the seeded methods (passkey included)
  await login1(); await createBranch('authn-pk');
  await page.locator('nav a[data-nav="/auth-methods"]').click();
  await page.waitForSelector('#authn-methods');
  await item('m:passkey').waitFor(); // the passkey method is now a real, seeded method (no longer catalogue-only)
  await item('c:passkey-only').waitFor(); await item('c:password-then-passkey').waitFor();
  await shot('1-seeded-with-passkey');
  await page.click('#authn-save'); await page.waitForSelector('#authn-note');
  const ap = await (await call('POST', '/workspace/apply', { confirm: true }, 'authn-pk')).json(); assert.equal(ap.applied, true, JSON.stringify(ap));

  // ---- 2. enroll a passkey from the person's own profile (browser ceremony on her session)
  await page.locator('nav a[data-nav="/my-profile"]').click();
  const comp = page.locator('iam-passkeys-profile');
  await comp.waitFor();
  await comp.getByRole('button', { name: 'Add a passkey' }).waitFor();
  await comp.locator('#pk-name').fill('Virtual key');
  await shot('2a-profile-passkeys');
  await comp.getByRole('button', { name: 'Add a passkey' }).click();
  await page.waitForFunction(() => document.querySelector('iam-passkeys-profile')?.textContent?.includes('Passkey registered'), undefined, { timeout: 15000 });
  assert.ok(await comp.locator('.pk-name', { hasText: 'Virtual key' }).count(), 'the named passkey is listed');
  await shot('2b-passkey-enrolled');

  // ---- 3. sign out, sign in through the passkey-only chain (core ceremony page + script)
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForSelector('[data-chain="passkey-only"]');
  await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.locator('[data-chain="passkey-only"]').first().click()]);
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', 'demo-alice');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-wa-options]');
  assert.match(await page.textContent('body'), /Step 1 of 1|Passkey/);
  assert.equal(await page.locator('button[type=submit]').count(), 0, 'the passkey step submits from the ceremony, not a Continue button');
  await page.setViewportSize({ width: 390, height: 780 }); await shot('3a-passkey-step-mobile'); await page.setViewportSize({ width: 1280, height: 1100 });
  await shot('3b-passkey-step-desktop');
  await Promise.all([page.waitForURL(/localhost:4200(?!\/core)/, { timeout: 15000 }), page.locator('.wa-btn').click()]);
  await page.waitForSelector('nav'); const k = claims();
  assert.deepEqual(k.amr, ['hwk']); assert.equal(k.auth_level, 9); assert.equal(k.auth_mfa, false, 'one passkey alone is one factor'); assert.equal(k.auth_chain, 'passkey-only');
  console.log('passkey chain claims', JSON.stringify({ amr: k.amr, auth_level: k.auth_level, auth_mfa: k.auth_mfa, auth_chain: k.auth_chain }));

  // ---- 4. a cancelled ceremony stays on the step with an explanation (remove the authenticator, try again)
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForSelector('[data-chain="passkey-only"]');
  await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.locator('[data-chain="passkey-only"]').first().click()]);
  await page.fill('input[name=username]', 'demo-alice'); await page.click('button[type=submit]');
  await page.waitForSelector('[data-wa-options]');
  await page.locator('.wa-btn').click();
  await page.waitForFunction(() => document.querySelector('.wa-status')?.textContent?.length > 0, undefined, { timeout: 15000 });
  assert.match(await page.locator('.wa-status').innerText(), /passkey|cancelled|timed out/i);
  assert.equal(errors.filter((e) => !/WebAuthn|credentials/.test(e)).length, 0, 'no unexpected page errors: ' + errors.join(' | '));
  await shot('4-ceremony-refused');
  console.log('PASS webauthn: passkey enrolled from the profile through a virtual authenticator, passkey-only sign-in with hwk/level 9 claims, refused ceremony explained');
} catch (e) {
  console.error('FAILED:', e.message); try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); } catch {}
  process.exitCode = 1;
} finally { await browser?.close(); await stopAll(); }
