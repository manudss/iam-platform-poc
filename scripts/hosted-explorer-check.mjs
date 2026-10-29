// Live check of a hosted demo (fresh browser, NO admin token typed): sign in through the core form, then use the explorer.
// Usage: NODE_PATH=... CHROME_BIN=... node scripts/hosted-explorer-check.mjs https://<service>.onrender.com [outDir]
import { mkdirSync } from 'node:fs'; import { join, resolve } from 'node:path'; import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const base = process.argv[2]; const out = resolve(process.argv[3] ?? '/tmp/hosted-shots'); mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] });
const page = await (await b.newContext({ viewport: { width: 1100, height: 1500 } })).newPage(); page.setDefaultTimeout(90000);
page.on('dialog', (d) => d.accept());
const btn = (n) => page.locator('.explorer button').filter({ hasText: new RegExp(`^${n}$`) }).first();
const nav = (p) => page.click(`nav a[data-nav="${p}"]`);
const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: true });
try {
  await page.goto(base + '/'); await page.click('#signin-browser'); await page.waitForSelector('input[name=password]');
  await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await page.click('button[type=submit]'); await page.waitForSelector('nav a[data-nav="/database/branches"]');
  assert.equal(await page.locator('input[name=admintoken]').inputValue(), ''); // no token typed: the edge adds it
  await nav('/database/branches');
  await page.waitForSelector('text=protected'); await shot('h1-branches');
  assert.doesNotMatch(await page.locator('.explorer .msg').first().innerText().catch(() => ''), /capability required/);
  const br = 'hosted-' + Date.now().toString(36);
  await page.fill('input[name=nb]', br); await btn('Create branch').click(); await page.waitForSelector(`td:has-text("${br}")`);
  await nav('/database/data'); await page.selectOption('select[name=dr]', br); await page.click('button:has-text("roles")'); await page.waitForSelector('th:has-text("label")');
  await btn('Add a row').click(); await page.fill('textarea[name=ej]', JSON.stringify({ id: 'auditor-' + br, label: 'Auditor', is_sensitive: 0 }));
  await page.fill('input[name=em]', 'add role'); await btn('Commit change').click(); await page.waitForSelector('td:has-text("Auditor")');
  await nav('/database/pulls'); await page.selectOption('select[name=ps]', br); await page.fill('input[name=pti]', 'Hosted check ' + br); await btn('Open pull request').click();
  await page.waitForSelector('text=Can be merged'); assert.equal(await btn('Approve').isDisabled(), true); await shot('h2-pull-request');
  await btn('Merge').click(); await page.waitForSelector('.explorer .msg:has-text("Merged as")'); await page.waitForTimeout(2500); await shot('h3-merged');
  await nav('/assignments'); await page.waitForSelector('#assignments td:text-is("demo-bob")'); await nav('/plugins'); await page.waitForSelector('#plugins table');
  assert.equal(await page.locator('[role=alert]').count(), 0);
  assert.doesNotMatch((await page.textContent('body')) ?? '', /capability required|Failed to fetch/);
  await page.goto(base + '/database/pulls'); await page.waitForSelector('#signin-browser'); // a direct link needs sign-in again (token is memory only), then returns to that page
  await page.click('#signin-browser'); await page.waitForSelector('input[name=password]'); await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret'); await page.click('button[type=submit]');
  await page.waitForSelector('nav a.active[data-nav="/database/pulls"]');
  console.log('HOSTED CHECK OK', base, br);
} catch (e) { console.error('FAILED', e.message); await shot('h-failure'); process.exitCode = 1; } finally { await b.close(); }
