// Real-browser end-to-end for authentication methods (local only): starts Dolt, the Rust core, the NestJS API (workspace mode)
// and `ng serve`, builds methods and chains in the console, enrolls a demo user, then signs in through the core's real login pages
// (password -> authenticator code, then e-mail code -> PIN) and checks the id_token claims. Saves desktop and mobile screenshots.
// The e-mail code goes to the DEMO OUTBOX (simulated). Binds to 127.0.0.1 only.
// Needs: DOLT_BIN, CHROME_BIN, playwright-core resolvable (NODE_PATH), built core and API.
// Usage: DOLT_BIN=... CHROME_BIN=... node scripts/auth-methods-e2e.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  let lastToken = null;
  page.on('response', async (r) => { if (r.url().endsWith('/token') && r.ok()) { try { lastToken = (await r.json()).id_token; } catch {} } });
  const BASE = 'http://localhost:4200';
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: false });
  const claims = () => JSON.parse(Buffer.from(lastToken.split('.')[1], 'base64url').toString());
  const noAlert = async (l) => assert.equal(await page.locator('[role=alert]').count(), 0, l + ': no alert (' + (await page.locator('[role=alert]').allInnerTexts()).join('|') + ')');
  const fillRow = async (id, sel, value) => page.locator(`tr:has(small:text-is("${id}")) ${sel}`).first().fill(String(value));
  const signInFirstStep = async (user, pw) => {
    await page.waitForSelector('#signin-browser');
    await Promise.all([page.waitForURL(/localhost:4200\/core\/authorize/), page.click('#signin-browser')]);
    await page.waitForSelector('input[name=username]');
    await page.fill('input[name=username]', user);
    if (pw !== undefined) await page.fill('input[name=password]', pw);
  };
  const submit = () => Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);

  // a classic bearer token for API checks, taken before any chain is live
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const auth = await (await fetch(BASE + '/core/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'demo-web', redirect_uri: BASE + '/callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', username: 'demo-alice', password: 'demo-only-not-a-secret' }) })).json();
  const tok = await (await fetch(BASE + '/core/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.code, code_verifier: verifier, client_id: 'demo-web', redirect_uri: BASE + '/callback' }) })).json();
  const call = (method, path, body, branch) => fetch('http://127.0.0.1:3000/tenants/acme-demo' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok.id_token, 'x-api-admin-token': ADMIN_TOKEN, ...(branch ? { 'x-iam-branch': branch } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const login1 = async () => {
    await page.goto(`${BASE}/login`); await signInFirstStep('demo-alice', 'demo-only-not-a-secret');
    await page.click('button[type=submit]'); await page.waitForSelector('[name=globalBranch]');
    await page.locator('details.token').evaluate((e) => (e.open = true)); await page.fill('[name=admintoken]', ADMIN_TOKEN);
  };
  const createBranch = async (name) => { await page.fill('[name=workspaceNewBranch]', name); await page.getByRole('button', { name: 'Create & select', exact: true }).click(); await page.waitForFunction((n) => document.querySelector('[name=globalBranch]')?.value === n, name); await page.waitForTimeout(200); };

  // ---- 1. classic sign-in (no chain yet), a working branch, the console page
  await login1(); await createBranch('authn-work');
  await page.locator('nav a[data-nav="/auth-methods"]').click();
  await page.waitForSelector('#authn-methods'); await noAlert('page'); await shot('1-empty-desktop');

  // ---- 2. build methods and chains in the console
  await page.waitForSelector('#authn-seeded'); // examples are offered before anything is stored
  assert.equal(await page.locator('tr:has(small:text-is("passkey"))').count(), 0, 'catalogue-only types are not seeded');
  await page.waitForSelector('tr:has(small:text-is("pin-keypad"))');
  // creating a new method and a new chain still works on top of the examples
  await page.selectOption('select[name=newtype]', 'totp'); await page.fill('input[name=newname]', 'Backup authenticator'); await page.click('#authn-add-method');
  await page.waitForSelector('tr:has(small:text-is("backup-authenticator"))');
  const chainBox = (id) => page.locator(`.chain[data-chain="${id}"]`);
  const c1 = chainBox('password-then-authenticator'), c2 = chainBox('e-mail-then-pin-keypad');
  await c1.waitFor();
  await c1.locator('input[type=radio]').check();
  await page.waitForFunction(() => document.querySelectorAll('.analysis').length >= 3);
  const a1 = await c1.locator('.analysis').innerText(), a2 = await c2.locator('.analysis').innerText();
  assert.match(a1, /Multi-factor/); assert.match(a2, /Not multi-factor/); assert.match(a2, /simulated/i);
  await shot('2-chains-desktop');
  await page.setViewportSize({ width: 390, height: 800 }); await shot('2b-chains-mobile'); await page.setViewportSize({ width: 1280, height: 1100 });
  await page.click('#authn-save'); await page.waitForSelector('#authn-note'); await noAlert('save');
  // staged only: the live sign-in still shows the classic form until Apply
  const probe = async () => { const r = await fetch(BASE + '/core/authorize?client_id=demo-web&redirect_uri=' + encodeURIComponent(BASE + '/callback') + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=x&response_type=code'); return r.text(); };
  assert.match(await probe(), /name="password"/, 'classic form before Apply');
  assert.match(await page.textContent('#authn-live'), /Saved on this branch, not live until Apply|single base password/);

  // ---- 3. demo enrollment (secret shown once)
  const enroll = async (id) => { await page.locator(`tr:has(small:text-is("${id}")) button:text-is("Settings")`).click(); };
  await enroll('authenticator-app'); await page.fill('input[name=enrolluser]', 'demo-alice'); await page.getByRole('button', { name: 'Provision', exact: true }).click();
  await page.waitForSelector('#authn-shown');
  const secret = (await page.locator('#authn-shown').innerText()).match(/: ([A-Z2-7]{16,})/)[1];
  await shot('3-enrolled-totp');
  await enroll('pin-keypad'); await enroll('e-mail-code');
  await page.fill('input[name=enrolluser]', 'demo-alice'); await page.fill('input[name=enrollemail]', 'alice@example.invalid'); await page.getByRole('button', { name: 'Provision', exact: true }).click(); await page.waitForSelector('#authn-shown');
  await enroll('e-mail-code'); await enroll('pin-keypad');
  await page.fill('input[name=enrolluser]', 'demo-alice'); await page.fill('input[name=enrollpin]', '246810'); await page.getByRole('button', { name: 'Provision', exact: true }).click(); await page.waitForSelector('#authn-shown'); await sleep(500);
  await noAlert('enroll');
  await shot('3b-methods-enrolled-desktop');
  const ap = await call('POST', '/workspace/apply', { confirm: true }, 'authn-work'); const apj = await ap.json(); assert.equal(apj.applied, true, JSON.stringify(apj));

  // ---- 4. sign out, sign in through the chain password -> authenticator
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInFirstStep('demo-alice', 'wrong'); await submit();
  assert.match(await page.textContent('body'), /Sign-in failed|Wrong|incorrect/i); await shot('4a-first-step-denied-mobile-desktop');
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret'); await submit();
  await page.waitForSelector('input[name=a_code]'); assert.match(await page.textContent('body'), /Step 2 of 2/);
  await page.setViewportSize({ width: 390, height: 780 }); await shot('4b-step2-authenticator-mobile'); await page.setViewportSize({ width: 1280, height: 1100 });
  await page.fill('input[name=a_code]', '000000'); await submit();
  assert.match(await page.textContent('body'), /Incorrect|attempt/i);
  await page.fill('input[name=a_code]', totpAt(secret, Date.now(), 30, 6)); await Promise.all([page.waitForURL(/localhost:4200(?!\/core)/), page.click('button[type=submit]')]);
  await page.waitForSelector('nav'); const k1 = claims();
  assert.equal(k1.auth_mfa, true); assert.deepEqual(k1.amr.sort(), ['otp', 'pwd']); assert.equal(k1.auth_level, 8); assert.equal(k1.auth_level_basis, 'configured');
  console.log('chain 1 claims', JSON.stringify({ amr: k1.amr, auth_level: k1.auth_level, auth_mfa: k1.auth_mfa, auth_chain: k1.auth_chain }));

  // ---- 5. a new branch from main (now holding the chains): make chain 2 the default (e-mail code -> PIN digits), Apply it
  await page.waitForSelector('[name=globalBranch]');
  await page.locator('details.token').evaluate((e) => (e.open = true)); await page.fill('[name=admintoken]', ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Refresh branches', exact: true }).click(); await createBranch('authn-work2');
  await page.locator('nav a[data-nav="/auth-methods"]').click(); await page.waitForSelector('.chain[data-chain="e-mail-then-pin-keypad"]');
  await page.locator('.chain[data-chain="e-mail-then-pin-keypad"] input[type=radio]').check();
  await page.click('#authn-save'); await page.waitForSelector('#authn-note');
  await shot('5-chain2-selected-desktop');
  const ap2 = await (await call('POST', '/workspace/apply', { confirm: true }, 'authn-work2')).json(); assert.equal(ap2.applied, true, JSON.stringify(ap2));
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInFirstStep('demo-alice'); await shot('5b-chain2-first-step');
  await submit();
  await page.waitForSelector('input[name=a_code]'); assert.match(await page.textContent('body'), /Step 1 of 2/);
  const box = await (await call('GET', '/auth/outbox')).json();
  assert.equal(box.simulated, true); const mail = box.messages.at(-1); assert.equal(mail.to, 'alice@example.invalid');
  const code = mail.text.match(/\b(\d{6})\b/)[1];
  await page.setViewportSize({ width: 390, height: 780 }); await shot('5c-chain2-email-step-mobile'); await page.setViewportSize({ width: 1280, height: 1100 });
  await page.fill('input[name=a_code]', code); await submit();
  await page.waitForSelector('.pad'); assert.match(await page.textContent('body'), /Step 2 of 2/);
  assert.equal(await page.locator('input[type=text],input[type=password]').count(), 0, 'no text input carries the PIN');
  await shot('5d-chain2-keypad-desktop');
  const order1 = await page.locator('.pad button.k b').allInnerTexts();
  await page.setViewportSize({ width: 390, height: 780 }); await shot('5e-chain2-keypad-mobile'); await page.setViewportSize({ width: 1280, height: 1100 });
  const pin = '246810'; let orders = [order1.join('')];
  for (const [n, d] of [...pin].entries()) {
    await page.locator(`.pad button.k:has(b:text-is("${d}"))`).first().click();
    await page.waitForFunction((k) => document.querySelectorAll('.dots i.on').length === k, n + 1);
    orders.push((await page.locator('.pad button.k b').allInnerTexts()).join(''));
  }
  assert.ok(new Set(orders).size > 3, 'the keypad order changes between pages: ' + orders.join(' '));
  await shot('5f-chain2-keypad-full');
  await Promise.all([page.waitForURL(/localhost:4200(?!\/core)/), page.locator('.pad .go').click()]);
  await page.waitForSelector('nav'); const k2 = claims();
  console.log('chain 2 claims', JSON.stringify({ amr: k2.amr, auth_level: k2.auth_level, auth_level_declared: k2.auth_level_declared, auth_mfa: k2.auth_mfa, auth_simulated: k2.auth_simulated }));
  assert.equal(k2.auth_mfa, false); assert.ok(!k2.amr.includes('email'), 'simulated e-mail is not claimed as verified'); assert.ok(k2.auth_simulated.length > 0);
  assert.deepEqual(errors, []);
  console.log('PASS authn: methods and chains built in the console, staged until Apply, chain 1 (password+TOTP) MFA claims, chain 2 (simulated e-mail + shuffled PIN keypad) not MFA');
} catch (e) {
  console.error('FAILED:', e.message); try { console.error((await browser?.contexts()[0]?.pages()[0]?.evaluate(() => [...document.querySelectorAll('.chain select')].map(e=>e.outerHTML).join('\n'))) ?? ''); } catch {} try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); } catch {}
  process.exitCode = 1;
} finally { await browser?.close(); await stopAll(); }
