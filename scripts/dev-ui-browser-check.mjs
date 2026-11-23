// Real-browser check of the LOCAL dev stack (already running, docker compose dev override):
// drives headless Chrome through the genuine console UI, the same path a developer follows.
//   1. PKCE sign-in through the real authorize form (demo-alice, fictional),
//   2. My applications must render without "Internal server error" (user-reported symptom),
//   3. the Roles screen must open the personal branch WITHOUT any manually typed admin token:
//      the "Enter the admin capability token" banner and a stuck "Branch unavailable" pill are failures.
// Needs: CHROME_BIN, playwright-core resolvable (NODE_PATH), the dev stack listening on BASE.
// Loopback only, fictional demo data. Usage: node scripts/dev-ui-browser-check.mjs [outDir]
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const BASE = process.env.DEV_UI_BASE ?? 'http://localhost:4200'; // the sign-in redirect_uri is localhost:4200; 127.0.0.1 is a DIFFERENT origin (own sessionStorage), which bounced the check to /login
const out = process.argv[2] ?? join(tmpdir(), 'dev-ui-shots'); mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME_BIN;
if (!chrome) { console.log('SKIPPED: CHROME_BIN is required'); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
let failed = false;
const fail = (name, why) => { failed = true; console.log('FAIL', name, why); };
const ok = (name, extra = '') => console.log('PASS', name, extra);
const pageErrors = []; // JS errors and console.error lines, so a stuck screen explains itself in the job log
let page = null;
try {
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  const bannerHit = { at: null };
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text().slice(0, 200)}`); });

  // 1. real PKCE sign-in, started from the console's own login page: the console generates and stores
  // the state + verifier, so driving /core/authorize directly would fail the callback's state check.
  await page.goto(`${BASE}/login`);
  await Promise.all([page.waitForURL(/\/core\/authorize\//, { timeout: 20000 }), page.click('button:has-text("Sign in")')]);
  await page.waitForSelector('input[name=password]', { timeout: 15000 });
  await page.fill('input[name=username]', 'demo-alice');
  await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await Promise.all([page.waitForURL(/localhost:4200\/callback/, { timeout: 20000 }), page.click('button[type=submit]')]);
  // The callback page still has to exchange the code and store the session before it routes away;
  // a manual goto here races that exchange, loses the session and the console bounces to /login.
  await page.waitForURL((u) => !u.pathname.startsWith('/callback'), { timeout: 20000 });
  ok('browser sign-in', page.url().slice(0, 60));

  // 2. My applications: no Internal server error, the workspace renders
  if (!page.url().includes('/my-applications')) await page.goto(`${BASE}/my-applications`);
  await page.waitForSelector('text=My applications', { timeout: 20000 });
  let sawError = false;
  for (let i = 0; i < 30; i++) {
    const body = await page.textContent('body');
    if (/Internal server error/i.test(body)) { sawError = true; break; }
    if (/Other applications|Favourites/i.test(body)) break; // list settled
    await sleep(500);
  }
  await page.screenshot({ path: join(out, '1-my-applications.png'), fullPage: true });
  if (sawError) fail('My applications in a real browser', '"Internal server error" shown');
  else ok('My applications in a real browser', 'no server error, list rendered');

  // 3. Roles screen: the personal branch must open without any typed admin token
  const nav = page.locator('a[data-nav="/roles"]');
  if ((await nav.count()) === 0) { fail('Roles screen without a typed token', 'no Roles nav entry (admin area not entered?)'); }
  else {
    await nav.first().click();
    let banner = false;
    for (let i = 0; i < 40; i++) {
      const body = await page.textContent('body');
      if (/Enter the admin capability token/i.test(body)) { banner = true; bannerHit.at = i * 0.5; break; }
      await sleep(500);
    }
    await page.screenshot({ path: join(out, '2-roles.png'), fullPage: true });
    const body = await page.textContent('body');
    if (banner) fail('Roles screen without a typed token', `capability banner appeared after ~${bannerHit.at}s`);
    else if (/Branch unavailable/i.test(body)) fail('Roles screen without a typed token', 'branch pill stuck on "Branch unavailable"');
    else ok('Roles screen without a typed token', 'personal branch opened, no capability banner');
  }
} catch (e) {
  failed = true;
  console.log('FAIL browser flow crashed:', String(e && e.message || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  if (page) {
    console.log('page url:', page.url());
    const body = await page.textContent('body').catch(() => '<unreadable>');
    console.log('page body (first 400 chars):', (body || '').replace(/\s+/g, ' ').slice(0, 400) || '<empty>');
    await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
  }
} finally { await browser.close(); }
if (pageErrors.length) console.log('page errors:', JSON.stringify(pageErrors.slice(0, 10)));
if (failed) { console.log('DEV UI BROWSER CHECK FAILED'); process.exit(1); }
console.log('DEV UI BROWSER CHECK PASSED');
