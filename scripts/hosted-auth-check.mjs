// Real-browser check of the HOSTED preview (fresh browser, NO admin token typed: the edge adds it). Fictional demo data only.
// Builds methods and chains in the console, Applies, signs in through the chains and checks the id_token claims.
// Usage: NODE_PATH=... CHROME_BIN=... node scripts/hosted-auth-check.mjs https://<service>.onrender.com [outDir]
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
const BASE = (process.argv[2] ?? '').replace(/\/$/, ''); if (!BASE) { console.log('usage: hosted-auth-check.mjs <url> [outDir]'); process.exit(1); }
const out = resolve(process.argv[3] ?? join(tmpdir(), 'iam-hosted-authn-shots')); mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME_BIN; const ADMIN_TOKEN = '';
const HOSTRE = new RegExp(new URL(BASE).host.replace(/\./g, '\\.') + '(?!\\/core)');
const stopAll = async () => {}; const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(2000); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  let lastToken = null;
  page.on('response', async (r) => { if (r.url().endsWith('/token') && r.ok()) { try { lastToken = (await r.json()).id_token; } catch {} } });
    const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: false });
  const claims = () => JSON.parse(Buffer.from(lastToken.split('.')[1], 'base64url').toString());
  const noAlert = async (l) => assert.equal(await page.locator('[role=alert]').count(), 0, l + ': no alert (' + (await page.locator('[role=alert]').allInnerTexts()).join('|') + ')');
  const fillRow = async (id, sel, value) => page.locator(`tr:has(small:text-is("${id}")) ${sel}`).first().fill(String(value));
  const signInFirstStep = async (user, pw) => {
    await page.waitForSelector('#signin-browser, [data-chain=password-only]');
    await Promise.all([page.waitForURL(/\/core\/authorize/), page.click('#signin-browser, [data-chain=password-only]')]);
    await page.waitForSelector('input[name=username]');
    await page.fill('input[name=username]', user);
    if (pw !== undefined) await page.fill('input[name=password]', pw);
  };
  const submit = () => Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);

  // a classic bearer token for API checks, taken before any chain is live
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const auth = await (await fetch(BASE + '/core/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'demo-web', redirect_uri: BASE + '/callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', username: 'demo-alice', password: 'demo-only-not-a-secret' }) })).json();
  const tok = await (await fetch(BASE + '/core/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.code, code_verifier: verifier, client_id: 'demo-web', redirect_uri: BASE + '/callback' }) })).json();
  const call = (method, path, body, branch) => fetch(BASE + '/api/tenants/acme-demo' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok.id_token, ...(branch ? { 'x-iam-branch': branch } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const login1 = async () => {
    await page.goto(`${BASE}/login`); await signInFirstStep('demo-alice', 'demo-only-not-a-secret');
    await page.click('button[type=submit]'); await page.waitForSelector('[name=globalBranch]');
    
  };
  const createBranch = async (name) => { await openManage(page); await page.fill('[name=workspaceNewBranch]', name); await page.getByRole('button', { name: 'Create & select', exact: true }).click(); await page.waitForFunction((n) => document.querySelector('[name=globalBranch]')?.value === n, name); await page.waitForTimeout(200); };

  // ---- 1. classic sign-in (no chain yet), a working branch, the console page
  await login1(); await createBranch('aw-' + RUN);
  await page.locator('nav a[data-nav="/auth-methods"]').click();
  await page.waitForSelector('#authn-methods'); await noAlert('page'); await shot('1-empty-desktop');

  // ---- 2. build methods and chains in the console
  await page.locator('.it[data-key="m:pin-keypad"]').waitFor(); assert.equal(await page.locator('#authn-seeded').count(), 0, 'the examples are STORED by the demo seed, not a UI default');
  const live0 = await (await call('GET', '/auth', undefined, 'aw-' + RUN)).json(); const dc = live0.working?.config?.defaultChain; assert.ok(live0.working?.config?.chains?.some((c) => c.id === 'password-then-authenticator') && live0.working?.seeded === false && (dc === null || dc === 'password-only'), 'stored seed (examples stored, not a UI default; no MFA chain selected): ' + JSON.stringify({ dc, seeded: live0.working?.seeded }));
  assert.equal(await page.locator('.it[data-key="m:passkey"]').count(), 0, 'catalogue-only types are not seeded');
  const item = (key) => page.locator(`.it[data-key="${key}"]`);
  const editOf = async (key) => { await item(key).getByRole('button', { name: 'Edit', exact: true }).click(); await page.waitForSelector('#authn-edit'); };
  const done = async () => { await page.locator('#authn-edit').getByRole('button', { name: 'Done', exact: true }).click(); await page.waitForSelector('#authn-edit', { state: 'detached' }); };
  // a new instance through the single button and the type chooser
  await page.click('#authn-new-instance'); await page.waitForSelector('#authn-type-chooser');
  await page.click('#authn-type-chooser [data-type="totp"]'); await page.fill('input[name=newname]', 'Backup authenticator'); await page.click('#authn-create-instance');
  await item('m:backup-authenticator').waitFor();
  await editOf('c:password-then-authenticator'); await page.locator('#authn-edit [name=erec]').check();
  await page.waitForSelector('#authn-edit .analysis'); const a1 = await page.locator('#authn-edit .analysis').innerText(); await done();
  await editOf('c:e-mail-then-pin-keypad'); await page.waitForSelector('#authn-edit .analysis'); const a2 = await page.locator('#authn-edit .analysis').innerText(); await done();
  // regression: a new chain accepts a step that is not in use, and its panel stays open
  await page.click('#authn-new-chain'); await page.fill('.modal input[name=chainname]', 'Regression chain'); await page.click('#authn-create-chain'); await page.waitForSelector('#authn-edit');
  await page.selectOption('#authn-edit select[name=steppick]', { label: 'E-mail code (not in use)' }).catch(async () => { await page.selectOption('#authn-edit select[name=steppick]', { index: 2 }); });
  await page.click('#authn-add-step'); await page.waitForSelector('#authn-edit .steps li'); await page.click('#authn-add-step');
  assert.equal(await page.locator('#authn-edit .steps li').count(), 2, 'two steps, panel still open');
  await done(); await item('c:regression-chain').waitFor();
  assert.match(a1, /Multi-factor/); assert.match(a2, /Not multi-factor/); assert.match(a2, /simulated/i);
  await shot('2-chains-desktop');
  await page.setViewportSize({ width: 390, height: 800 }); await shot('2b-chains-mobile'); await page.setViewportSize({ width: 1280, height: 1100 });
  await page.click('#authn-save'); await page.waitForSelector('#authn-note'); await noAlert('save');
  // staged only: the live sign-in still shows the classic form until Apply
  const probe = async () => { const r = await fetch(BASE + '/core/authorize?client_id=demo-web&redirect_uri=' + encodeURIComponent(BASE + '/callback') + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=x&response_type=code'); return r.text(); };
  assert.match(await probe(), /name="password"/, 'classic form before Apply');
  assert.match(await page.textContent('#authn-live'), /Saved on this branch, not live until Apply|single base password/);

  // ---- 3. demo enrollment (secret shown once)
  // the demo seed already enrolled the fictional demo-alice (TOTP, PIN, e-mail) with the published fictional credentials: nothing is provisioned here
  const secret = 'JBSWY3DPEHPK3PXP';
  await noAlert('enroll');
  await shot('3b-methods-enrolled-desktop');
  const ap = await call('POST', '/workspace/apply', { confirm: true }, 'aw-' + RUN); const apj = await ap.json(); assert.equal(apj.applied, true, JSON.stringify(apj));

  // ---- 4. sign out, sign in through the chain password -> authenticator
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInFirstStep('demo-alice', 'wrong'); await submit();
  assert.match(await page.textContent('body'), /Sign-in failed|Wrong|incorrect/i); await shot('4a-first-step-denied-mobile-desktop');
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret'); await submit();
  await page.waitForSelector('input[name=a_code]'); assert.match(await page.textContent('body'), /Step 2 of 2/);
  await page.setViewportSize({ width: 390, height: 780 }); await shot('4b-step2-authenticator-mobile'); await page.setViewportSize({ width: 1280, height: 1100 });
  await page.fill('input[name=a_code]', '000000'); await submit();
  assert.match(await page.textContent('body'), /Incorrect|attempt/i);
  await page.fill('input[name=a_code]', totpAt(secret, Date.now(), 30, 6)); await Promise.all([page.waitForURL(HOSTRE), page.click('button[type=submit]')]);
  await page.waitForSelector('nav'); const k1 = claims();
  assert.equal(k1.auth_mfa, true); assert.deepEqual(k1.amr.sort(), ['otp', 'pwd']); assert.equal(k1.auth_level, 8); assert.equal(k1.auth_level_basis, 'configured');
  console.log('chain 1 claims', JSON.stringify({ amr: k1.amr, auth_level: k1.auth_level, auth_mfa: k1.auth_mfa, auth_chain: k1.auth_chain }));

  // ---- 5. a new branch from main (now holding the chains): make chain 2 the default (e-mail code -> PIN digits), Apply it
  await page.waitForSelector('[name=globalBranch]');
  
  await openManage(page); await page.getByRole('button', { name: 'Refresh branches', exact: true }).click(); await createBranch('aw2-' + RUN);
  await page.locator('nav a[data-nav="/auth-methods"]').click(); await item('c:e-mail-then-pin-keypad').waitFor();
  await editOf('c:e-mail-then-pin-keypad'); await page.locator('#authn-edit [name=erec]').check(); await done();
  await page.click('#authn-save'); await page.waitForSelector('#authn-note');
  await shot('5-chain2-selected-desktop');
  const ap2 = await (await call('POST', '/workspace/apply', { confirm: true }, 'aw2-' + RUN)).json(); assert.equal(ap2.applied, true, JSON.stringify(ap2));
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
  await Promise.all([page.waitForURL(HOSTRE), page.locator('.pad .go').click()]);
  await page.waitForSelector('nav'); const k2 = claims();
  console.log('chain 2 claims', JSON.stringify({ amr: k2.amr, auth_level: k2.auth_level, auth_level_declared: k2.auth_level_declared, auth_mfa: k2.auth_mfa, auth_simulated: k2.auth_simulated }));
  assert.equal(k2.auth_mfa, false); assert.ok(!k2.amr.includes('email'), 'simulated e-mail is not claimed as verified'); assert.ok(k2.auth_simulated.length > 0);
  // leave the shared preview as we found it: classic password sign-in again (a restart does not reset the stored configuration)
  await page.waitForSelector('[name=globalBranch]');
  await openManage(page); await page.getByRole('button', { name: 'Refresh branches', exact: true }).click(); await createBranch('aw3-' + RUN);
  await page.locator('nav a[data-nav="/auth-methods"]').click(); await item('c:password-only').waitFor();
  await editOf('c:password-only'); await page.locator('#authn-edit [name=erec]').check(); await done(); await page.click('#authn-save'); await page.waitForSelector('#authn-note');
  const ap3 = await (await call('POST', '/workspace/apply', { confirm: true }, 'aw3-' + RUN)).json(); assert.equal(ap3.applied, true, JSON.stringify(ap3));
  assert.deepEqual(errors, []);
  console.log('HOSTED PASS authn: methods and chains built in the console, staged until Apply, chain 1 (password+TOTP) MFA claims, chain 2 (simulated e-mail + shuffled PIN keypad) not MFA');
} catch (e) {
  console.error('FAILED:', e.message); try { console.error((await browser?.contexts()[0]?.pages()[0]?.evaluate(() => [...document.querySelectorAll('#authn-edit select')].map(e=>e.outerHTML).join('\n'))) ?? ''); } catch {} try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); } catch {}
  process.exitCode = 1;
} finally { await browser?.close(); await stopAll(); }
