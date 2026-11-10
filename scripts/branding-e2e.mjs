// Branding browser end-to-end (local only): starts Dolt, the Rust core, the NestJS API and `production SSR`, then drives the Angular administration (sidebar pages, deep links, refresh, mobile) with headless Chrome through playwright-core, and saves screenshots. Binds to 127.0.0.1 only.
// console with headless Chrome through playwright-core, and saves screenshots. Binds to 127.0.0.1 only.
// Needs: DOLT_BIN, CHROME_BIN, playwright-core resolvable (npm i playwright-core), built core and API (core/target/debug/iam-core, apps/api/dist).
// Usage: DOLT_BIN=... CHROME_BIN=... node scripts/ui-e2e.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core'); // honours NODE_PATH

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-branding-shots'));
mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN;
if (!dolt || !chrome) { throw Error('DOLT_BIN and CHROME_BIN are required'); }
const dir = mkdtempSync(join(tmpdir(), 'iam-ui-')), home = join(dir, 'h'), data = join(dir, 'd');
mkdirSync(home); mkdirSync(data);
const env = { ...process.env, HOME: home };
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v], { env });
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, env, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
// Each child starts in its OWN process group (detached) so the whole tree (npx -> production SSR, node, ...) can be stopped by group, never by a name pattern.
const run = (cmd, args, opts) => procs.push(spawn(cmd, args, { stdio: ['ignore',openSync(join(out, 'process-'+procs.length+'.log'),'w'),openSync(join(out, 'error-'+procs.length+'.log'),'w')], detached: true, ...opts }));
const portOpen = (port) => new Promise((ok) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); ok(true); }); c.once('error', () => ok(false)); });
// Descendants of the children we started, snapshotted BEFORE stopping anything (`production SSR` moves its server into its own session, so a group kill alone misses it).
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
  for (let i = 0; i < 40 && ((await portOpen(4200)) || (await portOpen(8081)) || (await portOpen(3000)) || (await portOpen(3307)) || (await portOpen(4000))); i++) {
    if (i === 20) { for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } }
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const port of [4200, 8081, 3000, 3307]) if (await portOpen(port)) console.log('WARNING: port ' + port + ' still in use after cleanup');
};
run(dolt, ['sql-server', '--host', '127.0.0.1', '--port', '3307', '--data-dir', data], { cwd: data, env });
const GATE = { IAM_AUTH_GATE_ADDR: '127.0.0.1:3000', IAM_AUTH_GATE_TOKEN: 'local-gate-token-demo' }; // sign-in goes through the plugin gate (API on :3000)
const ADMIN_TOKEN = 'local-demo-plugin-admin-token';
const CORE_TOKEN = 'local-core-admin-token-demo';
// Step 3: the API requires the real event bus; CI provides NATS_SERVER_BIN.
const NATS = process.env.NATS_SERVER_BIN ?? process.env.NATS_BIN;
assert.ok(NATS, 'NATS_SERVER_BIN is required');
if (NATS) { run(NATS, ['-c', join(root, 'conf/nats-local.conf')]); await sleep(1000); }
run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), env: { ...process.env, ...GATE, IAM_CORE_ADMIN_TOKEN: CORE_TOKEN, ...(NATS ? { IAM_CORE_NATS_URL: '127.0.0.1:4222', IAM_CORE_NATS_PASSWORD: 'core-dev' } : {}) } });
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_BUS_NATS_URL: '127.0.0.1:4222', IAM_BUS_NATS_USER: 'api-host', IAM_BUS_NATS_PASSWORD: 'api-host-dev', IAM_WORKSPACE_MODE: '1', IAM_PLUGIN_STORE: 'dolt', IAM_DIRECTORY_AUTH: '1', IAM_CREDENTIAL_FILE: join(dir, 'credentials.json'), IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_CORE_ADMIN_TOKEN: CORE_TOKEN, IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } }); // the console is built for workspace mode (personal branch + Review & Apply), like demo/start.sh and scripts/workspace-e2e.mjs
run('node',['dist/web/server/server.mjs'],{cwd:join(root,'apps/web'),env:{...process.env,PORT:'4000',IAM_WEB_API_ORIGIN:'http://127.0.0.1:4200'}});
run('node',['demo/server.mjs'],{cwd:root,env:{...process.env,PORT:'4200',IAM_API_ADMIN_TOKEN:ADMIN_TOKEN}});
let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4200/')).ok && (await fetch('http://127.0.0.1:4200/api/health')).ok) break; } catch {} await sleep(500); }
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
  page.setDefaultTimeout(60000);

  let adminHeaders; page.on('request',r=>{if(r.url().endsWith('/plugins/branding-base/form'))adminHeaders=r.headers();});
  const errors = []; page.on('pageerror', (e) => (errors.push(e.message),console.log('PAGEERROR',e.message)));
  page.on('dialog', (d) => d.accept());
  const BASE = 'http://localhost:4200';
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: true });
  const path = () => new URL(page.url()).pathname;
  const status = (txt) => page.waitForFunction((t) => [...document.querySelectorAll('[role=status]')].some((e) => e.textContent?.includes(t)), txt);
  const noBanner = async (label) => { const alerts = await page.locator('[role=alert]').allTextContents(); assert.equal(alerts.length, 0, label + ': no alert (got: ' + JSON.stringify(alerts) + ')'); const t = (await page.textContent('body')) ?? ''; assert.ok(!/Cannot GET|Internal server error|HTTP 5\d\d|Failed to fetch|admin capability required/.test(t), label + ': no error banner'); };
  const nav = (p) => page.click(`nav a[data-nav="${p}"]`);
  // the core login form: wrong password first when asked, then the right one; returns to the console
  await page.goto(`${BASE}/login`, {waitUntil:'commit'});

  await page.locator('#signin-browser, button[data-chain]').first().click();
  await page.fill('input[name=username]', 'demo-alice');await page.fill('input[name=password]', 'demo-only-not-a-secret');
  await page.click('button[type=submit]');
  await page.waitForSelector('header .who');
  await status('personal branch');
  await page.waitForSelector('nav a[data-nav="/screens/branding-base/customisation"]');
  await nav('/screens/branding-base/customisation');
  await page.waitForFunction(()=>document.querySelector('iam-customisation .status')?.textContent.includes('Draft loaded'));
  const frame=page.frameLocator('iframe[title="Live branding preview"]');
  await frame.locator('app-brand img').first().waitFor();
  await shot('branding-light');
  await page.locator('input[name=primaryColor]').fill('#00695c');
  await page.locator('input[name=accentColor]').fill('#d6a33a');
  await page.locator('input[name=productName]').fill('Acme Identity');
  await page.waitForFunction(()=>document.querySelector('iam-customisation .status')?.textContent.includes('Preview updated'));
  await frame.getByText('Acme Identity',{exact:true}).waitFor();
  assert.equal((await (await fetch(BASE+'/api/tenants/acme-demo/branding')).json()).productName,'lyam','unsaved preview never publishes');
  const expected=await page.evaluate(()=>{const css=getComputedStyle(document.documentElement);return Object.fromEntries(['--sidebar-bg','--bg','--card','--accent','--accent-ink'].map(k=>[k,css.getPropertyValue(k).trim()]));});
  assert.notEqual(expected['--sidebar-bg'],'#0f0069','live editing themes the admin sidebar, not just the iframe');
  const checkAdmin=async()=>{
    await page.waitForFunction(e=>getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim()===e,expected['--sidebar-bg']);
    await page.evaluate(()=>{for(const [selector,role] of [['.side','--sidebar-bg'],['body','--bg'],['.top','--card']]){
      const probe=document.createElement('div');probe.style.background=`var(${role})`;document.body.append(probe);
      const actual=getComputedStyle(document.querySelector(selector)).backgroundColor,want=getComputedStyle(probe).backgroundColor;probe.remove();if(actual!==want)throw Error(`${selector}: ${actual} != ${want}`);
    }});
  };
  await checkAdmin();await shot('branding-forest');
  await page.locator('[data-mode=dark]').click();
  await page.getByRole('button',{name:'Dark',exact:true}).first().click();await checkAdmin();await shot('branding-dark');
  await page.locator('[data-save]').click();
  await page.waitForFunction(()=>document.querySelector('iam-customisation .status')?.textContent.includes('Saved to this branch'));
  assert.equal((await (await fetch(BASE+'/api/tenants/acme-demo/branding')).json()).productName,'lyam','saving the draft never changes main');
  // Saved working-branch branding follows navigation across the administration.
  for(const route of ['/users','/roles','/assignments','/plugins','/database/branches']){await nav(route);await checkAdmin();await noBanner(route);}
  const workingBranch=adminHeaders['x-iam-branch'];
  await page.selectOption('select[aria-label="Data branch"]','main');
  await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim()==='#0f0069');
  await page.selectOption('select[aria-label="Data branch"]',workingBranch);await checkAdmin();
  await nav('/users');await shot('admin-users-dark');
  await page.getByRole('button',{name:'Light',exact:true}).first().click();await shot('admin-users-light');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await shot('admin-users-mobile');
  await page.click('.burger');await shot('admin-sidebar-mobile');await page.click('.scrim');
  await page.setViewportSize({width:1440,height:1040});
  await nav('/screens/branding-base/customisation');await page.waitForFunction(()=>document.querySelector('iam-customisation .status')?.textContent.includes('Draft loaded'));await checkAdmin();
  assert.equal((await fetch(BASE+'/api/tenants/acme-demo/branding/draft')).status,401,'no unauthenticated draft disclosure');
  // A valid branch ticket exposes only this draft, including core-rendered pages.
  const issue=await fetch(BASE+'/api/tenants/acme-demo/workspace/branch-test',{method:'POST',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({branch:adminHeaders['x-iam-branch']})});
  assert.equal(issue.status,201);const ticket=await issue.json();
  const q=new URLSearchParams({branch:ticket.branch,ticket:ticket.ticket});
  const testProfile=await(await fetch(BASE+'/api/tenants/acme-demo/branding?'+q)).json();assert.equal(testProfile.productName,'Acme Identity');
  const testPage=await browser.newPage({viewport:{width:390,height:844}});
  await testPage.goto(BASE+'/login?'+q);await testPage.getByText('Acme Identity',{exact:true}).waitFor();
  await testPage.locator('#signin-browser, button[data-chain]').first().click();await testPage.waitForSelector('input[name=password]');
  assert.ok(await testPage.locator('link[href*="branding/theme.css"]').getAttribute('href').then(h=>h.includes('ticket=')));
  await testPage.screenshot({path:join(out,'branding-core-mobile.png')});await testPage.close();
  // Unsafe artwork is rejected before it is persisted, even through generic settings.
  const unsafe=await fetch(BASE+'/api/tenants/acme-demo/plugins/branding-base/settings',{method:'PUT',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({values:{logoMode:'custom',logoSvg:'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'}})});
  assert.equal(unsafe.status,400);
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(300);
  await shot('branding-mobile');
  const inner=page.frames().find(f=>f.url().includes('preview=1'));
  await inner.locator('section.hero').screenshot({path:join(out,'branding-mobile-card.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no page overflow on 390px');
  await page.setViewportSize({width:1440,height:1040});
  await page.click('#review-apply');await page.waitForSelector('#workspace-apply');await page.click('#workspace-apply');await status('Applied');
  assert.equal((await(await fetch(BASE+'/api/tenants/acme-demo/branding')).json()).productName,'Acme Identity','Apply publishes branding');
  const css=await fetch(BASE+'/api/tenants/acme-demo/branding/theme.css');assert.equal(css.status,200);
  assert.ok((await css.text()).includes('--accent-ink'));
  const refused=await fetch(BASE+'/api/tenants/acme-demo/branding?branch=unpublished');assert.equal(refused.status,403);
  assert.deepEqual(errors,[]);
  console.log('BRANDING E2E PASS: Apply, ticketed core, rejected persisted SVG; real Dolt, NATS, Rust core, API, Angular; unsaved live preview, both modes, save stays on branch, main unchanged, mobile, ticket boundary.');
} finally {if(browser)await browser.close();await stopAll();rmSync(dir,{recursive:true,force:true});}
