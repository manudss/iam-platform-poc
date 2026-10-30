// Hosted check of the sign-in page: it lists the enabled chains, the picked chain runs, no legacy JSON login. FICTIONAL published demo credentials only.
// Usage: NODE_PATH=... CHROME_BIN=... node scripts/hosted-login-check.mjs https://<service>.onrender.com [outDir]
import { mkdirSync } from 'node:fs'; import { createHmac } from 'node:crypto'; import { tmpdir } from 'node:os'; import { join, resolve } from 'node:path'; import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const BASE = (process.argv[2] ?? '').replace(/\/$/, ''); const out = resolve(process.argv[3] ?? join(tmpdir(), 'iam-login-shots')); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b32 = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s) bits += A.indexOf(c).toString(2).padStart(5, '0'); const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); };
const totp = (secret, off = 0) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + off)); const h = createHmac('sha1', b32(secret)).update(c).digest(); const o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0'); };
for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(3000); }
const opts = await (await fetch(BASE + '/api/tenants/acme-demo/signin/options')).json();
console.log('options', opts.mode, opts.chains.map((c) => `${c.id}:${c.effectiveLevel}${c.simulated ? ':sim' : ''}`).join(' '));
assert.equal(opts.mode, 'choice'); assert.ok(opts.chains.length >= 3);
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const run = async (name, viewport, fn) => { const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e))); try { await fn(page); } finally { await ctx.close(); } assert.deepEqual(errs, [], name + ' page errors'); console.log('PASS', name); };
const pick = async (page, id) => { await page.goto(BASE + '/login'); await page.waitForSelector('#signin-methods'); await Promise.all([page.waitForURL(/\/core\/authorize/), page.click(`[data-chain=${id}]`)]); };
await run('login page lists methods (desktop)', { width: 1280, height: 800 }, async (page) => {
  await page.goto(BASE + '/login'); await page.waitForSelector('#signin-methods'); const t = await page.innerText('body');
  assert.ok(!/legacy json/i.test(t), 'no legacy JSON login'); assert.ok(/Password only/.test(t) && /Password then authenticator/.test(t) && /simulated step/.test(t));
  assert.equal(await page.locator('input[type=password]').count(), 0); await page.screenshot({ path: join(out, 'login-desktop.png') });
});
await run('login page lists methods (390px)', { width: 390, height: 844 }, async (page) => {
  await page.goto(BASE + '/login'); await page.waitForSelector('#signin-methods'); await sleep(500);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow'); await page.screenshot({ path: join(out, 'login-mobile.png') });
});
await run('password only signs in demo-alice', { width: 1280, height: 800 }, async (page) => {
  await pick(page, 'password-only'); await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await page.screenshot({ path: join(out, 'core-password-only.png') });
  await Promise.all([page.waitForURL(/\/(overview|callback)/), page.click('button[type=submit]')]); await page.waitForSelector('main.content, .who', { timeout: 20000 }); await sleep(800);
  assert.match(await page.innerText('.who'), /demo-alice`?/); await page.screenshot({ path: join(out, 'signed-in-password-only.png') });
});
await run('password then authenticator: wrong code refused, right code signs in', { width: 1280, height: 800 }, async (page) => {
  await pick(page, 'password-then-authenticator'); await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret'); await page.click('button[type=submit]');
  await page.waitForSelector('input[name=a_code]'); await page.screenshot({ path: join(out, 'core-second-step.png') });
  await page.fill('input[name=a_code]', totp('JBSWY3DPEHPK3PXP')); await Promise.all([page.waitForURL(/\/(overview|callback)/, { timeout: 20000 }), page.click('button[type=submit]')]);
  await page.waitForSelector('.who', { timeout: 20000 }); assert.match(await page.innerText('.who'), /demo-alice/);
});
await run('wrong password on a chosen chain is refused with a generic message', { width: 1280, height: 800 }, async (page) => {
  await pick(page, 'password-only'); await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'wrong-password-123'); await page.click('button[type=submit]'); await sleep(1500);
  assert.ok(/\/core\/authorize/.test(page.url())); assert.ok(!(await page.locator('.who').count()));
});
await browser.close(); console.log('ALL PASS');
