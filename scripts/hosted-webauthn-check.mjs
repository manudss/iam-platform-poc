// Real-browser check of the HOSTED passkey flow (fresh browser, virtual authenticator over CDP: real
// WebAuthn ceremonies, no hardware). Fictional demo data only.
//   1. /authorize/webauthn.js is served by the core as JavaScript (regression: the hosted edge used to
//      send it to the SPA, which answered HTML, so "Use my passkey" did nothing);
//   2. demo-alice enrolls a passkey from her profile on the hosted preview;
//   3. she signs in through the passkey-only chain (core ceremony page + script) and lands signed in
//      with the hwk/level 9 claims.
// Usage: NODE_PATH=... CHROME_BIN=... node scripts/hosted-webauthn-check.mjs https://<service>.onrender.com [outDir]
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const BASE = (process.argv[2] ?? '').replace(/\/$/, ''); if (!BASE) { console.log('usage: hosted-webauthn-check.mjs <url> [outDir]'); process.exit(1); }
const out = resolve(process.argv[3] ?? join(tmpdir(), 'iam-hosted-webauthn-shots')); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(2000); }

// ---- 1. the ceremony script must be JavaScript from the core, not the SPA's HTML
const js = await fetch(BASE + '/authorize/webauthn.js');
assert.match(js.headers.get('content-type') ?? '', /javascript/, 'ceremony script MIME type');
assert.match(await js.text(), /navigator\.credentials\.get/, 'ceremony script body');
console.log('PASS 1: /authorize/webauthn.js served as JavaScript');

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  let lastToken = null;
  page.on('response', async (r) => { if (r.url().endsWith('/token') && r.ok()) { try { lastToken = (await r.json()).id_token; } catch {} } });
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: false });
  const claims = () => JSON.parse(Buffer.from(lastToken.split('.')[1], 'base64url').toString());

  // A virtual authenticator (Chrome DevTools Protocol): a software security key inside the browser.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  assert.ok(authenticatorId, 'virtual authenticator created');

  // ---- 2. password sign-in, enroll a passkey from the profile
  await page.goto(BASE + '/login'); await page.waitForSelector('#signin-methods');
  await Promise.all([page.waitForURL(/\/core\/authorize/), page.click('[data-chain=password-only]')]);
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await Promise.all([page.waitForURL(/\/(overview|callback)/), page.click('button[type=submit]')]);
  await page.waitForSelector('.who', { timeout: 30000 });
  await page.locator('nav a[data-nav="/my-profile"]').click();
  const comp = page.locator('iam-passkeys-profile');
  await comp.waitFor();
  await comp.getByRole('button', { name: 'Add a passkey' }).waitFor();
  await comp.locator('#pk-name').fill('Hosted virtual key');
  await comp.getByRole('button', { name: 'Add a passkey' }).click();
  await page.waitForFunction(() => document.querySelector('iam-passkeys-profile')?.textContent?.includes('Passkey registered'), undefined, { timeout: 30000 });
  await shot('enrolled');
  console.log('PASS 2: passkey enrolled on the hosted preview');

  // ---- 3. sign out, sign in through the passkey-only chain
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForSelector('[data-chain="passkey-only"]');
  await Promise.all([page.waitForURL(/\/core\/authorize/), page.locator('[data-chain="passkey-only"]').first().click()]);
  await page.fill('input[name=username]', 'demo-alice');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-wa-options]');
  assert.equal(await page.locator('button[type=submit]').count(), 0, 'the passkey step submits from the ceremony');
  await shot('passkey-step');
  await page.locator('.wa-btn').click();
  for (let i = 0; i < 15 && page.url().includes('/authorize'); i++) {
    await sleep(2000);
    console.log('ceremony poll', JSON.stringify(await page.evaluate(() => ({ url: location.pathname, status: document.querySelector('.wa-status')?.textContent ?? null, disabled: document.querySelector('.wa-btn')?.disabled ?? null, answer: document.querySelector('input[name=a_webauthn]')?.value?.length ?? null }))));
  }
  assert.ok(!page.url().includes('/authorize'), 'the passkey ceremony did not complete');
  await page.waitForSelector('.who', { timeout: 30000 });
  assert.match(await page.innerText('.who'), /demo-alice/);
  const k = claims();
  assert.deepEqual(k.amr, ['hwk']); assert.equal(k.auth_level, 9); assert.equal(k.auth_mfa, false); assert.equal(k.auth_chain, 'passkey-only');
  await shot('signed-in-passkey');
  assert.equal(errors.filter((e) => !/WebAuthn|credentials/.test(e)).length, 0, 'no unexpected page errors: ' + errors.join(' | '));
  console.log('PASS 3: passkey-only sign-in on the hosted preview, claims', JSON.stringify({ amr: k.amr, auth_level: k.auth_level, auth_chain: k.auth_chain }));
  console.log('ALL PASS');
} finally {
  await browser.close();
}
